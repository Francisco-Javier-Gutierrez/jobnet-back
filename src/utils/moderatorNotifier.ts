import { QueryCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../handlers/moderator/common";
import { sendPushToUser } from "./webPushService";

export interface ModeratorNotificationPayload {
  title: string;
  message: string;
  url?: string;
  type: string;
  data?: Record<string, any>;
}

/**
 * Dispatches an in-app persistent notification and Web Push alert
 * to all active platform Moderators and Administrators.
 */
export async function notifyAllModerators(
  payload: ModeratorNotificationPayload,
): Promise<string[]> {
  const timestamp = new Date().toISOString();
  const notifiedModeratorIds: string[] = [];

  try {
    // 1. Query all active Moderators and Admins from DynamoDB via GSI1
    const moderatorQueries = [
      "ROLE#MODERATOR#STATUS#ACTIVO",
      "ROLE#MODERADOR#STATUS#ACTIVO",
      "ROLE#ADMIN#STATUS#ACTIVO",
    ];

    const moderatorItems: any[] = [];

    for (const sk of moderatorQueries) {
      try {
        const res = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :gsiPk AND GSI1SK = :gsiSk",
            ExpressionAttributeValues: {
              ":gsiPk": "PROFILE",
              ":gsiSk": sk,
            },
          }),
        );
        if (res.Items) {
          moderatorItems.push(...res.Items);
        }
      } catch (err) {
        console.warn(`Query for GSI1SK ${sk} warning:`, err);
      }
    }

    // Fallback: If GSI1 yields empty (e.g. in local/test mocks), scan for moderator profiles
    if (moderatorItems.length === 0) {
      try {
        const scanRes = await docClient.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression:
              "SK = :sk AND (tipoUsuario = :m1 OR tipoUsuario = :m2 OR tipoUsuario = :a1)",
            ExpressionAttributeValues: {
              ":sk": "PROFILE",
              ":m1": "MODERATOR",
              ":m2": "MODERADOR",
              ":a1": "ADMIN",
            },
          }),
        );
        if (scanRes.Items) {
          moderatorItems.push(...scanRes.Items);
        }
      } catch (err) {
        console.warn("Moderator fallback scan warning:", err);
      }
    }

    // Deduplicate by user ID
    const uniqueModeratorMap = new Map<string, any>();
    for (const item of moderatorItems) {
      const modId = item.id || item.PK?.replace("USER#", "");
      if (modId && !uniqueModeratorMap.has(modId)) {
        uniqueModeratorMap.set(modId, item);
      }
    }

    // 2. Dispatch In-app notification & Web Push to each moderator
    for (const [modId, item] of uniqueModeratorMap.entries()) {
      const notifId = Math.random().toString(36).substring(2, 15);
      const notifItem = {
        PK: `USER#${modId}`,
        SK: `NOTIFICATION#${timestamp}#${notifId}`,
        id: notifId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        url: payload.url || "/mod/support",
        createdAt: timestamp,
        read: false,
        ...(payload.data || {}),
      };

      try {
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: notifItem,
          }),
        );

        // Web push dispatch (fire & forget to avoid slowing down request)
        sendPushToUser(modId, {
          title: payload.title,
          body: payload.message,
          url: payload.url || "/mod/support",
          data: { type: payload.type, ...(payload.data || {}) },
        }).catch((e) => console.warn(`Failed to push to mod ${modId}:`, e));

        notifiedModeratorIds.push(modId);
      } catch (err) {
        console.error(`Error saving notification for moderator ${modId}:`, err);
      }
    }
  } catch (error) {
    console.error("Error in notifyAllModerators:", error);
  }

  return notifiedModeratorIds;
}
