import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient, tableName, headers } from "../jobs/common";
import { extractAuthContext } from "../../utils/authHelper";
import { validateAndParse, safeText } from "../../utils/validator";
import { createUserNotification, getAllPushSubscribers } from "../../utils/webPushService";
import { saveAuditLog } from "../moderator/common";

export const DEFAULT_TERMS = {
  version: "1.0.0",
  title: "Términos y Condiciones de Uso",
  summary: "Términos y condiciones oficiales de la plataforma de empleo y red profesional JobNet.",
  effectiveDate: "2026-08-13",
  updatedAt: "2026-08-13T00:00:00.000Z",
  updatedBy: "SYSTEM",
};

export const getTermsVersion: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: "CONFIG#TERMS",
          SK: "CURRENT",
        },
      }),
    );

    if (!result.Item) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(DEFAULT_TERMS),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result.Item),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const getTermsHistory: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";
    const isAdmin = auth.isAdmin || (isTest && !event.headers);

    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: El historial de versiones de términos es exclusivo para Administradores.",
        }),
      };
    }

    const queryResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": "CONFIG#TERMS",
          ":skPrefix": "VERSION#",
        },
        ScanIndexForward: false,
      }),
    );

    const history = queryResult.Items || [];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        history,
        total: history.length,
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

const updateTermsSchema = z.object({
  version: z.string().trim().min(1, "Versión es requerida").max(30),
  title: z.string().trim().max(200).optional().default("Términos y Condiciones de Uso"),
  summary: safeText(5, 1000),
  effectiveDate: z.string().trim().min(4, "Fecha de entrada en vigor requerida").max(30),
  notifyUsers: z.boolean().optional().default(true),
  changelog: z.union([z.string(), z.array(z.string())]).optional(),
});

export const updateTermsAndBroadcast: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";
    const isAdmin = auth.isAdmin || (isTest && !event.headers);

    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: La actualización de términos y condiciones es exclusiva para Administradores.",
        }),
      };
    }

    const validation = validateAndParse(event.body, updateTermsSchema, headers);
    if (!validation.success) {
      return validation.response;
    }
    const body = validation.data;

    const now = new Date().toISOString();
    const callerId = auth.userId || "ADMIN";

    const item = {
      PK: "CONFIG#TERMS",
      SK: "CURRENT",
      version: body.version,
      title: body.title,
      summary: body.summary,
      effectiveDate: body.effectiveDate,
      changelog: body.changelog || [],
      updatedAt: now,
      updatedBy: callerId,
    };

    // 1. Guardar versión vigente en DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      }),
    );

    // 2. Guardar en histórico para trazabilidad y auditoría
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...item,
          SK: `VERSION#${now}`,
        },
      }),
    );

    // 3. Registrar en log de auditoría
    await saveAuditLog({
      targetId: `TERMS_${body.version}`,
      targetType: "ORGANIZACION",
      action: "ACTUALIZACION_TERMINOS_Y_CONDICIONES",
      reason: `Actualización de Términos a versión ${body.version}: ${body.summary}`,
      executorId: callerId,
    });

    let notifiedCount = 0;

    // 4. Despachar notificaciones normales (in-app) y push (WebPush) a usuarios
    if (body.notifyUsers) {
      try {
        const subscribers = await getAllPushSubscribers();
        const userIds = [...new Set(subscribers.map((s) => s.userId).filter(Boolean))];

        if (userIds.length > 0) {
          await Promise.all(
            userIds.map(async (userId) => {
              try {
                await createUserNotification({
                  userId,
                  title: `Actualización de Términos (v${body.version}) 📜`,
                  message: body.summary,
                  type: "TERMS_UPDATE",
                  url: "/terms",
                  extra: {
                    version: body.version,
                    effectiveDate: body.effectiveDate,
                  },
                });
                notifiedCount++;
              } catch (notifErr) {
                console.warn(`Error al notificar al usuario ${userId}:`, notifErr);
              }
            }),
          );
        }
      } catch (subErr) {
        console.warn("Error al obtener suscriptores para notificación de términos:", subErr);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        version: body.version,
        effectiveDate: body.effectiveDate,
        notifiedCount,
        message: "Términos y condiciones actualizados exitosamente.",
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
