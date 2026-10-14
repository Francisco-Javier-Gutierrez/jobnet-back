import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";
import {
  savePushSubscription as saveSubService,
  removePushSubscription as removeSubService,
  DEFAULT_VAPID_PUBLIC_KEY,
  getAllPushSubscribers,
  createUserNotification,
} from "../../utils/webPushService";

// Obtener notificaciones del usuario
export const getNotifications: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
        ScanIndexForward: false,
      }),
    );

    const notifications = (result.Items || []).map((item: any) => ({
      id: item.id || item.SK.split("#").pop(),
      type: item.type || "system",
      title: item.title || "",
      message: item.message || "",
      reason: item.reason || null,
      gracePeriodEnd: item.gracePeriodEnd || null,
      createdAt: item.createdAt || "",
      read: item.read ?? false,
      actionRequired: item.actionRequired || false,
      actionType: item.actionType || null,
      companyId: item.PK.replace("USER#", ""),
    }));

    return { statusCode: 200, headers, body: JSON.stringify(notifications) };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Marcar una notificación como leída
export const markNotificationRead: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    const notifId = event.pathParameters?.notifId;
    if (!userId || !notifId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing userId or notifId" }),
      };
    }

    // Buscar la SK completa de la notificación por su id parcial
    const queryRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
      }),
    );

    const target = (queryRes.Items || []).find(
      (item: any) => item.id === notifId || item.SK.endsWith(notifId),
    );

    if (!target) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: target.PK, SK: target.SK },
        UpdateExpression: "SET #r = :read",
        ExpressionAttributeNames: { "#r": "read" },
        ExpressionAttributeValues: { ":read": true },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: "Notification marked as read" }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Marcar todas las notificaciones como leídas
export const markAllNotificationsRead: APIGatewayProxyHandler = async (
  event,
) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const queryRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
      }),
    );

    const unread = (queryRes.Items || []).filter(
      (item: any) => item.read !== true,
    );

    await Promise.all(
      unread.map((item: any) =>
        docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: "SET #r = :read",
            ExpressionAttributeNames: { "#r": "read" },
            ExpressionAttributeValues: { ":read": true },
          }),
        ),
      ),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `${unread.length} notifications marked as read`,
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Registrar suscripción Push
export const savePushSubscription: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const subscription = body.subscription || body;
    const userAgent =
      body.userAgent ||
      event.headers?.["user-agent"] ||
      event.headers?.["User-Agent"] ||
      "unknown";

    if (!subscription?.endpoint || !subscription?.keys) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "Invalid payload: subscription object with endpoint and keys is required",
        }),
      };
    }

    await saveSubService(userId, subscription, userAgent);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Push subscription saved successfully",
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Eliminar suscripción Push
export const deletePushSubscription: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const endpoint = body.endpoint || event.queryStringParameters?.endpoint;

    if (!endpoint) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing 'endpoint' in request body or query parameter",
        }),
      };
    }

    await removeSubService(userId, endpoint);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Push subscription removed successfully",
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Obtener clave pública VAPID
export const getVapidPublicKey: APIGatewayProxyHandler = async () => {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      publicKey: process.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY,
    }),
  };
};

// Listar suscriptores de notificaciones push (Consola de Administración)
export const getPushSubscribers: APIGatewayProxyHandler = async () => {
  try {
    const subscribers = await getAllPushSubscribers();
    const totalDevices = subscribers.reduce(
      (acc, u) => acc + (u.devices?.length || 0),
      0,
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        subscribers,
        totalUsers: subscribers.length,
        totalDevices,
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Enviar notificación push personalizada (Consola de Administración)
export const sendCustomPushNotification: APIGatewayProxyHandler = async (
  event,
) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const {
      targetType = "all", // "all" | "selected"
      userIds = [],
      title,
      message,
      url = "/notifications",
      icon = "/logotipo.svg",
      image,
      tag = "jobnet-admin-broadcast",
    } = body;

    if (!title || !message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields: 'title' and 'message'",
        }),
      };
    }

    let targetUserIds: string[] = [];

    if (
      targetType === "selected" &&
      Array.isArray(userIds) &&
      userIds.length > 0
    ) {
      targetUserIds = [...new Set(userIds)];
    } else {
      const allSubscribers = await getAllPushSubscribers();
      targetUserIds = allSubscribers.map((u) => u.userId);
    }

    if (targetUserIds.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "No target users found with active push subscriptions.",
        }),
      };
    }

    let totalSent = 0;
    let totalFailed = 0;

    await Promise.all(
      targetUserIds.map(async (userId) => {
        try {
          await createUserNotification({
            userId,
            title,
            message,
            type: "admin_custom_broadcast",
            url,
            extra: {
              icon,
              image: image || undefined,
              tag,
              source: "ADMIN_CONSOLE",
              broadcastAt: new Date().toISOString(),
            },
          });
          totalSent++;
        } catch (err) {
          totalFailed++;
          console.error(`Error sending custom push to user ${userId}:`, err);
        }
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Notifications dispatched successfully",
        targetedUsers: targetUserIds.length,
        sent: totalSent,
        failed: totalFailed,
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
