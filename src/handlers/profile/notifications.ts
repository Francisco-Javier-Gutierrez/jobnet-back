import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";
import {
  savePushSubscription as saveSubService,
  removePushSubscription as removeSubService,
  DEFAULT_VAPID_PUBLIC_KEY,
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
          error: "Invalid payload: subscription object with endpoint and keys is required",
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
        body: JSON.stringify({ error: "Missing 'endpoint' in request body or query parameter" }),
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

// Notificación de Interacción con el CV: Envía de forma inmediata una notificación push al candidato cuando un reclutador abre, visualiza o descarga su CV
export const notifyCvInteraction: APIGatewayProxyHandler = async (event) => {
  try {
    const candidateId = event.pathParameters?.id;
    if (!candidateId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing candidate id in path parameters" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const rawAction = (body.action || "VIEW").toUpperCase();
    const action = rawAction === "DOWNLOAD" ? "DOWNLOAD" : "VIEW";
    const companyName = body.companyName || body.empresa || "Una organización reclutadora";
    const recruiterName = body.recruiterName || body.reclutador || "";
    const vacancyTitle = body.vacancyTitle || body.puesto || "una vacante activa";

    const recruiterEntity = recruiterName
      ? `${recruiterName} (${companyName})`
      : companyName;

    const isDownload = action === "DOWNLOAD";
    const title = isDownload
      ? "Tu CV ha sido descargado"
      : "Tu CV ha sido visualizado";

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
