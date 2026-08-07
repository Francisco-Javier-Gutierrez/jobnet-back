import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
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

const isOffline = process.env.IS_OFFLINE === "true";

const dbClient = isOffline
  ? new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new DynamoDBClient({});

const docClient = DynamoDBDocumentClient.from(dbClient);

const sesClient = isOffline
  ? new SESClient({
      endpoint: "http://localhost:4565",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new SESClient({});
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

const getEndpoint = (event: any) => {
  if (isOffline) {
    return "http://localhost:3002";
  }
  const wsApiId = process.env.WS_API_ID || "lzvcx59zaa";
  const stage = event.requestContext?.stage || "prod";
  const domainName = event.requestContext?.domainName;
  if (domainName && domainName.includes(wsApiId)) {
    return `https://${domainName}/${stage}`;
  }
  return `https://${wsApiId}.execute-api.us-east-1.amazonaws.com/${stage}`;
};

const broadcastAppealResolved = async (
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

const getOrgAppealMessageCount = async (companyId: string): Promise<number> => {
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

export const getVerificationRequests: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND estatusVerificacion = :status",
        ExpressionAttributeValues: {
          ":sk": "PROFILE",
          ":status": "En revisión",
        },
      }),
    );

    const requests = (result.Items || []).map((item: any) => ({
      companyId: item.PK.replace("USER#", ""),
      companyName: item.nombre || "Sin Nombre",
      taxId: item.taxId || "",
      email: item.email || "",
      docUrl: item.documentoVerificacion || "",
      estatusVerificacion: item.estatusVerificacion || "",
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(requests),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const resolveVerification: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId = event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'companyId'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { approve } = body;

    if (approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'approve'" }),
      };
    }

    // Fetch existing profile to ensure it exists and get other attributes
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${companyId}`,
          SK: "PROFILE",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Company profile not found" }),
      };
    }

    const updatedItem = {
      ...existing.Item,
      organizacionVerificada: approve,
      estatusVerificacion: approve ? "Verificada" : "Rechazada",
      fechaActualizacion: new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: updatedItem,
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        companyId,
        organizacionVerificada: approve,
        estatusVerificacion: updatedItem.estatusVerificacion,
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

export const getIncidents: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND begins_with(PK, :prefix) AND (estatus = :statusPendiente OR estatus = :statusEvaluacion)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "INCIDENT#",
          ":statusPendiente": "PENDIENTE",
          ":statusEvaluacion": "EVALUACION",
        },
      }),
    );

    const incidents = (result.Items || [])
      .map((item: any) => ({
        id: item.PK.replace("INCIDENT#", ""),
        targetType:
          item.targetType ||
          (item.jobId
            ? "VACANTE"
            : item.postId
              ? "POST"
              : item.companyId
                ? "ORGANIZACION"
                : "GENERAL"),
        targetId:
          item.targetId || item.jobId || item.postId || item.companyId || "",
        targetTitle:
          item.targetTitle ||
          item.jobTitle ||
          item.postTitle ||
          item.companyName ||
          "Contenido sin título",
        jobId: item.jobId || "",
        jobTitle: item.jobTitle || "",
        postId: item.postId || "",
        postTitle: item.postTitle || "",
        companyId: item.companyId || "",
        companyName: item.companyName || "",
        reporter: item.reporter || "Anónimo",
        reason: item.reason || "",
        severity: item.severity || "media",
        infraccion: item.infraccion || "otro",
        estatus: item.estatus || "PENDIENTE",
        fechaCreacion: item.fechaCreacion || "",
      }))
      .sort((a, b) => b.fechaCreacion.localeCompare(a.fechaCreacion));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(incidents),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createIncident: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const {
      jobId,
      jobTitle,
      postId,
      postTitle,
      companyId,
      companyName,
      targetType,
      targetId,
      targetTitle,
      reporter,
      reason,
      severity,
      infraccion,
    } = body;

    if (!reason) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'reason'" }),
      };
    }

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const incidentItem = {
      PK: `INCIDENT#${uuid}`,
      SK: "METADATA",
      targetType:
        targetType ||
        (jobId
          ? "VACANTE"
          : postId
            ? "POST"
            : companyId
              ? "ORGANIZACION"
              : "GENERAL"),
      targetId: targetId || jobId || postId || companyId || "",
      targetTitle: targetTitle || jobTitle || postTitle || companyName || "",
      jobId: jobId || (targetType === "VACANTE" ? targetId : ""),
      jobTitle: jobTitle || (targetType === "VACANTE" ? targetTitle : ""),
      postId: postId || (targetType === "POST" ? targetId : ""),
      companyId:
        companyId ||
        (targetType === "ORGANIZACION" || targetType === "EMPRESA"
          ? targetId
          : ""),
      companyName:
        companyName ||
        (targetType === "ORGANIZACION" || targetType === "EMPRESA"
          ? targetTitle
          : ""),
      reporter: reporter || "Anónimo",
      reason,
      severity: severity || "media",
      infraccion: infraccion || "otro",
      estatus: "PENDIENTE",
      fechaCreacion: createdAt,
    };

    // Remove empty attributes
    const cleanItem = Object.fromEntries(
      Object.entries(incidentItem).filter(([, v]) => v !== ""),
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: cleanItem,
      }),
    );

    // RF-72: Flag de Suspensión por Denuncias
    // Si una vacante acumula 5 o más reportes independientes en menos de 12 horas,
    // se activa automáticamente la bandera de "Revisión Obligatoria" y estado "EVALUACION".
    let autoSuspended = false;
    let incidentCount = 1;

    if (jobId) {
      const twelveHoursAgo = new Date(
        Date.now() - 12 * 60 * 60 * 1000,
      ).toISOString();

      const existingReportsResult = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression:
            "SK = :sk AND begins_with(PK, :prefix) AND jobId = :jobId AND fechaCreacion >= :twelveHoursAgo",
          ExpressionAttributeValues: {
            ":sk": "METADATA",
            ":prefix": "INCIDENT#",
            ":jobId": jobId,
            ":twelveHoursAgo": twelveHoursAgo,
          },
        }),
      );

      incidentCount = (existingReportsResult.Items || []).length;

      if (incidentCount >= 5) {
        autoSuspended = true;
        const graceLimit = new Date();
        graceLimit.setDate(graceLimit.getDate() + 15);

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :evalState, banderaRevisionObligatoria = :flag, fechaLimiteApelacion = :grace, motivoSuspensionAutomatica = :reason",
            ExpressionAttributeValues: {
              ":evalState": "EVALUACION",
              ":flag": true,
              ":grace": graceLimit.toISOString(),
              ":reason":
                "Suspensión automática por acumulación de 5 o más denuncias en menos de 12 horas (RF-72)",
            },
          }),
        );

        // RF-73: Registra auditoría automática
        await saveAuditLog({
          targetId: jobId,
          targetType: "VACANTE",
          action: "SUSPENSION_AUTOMATICA_RF72",
          reason:
            "Acumulación de 5 o más denuncias en menos de 12 horas (RF-72)",
          executorId: "SISTEMA_AUTOGUARDIA",
        });
      }
    }

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: uuid,
        autoSuspended,
        incidentCount,
        ...cleanItem,
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

export const resolveIncident: APIGatewayProxyHandler = async (event) => {
  try {
    const incidentId = event.pathParameters?.incidentId;
    if (!incidentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'incidentId'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { action } = body;

    if (!action || !["approve", "block", "evaluate"].includes(action)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "Invalid or missing body parameter 'action'. Must be 'approve', 'block' or 'evaluate'",
        }),
      };
    }

    // Fetch existing incident
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      // Fallback: Si no existe la incidencia, puede que se haya llamado desde la pantalla de Apelaciones
      // pasando directamente el ID de la vacante. Verificamos si existe la vacante.
      const vacancyRes = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${incidentId}`,
            SK: "METADATA",
          },
        }),
      );

      if (vacancyRes.Item) {
        // Creamos una incidencia "ficticia" o de sistema vinculada a esta vacante para que el flujo pueda continuar
        existing.Item = {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
          jobId: incidentId,
          jobTitle: vacancyRes.Item.titulo || "Vacante Sancionada",
          estatus: "EVALUACION",
          companyId: vacancyRes.Item.empresaUuid || vacancyRes.Item.companyId,
          targetType: "VACANTE",
          targetId: incidentId,
          reason: "Resolución/Apelación directa iniciada por moderador",
          fechaCreacion: new Date().toISOString(),
        };

        // Guardamos esta incidencia para que el UpdateCommand posterior no deje un registro huérfano y malformado
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: existing.Item,
          }),
        );
      } else {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Incident not found" }),
        };
      }
    }

    const incident = existing.Item;

    // Retrieve target company ID
    let targetCompanyId = incident.companyId;
    if (!targetCompanyId && incident.jobId) {
      const vacancyRes = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${incident.jobId}`,
            SK: "METADATA",
          },
        }),
      );
      if (vacancyRes.Item) {
        targetCompanyId =
          vacancyRes.Item.empresaUuid || vacancyRes.Item.companyId;
      }
    }

    // Require at least 3 messages from the organization if resolving an evaluated incident/appeal
    if (
      (existing.Item.estatus === "EVALUACION" ||
        action === "approve" ||
        action === "block") &&
      incident.jobId
    ) {
      if (targetCompanyId) {
        const orgMsgCount = await getOrgAppealMessageCount(targetCompanyId);
        if (orgMsgCount < 3) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: `Se requieren al menos 3 mensajes de evidencia o justificación por parte de la organización en el chat de apelación para emitir dictamen final. (Mensajes actuales de la empresa: ${orgMsgCount}/3)`,
            }),
          };
        }
      }
    }

    // Update incident status
    const newStatus =
      action === "block"
        ? "BLOQUEADO"
        : action === "evaluate"
          ? "EVALUACION"
          : "RESUELTO";
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
        UpdateExpression:
          "SET estatus = :status, fechaActualizacion = :updated",
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":updated": new Date().toISOString(),
        },
      }),
    );

    if (incident.jobId) {
      if (action === "block") {
        // RF-24 Fase 2 — Ejecución del Borrado Lógico de la vacante fraudulenta
        const timestamp = new Date().toISOString();

        await docClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: `VACANCY_SUSPENSION#${incident.jobId}`, SK: "GRACE_PERIOD" },
          }),
        );

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :deletedState, suspendida = :s, isDeleted = :del, oculta = :o, deletedAt = :deleted",
            ExpressionAttributeValues: {
              ":deletedState": "Eliminada",
              ":s": true,
              ":del": true,
              ":o": true,
              ":deleted": timestamp,
            },
          }),
        );

        // RF-24 Fase 1 — Notificación de Resolución Desfavorable
        if (targetCompanyId) {
          const notifId = Math.random().toString(36).substring(2, 15);
          await docClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `USER#${targetCompanyId}`,
                SK: `NOTIFICATION#${timestamp}#${notifId}`,
                id: notifId,
                type: "SUSPENSION_CONFIRMED",
                title: "Resolución Desfavorable: Vacante Eliminada",
                message: `Tras la evaluación de la apelación, la resolución ha sido en su contra y la vacante ha sido eliminada definitivamente del Job Board por infracción de normas.`,
                createdAt: timestamp,
                read: false,
              },
            }),
          );
        }

        // RF-74: Extraer correo de la empresa y bloquear dominio corporativo si aplica
        try {
          const vacancyRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: `VACANCY#${incident.jobId}`,
                SK: "METADATA",
              },
            }),
          );

          if (vacancyRes.Item && vacancyRes.Item.empresaUuid) {
            const compProfileRes = await docClient.send(
              new GetCommand({
                TableName: tableName,
                Key: {
                  PK: `USER#${vacancyRes.Item.empresaUuid}`,
                  SK: "PROFILE",
                },
              }),
            );

            if (
              compProfileRes.Item &&
              compProfileRes.Item.email &&
              compProfileRes.Item.email.includes("@")
            ) {
              const companyEmail = compProfileRes.Item.email;

              // Send SES Email for Blocked Vacancy
              await sesClient
                .send(
                  new SendEmailCommand({
                    Source: "noreply@franciscojgh.com",
                    Destination: {
                      ToAddresses: [companyEmail],
                    },
                    Message: {
                      Subject: {
                        Data: `Resolución Desfavorable: Vacante Eliminada`,
                      },
                      Body: {
                        Text: {
                          Data: `Estimado reclutador,\n\nTras la evaluación de la apelación de su vacante "${incident.jobTitle || 'Sancionada'}", la resolución ha sido en su contra y la vacante ha sido eliminada definitivamente del Job Board por infracción de nuestras normas.\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                        },
                      },
                    },
                  }),
                )
                .catch((err) =>
                  console.error("Error sending SES block email:", err),
                );

              const compDomain = companyEmail.split("@")[1];
              await blockCorporateDomain(
                compDomain,
                incident.reason || "Suspensión por vacante fraudulenta",
                vacancyRes.Item.empresaUuid,
              );
            }
          }
        } catch (e) {
          console.error(
            "Error auto-blocking corporate domain on incident resolve:",
            e,
          );
        }

        // Close the appeal chat for the organization
        if (targetCompanyId) {
          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: `USER#${targetCompanyId}`, SK: "PROFILE" },
              UpdateExpression: "SET apelacionIniciada = :ai",
              ExpressionAttributeValues: { ":ai": false },
            }),
          );
        }
      } else if (action === "evaluate") {
        // RF-23 Fase 1 — Pausar vacante para evaluación y notificar oficialmente
        const graceLimit = new Date();
        graceLimit.setDate(graceLimit.getDate() + 15);
        const timestamp = new Date().toISOString();
        const ttlSeconds = Math.floor(graceLimit.getTime() / 1000);

        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `VACANCY_SUSPENSION#${incident.jobId}`,
              SK: "GRACE_PERIOD",
              jobId: incident.jobId,
              status: "EVALUACION",
              ttl: ttlSeconds,
            },
          }),
        );

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :evaluation, fechaLimiteApelacion = :grace",
            ExpressionAttributeValues: {
              ":evaluation": "EVALUACION",
              ":grace": graceLimit.toISOString(),
            },
          }),
        );

        // Fetch company profile to retrieve email and push in-app notification
        const vacancy = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
          }),
        );

        if (vacancy.Item && vacancy.Item.empresaUuid) {
          const companyProfile = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${vacancy.Item.empresaUuid}`,
                SK: "PROFILE",
              },
            }),
          );

          const companyEmail =
            companyProfile.Item?.email || "empresa@jobnet.com";
          const jobTitle = vacancy.Item.titulo || "Vacante";

          // RF-23 Fase 1: Notificación in-app persistente
          const notifId = Math.random().toString(36).substring(2, 15);
          await docClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `USER#${vacancy.Item.empresaUuid}`,
                SK: `NOTIFICATION#${timestamp}#${notifId}`,
                id: notifId,
                type: "SUSPENSION_NOTICE",
                title: "Notificación Oficial: Vacante Pausada para Evaluación",
                message: `Su publicación de empleo "${jobTitle}" ha sido pausada preventivamente por denuncias de infracción. Dispone de un periodo de gracia hasta el ${graceLimit.toLocaleDateString()} para presentar su apelación a través del soporte.`,
                reason:
                  incident.reason ||
                  "Evaluación preventiva por reportes acumulados",
                gracePeriodEnd: graceLimit.toISOString(),
                createdAt: timestamp,
                read: false,
                actionRequired: true,
                actionType: "APPEAL_SUSPENSION",
                companyId: vacancy.Item.empresaUuid,
              },
            }),
          );

          // Send warning email via SES
          await sesClient
            .send(
              new SendEmailCommand({
                Source: "noreply@franciscojgh.com",
                Destination: {
                  ToAddresses: [companyEmail],
                },
                Message: {
                  Subject: {
                    Data: `ALERTA: Vacante "${jobTitle}" Pausada para Evaluación`,
                  },
                  Body: {
                    Text: {
                      Data: `Estimado reclutador,\n\nTu publicación de empleo "${jobTitle}" ha sido pausada temporalmente por moderadores de JobNet debido a reportes de sospecha de infracción:\n\nMotivo del reporte: ${incident.reason}\n\nSe ha iniciado un periodo de gracia de 15 días. Tienes hasta el ${graceLimit.toLocaleDateString()} para apelar esta sanción ingresando a la sección "Mis Vacantes" en tu panel de reclutador y seleccionando la opción "Apelar".\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                    },
                  },
                },
              }),
            )
            .catch((err) =>
              console.error(
                "Error sending SES email for vacancy evaluation:",
                err,
              ),
            );
        }
      } else if (action === "approve") {
        // Fase 3 — Reactivar vacante (apelación favorable)
        await docClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: `VACANCY_SUSPENSION#${incident.jobId}`, SK: "GRACE_PERIOD" },
          }),
        );

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :active, fechaLimiteApelacion = :nullVal",
            ExpressionAttributeValues: {
              ":active": "Activa",
              ":nullVal": null,
            },
          }),
        );

        // RF-24 Fase 1 — Notificación de Resolución Favorable (Approve)
        if (targetCompanyId) {
          const timestamp = new Date().toISOString();
          const notifId = Math.random().toString(36).substring(2, 15);
          await docClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `USER#${targetCompanyId}`,
                SK: `NOTIFICATION#${timestamp}#${notifId}`,
                id: notifId,
                type: "SUSPENSION_CANCELED",
                title: "Resolución Favorable: Vacante Reactivada",
                message: `La evaluación de su apelación ha concluido de manera favorable. Su vacante ha sido reactivada y ya se encuentra visible nuevamente en el Job Board.`,
                createdAt: timestamp,
                read: false,
              },
            }),
          );

          try {
            const compProfileRes = await docClient.send(
              new GetCommand({
                TableName: tableName,
                Key: { PK: `USER#${targetCompanyId}`, SK: "PROFILE" },
              }),
            );

            if (
              compProfileRes.Item &&
              compProfileRes.Item.email &&
              compProfileRes.Item.email.includes("@")
            ) {
              const companyEmail = compProfileRes.Item.email;

              // Send SES Email for Approved Vacancy
              await sesClient
                .send(
                  new SendEmailCommand({
                    Source: "noreply@franciscojgh.com",
                    Destination: {
                      ToAddresses: [companyEmail],
                    },
                    Message: {
                      Subject: {
                        Data: `Resolución Favorable: Vacante Reactivada`,
                      },
                      Body: {
                        Text: {
                          Data: `Estimado reclutador,\n\nNos complace informarle que la evaluación de su apelación referente a la vacante "${incident.jobTitle || 'Pausada'}" ha concluido de manera favorable.\n\nSu vacante ha sido reactivada y ya se encuentra visible nuevamente en el Job Board.\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                        },
                      },
                    },
                  }),
                )
                .catch((err) =>
                  console.error("Error sending SES approve email:", err),
                );
            }
          } catch (e) {
            console.error("Error sending approve email:", e);
          }
        }

        // Close the appeal chat for the organization
        if (targetCompanyId) {
          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: `USER#${targetCompanyId}`, SK: "PROFILE" },
              UpdateExpression: "SET apelacionIniciada = :ai",
              ExpressionAttributeValues: { ":ai": false },
            }),
          );
        }
      }
    } else if (targetCompanyId) {
      // Organization Incident Handling (RF-26)
      if (action === "evaluate") {
        await executeOrgSuspensionInitiation(
          targetCompanyId,
          incident.reason ||
            "Revisión por reportes e incidencias de organización",
          4,
        );
      } else if (action === "block") {
        const timestamp = new Date().toISOString();
        await docClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: `SUSPENSION#${targetCompanyId}`, SK: "GRACE_PERIOD" },
          }),
        );

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `USER#${targetCompanyId}`, SK: "PROFILE" },
            UpdateExpression:
              "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, suspensionReason = :sr, updatedAt = :u",
            ExpressionAttributeValues: {
              ":st": "Suspendida",
              ":ec": "SUSPENDIDA",
              ":b": true,
              ":ss": "SUSPENDED",
              ":sr": incident.reason || "Dictamen desfavorable",
              ":u": timestamp,
            },
          }),
        );

        const notifId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCompanyId}`,
              SK: `NOTIFICATION#${timestamp}#${notifId}`,
              id: notifId,
              type: "SUSPENSION_CONFIRMED",
              title: "Resolución Final: Cuenta Suspendida",
              message: `Su cuenta de organización ha sido suspendida definitivamente debido a infracciones.`,
              createdAt: timestamp,
              read: false,
            },
          }),
        );
      } else if (action === "approve") {
        const timestamp = new Date().toISOString();
        await docClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: `SUSPENSION#${targetCompanyId}`, SK: "GRACE_PERIOD" },
          }),
        );

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `USER#${targetCompanyId}`, SK: "PROFILE" },
            UpdateExpression:
              "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, updatedAt = :u REMOVE suspensionReason, suspensionGracePeriodEnd",
            ExpressionAttributeValues: {
              ":st": "Activa",
              ":ec": "ACTIVO",
              ":b": false,
              ":ss": "CANCELLED",
              ":u": timestamp,
            },
          }),
        );

        const notifId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCompanyId}`,
              SK: `NOTIFICATION#${timestamp}#${notifId}`,
              id: notifId,
              type: "SUSPENSION_CANCELLED",
              title: "Apelación Favorable: Suspensión Revocada",
              message: `El reporte en contra de su organización ha sido desestimado y su cuenta se encuentra activa.`,
              createdAt: timestamp,
              read: false,
            },
          }),
        );
      }
    } else if (incident.postId) {
      if (action === "block") {
        const postItemsResult = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: {
              ":pk": `POST#${incident.postId}`,
            },
          }),
        );

        const items = postItemsResult.Items || [];

        for (const item of items) {
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: item.PK,
                SK: item.SK,
              },
            }),
          );
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        incidentId,
        estatus: newStatus,
        action,
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

function getLevenshteinDistance(a: string, b: string): number {
  const tmp = [];
  let i, j;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] +
          (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return tmp[a.length][b.length];
}

export const getSuggestedSkills: APIGatewayProxyHandler = async (event) => {
  try {
    const categoryFilter = event.queryStringParameters?.category;

    // 1. Scan all pending suggestions
    const suggestionsResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND (begins_with(PK, :skillPrefix) OR begins_with(PK, :sectorPrefix))",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":skillPrefix": "SUGGESTION#SKILL#",
          ":sectorPrefix": "SUGGESTION#SECTOR#",
        },
      }),
    );

    // 2. Scan all master catalog items to pre-calculate similarity matches
    const catalogResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: {
          ":sk": "CATALOG",
        },
      }),
    );
    const catalogItems = catalogResult.Items || [];

    let suggestions = (suggestionsResult.Items || []).map((item: any) => {
      const isSector =
        item.PK.startsWith("SUGGESTION#SECTOR#") || item.category === "Sector";
      const itemCategory: "Habilidad" | "Sector" = isSector
        ? "Sector"
        : "Habilidad";
      const id = item.PK.replace("SUGGESTION#SKILL#", "").replace(
        "SUGGESTION#SECTOR#",
        "",
      );
      const name = item.name || "";

      // Find similarity matches in the same category
      const sameCatCatalog = catalogItems.filter(
        (cat: any) => cat.category === itemCategory,
      );
      const duplicateMatch = sameCatCatalog.find((cat: any) => {
        if (cat.name.toLowerCase() === name.toLowerCase()) return true;
        const dist = getLevenshteinDistance(cat.name, name);
        return dist <= 2;
      });

      return {
        id,
        name,
        category: itemCategory,
        createdAt: item.fechaCreacion || item.createdAt || "",
        hasDuplicate: !!duplicateMatch,
        existingName: duplicateMatch ? duplicateMatch.name : null,
      };
    });

    if (categoryFilter) {
      suggestions = suggestions.filter(
        (s) => s.category.toLowerCase() === categoryFilter.toLowerCase(),
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(suggestions),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { name, category } = body;

    if (!name) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'name'" }),
      };
    }

    const isSector =
      category === "Sector" || (event.path && event.path.includes("/sectors/"));
    const cat = isSector ? "Sector" : "Habilidad";
    const pkPrefix = isSector ? "SUGGESTION#SECTOR#" : "SUGGESTION#SKILL#";

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const suggestionItem = {
      PK: `${pkPrefix}${uuid}`,
      SK: "METADATA",
      name: name.trim(),
      category: cat,
      fechaCreacion: createdAt,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: suggestionItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: uuid,
        ...suggestionItem,
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

export const resolveSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const suggestionId = event.pathParameters?.id;
    if (!suggestionId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { approve, unifyWith, unifyMode, addAnyway } = body;

    if (approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'approve'" }),
      };
    }

    // Fetch existing suggestion (try skill first, then sector)
    let existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `SUGGESTION#SKILL#${suggestionId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      existing = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `SUGGESTION#SECTOR#${suggestionId}`,
            SK: "METADATA",
          },
        }),
      );
    }

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Suggestion not found" }),
      };
    }

    const suggestion = existing.Item;
    const itemName = suggestion.name;
    const itemCategory: "Habilidad" | "Sector" =
      suggestion.category ||
      (suggestion.PK.includes("#SECTOR#") ? "Sector" : "Habilidad");

    if (approve) {
      // Unification mode: REPLACE_EXISTING (replace existing master catalog name with suggested name)
      if (unifyMode === "REPLACE_EXISTING" && unifyWith) {
        // Find existing catalog item with unifyWith name
        const findCatalog = await docClient.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: "SK = :sk AND category = :cat AND valName = :v",
            ExpressionAttributeValues: {
              ":sk": "CATALOG",
              ":cat": itemCategory,
              ":v": unifyWith.toLowerCase(),
            },
          }),
        );

        if (findCatalog.Items && findCatalog.Items.length > 0) {
          const targetCatalogItem = findCatalog.Items[0];
          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: targetCatalogItem.PK, SK: "CATALOG" },
              UpdateExpression:
                "SET #n = :newName, valName = :valName, updatedAt = :u",
              ExpressionAttributeNames: { "#n": "name" },
              ExpressionAttributeValues: {
                ":newName": itemName,
                ":valName": itemName.toLowerCase(),
                ":u": new Date().toISOString(),
              },
            }),
          );
        }
      } else if (unifyMode === "KEEP_EXISTING") {
        // Simply keep existing catalog item without adding new
      } else if (addAnyway || !unifyWith) {
        // Add as a brand new independent master catalog item
        const uuid = Math.random().toString(36).substring(2, 15);
        const finalName = unifyWith || itemName;

        const exactCheck = await docClient.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression:
              "SK = :sk AND valName = :valName AND category = :cat",
            ExpressionAttributeValues: {
              ":sk": "CATALOG",
              ":valName": finalName.toLowerCase(),
              ":cat": itemCategory,
            },
          }),
        );

        if (!exactCheck.Items || exactCheck.Items.length === 0) {
          await docClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `CATALOG#${uuid}`,
                SK: "CATALOG",
                name: finalName,
                valName: finalName.toLowerCase(),
                category: itemCategory,
                createdAt: new Date().toISOString(),
              },
            }),
          );
        }
      }
    }

    // Delete suggestion from DynamoDB
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: suggestion.PK,
          SK: "METADATA",
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        action: approve ? "APPROVED" : "REJECTED",
        unifyMode: unifyMode || null,
        category: itemCategory,
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

export const getAuditLogs: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND begins_with(PK, :prefix)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "AUDIT#",
        },
      }),
    );

    const logs = (result.Items || [])
      .map((item: any) => ({
        id: item.auditId || item.PK.replace("AUDIT#", ""),
        targetId: item.targetId || "",
        targetType: item.targetType || "VACANTE",
        action: item.action || "",
        reason: item.reason || "",
        executorId: item.executorId || "SISTEMA",
        timestamp: item.timestamp || "",
        fecha: item.fecha || "",
        hora: item.hora || "",
      }))
      .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(logs),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

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
    reason: `Dominio @${cleanDomain} bloqueado: ${reason}`,
    executorId: "MODERADOR",
  });
}

export const getBlockedDomains: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND begins_with(PK, :prefix)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "BLOCKED_DOMAIN#",
        },
      }),
    );

    const domains = (result.Items || []).map((item: any) => ({
      domain: item.domain || item.PK.replace("BLOCKED_DOMAIN#", ""),
      blockedAt: item.blockedAt || "",
      reason: item.reason || "",
      companyId: item.companyId || "",
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(domains),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Fase 1 — Inicio del proceso de suspensión de cuenta
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
        "SET estatus = :st, estadoCuenta = :ec, suspensionReason = :sr, suspensionGracePeriodEnd = :spe, suspensionStatus = :ss, updatedAt = :u",
      ExpressionAttributeValues: {
        ":st": "En revisión",
        ":ec": "REVISION",
        ":sr": reason,
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

// Fase 1 — Inicio del proceso de suspensión de cuenta
export const initiateSuspension: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId =
      event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const reason =
      body.reason || "Infracción de términos de servicio y conducta";
    const graceDays = typeof body.graceDays === "number" ? body.graceDays : 4;

    const res = await executeOrgSuspensionInitiation(
      companyId,
      reason,
      graceDays,
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Proceso de suspensión iniciado exitosamente",
        companyId,
        status: "En revisión",
        gracePeriodEnd: res.gracePeriodEnd,
        reason,
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

// Fase 3a — Dictamen favorable / Revocación de suspensión
export const cancelSuspension: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId =
      event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const notes = body.notes || "Apelación aprobada. Suspensión revocada.";
    const timestamp = new Date().toISOString();

    // Validar regla de al menos 3 mensajes por parte de la organización en el chat
    const orgMsgCount = await getOrgAppealMessageCount(companyId);
    if (orgMsgCount < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Se requieren al menos 3 mensajes de evidencia o justificación por parte de la organización en el chat de apelación para emitir dictamen final. (Mensajes actuales de la empresa: ${orgMsgCount}/3)`,
        }),
      };
    }

    // 1. Eliminar registro de periodo de gracia TTL
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { PK: `SUSPENSION#${companyId}`, SK: "GRACE_PERIOD" },
      }),
    );

    // 2. Restablecer estado de la empresa a "Activa"
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        UpdateExpression:
          "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, updatedAt = :u REMOVE suspensionReason, suspensionGracePeriodEnd",
        ExpressionAttributeValues: {
          ":st": "Activa",
          ":ec": "ACTIVO",
          ":b": false,
          ":ss": "CANCELLED",
          ":u": timestamp,
        },
      }),
    );

    // 3. Notificación de apelación favorable
    const notifId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${companyId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type: "SUSPENSION_CANCELLED",
          title: "Apelación Favorable: Suspensión Revocada",
          message: `El proceso de suspensión ha sido revocado y su cuenta se encuentra nuevamente Activa. Dictamen: ${notes}`,
          createdAt: timestamp,
          read: false,
        },
      }),
    );

    // 4. Auditoría
    await saveAuditLog({
      targetId: companyId,
      targetType: "ORGANIZACION",
      action: "REVOCACION_SUSPENSION_RF7",
      reason: `Suspensión revocada / Apelación aprobada: ${notes}`,
      executorId: "MODERADOR",
    });

    // 5. Broadcast WS de resolución
    await broadcastAppealResolved(companyId, "CANCELLED", event);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Suspensión cancelada y cuenta restablecida a Activa",
        companyId,
        status: "Activa",
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

// Fase 3b — Dictamen desfavorable / Suspensión definitiva
export const confirmSuspension: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId =
      event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const reason =
      body.reason ||
      "Dictamen desfavorable tras proceso de evaluación/apelación";
    const timestamp = new Date().toISOString();

    // Validar regla de al menos 3 mensajes por parte de la organización en el chat
    const orgMsgCount = await getOrgAppealMessageCount(companyId);
    if (orgMsgCount < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Se requieren al menos 3 mensajes de evidencia o justificación por parte de la organización en el chat de apelación para emitir dictamen final. (Mensajes actuales de la empresa: ${orgMsgCount}/3)`,
        }),
      };
    }

    // 1. Eliminar registro de periodo de gracia TTL
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { PK: `SUSPENSION#${companyId}`, SK: "GRACE_PERIOD" },
      }),
    );

    // 2. Cambiar estado a "Suspendida" y bloquear la cuenta
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        UpdateExpression:
          "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, suspensionReason = :sr, updatedAt = :u",
        ExpressionAttributeValues: {
          ":st": "Suspendida",
          ":ec": "SUSPENDIDA",
          ":b": true,
          ":ss": "SUSPENDED",
          ":sr": reason,
          ":u": timestamp,
        },
      }),
    );

    // 3. Ocultar vacantes del Job Board
    const jobsResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND companyId = :cid",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":cid": companyId,
        },
      }),
    );

    for (const item of jobsResult.Items || []) {
      if (item.PK.startsWith("JOB#")) {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: item.PK, SK: "METADATA" },
            UpdateExpression:
              "SET estatus = :st, suspendida = :s, updatedAt = :u",
            ExpressionAttributeValues: {
              ":st": "Oculta",
              ":s": true,
              ":u": timestamp,
            },
          }),
        );
      }
    }

    // 4. Notificación de suspensión definitiva
    const notifId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${companyId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type: "SUSPENSION_CONFIRMED",
          title: "Resolución Final: Cuenta Suspendida",
          message: `Su cuenta ha sido suspendida definitivamente. El inicio de sesión ha sido bloqueado y sus vacantes han sido ocultadas del Job Board. Motivo: ${reason}`,
          createdAt: timestamp,
          read: false,
        },
      }),
    );

    // 5. Auditoría
    await saveAuditLog({
      targetId: companyId,
      targetType: "ORGANIZACION",
      action: "SUSPENSION_DEFINITIVA_RF7",
      reason: `Suspensión ejecutada definitivamente: ${reason}`,
      executorId: "MODERADOR",
    });

    // 6. Broadcast WS de resolución
    await broadcastAppealResolved(companyId, "SUSPENDED", event);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Empresa suspendida definitivamente y vacantes ocultadas",
        companyId,
        status: "Suspendida",
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

// Consulta de estado de suspensión
export const getSuspensionStatus: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId =
      event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const profileRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
      }),
    );

    const graceRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `SUSPENSION#${companyId}`, SK: "GRACE_PERIOD" },
      }),
    );

    const profile = profileRes.Item || {};
    const graceItem = graceRes.Item;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        companyId,
        estatus: profile.estatus || "Activa",
        bloqueada: Boolean(profile.bloqueada),
        inGracePeriod: Boolean(graceItem),
        gracePeriodEnd:
          graceItem?.gracePeriodEnd || profile.suspensionGracePeriodEnd || null,
        reason: graceItem?.reason || profile.suspensionReason || null,
        createdAt: graceItem?.createdAt || profile.updatedAt || null,
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

// Trigger de expiración TTL (DynamoDB Streams)
export const handleSuspensionExpiry = async (event: any) => {
  console.log(
    "Processing DynamoDB Stream TTL Event for Suspension:",
    JSON.stringify(event),
  );

  for (const record of event.Records || []) {
    if (record.eventName === "REMOVE") {
      const oldImage = record.dynamodb?.OldImage;
      if (!oldImage) continue;

      const pk = oldImage.PK?.S || "";
      const sk = oldImage.SK?.S || "";

      if (pk.startsWith("SUSPENSION#") && sk === "GRACE_PERIOD") {
        const companyId =
          oldImage.companyId?.S || pk.replace("SUSPENSION#", "");
        const status = oldImage.status?.S;

        if (status === "IN_REVIEW") {
          console.log(
            `TTL Expired for company ${companyId}. Executing automatic suspension.`,
          );
          const timestamp = new Date().toISOString();

          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
              UpdateExpression:
                "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, updatedAt = :u",
              ExpressionAttributeValues: {
                ":st": "Suspendida",
                ":ec": "SUSPENDIDA",
                ":b": true,
                ":ss": "SUSPENDED_BY_TTL",
                ":u": timestamp,
              },
            }),
          );

          const jobsResult = await docClient.send(
            new ScanCommand({
              TableName: tableName,
              FilterExpression: "SK = :sk AND companyId = :cid",
              ExpressionAttributeValues: {
                ":sk": "METADATA",
                ":cid": companyId,
              },
            }),
          );

          for (const item of jobsResult.Items || []) {
            if (item.PK.startsWith("JOB#")) {
              await docClient.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: item.PK, SK: "METADATA" },
                  UpdateExpression:
                    "SET estatus = :st, suspendida = :s, updatedAt = :u",
                  ExpressionAttributeValues: {
                    ":st": "Oculta",
                    ":s": true,
                    ":u": timestamp,
                  },
                }),
              );
            }
          }

          await saveAuditLog({
            targetId: companyId,
            targetType: "ORGANIZACION",
            action: "SUSPENSION_AUTOMATICA_TTL_EXPIRADO",
            reason:
              "Periodo de gracia concluyó sin resolución/apelación favorable. Cuenta suspendida automáticamente.",
            executorId: "SISTEMA_DYNAMODB_TTL",
          });
        }
      } else if (pk.startsWith("VACANCY_SUSPENSION#") && sk === "GRACE_PERIOD") {
        const jobId = oldImage.jobId?.S;
        const status = oldImage.status?.S;

        if (status === "EVALUACION" && jobId) {
          console.log(
            `TTL Expired for vacancy ${jobId}. Executing automatic deletion (RF-23).`,
          );
          const timestamp = new Date().toISOString();

          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: `VACANCY#${jobId}`, SK: "METADATA" },
              UpdateExpression:
                "SET estado = :deletedState, suspendida = :s, isDeleted = :del, oculta = :o, deletedAt = :deleted",
              ExpressionAttributeValues: {
                ":deletedState": "Eliminada",
                ":s": true,
                ":del": true,
                ":o": true,
                ":deleted": timestamp,
              },
            }),
          );

          const vacRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: `VACANCY#${jobId}`, SK: "METADATA" },
            }),
          );

          if (vacRes.Item && vacRes.Item.empresaUuid) {
            const targetCompanyId = vacRes.Item.empresaUuid;
            const notifId = Math.random().toString(36).substring(2, 15);
            await docClient.send(
              new PutCommand({
                TableName: tableName,
                Item: {
                  PK: `USER#${targetCompanyId}`,
                  SK: `NOTIFICATION#${timestamp}#${notifId}`,
                  id: notifId,
                  type: "SUSPENSION_CONFIRMED",
                  title: "Resolución Desfavorable: Vacante Eliminada por Expiración",
                  message: `El periodo de apelación para su vacante ha expirado sin resolución favorable. La vacante ha sido eliminada definitivamente del Job Board por infracción de normas.`,
                  createdAt: timestamp,
                  read: false,
                },
              }),
            );
          }

          await saveAuditLog({
            targetId: jobId,
            targetType: "VACANTE",
            action: "ELIMINACION_AUTOMATICA_TTL_EXPIRADO",
            reason:
              "Periodo de gracia concluyó sin apelación favorable. Vacante eliminada automáticamente.",
            executorId: "SISTEMA_DYNAMODB_TTL",
          });
        }
      }
    }
  }
};

// Empresa se une al chat de apelación
export const joinAppeal: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId =
      event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId es requerido" }),
      };
    }

    const timestamp = new Date().toISOString();

    // Actualizar perfil indicando que la empresa inició/accedió a la apelación si no estaba marcado
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        UpdateExpression: "SET apelacionIniciada = :ai, updatedAt = :u",
        ExpressionAttributeValues: {
          ":ai": true,
          ":u": timestamp,
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Unido a la apelación con éxito",
        companyId,
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

export const getAppeals: APIGatewayProxyHandler = async () => {
  try {
    // 1. Fetch organizations under review/appeal
    const orgsResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND (estatus = :st OR estadoCuenta = :ec OR suspensionStatus = :ss)",
        ExpressionAttributeValues: {
          ":sk": "PROFILE",
          ":st": "En revisión",
          ":ec": "REVISION",
          ":ss": "IN_REVIEW",
        },
      }),
    );

    // 2. Fetch vacancies under evaluation/appeal
    const vacanciesResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND (estado = :evalState OR banderaRevisionObligatoria = :flag)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":evalState": "EVALUACION",
          ":flag": true,
        },
      }),
    );

    const appeals = [
      ...(orgsResult.Items || []).map((org: any) => ({
        id: org.PK.replace("USER#", ""),
        type: "ORGANIZACION",
        companyId: org.PK.replace("USER#", ""),
        name:
          org.nombreComercial ||
          org.nombre ||
          org.razonSocial ||
          "Organización en Apelación",
        reason:
          org.suspensionReason ||
          "Proceso de revisión de cuenta e infracción de normas",
        status: org.estatus || "En revisión",
        gracePeriodEnd: org.suspensionGracePeriodEnd || null,
        createdAt:
          org.updatedAt || org.fechaCreacion || new Date().toISOString(),
      })),
      ...(vacanciesResult.Items || []).map((vac: any) => ({
        id: vac.PK.replace("VACANCY#", ""),
        type: "VACANTE",
        jobId: vac.PK.replace("VACANCY#", ""),
        companyId: vac.empresaUuid || "",
        name: vac.titulo || "Vacante en evaluación",
        reason:
          vac.motivoSuspensionAutomatica ||
          "Vacante pausada para evaluación por acumulación de reportes",
        status: vac.estado || "EVALUACION",
        gracePeriodEnd: vac.fechaLimiteApelacion || null,
        createdAt:
          vac.fechaActualizacion ||
          vac.fechaCreacion ||
          new Date().toISOString(),
      })),
    ];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(appeals),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
