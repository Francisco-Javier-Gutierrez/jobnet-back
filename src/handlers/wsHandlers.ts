/* eslint-disable @typescript-eslint/no-explicit-any */
import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";

const isOffline = process.env.IS_OFFLINE === "true";
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

const dbClient = isOffline
  ? new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new DynamoDBClient({});

const docClient = DynamoDBDocumentClient.from(dbClient);

const getEndpoint = (event: any) => {
  if (isOffline) {
    return "http://localhost:3002";
  }
  const wsApiId = process.env.WS_API_ID || "lzvcx59zaa";
  const stage = event.requestContext?.stage || "prod";
  const domainName = event.requestContext?.domainName;
  if (domainName && domainName.includes(wsApiId)) {
    return `https://${domainName}/${stage}`;
  }
  return `https://${wsApiId}.execute-api.us-east-1.amazonaws.com/${stage}`;
};

const createOfflineNotification = async ({
  userId,
  title,
  message,
}: {
  userId: string;
  title: string;
  message: string;
}) => {
  try {
    const timestamp = new Date().toISOString();
    const notifId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type: "comment",
          title,
          message:
            message && message.length > 80
              ? message.substring(0, 80) + "..."
              : message || "Tienes un nuevo mensaje.",
          createdAt: timestamp,
          read: false,
        },
      }),
    );
  } catch (err) {
    console.error(
      `Error creating offline notification for user ${userId}:`,
      err,
    );
  }
};

export const connect: APIGatewayProxyHandler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.requestContext.authorizer?.principalId || "anonymous";
  console.log(`Connection established: ${connectionId} for user ${userId}`);

  try {
    // 1. Save connection ID lookup metadata
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
          userId,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    // 2. Save user-to-connection mapping (include userId for sender exclusion)
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `WS_CONNECTION#${connectionId}`,
          userId,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    // 3. Save moderator broadcast mapping if user is moderator/admin
    const userRole = (
      event.requestContext.authorizer?.role ||
      event.queryStringParameters?.role ||
      ""
    ).toUpperCase();
    const isModerator =
      userRole === "MODERATOR" ||
      userRole === "ADMIN" ||
      userId.includes("mod") ||
      userId.includes("admin") ||
      userId === "anonymous";

    if (isModerator) {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: "ROLE#MODERATOR",
            SK: `WS_CONNECTION#${connectionId}`,
            userId,
            createdAt: new Date().toISOString(),
          },
        }),
      );
    }

    return { statusCode: 200, body: "Connected" };
  } catch (error: any) {
    console.error("Error saving WS connection:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};

export const disconnect: APIGatewayProxyHandler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  console.log(`Connection closed: ${connectionId}`);

  try {
    // 1. Get connection metadata to retrieve userId
    const lookup = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
        },
      }),
    );

    if (lookup.Item) {
      const userId = lookup.Item.userId;
      // Delete user mapping
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `USER#${userId}`,
            SK: `WS_CONNECTION#${connectionId}`,
          },
        }),
      );
    }

    // Delete moderator broadcast mapping
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: "ROLE#MODERATOR",
          SK: `WS_CONNECTION#${connectionId}`,
        },
      }),
    );

    // Delete connection metadata
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
        },
      }),
    );

    return { statusCode: 200, body: "Disconnected" };
  } catch (error: any) {
    console.error("Error deleting WS connection:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};

export const defaultRoute: APIGatewayProxyHandler = async (event: any) => {
  console.log(`Default route hit: ${event.requestContext.connectionId}`);
  return { statusCode: 200, body: "Default route" };
};

export const sendMessage = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  const senderId = event.requestContext.authorizer?.principalId || "anonymous";
  console.log(`sendMessage route hit by connection: ${connectionId}`);

  try {
    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};
    const {
      jobId,
      candidateId,
      disputeId,
      appealId,
      appealCompanyId,
      text,
      attachmentUrl,
      attachmentType,
      attachmentName,
      attachmentKey,
      messageId: clientMessageId,
    } = body;

    // Handle Appeal Chat Routing if appealId is present
    if (appealId && appealCompanyId) {
      if (!text && !attachmentUrl) {
        return {
          statusCode: 400,
          body: "Missing text or attachment parameter for appeal message",
        };
      }

      const timestamp = new Date().toISOString();
      const messageId = clientMessageId || randomUUID();

      // Idempotency check: skip if this messageId was already persisted
      if (clientMessageId) {
        const dupCheck = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            FilterExpression: "messageId = :mid",
            ExpressionAttributeValues: {
              ":pk": `APPEAL_CHAT#${appealId}`,
              ":skPrefix": "MSG#",
              ":mid": clientMessageId,
            },
            Limit: 1,
            ScanIndexForward: false,
          }),
        );
        if (dupCheck.Items && dupCheck.Items.length > 0) {
          console.log(`Duplicate appeal messageId=${clientMessageId} skipped.`);
          return {
            statusCode: 200,
            body: JSON.stringify({
              message: "Duplicate message skipped",
              duplicate: true,
              item: dupCheck.Items[0],
            }),
          };
        }
      }

      const messageItem: any = {
        PK: `APPEAL_CHAT#${appealId}`,
        SK: `MSG#${timestamp}#${messageId}`,
        messageId,
        appealId,
        companyId: appealCompanyId,
        senderId,
        text: text || "",
        createdAt: timestamp,
      };

      if (attachmentUrl) {
        messageItem.attachmentUrl = attachmentUrl;
        messageItem.attachmentType = attachmentType || "file";
        messageItem.attachmentName = attachmentName || "attachment";
        messageItem.attachmentKey = attachmentKey || "";
      }

      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: messageItem,
        }),
      );

      // Collect all target partition keys for broadcast.
      // The org user's WS connections are registered under USER#<cognitoSub> (not companyId),
      // so we must also look up the company profile to find the owner's actual cognitoSub.
      const targetKeys: string[] = [
        `USER#${appealCompanyId}`,
        "ROLE#MODERATOR",
      ];

      // Try to resolve the org owner's actual Cognito sub from their profile
      try {
        const companyProfile = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${appealCompanyId}`, SK: "PROFILE" },
          }),
        );
        const ownerSub =
          companyProfile.Item?.sub || companyProfile.Item?.cognitoSub;
        if (
          ownerSub &&
          ownerSub !== appealCompanyId &&
          !targetKeys.includes(`USER#${ownerSub}`)
        ) {
          targetKeys.push(`USER#${ownerSub}`);
        }
      } catch {
        // Non-critical: if profile lookup fails, we still try the companyId key
      }

      const apigwClient = new ApiGatewayManagementApiClient({
        endpoint: getEndpoint(event),
      });

      const recipientPromises: Promise<void>[] = [];
      for (const pkKey of targetKeys) {
        const connRes = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": pkKey,
              ":skPrefix": "WS_CONNECTION#",
            },
          }),
        );
        for (const cItem of connRes.Items || []) {
          const cid = cItem.SK.replace("WS_CONNECTION#", "");
          // Exclude ALL connections belonging to the sender (not just the current one)
          // to prevent echo when sender has multiple tabs open
          if (cid === connectionId) continue;
          if (cItem.userId && cItem.userId === senderId) continue;
          recipientPromises.push(
            apigwClient
              .send(
                new PostToConnectionCommand({
                  ConnectionId: cid,
                  Data: Buffer.from(
                    JSON.stringify({
                      type: "APPEAL_MESSAGE",
                      messageId,
                      appealId,
                      appealCompanyId,
                      senderId,
                      text: text || "",
                      attachmentUrl: attachmentUrl || null,
                      attachmentType:
                        attachmentType ||
                        (attachmentUrl &&
                        /\.(jpg|jpeg|png|webp|gif|svg)($|\?)/i.test(
                          attachmentUrl,
                        )
                          ? "image"
                          : "file"),
                      attachmentName: attachmentName || "attachment",
                      createdAt: timestamp,
                    }),
                  ),
                }),
              )
              .then(() => {})
              .catch(async (err) => {
                if (err.name === "GoneException" || err.statusCode === 410) {
                  await docClient.send(
                    new DeleteCommand({
                      TableName: tableName,
                      Key: { PK: pkKey, SK: `WS_CONNECTION#${cid}` },
                    }),
                  );
                }
              }),
          );
        }
      }
      await Promise.all(recipientPromises);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Appeal message sent",
          item: messageItem,
        }),
      };
    }

    // Standard Application Chat Routing
    if (!jobId || !candidateId || (!text && !attachmentUrl)) {
      return {
        statusCode: 400,
        body: "Missing jobId, candidateId, text or attachment parameters",
      };
    }

    // Fetch the job details to check ownership
    const jobResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${jobId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!jobResult.Item) {
      return { statusCode: 404, body: "Vacancy not found" };
    }

    const job = jobResult.Item;
    const companyId = job.empresaUuid;

    // Validate that sender is either the candidate or the company
    if (senderId !== candidateId && senderId !== companyId) {
      return {
        statusCode: 403,
        body: "Not authorized to send messages in this conversation",
      };
    }

    const timestamp = new Date().toISOString();
    const messageItem: any = {
      PK: `CHAT#${jobId}#${candidateId}`,
      SK: `MSG#${timestamp}`,
      senderId,
      text: text || "",
      createdAt: timestamp,
    };

    if (attachmentUrl) {
      messageItem.attachmentUrl = attachmentUrl;
      messageItem.attachmentType = attachmentType || "file";
      messageItem.attachmentName = attachmentName || "attachment";
      messageItem.attachmentKey = attachmentKey || "";
    }

    // Save chat message
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: messageItem,
      }),
    );

    // Identify recipient
    const recipientId = senderId === candidateId ? companyId : candidateId;

    // Fetch recipient active WebSocket connections
    const connectionsResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${recipientId}`,
          ":skPrefix": "WS_CONNECTION#",
        },
      }),
    );

    const activeConnections = connectionsResult.Items || [];
    const apigwClient = new ApiGatewayManagementApiClient({
      endpoint: getEndpoint(event),
    });

    let deliveredSockets = 0;
    // Route messages to all active connection IDs of the recipient
    const sendPromises = activeConnections.map(async (connItem) => {
      const targetConnectionId = connItem.SK.replace("WS_CONNECTION#", "");
      try {
        await apigwClient.send(
          new PostToConnectionCommand({
            ConnectionId: targetConnectionId,
            Data: Buffer.from(
              JSON.stringify({
                action: "receiveMessage",
                jobId,
                candidateId,
                senderId,
                text: text || "",
                attachmentUrl,
                attachmentType,
                attachmentName,
                createdAt: timestamp,
              }),
            ),
          }),
        );
        deliveredSockets++;
      } catch (err: any) {
        // If connection is stale/gone, delete it from DynamoDB
        if (err.statusCode === 410) {
          console.log(
            `Stale connection detected: ${targetConnectionId}, cleaning up.`,
          );
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${recipientId}`,
                SK: `WS_CONNECTION#${targetConnectionId}`,
              },
            }),
          );
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: `WS_CONNECTION#${targetConnectionId}`,
                SK: "METADATA",
              },
            }),
          );
        } else {
          console.error(`Error sending message to ${targetConnectionId}:`, err);
        }
      }
    });

    await Promise.all(sendPromises);

    if (activeConnections.length === 0 || deliveredSockets === 0) {
      await createOfflineNotification({
        userId: recipientId,
        title: "Nuevo mensaje de chat",
        message:
          text ||
          attachmentName ||
          "Tienes un nuevo mensaje en tu conversación.",
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: messageItem }),
    };
  } catch (error: any) {
    console.error("Error sending WebSocket message:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};

export const getChatMessages: APIGatewayProxyHandler = async (event: any) => {
  const jobId = event.pathParameters?.jobId;
  const candidateId = event.pathParameters?.candidateId;

  if (!jobId || !candidateId) {
    return {
      statusCode: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Missing parameters 'jobId' or 'candidateId'",
      }),
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `CHAT#${jobId}#${candidateId}`,
          ":skPrefix": "MSG#",
        },
      }),
    );

    const messages = (result.Items || []).map((m) => ({
      senderId: m.senderId,
      text: m.text,
      attachmentUrl: m.attachmentUrl || null,
      attachmentType: m.attachmentType || null,
      attachmentName: m.attachmentName || null,
      createdAt: m.createdAt,
    }));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export const getAppealMessages: APIGatewayProxyHandler = async (event: any) => {
  const appealId = event.pathParameters?.id || event.pathParameters?.appealId;

  if (!appealId) {
    return {
      statusCode: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Missing path parameter 'id'",
      }),
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `APPEAL_CHAT#${appealId}`,
          ":skPrefix": "MSG#",
        },
      }),
    );

    const messages = (result.Items || [])
      .filter(
        (m) =>
          !m.isJoinMessage &&
          (!m.text || !m.text.includes("La empresa se ha unido")),
      )
      .map((m) => ({
        appealId: m.appealId || appealId,
        companyId: m.companyId,
        senderId: m.senderId,
        text: m.text,
        attachmentUrl: m.attachmentUrl || null,
        attachmentType: m.attachmentType || null,
        attachmentName: m.attachmentName || null,
        createdAt: m.createdAt,
      }));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: error.message }),
    };
  }
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true as const,
  "Content-Type": "application/json",
};

/**
 * HTTP POST endpoint for sending chat messages via REST API.
 * Acts as primary sending channel when WebSocket is unavailable.
 * Route: POST /chats/{jobId}/{candidateId}/messages
 */
export const sendChatMessageHttp: APIGatewayProxyHandler = async (
  event: any,
) => {
  const jobId = event.pathParameters?.jobId;
  const candidateId = event.pathParameters?.candidateId;

  if (!jobId || !candidateId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Missing path parameters 'jobId' or 'candidateId'",
      }),
    };
  }

  let body: any;
  try {
    body =
      typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const {
    senderId,
    text,
    attachmentUrl,
    attachmentType,
    attachmentName,
    attachmentKey,
  } = body;

  if (!senderId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Missing 'senderId' in request body" }),
    };
  }

  if (!text && !attachmentUrl) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Missing 'text' or 'attachmentUrl' in request body",
      }),
    };
  }

  try {
    const timestamp = new Date().toISOString();
    const messageItem: any = {
      PK: `CHAT#${jobId}#${candidateId}`,
      SK: `MSG#${timestamp}`,
      senderId,
      text: text || "",
      createdAt: timestamp,
    };

    if (attachmentUrl) {
      messageItem.attachmentUrl = attachmentUrl;
      messageItem.attachmentType = attachmentType || "file";
      messageItem.attachmentName = attachmentName || "attachment";
      messageItem.attachmentKey = attachmentKey || "";
    }

    // Persist message to DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: messageItem,
      }),
    );

    // Best-effort: push to recipient via WebSocket if they have active connections
    try {
      const jobResult = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${jobId}`,
            SK: "METADATA",
          },
        }),
      );

      if (jobResult.Item) {
        const companyId = jobResult.Item.empresaUuid;
        const recipientId = senderId === candidateId ? companyId : candidateId;

        const connectionsResult = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": `USER#${recipientId}`,
              ":skPrefix": "WS_CONNECTION#",
            },
          }),
        );

        const activeConnections = connectionsResult.Items || [];

        let pushedSockets = 0;
        if (activeConnections.length > 0) {
          const wsApiId = process.env.WS_API_ID || "lzvcx59zaa";
          const wsEndpoint = isOffline
            ? "http://localhost:3002"
            : `https://${wsApiId}.execute-api.us-east-1.amazonaws.com/prod`;

          const apigwClient = new ApiGatewayManagementApiClient({
            endpoint: wsEndpoint,
          });

          const pushPayload = JSON.stringify({
            action: "receiveMessage",
            jobId,
            candidateId,
            senderId,
            text: text || "",
            attachmentUrl,
            attachmentType,
            attachmentName,
            createdAt: timestamp,
          });

          await Promise.allSettled(
            activeConnections.map(async (connItem) => {
              const targetConnId = connItem.SK.replace("WS_CONNECTION#", "");
              try {
                await apigwClient.send(
                  new PostToConnectionCommand({
                    ConnectionId: targetConnId,
                    Data: Buffer.from(pushPayload),
                  }),
                );
                pushedSockets++;
              } catch (err: any) {
                if (err.statusCode === 410 || err.name === "GoneException") {
                  await docClient.send(
                    new DeleteCommand({
                      TableName: tableName,
                      Key: {
                        PK: `USER#${recipientId}`,
                        SK: `WS_CONNECTION#${targetConnId}`,
                      },
                    }),
                  );
                }
              }
            }),
          );
        }

        if (activeConnections.length === 0 || pushedSockets === 0) {
          await createOfflineNotification({
            userId: recipientId,
            title: "Nuevo mensaje de chat",
            message:
              text ||
              attachmentName ||
              "Tienes un nuevo mensaje en tu conversación.",
          });
        }
      }
    } catch (wsErr) {
      // WebSocket push is best-effort; message is already persisted
      console.warn("WebSocket push failed (non-critical):", wsErr);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        message: {
          senderId: messageItem.senderId,
          text: messageItem.text,
          attachmentUrl: messageItem.attachmentUrl || null,
          attachmentType: messageItem.attachmentType || null,
          attachmentName: messageItem.attachmentName || null,
          createdAt: messageItem.createdAt,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error sending chat message via HTTP:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export const sendAppealMessageHttp: APIGatewayProxyHandler = async (
  event: any,
) => {
  const appealId = event.pathParameters?.id || event.pathParameters?.appealId;
  if (!appealId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Missing parameter 'id'" }),
    };
  }

  try {
    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};
    const { text, attachmentUrl, companyId } = body;
    
    if (!companyId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing parameter 'companyId' in body" }),
      };
    }

    const senderId =
      body.senderId ||
      event.requestContext.authorizer?.principalId ||
      event.requestContext.authorizer?.lambda?.principalId ||
      "MODERATOR";

    if (!text && !attachmentUrl) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing text or attachment" }),
      };
    }

    const timestamp = new Date().toISOString();
    const messageId = body.messageId || randomUUID();

    if (body.messageId) {
      const dupCheck = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          FilterExpression: "messageId = :mid",
          ExpressionAttributeValues: {
            ":pk": `APPEAL_CHAT#${appealId}`,
            ":skPrefix": "MSG#",
            ":mid": body.messageId,
          },
          Limit: 1,
          ScanIndexForward: false,
        }),
      );
      if (dupCheck.Items && dupCheck.Items.length > 0) {
        console.log(
          `Duplicate HTTP appeal messageId=${body.messageId} skipped.`,
        );
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            success: true,
            duplicate: true,
            message: dupCheck.Items[0],
          }),
        };
      }
    }

    const messageItem: any = {
      PK: `APPEAL_CHAT#${appealId}`,
      SK: `MSG#${timestamp}#${messageId}`,
      messageId,
      appealId,
      companyId,
      senderId,
      text: text || "",
      createdAt: timestamp,
    };

    if (attachmentUrl) {
      messageItem.attachmentUrl = attachmentUrl;
    }

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: messageItem,
      }),
    );

    const targetKeys: string[] = [`USER#${companyId}`, "ROLE#MODERATOR"];

    try {
      const companyProfile = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        }),
      );
      const ownerSub =
        companyProfile.Item?.sub || companyProfile.Item?.cognitoSub;
      if (
        ownerSub &&
        ownerSub !== companyId &&
        !targetKeys.includes(`USER#${ownerSub}`)
      ) {
        targetKeys.push(`USER#${ownerSub}`);
      }
    } catch {
      // Non-critical: if profile lookup fails, we still try the companyId key
    }
    const apigwClient = new ApiGatewayManagementApiClient({
      endpoint: getEndpoint(event),
    });

    let delivered = 0;
    let companyHasSockets = false;

    for (const pkKey of targetKeys) {
      const connRes = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": pkKey,
            ":skPrefix": "WS_CONNECTION#",
          },
        }),
      );

      const activeConnections = connRes.Items || [];
      if (pkKey === `USER#${companyId}` && activeConnections.length > 0) {
        companyHasSockets = true;
      }

      for (const cItem of activeConnections) {
        const cid = cItem.SK.replace("WS_CONNECTION#", "");
        // Exclude sender's own connections to prevent echo
        if (cItem.userId && cItem.userId === senderId) continue;
        try {
          await apigwClient.send(
            new PostToConnectionCommand({
              ConnectionId: cid,
              Data: Buffer.from(
                JSON.stringify({
                  type: "APPEAL_MESSAGE",
                  messageId,
                  appealId,
                  appealCompanyId: companyId,
                  senderId,
                  text: text || "",
                  attachmentUrl: attachmentUrl || null,
                  attachmentType:
                    body.attachmentType ||
                    (attachmentUrl &&
                    /\.(jpg|jpeg|png|webp|gif|svg)($|\?)/i.test(attachmentUrl)
                      ? "image"
                      : "file"),
                  attachmentName: body.attachmentName || "attachment",
                  createdAt: timestamp,
                }),
              ),
            }),
          );
          delivered++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.name === "GoneException") {
            await docClient.send(
              new DeleteCommand({
                TableName: tableName,
                Key: { PK: pkKey, SK: `WS_CONNECTION#${cid}` },
              }),
            );
          }
        }
      }
    }

    if (!companyHasSockets || delivered === 0) {
      await createOfflineNotification({
        userId: companyId,
        title: "Mensaje de Moderación (Apelación)",
        message: text || "Un moderador ha respondido a tu apelación.",
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true, message: messageItem }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
