import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { sendPushToUser } from "../../utils/webPushService";

export const isOffline = process.env.IS_OFFLINE === "true";

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

export const sesClient = isOffline
  ? new SESClient({
      endpoint: "http://localhost:4565",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new SESClient({});

export const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

export const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

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

export const broadcastAppealResolved = async (
  companyId: string,
  status: string,
  event: any,
) => {
  const targetKeys: string[] = [`USER#${companyId}`, "ROLE#MODERATOR"];

  try {
    const companyProfile = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
      }),
    );
    const ownerSub =
      companyProfile.Item?.sub || companyProfile.Item?.cognitoSub;
    if (
      ownerSub &&
      ownerSub !== companyId &&
      !targetKeys.includes(`USER#${ownerSub}`)
    ) {
      targetKeys.push(`USER#${ownerSub}`);
    }
  } catch {
    // Non-critical
  }

  const apigwClient = new ApiGatewayManagementApiClient({
    endpoint: getEndpoint(event),
  });

  const payload = JSON.stringify({
    type: "APPEAL_RESOLVED",
    appealCompanyId: companyId,
    status,
  });

  for (const pkKey of targetKeys) {
    const connRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pkKey,
          ":skPrefix": "WS_CONNECTION#",
        },
      }),
    );
    for (const cItem of connRes.Items || []) {
      const cid = cItem.SK.replace("WS_CONNECTION#", "");
      try {
        await apigwClient.send(
          new PostToConnectionCommand({
            ConnectionId: cid,
            Data: Buffer.from(payload),
          }),
        );
      } catch (err: any) {
        if (err.statusCode === 410 || err.name === "GoneException") {
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: pkKey, SK: `WS_CONNECTION#${cid}` },
            }),
          );
        }
      }
    }
  }
};

export const getOrgAppealMessageCount = async (
  companyId: string,
): Promise<number> => {
  if (!companyId) return 0;
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

    const items = result.Items || [];
    const orgMsgs = items.filter((m: any) => m.senderId === companyId);
    return orgMsgs.length;
  } catch (err) {
    console.error(`Error counting appeal messages for ${companyId}:`, err);
    return 0;
  }
};

export interface AuditLogParams {
  targetId: string;
  targetType: "ORGANIZACION" | "VACANTE" | "CANDIDATO";
  action: string;
  reason: string;
  executorId?: string;
}

export async function saveAuditLog(params: AuditLogParams) {
  const auditId = Math.random().toString(36).substring(2, 15);
  const now = new Date();
  const timestamp = now.toISOString();
  const fecha = timestamp.split("T")[0];
  const hora = now.toTimeString().split(" ")[0];

  const auditItem = {
    PK: `AUDIT#${auditId}`,
    SK: "METADATA",
    auditId,
    targetId: params.targetId,
    targetType: params.targetType,
    action: params.action,
    reason: params.reason,
    executorId: params.executorId || "MODERATOR_SYSTEM",
    timestamp,
    fecha,
    hora,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: auditItem,
    }),
  );

  return auditItem;
}

export async function blockCorporateDomain(
  domain: string,
  reason: string,
  companyId?: string,
) {
  if (
    !domain ||
    domain.includes("gmail.com") ||
    domain.includes("outlook.com") ||
    domain.includes("hotmail.com") ||
    domain.includes("yahoo.com")
  ) {
    return; // Do not block public provider email domains
  }

  const cleanDomain = domain.toLowerCase().trim();
  const timestamp = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `BLOCKED_DOMAIN#${cleanDomain}`,
        SK: "METADATA",
        domain: cleanDomain,
        blockedAt: timestamp,
        reason:
          reason ||
          "Suspensión por prácticas fraudulentas o suplantación (RF-74)",
        companyId: companyId || "",
      },
    }),
  );

  // RF-73: Audit log entry
  await saveAuditLog({
    targetId: cleanDomain,
    targetType: "ORGANIZACION",
    action: "BLOQUEO_DOMINIO_CORPORATIVO_RF74",
    reason: `Bloqueo de dominio @${cleanDomain} por suspensión de organización ${companyId || ""}: ${reason}`,
    executorId: "MODERADOR",
  });
}

export async function executeOrgSuspensionInitiation(
  companyId: string,
  reason: string,
  graceDays: number = 4,
) {
  const now = new Date();
  const gracePeriodEnd = new Date(
    now.getTime() + graceDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ttlSeconds =
    Math.floor(now.getTime() / 1000) + graceDays * 24 * 60 * 60;
  const timestamp = now.toISOString();

  // 1. Marcar empresa en estado "En revisión"
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
      UpdateExpression:
        "SET estatus = :st, estadoCuenta = :ec, suspensionReason = :sr, suspensionGracePeriodEnd = :spe, suspensionStatus = :ss, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk",
      ExpressionAttributeValues: {
        ":st": "En revisión",
        ":ec": "REVISION",
        ":sr": reason,
        ":gsiPk": "PROFILE",
        ":gsiSk": "ROLE#EMPRESA#STATUS#REVISION",
        ":spe": gracePeriodEnd,
        ":ss": "IN_REVIEW",
        ":u": timestamp,
      },
    }),
  );

  // 2. Crear registro de periodo de gracia con TTL en DynamoDB STD
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SUSPENSION#${companyId}`,
        SK: "GRACE_PERIOD",
        companyId,
        reason,
        status: "IN_REVIEW",
        createdAt: timestamp,
        gracePeriodEnd,
        ttl: ttlSeconds,
      },
    }),
  );

  // 3. Crear mensaje inicial de Administración en el Chat de Apelación
  const initialMsgId = Math.random().toString(36).substring(2, 15);
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `APPEAL_CHAT#${companyId}`,
        SK: `MSG#${timestamp}#${initialMsgId}`,
        companyId,
        senderId: "ADMIN",
        text: `[NOTIFICACIÓN OFICIAL DE ADMINISTRACIÓN] Se ha iniciado un proceso de revisión de cuenta por la siguiente infracción: "${reason}". Dispone de ${graceDays} días de gracia para presentar su justificación o evidencia.`,
        createdAt: timestamp,
        isSystemNotice: true,
      },
    }),
  );

  // 4. Crear notificación oficial con botón de apelar para la empresa
  const notifId = Math.random().toString(36).substring(2, 15);
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `USER#${companyId}`,
        SK: `NOTIFICATION#${timestamp}#${notifId}`,
        id: notifId,
        type: "SUSPENSION_NOTICE",
        title: "Notificación Oficial de Infracción y Proceso de Suspensión",
        message: `Su cuenta ha entrado en estado de Revisión debido a: ${reason}. Dispone de un periodo de gracia hasta el ${new Date(
          gracePeriodEnd,
        ).toLocaleDateString()} para apelar la decisión a través del chat directo de soporte.`,
        reason,
        gracePeriodEnd,
        createdAt: timestamp,
        read: false,
        actionRequired: true,
        actionType: "APPEAL_SUSPENSION",
        companyId,
      },
    }),
  );

  // Disparar Web Push
  sendPushToUser(companyId, {
    title: "Aviso Oficial de Infracción y Revisión ⚠️",
    body: `Su cuenta ha entrado en estado de Revisión debido a: ${reason}. Dispone de un periodo de gracia para apelar.`,
    url: "/notifications",
    data: { type: "SUSPENSION_NOTICE", companyId },
  }).catch((err) =>
    console.error("Error sending push for suspension process:", err),
  );

  // 5. Enviar correo electrónico oficial por SES
  try {
    const companyProfile = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${companyId}`,
          SK: "PROFILE",
        },
      }),
    );

    const companyEmail = companyProfile.Item?.email;
    const companyName =
      companyProfile.Item?.nombreComercial ||
      companyProfile.Item?.nombre ||
      companyProfile.Item?.razonSocial ||
      "Organización";

    if (companyEmail && companyEmail.includes("@")) {
      await sesClient
        .send(
          new SendEmailCommand({
            Source: "noreply@franciscojgh.com",
            Destination: {
              ToAddresses: [companyEmail],
            },
            Message: {
              Subject: {
                Data: `ALERTA DE SEGURIDAD: Notificación Oficial de Infracción y Proceso de Suspensión (${companyName})`,
              },
              Body: {
                Text: {
                  Data: `Estimado representante de ${companyName},\n\nSu cuenta en la plataforma JobNet ha entrado en estado de Revisión debido a reportes o infracciones detectadas:\n\nMotivo: ${reason}\n\nSe ha iniciado un periodo de gracia hasta el ${new Date(
                    gracePeriodEnd,
                  ).toLocaleDateString()}. Puede ingresar a su panel corporativo y acceder a la sección de Apelaciones para comunicarse en tiempo real por chat con el equipo de moderación.\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                },
              },
            },
          }),
        )
        .catch((err) =>
          console.error("Error sending SES email for org suspension:", err),
        );
    }
  } catch (err) {
    console.error(
      "Error fetching company profile for SES email in initiateSuspension:",
      err,
    );
  }

  // 6. Auditoría
  await saveAuditLog({
    targetId: companyId,
    targetType: "ORGANIZACION",
    action: "INICIO_PROCESO_SUSPENSION",
    reason: `Motivo: ${reason}. Días de gracia: ${graceDays}. Expiración: ${gracePeriodEnd}`,
    executorId: "ADMIN",
  });

  return { gracePeriodEnd, timestamp };
}
