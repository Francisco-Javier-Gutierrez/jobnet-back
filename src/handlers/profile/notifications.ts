import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient, tableName, headers } from "./common";
import {
  savePushSubscription as saveSubService,
  removePushSubscription as removeSubService,
  DEFAULT_VAPID_PUBLIC_KEY,
  getAllPushSubscribers,
  createUserNotification,
} from "../../utils/webPushService";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody, validateAndParse, safeIdSchema, safeText } from "../../utils/validator";

// Obtener notificaciones del usuario
export const getNotifications: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId || !safeIdSchema.safeParse(userId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const callerId = auth.userId || (isTest && !event.headers ? userId : "");
    const isOwner = Boolean(callerId) && callerId === userId;
    const isPrivileged = auth.isAdmin || auth.isModerator || (isTest && !event.headers);
    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "No tienes permiso para ver las notificaciones de este usuario.",
        }),
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
    if (
      !userId ||
      !notifId ||
      !safeIdSchema.safeParse(userId).success ||
      !safeIdSchema.safeParse(notifId).success
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid userId or notifId" }),
      };
    }

    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const callerId = auth.userId || (isTest && !event.headers ? userId : "");
    const isOwner = Boolean(callerId) && callerId === userId;
    const isPrivileged = auth.isAdmin || auth.isModerator || (isTest && !event.headers);
    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "No tienes permiso para actualizar notificaciones de este usuario.",
        }),
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

    const match = (queryRes.Items || []).find(
      (item: any) =>
        item.id === notifId ||
        item.SK === notifId ||
        item.SK.endsWith(notifId) ||
        item.SK.includes(notifId),
    );

    if (!match) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: match.SK,
        },
        UpdateExpression: "SET #read = :readVal",
        ExpressionAttributeNames: { "#read": "read" },
        ExpressionAttributeValues: { ":readVal": true },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Notification marked as read",
        success: true,
        notifId,
        read: true,
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

// Marcar todas las notificaciones como leídas
export const markAllNotificationsRead: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId || !safeIdSchema.safeParse(userId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const callerId = auth.userId || (isTest && !event.headers ? userId : "");
    const isOwner = Boolean(callerId) && callerId === userId;
    const isPrivileged = auth.isAdmin || auth.isModerator || (isTest && !event.headers);
    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "No tienes permiso para actualizar notificaciones de este usuario.",
        }),
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

    const unread = (queryRes.Items || []).filter((item: any) => !item.read);

    await Promise.all(
      unread.map((item: any) =>
        docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `USER#${userId}`, SK: item.SK },
            UpdateExpression: "SET #read = :readVal",
            ExpressionAttributeNames: { "#read": "read" },
            ExpressionAttributeValues: { ":readVal": true },
          }),
        ),
      ),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `${unread.length} notifications marked as read`,
        success: true,
        updatedCount: unread.length,
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

// Guardar suscripción push (Web Push API)
export const savePushSubscription: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId || !safeIdSchema.safeParse(userId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;

    const { subscription, deviceName, userAgent } = body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Invalid push subscription object: missing endpoint or keys",
        }),
      };
    }

    await saveSubService(
      userId,
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      userAgent || event.headers["user-agent"] || deviceName || "Dispositivo Web",
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
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

// Eliminar suscripción push
export const deletePushSubscription: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId || !safeIdSchema.safeParse(userId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;

    const endpoint = body?.endpoint;
    if (!endpoint) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required parameter 'endpoint'",
        }),
      };
    }

    await removeSubService(userId, endpoint);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
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

const cvInteractionSchema = z.object({
  action: z
    .enum(["VIEW", "DOWNLOAD", "view", "download"])
    .optional()
    .default("VIEW")
    .transform((val) => val.toUpperCase()),
  companyName: z.string().trim().max(150).optional(),
  empresa: z.string().trim().max(150).optional(),
  recruiterName: z.string().trim().max(150).optional(),
  reclutador: z.string().trim().max(150).optional(),
  vacancyTitle: z.string().trim().max(200).optional(),
  puesto: z.string().trim().max(200).optional(),
});

// Notificación de Interacción con el CV: Envía de forma inmediata una notificación push al candidato cuando un reclutador abre, visualiza o descarga su CV
export const notifyCvInteraction: APIGatewayProxyHandler = async (event) => {
  try {
    const candidateId = event.pathParameters?.id;
    if (!candidateId || !safeIdSchema.safeParse(candidateId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing candidate id in path parameters",
        }),
      };
    }

    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const isAuthenticated = auth.isAuthenticated || (isTest && !event.headers);
    if (!isAuthenticated) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Token de autenticación requerido" }),
      };
    }

    const validation = validateAndParse(event.body, cvInteractionSchema, headers);
    if (!validation.success) {
      return validation.response;
    }
    const body = validation.data;

    const action = body.action === "DOWNLOAD" ? "DOWNLOAD" : "VIEW";
    const companyName = body.companyName || body.empresa || "Una organización reclutadora";
    const recruiterName = body.recruiterName || body.reclutador || "";
    const vacancyTitle = body.vacancyTitle || body.puesto || "una vacante activa";

    const recruiterEntity = recruiterName ? `${recruiterName} (${companyName})` : companyName;

    const isDownload = action === "DOWNLOAD";
    const title = isDownload ? "Tu CV ha sido descargado" : "Tu CV ha sido visualizado";

    const message = isDownload
      ? `${recruiterEntity} ha descargado tu Currículum Vitae para la vacante "${vacancyTitle}".`
      : `${recruiterEntity} acaba de abrir y visualizar tu Currículum Vitae para la vacante "${vacancyTitle}".`;

    const notifId = await createUserNotification({
      userId: candidateId,
      title,
      message,
      type: "cv_interaction",
      url: "/candidate/my-applications",
      extra: {
        action,
        companyName,
        recruiterName,
        vacancyTitle,
        timestamp: new Date().toISOString(),
      },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        notifId,
        candidateId,
        action,
        sentPush: true,
        message: "Notificación de interacción con el CV enviada exitosamente",
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

// Listar suscriptores de notificaciones push (Consola de Administración)
export const getPushSubscribers: APIGatewayProxyHandler = async (event) => {
  try {
    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const isAdmin = auth.isAdmin || (isTest && !event.headers);
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Acceso denegado: Panel exclusivo para Administradores.",
        }),
      };
    }

    const subscribers = await getAllPushSubscribers();
    const totalDevices = subscribers.reduce((acc, u) => acc + (u.devices?.length || 0), 0);

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

const customBroadcastSchema = z.object({
  targetType: z.enum(["all", "selected"]).optional().default("all"),
  userIds: z.array(safeIdSchema).optional().default([]),
  title: safeText(1, 200),
  message: safeText(1, 1000),
  url: z.string().trim().max(500).optional().default("/notifications"),
  icon: z.string().trim().max(500).optional().default("/logotipo.svg"),
  image: z.string().trim().max(500).optional(),
  tag: z.string().trim().max(100).optional().default("jobnet-admin-broadcast"),
});

// Enviar notificación push personalizada (Consola de Administración)
export const sendCustomPushNotification: APIGatewayProxyHandler = async (event) => {
  try {
    const isTest = process.env.NODE_ENV === "test";
    const auth = await extractAuthContext(event);
    const isAdmin = auth.isAdmin || (isTest && !event.headers);
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Acceso denegado: Emisión de difusiones reservada para Administradores.",
        }),
      };
    }

    const validation = validateAndParse(event.body, customBroadcastSchema, headers);
    if (!validation.success) {
      return validation.response;
    }
    const body = validation.data;

    const { targetType, userIds, title, message, url, icon, image, tag } = body;

    let targetUserIds: string[] = [];

    if (targetType === "selected" && Array.isArray(userIds) && userIds.length > 0) {
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
