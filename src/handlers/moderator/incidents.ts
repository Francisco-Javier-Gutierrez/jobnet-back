import { APIGatewayProxyHandler } from "aws-lambda";
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import {
  docClient,
  sesClient,
  tableName,
  headers,
  saveAuditLog,
  blockCorporateDomain,
  getOrgAppealMessageCount,
  executeOrgSuspensionInitiation,
} from "./common";
import { sendPushToUser } from "../../utils/webPushService";
import { parseJsonBody } from "../../utils/validator";

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
        targetId: item.targetId || item.jobId || item.postId || item.companyId || "",
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
    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
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

    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'reason'" }),
      };
    }

    if (reason.length > 2000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "El motivo del reporte excede el límite máximo de 2000 caracteres.",
        }),
      };
    }

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const incidentItem = {
      PK: `INCIDENT#${uuid}`,
      SK: "METADATA",
      targetType:
        targetType ||
        (jobId ? "VACANTE" : postId ? "POST" : companyId ? "ORGANIZACION" : "GENERAL"),
      targetId: targetId || jobId || postId || companyId || "",
      targetTitle: targetTitle || jobTitle || postTitle || companyName || "",
      jobId: jobId || (targetType === "VACANTE" ? targetId : ""),
      jobTitle: jobTitle || (targetType === "VACANTE" ? targetTitle : ""),
      postId: postId || (targetType === "POST" ? targetId : ""),
      companyId:
        companyId || (targetType === "ORGANIZACION" || targetType === "EMPRESA" ? targetId : ""),
      companyName:
        companyName ||
        (targetType === "ORGANIZACION" || targetType === "EMPRESA" ? targetTitle : ""),
      reporter: reporter || "Anónimo",
      reason,
      severity: severity || "media",
      infraccion: infraccion || "otro",
      estatus: "PENDIENTE",
      fechaCreacion: createdAt,
    };

    // Remove empty attributes
    const cleanItem = Object.fromEntries(Object.entries(incidentItem).filter(([, v]) => v !== ""));

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
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

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
          reason: "Acumulación de 5 o más denuncias en menos de 12 horas (RF-72)",
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
        targetCompanyId = vacancyRes.Item.empresaUuid || vacancyRes.Item.companyId;
      }
    }

    // Require at least 3 messages from the organization if resolving an evaluated incident/appeal
    if (
      (existing.Item.estatus === "EVALUACION" || action === "approve" || action === "block") &&
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
      action === "block" ? "BLOQUEADO" : action === "evaluate" ? "EVALUACION" : "RESUELTO";
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
        UpdateExpression: "SET estatus = :status, fechaActualizacion = :updated",
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
            Key: {
              PK: `VACANCY_SUSPENSION#${incident.jobId}`,
              SK: "GRACE_PERIOD",
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

          sendPushToUser(targetCompanyId, {
            title: "Resolución Desfavorable: Vacante Eliminada 🚫",
            body: "Tras la evaluación de la apelación, la vacante ha sido eliminada definitivamente por infracción de normas.",
            url: "/notifications",
            data: { type: "SUSPENSION_CONFIRMED" },
          }).catch((err) =>
            console.error("Error sending push for incident unfavorable resolution:", err),
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
                          Data: `Estimado reclutador,\n\nTras la evaluación de la apelación de su vacante "${incident.jobTitle || "Sancionada"}", la resolución ha sido en su contra y la vacante ha sido eliminada definitivamente del Job Board por infracción de nuestras normas.\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                        },
                      },
                    },
                  }),
                )
                .catch((err) => console.error("Error sending SES block email:", err));

              const compDomain = companyEmail.split("@")[1];
              await blockCorporateDomain(
                compDomain,
                incident.reason || "Suspensión por vacante fraudulenta",
                vacancyRes.Item.empresaUuid,
              );
            }
          }
        } catch (e) {
          console.error("Error auto-blocking corporate domain on incident resolve:", e);
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
            UpdateExpression: "SET estado = :evaluation, fechaLimiteApelacion = :grace",
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

          const companyEmail = companyProfile.Item?.email || "empresa@jobnet.com";
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
                reason: incident.reason || "Evaluación preventiva por reportes acumulados",
                gracePeriodEnd: graceLimit.toISOString(),
                createdAt: timestamp,
                read: false,
                actionRequired: true,
                actionType: "APPEAL_SUSPENSION",
                companyId: vacancy.Item.empresaUuid,
              },
            }),
          );

          sendPushToUser(vacancy.Item.empresaUuid, {
            title: "Aviso Oficial: Vacante Pausada ⚠️",
            body: `Su vacante "${jobTitle}" ha sido pausada preventivamente por reportes. Ingrese a apelar.`,
            url: "/notifications",
            data: {
              type: "SUSPENSION_NOTICE",
              companyId: vacancy.Item.empresaUuid,
            },
          }).catch((err) => console.error("Error sending push for paused vacancy:", err));

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
            .catch((err) => console.error("Error sending SES email for vacancy evaluation:", err));
        }
      } else if (action === "approve") {
        // Fase 3 — Reactivar vacante (apelación favorable)
        await docClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY_SUSPENSION#${incident.jobId}`,
              SK: "GRACE_PERIOD",
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
            UpdateExpression: "SET estado = :active, fechaLimiteApelacion = :nullVal",
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

          sendPushToUser(targetCompanyId, {
            title: "Resolución Favorable: Vacante Reactivada ✅",
            body: "La evaluación de su apelación ha concluido favorablemente. Su vacante ha sido reactivada.",
            url: "/notifications",
            data: { type: "SUSPENSION_CANCELED" },
          }).catch((err) =>
            console.error("Error sending push for incident favorable resolution:", err),
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
                          Data: `Estimado reclutador,\n\nNos complace informarle que la evaluación de su apelación referente a la vacante "${incident.jobTitle || "Pausada"}" ha concluido de manera favorable.\n\nSu vacante ha sido reactivada y ya se encuentra visible nuevamente en el Job Board.\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                        },
                      },
                    },
                  }),
                )
                .catch((err) => console.error("Error sending SES approve email:", err));
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
          incident.reason || "Revisión por reportes e incidencias de organización",
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
              "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, suspensionReason = :sr, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk",
            ExpressionAttributeValues: {
              ":st": "Suspendida",
              ":ec": "SUSPENDIDA",
              ":b": true,
              ":ss": "SUSPENDED",
              ":sr": incident.reason || "Dictamen desfavorable",
              ":u": timestamp,
              ":gsiPk": "PROFILE",
              ":gsiSk": "ROLE#EMPRESA#STATUS#SUSPENDIDA",
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
              "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk REMOVE suspensionReason, suspensionGracePeriodEnd",
            ExpressionAttributeValues: {
              ":st": "Activa",
              ":ec": "ACTIVO",
              ":b": false,
              ":ss": "CANCELLED",
              ":u": timestamp,
              ":gsiPk": "PROFILE",
              ":gsiSk": "ROLE#EMPRESA#STATUS#ACTIVO",
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
    } else if (incident.targetCandidateId) {
      if (action === "block") {
        const timestamp = new Date().toISOString();
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `USER#${incident.targetCandidateId}`, SK: "PROFILE" },
            UpdateExpression:
              "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionReason = :sr, updatedAt = :u",
            ExpressionAttributeValues: {
              ":st": "Suspendida",
              ":ec": "SUSPENDIDA",
              ":b": true,
              ":sr": incident.reason || "Infracción de términos",
              ":u": timestamp,
            },
          }),
        );

        const notifId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${incident.targetCandidateId}`,
              SK: `NOTIFICATION#${timestamp}#${notifId}`,
              id: notifId,
              type: "SUSPENSION_CONFIRMED",
              title: "Cuenta Suspendida",
              message: `Tu cuenta de candidato ha sido suspendida debido a infracciones.`,
              createdAt: timestamp,
              read: false,
            },
          }),
        );
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
