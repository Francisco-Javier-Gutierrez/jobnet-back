import webpush from "web-push";
import crypto from "crypto";
import {
  QueryCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../handlers/profile/common";

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  image?: string;
  url?: string;
  tag?: string;
  data?: Record<string, any>;
}

export const DEFAULT_VAPID_PUBLIC_KEY =
  "BOIrktuQCHHiOWcKICA7YEwdKJf8WNYCmBS_PI338wnaB9VqXPQfCRwTN5NLYokujXBp5pdD83av6DACG2rAYok";
export const DEFAULT_VAPID_PRIVATE_KEY =
  "oJXO_P5wuj45JaC8taPC1E3pPR8Hu1zi_kAiv5yAaNg";
export const DEFAULT_VAPID_SUBJECT = "mailto:contacto@franciscojgh.com";

export function configureWebPush() {
  const subject = process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY;

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { subject, publicKey, privateKey };
}

// Auto-configure on load
configureWebPush();

export function hashEndpoint(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

/**
 * Guarda o actualiza una suscripción Push en DynamoDB para un usuario.
 */
export async function savePushSubscription(
  userId: string,
  subscription: PushSubscriptionData,
  userAgent: string = "unknown",
): Promise<void> {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Invalid push subscription format: endpoint and keys are required.");
  }

  const endpointHash = hashEndpoint(subscription.endpoint);
  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `USER#${userId}`,
        SK: `PUSH_SUB#${endpointHash}`,
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
        userAgent,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * Elimina una suscripción Push de DynamoDB.
 */
export async function removePushSubscription(
  userId: string,
  endpoint: string,
): Promise<void> {
  if (!endpoint) return;
  const endpointHash = hashEndpoint(endpoint);

  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: `USER#${userId}`,
        SK: `PUSH_SUB#${endpointHash}`,
      },
    }),
  );
}

/**
 * Envía una notificación Web Push a todas las suscripciones activas del usuario.
 * Si alguna suscripción responde con 410 (Gone) o 404 (Not Found), se elimina automáticamente.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushNotificationPayload,
): Promise<{ sent: number; failed: number; removed: number }> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "PUSH_SUB#",
        },
      }),
    );

    const subscriptions = result.Items || [];
    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0, removed: 0 };
    }

    const jsonPayload = JSON.stringify({
      title: payload.title || "JobNet",
      body: payload.body || "Tienes una nueva notificación",
      icon: payload.icon || "/logotipo.svg",
      badge: payload.badge || "/logotipo.svg",
      image: payload.image || undefined,
      url: payload.url || "/notifications",
      tag: payload.tag || "jobnet-notification",
      data: payload.data || {},
    });

    let sent = 0;
    let failed = 0;
    let removed = 0;

    await Promise.all(
      subscriptions.map(async (sub: any) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.keys?.p256dh,
                auth: sub.keys?.auth,
              },
            },
            jsonPayload,
          );
          sent++;
        } catch (error: any) {
          failed++;
          // Si el endpoint expiró o fue desuscrito por el navegador
          if (error.statusCode === 410 || error.statusCode === 404) {
            try {
              await removePushSubscription(userId, sub.endpoint);
              removed++;
            } catch (cleanupErr) {
              console.error("Error removing expired subscription:", cleanupErr);
            }
          } else {
            console.error(`Failed to send web push to ${userId}:`, error.message || error);
          }
        }
      }),
    );

    return { sent, failed, removed };
  } catch (err) {
    console.error(`Error querying push subscriptions for user ${userId}:`, err);
    return { sent: 0, failed: 0, removed: 0 };
  }
}

export interface CreateNotificationParams {
  userId: string;
  title: string;
  message: string;
  type?: string;
  url?: string;
  extra?: Record<string, any>;
}

/**
 * Guarda una notificación en DynamoDB (para el historial in-app en /notifications)
 * y además despacha automáticamente la notificación Web Push al navegador del usuario.
 */
export async function createUserNotification({
  userId,
  title,
  message,
  type = "system",
  url = "/notifications",
  extra = {},
}: CreateNotificationParams): Promise<string> {
  const timestamp = new Date().toISOString();
  const notifId = Math.random().toString(36).substring(2, 15);
  const truncatedMessage =
    message && message.length > 120
      ? message.substring(0, 117) + "..."
      : message;

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type,
          title,
          message: truncatedMessage,
          createdAt: timestamp,
          read: false,
          ...extra,
        },
      }),
    );
  } catch (dbErr) {
    console.error(`Error saving notification to DynamoDB for ${userId}:`, dbErr);
  }

  try {
    await sendPushToUser(userId, {
      title,
      body: truncatedMessage,
      url,
      icon: extra.icon || "/logotipo.svg",
      badge: extra.badge || "/logotipo.svg",
      image: extra.image || undefined,
      tag: extra.tag || "jobnet-notification",
      data: { type, notifId, ...extra },
    });
  } catch (pushErr) {
    console.error(`Error dispatching web push to ${userId}:`, pushErr);
  }

  return notifId;
}

export interface DeviceInfo {
  endpointHash: string;
  endpoint: string;
  userAgent: string;
  browser: string;
  os: string;
  deviceLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface PushSubscriberUser {
  userId: string;
  nombre: string;
  email: string;
  tipoUsuario: string;
  estadoCuenta: string;
  fotoPerfil: string;
  devices: DeviceInfo[];
  deviceCount: number;
  lastActive: string;
}

export function parseUserAgent(ua: string = ""): { browser: string; os: string; deviceLabel: string } {
  let browser = "Navegador Web";
  let os = "Dispositivo";

  if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/opr|opera/i.test(ua)) {
    browser = "Opera";
  } else if (/chrome|crios/i.test(ua)) {
    browser = "Chrome";
  } else if (/firefox|fxios/i.test(ua)) {
    browser = "Firefox";
  } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
    browser = "Safari";
  }

  if (/windows nt 10/i.test(ua)) {
    os = "Windows 10/11";
  } else if (/windows/i.test(ua)) {
    os = "Windows";
  } else if (/android/i.test(ua)) {
    os = "Android";
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = "iOS";
  } else if (/mac os x/i.test(ua)) {
    os = "macOS";
  } else if (/linux/i.test(ua)) {
    os = "Linux";
  }

  return {
    browser,
    os,
    deviceLabel: `${browser} en ${os}`,
  };
}

/**
 * Consulta todos los usuarios que cuentan con suscripciones Web Push activas.
 */
export async function getAllPushSubscribers(): Promise<PushSubscriberUser[]> {
  try {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":skPrefix": "PUSH_SUB#",
        },
      }),
    );

    const items = scanResult.Items || [];
    if (items.length === 0) return [];

    const userMap = new Map<string, PushSubscriberUser>();

    for (const item of items) {
      const userId = (item.PK || "").replace("USER#", "");
      if (!userId) continue;

      const device: DeviceInfo = {
        endpointHash: (item.SK || "").replace("PUSH_SUB#", ""),
        endpoint: item.endpoint || "",
        userAgent: item.userAgent || "unknown",
        ...parseUserAgent(item.userAgent),
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      };

      if (!userMap.has(userId)) {
        userMap.set(userId, {
          userId,
          nombre: "Usuario JobNet",
          email: "",
          tipoUsuario: "CANDIDATO",
          estadoCuenta: "ACTIVO",
          fotoPerfil: "",
          devices: [device],
          deviceCount: 1,
          lastActive: device.updatedAt,
        });
      } else {
        const u = userMap.get(userId)!;
        u.devices.push(device);
        u.deviceCount = u.devices.length;
        if (new Date(device.updatedAt).getTime() > new Date(u.lastActive).getTime()) {
          u.lastActive = device.updatedAt;
        }
      }
    }

    const userList = Array.from(userMap.values());

    // Obtener los perfiles correspondientes para enriquecer datos de cada usuario
    await Promise.all(
      userList.map(async (u) => {
        try {
          const profRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${u.userId}`,
                SK: "PROFILE",
              },
            }),
          );
          if (profRes.Item) {
            const p = profRes.Item;
            u.nombre = p.nombre || p.name || p.nombreComercial || u.nombre;
            u.email = p.email || "";
            u.tipoUsuario = p.tipoUsuario || p.role || "CANDIDATO";
            u.estadoCuenta = p.estadoCuenta || p.status || "ACTIVO";
            u.fotoPerfil = p.fotoPerfil || p.avatarUrl || "";
          }
        } catch (err) {
          console.warn(`Error al consultar perfil de usuario ${u.userId}:`, err);
        }
      }),
    );

    // Ordenar por última actividad descendente
    userList.sort(
      (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    );

    return userList;
  } catch (error) {
    console.error("Error al obtener suscriptores push:", error);
    return [];
  }
}

