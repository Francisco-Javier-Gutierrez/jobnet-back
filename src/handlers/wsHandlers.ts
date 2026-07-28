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

const isOffline = process.env.IS_OFFLINE === "true";
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-dev";

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
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  if (isOffline) {
    return "http://localhost:3002";
  }
  return `https://${domainName}/${stage}`;
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

    // 2. Save user-to-connection mapping
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `WS_CONNECTION#${connectionId}`,
          createdAt: new Date().toISOString(),
        },
      }),
    );

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
      appealCompanyId,
      text,
      attachmentUrl,
      attachmentType,
      attachmentName,
      attachmentKey,
    } = body;

    // Handle Appeal Chat Routing if appealCompanyId is present
    if (appealCompanyId) {
      if (!text && !attachmentUrl) {
        return {
          statusCode: 400,
          body: "Missing text or attachment parameter for appeal message",
        };
      }

      const timestamp = new Date().toISOString();
      const messageItem: any = {
        PK: `APPEAL_CHAT#${appealCompanyId}`,
        SK: `MSG#${timestamp}`,
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

      const targetUserIds = new Set<string>();
      targetUserIds.add(appealCompanyId);
      targetUserIds.add("ADMIN");
      targetUserIds.add("MODERATOR");

      const apigwClient = new ApiGatewayManagementApiClient({
        endpoint: getEndpoint(event),
      });

      const recipientPromises: Promise<void>[] = [];
      for (const uid of targetUserIds) {
        if (uid === senderId) continue;
        const connRes = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": `USER#${uid}`,
              ":skPrefix": "WS_CONNECTION#",
            },
          }),
        );
        for (const cItem of connRes.Items || []) {
          const cid = cItem.SK.replace("WS_CONNECTION#", "");
          recipientPromises.push(
            apigwClient
              .send(
                new PostToConnectionCommand({
                  ConnectionId: cid,
                  Data: Buffer.from(
                    JSON.stringify({
                      type: "APPEAL_MESSAGE",
                      appealCompanyId,
                      senderId,
                      text: text || "",
                      attachmentUrl,
                      createdAt: timestamp,
                    }),
                  ),
                }),
              )
              .then(() => {})
              .catch(async (err) => {
                if (err.name === "GoneException") {
                  await docClient.send(
                    new DeleteCommand({
                      TableName: tableName,
                      Key: { PK: `USER#${uid}`, SK: `WS_CONNECTION#${cid}` },
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

    // Handle Dispute/Claim Chat Routing if disputeId is present
    if (disputeId) {
      if (!text && !attachmentUrl) {
        return {
          statusCode: 400,
          body: "Missing text or attachment parameter for dispute message",
        };
      }

      // Fetch Dispute item
      const disputeResult = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `DISPUTE#${disputeId}`,
            SK: "METADATA",
          },
        }),
      );

      if (!disputeResult.Item) {
        return { statusCode: 404, body: "Dispute not found" };
      }

      const dispute = disputeResult.Item;
      const timestamp = new Date().toISOString();
      const messageItem: any = {
        PK: `DISPUTE#${disputeId}`,
        SK: `MSG#${timestamp}`,
        disputeId,
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

      // Recipients for dispute: complainant, respondent company/candidate, and moderators
      const targetUserIds = new Set<string>();
      if (dispute.candidateId) targetUserIds.add(dispute.candidateId);
      if (dispute.companyId) targetUserIds.add(dispute.companyId);
      if (dispute.complainantId) targetUserIds.add(dispute.complainantId);

      const apigwClient = new ApiGatewayManagementApiClient({
        endpoint: getEndpoint(event),
      });

      const recipientPromises: Promise<void>[] = [];

      for (const uid of targetUserIds) {
        if (uid === senderId) continue;
        const connRes = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": `USER#${uid}`,
              ":skPrefix": "WS_CONNECTION#",
            },
          }),
        );
        (connRes.Items || []).forEach((cItem) => {
          const targetConnId = cItem.SK.replace("WS_CONNECTION#", "");
          recipientPromises.push(
            apigwClient
              .send(
                new PostToConnectionCommand({
                  ConnectionId: targetConnId,
                  Data: Buffer.from(
                    JSON.stringify({
                      action: "receiveDisputeMessage",
                      disputeId,
                      senderId,
                      text: text || "",
                      attachmentUrl,
                      attachmentType,
                      attachmentName,
                      createdAt: timestamp,
                    }),
                  ),
                }),
              )
              .then(() => {})
              .catch(async (err: any) => {
                if (err.statusCode === 410) {
                  await docClient.send(
                    new DeleteCommand({
                      TableName: tableName,
                      Key: {
                        PK: `USER#${uid}`,
                        SK: `WS_CONNECTION#${targetConnId}`,
                      },
                    }),
                  );
                }
              }),
          );
        });
      }

      await Promise.all(recipientPromises);

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: messageItem }),
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

export const getDisputeMessages: APIGatewayProxyHandler = async (
  event: any,
) => {
  const disputeId = event.pathParameters?.disputeId;

  if (!disputeId) {
    return {
      statusCode: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Missing path parameter 'disputeId'",
      }),
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `DISPUTE#${disputeId}`,
          ":skPrefix": "MSG#",
        },
      }),
    );

    const messages = (result.Items || []).map((m) => ({
      disputeId: m.disputeId,
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
  const companyId = event.pathParameters?.id || event.pathParameters?.companyId;

  if (!companyId) {
    return {
      statusCode: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Missing path parameter 'companyId'",
      }),
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `APPEAL_CHAT#${companyId}`,
          ":skPrefix": "MSG#",
        },
      }),
    );

    const messages = (result.Items || []).map((m) => ({
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
