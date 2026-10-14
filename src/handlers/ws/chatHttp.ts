import { APIGatewayProxyHandler } from "aws-lambda";
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  docClient,
  tableName,
  isOffline,
  corsHeaders,
  createOfflineNotification,
} from "./common";

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
