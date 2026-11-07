import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { sendPushToUser } from "../../utils/webPushService";

export const isOffline = process.env.IS_OFFLINE === "true";
export const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

export const dbClient = isOffline
  ? new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(dbClient);

export const getEndpoint = (event: any) => {
  if (isOffline) {
    return "http://localhost:3002";
  }
  const wsApiId = process.env.WS_API_ID || "lzvcx59zaa";
  const stage = event?.requestContext?.stage || "prod";
  const domainName = event?.requestContext?.domainName;
  if (domainName && domainName.includes(wsApiId)) {
    return `https://${domainName}/${stage}`;
  }
  return `https://${wsApiId}.execute-api.us-east-1.amazonaws.com/${stage}`;
};

export const createOfflineNotification = async ({
  userId,
  title,
  message,
  url,
}: {
  userId: string;
  title: string;
  message: string;
  url?: string;
}) => {
  try {
    const timestamp = new Date().toISOString();
    const notifId = Math.random().toString(36).substring(2, 15);
    const bodyText =
      message && message.length > 80
        ? message.substring(0, 80) + "..."
        : message || "Tienes un nuevo mensaje.";

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type: "comment",
          title,
          message: bodyText,
          createdAt: timestamp,
          read: false,
          targetUrl: url || "/notifications",
        },
      }),
    );

    // Disparar Web Push Notification al dispositivo del usuario
    try {
      await sendPushToUser(userId, {
        title: title || "JobNet",
        body: bodyText,
        url: url || "/notifications",
      });
    } catch (pushErr) {
      console.error(`Error sending push notification to user ${userId}:`, pushErr);
    }
  } catch (err) {
    console.error(`Error creating offline notification for user ${userId}:`, err);
  }
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true as const,
  "Content-Type": "application/json",
};
