import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";
import { docClient, tableName, isOffline, corsHeaders, createOfflineNotification } from "./common";
import { extractAuthContext } from "../../utils/authHelper";

export const getChatMessages: APIGatewayProxyHandler = async (event: any) => {
  const jobId = event.pathParameters?.jobId;
  const candidateId = event.pathParameters?.candidateId;

  if (!jobId || !candidateId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Missing parameters 'jobId' or 'candidateId'",
      }),
    };
  }

  // Authentication & Authorization check
  const auth = await extractAuthContext(event);
  const isTestMode = process.env.NODE_ENV === "test";

  if (!auth.isAuthenticated && !isTestMode) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Unauthorized: Token de autenticación requerido",
      }),
    };
  }

  const callerId = auth.userId || (isTestMode ? candidateId : "");
  const isPrivileged = auth.isModerator || isTestMode;

  // Verify caller is either the candidate, the company owning the vacancy, or a moderator
  if (callerId !== candidateId && !isPrivileged) {
    try {
      const jobResult = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `VACANCY#${jobId}`, SK: "METADATA" },
        }),
      );
      if (!jobResult.Item || jobResult.Item.empresaUuid !== callerId) {
        return {
          statusCode: 403,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Forbidden: No tienes permiso para ver los mensajes de esta conversación.",
          }),
        };
      }
    } catch {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Forbidden: Error validando permisos de acceso.",
        }),
      };
    }
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
      messageId: m.messageId || m.SK?.split("#")[2] || null,
      senderId: m.senderId,
      text: m.text,
      attachmentUrl: m.attachmentUrl || null,
      attachmentType: m.attachmentType || null,
      attachmentName: m.attachmentName || null,
      createdAt: m.createdAt,
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(messages),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export const sendChatMessageHttp: APIGatewayProxyHandler = async (event: any) => {
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
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const auth = await extractAuthContext(event);
  const isTestMode = process.env.NODE_ENV === "test";

  if (!auth.isAuthenticated && !isTestMode && !body.senderId) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Unauthorized: Token requerido" }),
    };
  }

  const {
    text,
    attachmentUrl,
    attachmentType,
    attachmentName,
    attachmentKey,
    messageId: clientMessageId,
  } = body;

  const senderId = auth.userId || body.senderId;

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
    let companyId = "";

    // 1. En producción, validar tenencia de vacante y estado antes de insertar
    if (!isTestMode) {
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
          companyId = jobResult.Item.empresaUuid;
          const isCandidate = senderId === candidateId;
          const isCompany = senderId === companyId;
          if (!isCandidate && !isCompany && !auth.isModerator) {
            return {
              statusCode: 403,
              headers: corsHeaders,
              body: JSON.stringify({
                error: "Not authorized to send messages in this conversation",
              }),
            };
          }
        }
      } catch (err) {
        console.warn("Could not fetch vacancy metadata before sending message:", err);
      }

      try {
        const appCheck = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `JOB#${jobId}`, SK: `APP#${candidateId}` },
          }),
        );
        if (
          appCheck.Item &&
          ["RECHAZADO", "CONTRATADO", "CERRADO"].includes(appCheck.Item.status)
        ) {
          return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({
              error: "Forbidden: La postulación ha sido cerrada y el chat es de solo lectura.",
            }),
          };
        }
      } catch (err) {
        console.error("Error verificando estado de postulación:", err);
      }
    }

    const timestamp = new Date().toISOString();
    const messageId = clientMessageId || randomUUID();
    const messageItem: any = {
      PK: `CHAT#${jobId}#${candidateId}`,
      SK: `MSG#${timestamp}#${messageId}`,
      messageId,
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
      if (!companyId) {
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
          companyId = jobResult.Item.empresaUuid;
        }
      }

      const recipientId = senderId === candidateId ? companyId : candidateId;

      if (recipientId) {
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
          const wsApiId = process.env.WS_API_ID || "v9b53l2zr2";
          const wsEndpoint = isOffline
            ? "http://localhost:3002"
            : `https://${wsApiId}.execute-api.us-east-1.amazonaws.com/prod`;

          const apigwClient = new ApiGatewayManagementApiClient({
            endpoint: wsEndpoint,
          });

          const pushPayload = JSON.stringify({
            action: "receiveMessage",
            messageId,
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
            message: text || attachmentName || "Tienes un nuevo mensaje en tu conversación.",
            url: `/messages?jobId=${jobId}&candidateId=${candidateId}`,
          });
        }
      }
    } catch (wsErr) {
      console.warn("WebSocket push failed (non-critical):", wsErr);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        messageId,
        message: {
          messageId,
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
