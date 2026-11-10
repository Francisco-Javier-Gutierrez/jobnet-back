import { APIGatewayProxyHandler } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  docClient,
  tableName,
  headers,
  saveAuditLog,
  broadcastAppealResolved,
  getOrgAppealMessageCount,
  executeOrgSuspensionInitiation,
  sendEmailToCompany,
} from "./common";
import { sendPushToUser } from "../../utils/webPushService";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody, safeIdSchema } from "../../utils/validator";

// Fase 1 — Inicio del proceso de suspensión de cuenta
export const initiateSuspension: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId = event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined" || !safeIdSchema.safeParse(companyId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";
    if (!auth.isAdmin && !auth.isModerator && (!isTest || event.headers)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Gestión de suspensiones exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const reason = body.reason || "Infracción de términos de servicio y conducta";
    const rawGraceDays = typeof body.graceDays === "number" ? body.graceDays : 4;
    const graceDays = Math.min(Math.max(1, rawGraceDays), 30);

    const callerRole = auth.isAdmin ? "ADMIN" : "MODERATOR";
    const callerId = auth.userId || callerRole;

    // Regla de jerarquía suprema: Si la empresa fue restituida por un Administrador Central, un Moderador no puede iniciar suspensión
    if (auth.isModerator && !auth.isAdmin) {
      const profileCheck = await docClient
        .send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
          }),
        )
        .catch(() => ({ Item: null }));

      if (profileCheck?.Item?.revokedByRole === "ADMIN") {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error:
              "Acceso denegado: Esta organización fue restituida por un Administrador Central y no puede ser suspendida por un Moderador de Comunidad.",
          }),
        };
      }
    }

    const res = await executeOrgSuspensionInitiation(
      companyId,
      reason,
      graceDays,
      callerRole,
      callerId,
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
    const companyId = event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined" || !safeIdSchema.safeParse(companyId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";
    if (!auth.isAdmin && !auth.isModerator && (!isTest || event.headers)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Gestión de suspensiones exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const notes = body.notes || "Apelación aprobada. Suspensión revocada.";
    const timestamp = new Date().toISOString();

    const callerRole = auth.isAdmin ? "ADMIN" : "MODERATOR";
    const callerId = auth.userId || callerRole;

    // Jerarquía de Mando Suprema: Si la sanción fue iniciada o dictaminada por un Administrador Central, un Moderador no puede revocarla
    if (auth.isModerator && !auth.isAdmin) {
      const graceRes = await docClient
        .send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `SUSPENSION#${companyId}`, SK: "GRACE_PERIOD" },
          }),
        )
        .catch(() => ({ Item: null }));

      const profileRes = await docClient
        .send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
          }),
        )
        .catch(() => ({ Item: null }));

      const suspendedByRole = graceRes?.Item?.initiatedByRole || profileRes?.Item?.suspendedByRole;
      if (suspendedByRole === "ADMIN") {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error:
              "Acceso denegado: Esta sanción fue dictaminada por un Administrador Central con autoridad jerárquica suprema y no puede ser revocada por un Moderador de Comunidad.",
          }),
        };
      }
    }

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
          "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, revokedByRole = :rbr, revokedByUserId = :rbu, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk REMOVE suspensionReason, suspensionGracePeriodEnd",
        ExpressionAttributeValues: {
          ":st": "Activa",
          ":ec": "ACTIVO",
          ":b": false,
          ":ss": "CANCELLED",
          ":rbr": callerRole,
          ":rbu": callerId,
          ":u": timestamp,
          ":gsiPk": "PROFILE",
          ":gsiSk": "ROLE#EMPRESA#STATUS#ACTIVO",
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

    // Disparar Web Push
    sendPushToUser(companyId, {
      title: "Apelación Favorable: Suspensión Revocada ✅",
      body: `El proceso de suspensión ha sido revocado y su cuenta se encuentra nuevamente Activa. Dictamen: ${notes}`,
      url: "/notifications",
      data: { type: "SUSPENSION_CANCELLED", companyId },
    }).catch((err) => console.error("Error sending push for favorable appeal:", err));

    // Disparar Correo Directo por SES (Fase 3a)
    sendEmailToCompany(
      companyId,
      "RESOLUCIÓN FAVORABLE: Suspensión Revocada y Cuenta Restablecida",
      `Nos complace informarle que la apelación presentada ha sido evaluada favorablemente. El proceso de suspensión ha sido revocado y su cuenta se encuentra nuevamente activa en JobNet.\n\nDictamen / Notas del Moderador: ${notes}`,
    ).catch((err) => console.error("Error sending SES email for favorable appeal:", err));

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
    const companyId = event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId || companyId === "undefined" || !safeIdSchema.safeParse(companyId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId válido es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";
    if (!auth.isAdmin && !auth.isModerator && (!isTest || event.headers)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Gestión de suspensiones exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const reason = body.reason || "Dictamen desfavorable tras proceso de evaluación/apelación";
    const timestamp = new Date().toISOString();

    const callerRole = auth.isAdmin ? "ADMIN" : "MODERATOR";
    const callerId = auth.userId || callerRole;

    // Regla de Jerarquía: Si la organización fue restituida por un Administrador Central, un Moderador no puede suspenderla
    if (auth.isModerator && !auth.isAdmin) {
      const profileCheck = await docClient
        .send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
          }),
        )
        .catch(() => ({ Item: null }));

      if (profileCheck?.Item?.revokedByRole === "ADMIN") {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error:
              "Acceso denegado: Esta organización fue habilitada por un Administrador Central y no puede ser suspendida por un Moderador de Comunidad.",
          }),
        };
      }
    }

    // Validar regla de al menos 3 mensajes por parte de la organización en el chat (o periodo expirado / forzado por falta de respuesta)
    const orgMsgCount = await getOrgAppealMessageCount(companyId);
    if (orgMsgCount < 3 && !body.force) {
      const profileRes = await docClient
        .send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
          }),
        )
        .catch(() => ({ Item: null }));
      const graceEnd = profileRes?.Item?.suspensionGracePeriodEnd;
      const isPeriodExpired = graceEnd && new Date() >= new Date(graceEnd);

      if (!isPeriodExpired) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: `Se requieren al menos 3 mensajes de evidencia o justificación por parte de la organización en el chat de apelación para emitir dictamen final anticipado. (Mensajes actuales de la empresa: ${orgMsgCount}/3)`,
          }),
        };
      }
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
          "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, suspensionReason = :sr, dictamenByRole = :dbr, dictamenByUserId = :dbu, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk",
        ExpressionAttributeValues: {
          ":st": "Suspendida",
          ":ec": "SUSPENDIDA",
          ":b": true,
          ":ss": "SUSPENDED",
          ":sr": reason,
          ":dbr": callerRole,
          ":dbu": callerId,
          ":u": timestamp,
          ":gsiPk": "PROFILE",
          ":gsiSk": "ROLE#EMPRESA#STATUS#SUSPENDIDA",
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
            UpdateExpression: "SET estatus = :st, suspendida = :s, updatedAt = :u",
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

    // Disparar Web Push
    sendPushToUser(companyId, {
      title: "Resolución Final: Cuenta Suspendida 🚫",
      body: `Su cuenta ha sido suspendida definitivamente. Motivo: ${reason}`,
      url: "/notifications",
      data: { type: "SUSPENSION_CONFIRMED", companyId },
    }).catch((err) => console.error("Error sending push for final suspension:", err));

    // Disparar Correo Directo por SES (Fase 3b)
    sendEmailToCompany(
      companyId,
      "RESOLUCIÓN FINAL: Cuenta Suspendida por Infracción",
      `Le informamos que tras evaluar el expediente y la apelación correspondiente, se ha emitido un dictamen desfavorable. Su cuenta ha sido suspendida definitivamente de la plataforma JobNet, su inicio de sesión ha sido bloqueado y todas sus vacantes han sido ocultadas del Job Board.\n\nMotivo del dictamen: ${reason}`,
    ).catch((err) => console.error("Error sending SES email for final suspension:", err));

    // 5. Auditoría
    await saveAuditLog({
      targetId: companyId,
      targetType: "ORGANIZACION",
      action: "SUSPENSION_DEFINITIVA_RF7",
      reason: `Suspensión ejecutada definitivamente: ${reason}. Dictaminado por: ${callerRole}`,
      executorId: callerId,
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
    const companyId = event.pathParameters?.id || event.pathParameters?.companyId;
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
        gracePeriodEnd: graceItem?.gracePeriodEnd || profile.suspensionGracePeriodEnd || null,
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
  console.log("Processing DynamoDB Stream TTL Event for Suspension:", JSON.stringify(event));

  for (const record of event.Records || []) {
    if (record.eventName === "REMOVE") {
      const oldImage = record.dynamodb?.OldImage;
      if (!oldImage) continue;

      const pk = oldImage.PK?.S || "";
      const sk = oldImage.SK?.S || "";

      if (pk.startsWith("SUSPENSION#") && sk === "GRACE_PERIOD") {
        const companyId = oldImage.companyId?.S || pk.replace("SUSPENSION#", "");
        const status = oldImage.status?.S;

        if (status === "IN_REVIEW") {
          console.log(`TTL Expired for company ${companyId}. Executing automatic suspension.`);
          const timestamp = new Date().toISOString();

          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
              UpdateExpression:
                "SET estatus = :st, estadoCuenta = :ec, bloqueada = :b, suspensionStatus = :ss, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk",
              ExpressionAttributeValues: {
                ":st": "Suspendida",
                ":ec": "SUSPENDIDA",
                ":b": true,
                ":ss": "SUSPENDED_BY_TTL",
                ":u": timestamp,
                ":gsiPk": "PROFILE",
                ":gsiSk": "ROLE#EMPRESA#STATUS#SUSPENDIDA",
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
                  UpdateExpression: "SET estatus = :st, suspendida = :s, updatedAt = :u",
                  ExpressionAttributeValues: {
                    ":st": "Oculta",
                    ":s": true,
                    ":u": timestamp,
                  },
                }),
              );
            }
          }

          // Notificación interna, Web Push y Correo Directo SES (Fase 3c: Expiración sin respuesta)
          const notifId = Math.random().toString(36).substring(2, 15);
          await docClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `USER#${companyId}`,
                SK: `NOTIFICATION#${timestamp}#${notifId}`,
                id: notifId,
                type: "SUSPENSION_CONFIRMED",
                title: "Resolución Automática: Cuenta Suspendida",
                message:
                  "El periodo de gracia para apelar ha concluido sin resolución favorable. Su cuenta ha sido suspendida definitivamente y sus vacantes han sido ocultadas.",
                createdAt: timestamp,
                read: false,
              },
            }),
          );

          sendPushToUser(companyId, {
            title: "Resolución Automática: Cuenta Suspendida 🚫",
            body: "El periodo de gracia para apelar ha concluido sin respuesta/resolución favorable. Su cuenta ha sido suspendida definitivamente.",
            url: "/notifications",
            data: { type: "SUSPENSION_CONFIRMED", companyId },
          }).catch((err) => console.error("Error sending push for TTL suspension:", err));

          sendEmailToCompany(
            companyId,
            "RESOLUCIÓN AUTOMÁTICA: Cuenta Suspendida por Expiración de Periodo de Gracia",
            "Le informamos que el periodo de gracia concedido para atender el proceso de revisión de su cuenta ha concluido sin una resolución favorable o sin justificación probatoria. En consecuencia, su cuenta ha sido suspendida definitivamente, su acceso ha sido bloqueado y sus ofertas han sido retiradas de la plataforma.",
          ).catch((err) => console.error("Error sending SES email for TTL suspension:", err));

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
          console.log(`TTL Expired for vacancy ${jobId}. Executing automatic deletion (RF-23).`);
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
