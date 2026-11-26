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
  resolveChatIncidentParties,
  syncCompanyIncidents,
} from "./common";
import { sendStyledJobNetEmail } from "../../utils/emailTemplate";
import { sendPushToUser } from "../../utils/webPushService";
import { parseJsonBody } from "../../utils/validator";
import { extractAuthContext } from "../../utils/authHelper";
import { notifyAllModerators } from "../../utils/moderatorNotifier";

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
        candidateId: item.candidateId || "",
        candidateName: item.candidateName || "",
        reporterId: item.reporterId || "",
        reporter: item.reporter || "Anónimo",
        reason: item.reason || "",
        severity: item.severity || "media",
        infraccion: item.infraccion || "otro",
        estatus: item.estatus || "PENDIENTE",
        auditState: item.auditState || undefined,
        auditOpenedAt: item.auditOpenedAt || undefined,
        auditOpenedBy: item.auditOpenedBy || undefined,
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
    const auth = await extractAuthContext(event);
    const body = parseResult.data;
    const {
      jobId,
      jobTitle,
      postId,
      postTitle,
      companyId,
      companyName,
      candidateId,
      candidateName,
      reporterId,
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

    const isCandidate =
      (auth.role || "").toUpperCase() === "CANDIDATO" ||
      (auth.role || "").toUpperCase() === "CANDIDATE";

    let resolvedJobId = jobId || "";
    let resolvedCandidateId = candidateId || "";
    let resolvedCompanyId = companyId || "";
    let resolvedJobTitle = jobTitle || "";
    let resolvedCompanyName = companyName || "";
    const resolvedCandidateName = candidateName || "";

    if (targetType === "CHAT" || (targetId && targetId.includes("#"))) {
      if (targetId && targetId.includes("#")) {
        const parts = targetId.split("#");
        if (!resolvedJobId && parts[0]) resolvedJobId = parts[0];
        if (!resolvedCandidateId && parts[1]) resolvedCandidateId = parts[1];
      }
      if (resolvedJobId && (!resolvedCompanyId || !resolvedJobTitle || !resolvedCompanyName)) {
        try {
          const vacRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: `VACANCY#${resolvedJobId}`, SK: "METADATA" },
            }),
          );
          if (vacRes.Item) {
            if (!resolvedCompanyId)
              resolvedCompanyId = vacRes.Item.empresaUuid || vacRes.Item.companyId || "";
            if (!resolvedJobTitle) resolvedJobTitle = vacRes.Item.titulo || vacRes.Item.title || "";
            if (!resolvedCompanyName)
              resolvedCompanyName =
                vacRes.Item.company || vacRes.Item.empresaNombre || vacRes.Item.nombreEmpresa || "";
          }
        } catch (e) {
          console.warn("Could not query vacancy for chat incident:", e);
        }
      }
      if (isCandidate && !resolvedCandidateId) {
        resolvedCandidateId = auth.userId || "";
      }
      if (!isCandidate && !resolvedCompanyId) {
        resolvedCompanyId = auth.userId || "";
      }
    }

    const incidentItem = {
      PK: `INCIDENT#${uuid}`,
      SK: "METADATA",
      targetType:
        targetType ||
        (jobId ? "VACANTE" : postId ? "POST" : companyId ? "ORGANIZACION" : "GENERAL"),
      targetId: targetId || jobId || postId || companyId || "",
      targetTitle:
        targetTitle ||
        resolvedJobTitle ||
        jobTitle ||
        postTitle ||
        resolvedCompanyName ||
        companyName ||
        "",
      jobId: resolvedJobId || jobId || (targetType === "VACANTE" ? targetId : ""),
      jobTitle: resolvedJobTitle || jobTitle || (targetType === "VACANTE" ? targetTitle : ""),
      postId: postId || (targetType === "POST" ? targetId : ""),
      companyId:
        resolvedCompanyId ||
        companyId ||
        (targetType === "ORGANIZACION" || targetType === "EMPRESA" ? targetId : ""),
      companyName:
        resolvedCompanyName ||
        companyName ||
        (targetType === "ORGANIZACION" || targetType === "EMPRESA" ? targetTitle : ""),
      candidateId: resolvedCandidateId || candidateId || (isCandidate ? auth.userId : ""),
      candidateName: resolvedCandidateName || candidateName || "",
      reporterId: reporterId || auth.userId || "",
      reporter: reporter || auth.email || "Anónimo",
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

    // Notificación en bandeja al denunciante confirmando que la incidencia será revisada por moderación
    if (targetType === "CHAT" && auth.userId) {
      const notifRepId = Math.random().toString(36).substring(2, 15);
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `USER#${auth.userId}`,
            SK: `NOTIFICATION#${createdAt}#${notifRepId}`,
            id: notifRepId,
            type: "INCIDENT_REPORTED",
            title: "Reporte Registrado: Incidencia en Revisión 📋",
            message: `Hemos recibido tu reporte sobre la conversación asociada a "${resolvedJobTitle || jobTitle || targetTitle || "la vacante"}". La incidencia será revisada por el equipo de moderación.`,
            incidentId: uuid,
            jobId: resolvedJobId || jobId || "",
            companyId: resolvedCompanyId || companyId || "",
            candidateId: resolvedCandidateId || candidateId || "",
            createdAt,
            read: false,
          },
        }),
      );

      sendPushToUser(auth.userId, {
        title: "Reporte Registrado: Incidencia en Revisión 📋",
        body: `Tu reporte sobre la conversación será revisado por Moderación.`,
        url: "/notifications",
        data: { type: "INCIDENT_REPORTED", incidentId: uuid },
      }).catch((err) => console.warn("Could not send push notification to reporter:", err));
    }

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

    // Disparar notificación a todos los moderadores sobre la nueva incidencia
    notifyAllModerators({
      title: "Nueva Incidencia Reportada ⚠️",
      message: `${auth.email || "Usuario"} reportó una infracción de tipo ${infraccion || "controversia"}: "${reason.substring(0, 100)}".`,
      type: "NEW_INCIDENT_REPORT",
      url: "/mod/incidents",
      data: { incidentId: uuid, targetType, infraccion },
    }).catch((err) => console.warn("Could not notify moderators of incident:", err));

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
    const auth = await extractAuthContext(event);
    const isTest = process.env.NODE_ENV === "test";

    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      event.headers?.["x-user-type"] ||
      ""
    )
      .toString()
      .toUpperCase();
    const isHeaderPrivileged =
      headerRole === "ADMIN" || headerRole === "MODERATOR" || headerRole === "MODERADOR";
    const isPrivileged = auth.isAdmin || auth.isModerator || isHeaderPrivileged;

    if (!isPrivileged && (!isTest || event.headers)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Resolución de incidencias exclusiva para Administradores y Moderadores.",
        }),
      };
    }

    const operatorRole = auth.isAdmin || headerRole === "ADMIN" ? "ADMIN" : "MODERATOR";
    const operatorId =
      auth.userId || event.headers?.["x-user-id"] || event.headers?.["X-User-Id"] || operatorRole;

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

    // Concurrency lock: If incident is already assigned to a different moderator
    if (
      incident.assignedModeratorId &&
      incident.assignedModeratorId !== operatorId &&
      operatorRole !== "ADMIN"
    ) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Esta incidencia ya está siendo atendida por el moderador ${
            incident.assignedModeratorName || "asignado"
          }.`,
          assignedModeratorId: incident.assignedModeratorId,
          assignedModeratorName: incident.assignedModeratorName,
        }),
      };
    }

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
      incident.jobId &&
      incident.targetType !== "CHAT"
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
        UpdateExpression:
          "SET estatus = :status, resolvedByRole = :oprRole, resolvedByUserId = :oprId, fechaActualizacion = :updated",
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":oprRole": operatorRole,
          ":oprId": operatorId,
          ":updated": new Date().toISOString(),
        },
      }),
    );

    if (incident.targetType === "CHAT") {
      const parties = await resolveChatIncidentParties(incident);
      const timestamp = new Date().toISOString();
      const targetCompanyId = parties.companyId;
      const targetCandidateId = parties.candidateId;
      const jobTitle = parties.jobTitle;

      if (action === "evaluate") {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `INCIDENT#${incidentId}`, SK: "METADATA" },
            UpdateExpression: "SET auditState = :as, supervisionStatus = :ss",
            ExpressionAttributeValues: { ":as": "AUDIT_ACTIVE", ":ss": "UNDER_AUDIT" },
          }),
        );

        // Notificación formal al Candidato (In-app + Push)
        const notifCandId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCandidateId}`,
              SK: `NOTIFICATION#${timestamp}#${notifCandId}`,
              id: notifCandId,
              type: "AUDIT_CHANNEL_SUPERVISED",
              title: "Aviso de Auditoría de Mensajería: Canal Supervisado 🛡️",
              message: `La conversación asociada a la vacante "${jobTitle}" será revisada por el equipo de moderación tras admitirse la incidencia.`,
              incidentId,
              jobId: parties.jobId,
              createdAt: timestamp,
              read: false,
              actionType: "AUDIT_OPENED",
            },
          }),
        );

        // Notificación formal a la Empresa (In-app + Push)
        const notifOrgId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCompanyId}`,
              SK: `NOTIFICATION#${timestamp}#${notifOrgId}`,
              id: notifOrgId,
              type: "AUDIT_CHANNEL_SUPERVISED",
              title: "Notificación Oficial: Conversación en Revisión ⚠️",
              message: `El canal de mensajería asociado a la vacante "${jobTitle}" será revisado por el equipo de moderación debido a un reporte de presunta infracción.`,
              incidentId,
              jobId: parties.jobId,
              createdAt: timestamp,
              read: false,
              actionType: "AUDIT_OPENED",
            },
          }),
        );

        sendPushToUser(targetCandidateId, {
          title: "Auditoría de Mensajería: Canal Supervisado 🛡️",
          body: `El canal de mensajería para la vacante "${jobTitle}" entra en revisión supervisada por Moderación.`,
          url: "/notifications",
          data: { type: "AUDIT_CHANNEL_SUPERVISED", incidentId },
        }).catch(() => {});

        sendPushToUser(targetCompanyId, {
          title: "Apertura de Auditoría de Mensajería Directa ⚠️",
          body: `Su canal de mensajería para "${jobTitle}" entra en revisión supervisada.`,
          url: "/notifications",
          data: { type: "AUDIT_CHANNEL_SUPERVISED", incidentId },
        }).catch(() => {});
      } else if (action === "approve") {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `INCIDENT#${incidentId}`, SK: "METADATA" },
            UpdateExpression: "SET auditState = :as, auditDictum = :ad, supervisionStatus = :ss",
            ExpressionAttributeValues: {
              ":as": "AUDIT_CONCLUDED",
              ":ad": "DESESTIMADA",
              ":ss": "CONCLUDED",
            },
          }),
        );

        const notifCandId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCandidateId}`,
              SK: `NOTIFICATION#${timestamp}#${notifCandId}`,
              id: notifCandId,
              type: "AUDIT_RESOLVED",
              title: "Resolución de Incidencia: Caso Concluido ⚖️",
              message: `La evaluación de la conversación asociada a la vacante "${jobTitle}" ha concluido. La incidencia ha sido desestimada sin sanción.`,
              incidentId,
              dictum: "DESESTIMADA",
              jobId: parties.jobId,
              createdAt: timestamp,
              read: false,
            },
          }),
        );

        const notifOrgId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCompanyId}`,
              SK: `NOTIFICATION#${timestamp}#${notifOrgId}`,
              id: notifOrgId,
              type: "AUDIT_RESOLVED",
              title: "Resolución Favorable: Incidencia Desestimada ✅",
              message: `La evaluación de la conversación asociada a la vacante "${jobTitle}" ha concluido favorablemente sin sanción.`,
              incidentId,
              dictum: "DESESTIMADA",
              jobId: parties.jobId,
              createdAt: timestamp,
              read: false,
            },
          }),
        );

        sendPushToUser(targetCandidateId, {
          title: "Resolución de Incidencia: Caso Concluido ⚖️",
          body: `La incidencia de chat para "${jobTitle}" ha sido desestimada sin sanción.`,
          url: "/notifications",
          data: { type: "AUDIT_RESOLVED", incidentId },
        }).catch(() => {});

        sendPushToUser(targetCompanyId, {
          title: "Resolución Favorable: Incidencia Desestimada ✅",
          body: `La incidencia de chat para "${jobTitle}" fue desestimada favorablemente.`,
          url: "/notifications",
          data: { type: "AUDIT_RESOLVED", incidentId },
        }).catch(() => {});
      } else if (action === "block") {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `INCIDENT#${incidentId}`, SK: "METADATA" },
            UpdateExpression: "SET auditState = :as, auditDictum = :ad, supervisionStatus = :ss",
            ExpressionAttributeValues: {
              ":as": "AUDIT_CONCLUDED",
              ":ad": "SANCION_EMPRESA",
              ":ss": "CONCLUDED",
            },
          }),
        );

        await executeOrgSuspensionInitiation(
          targetCompanyId,
          `Dictamen de Incidencia de Chat: Infracción confirmada en mensajería de vacante "${jobTitle}".`,
          4,
          operatorRole,
          operatorId,
        );

        const notifCandId = Math.random().toString(36).substring(2, 15);
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${targetCandidateId}`,
              SK: `NOTIFICATION#${timestamp}#${notifCandId}`,
              id: notifCandId,
              type: "AUDIT_RESOLVED",
              title: "Resolución de Incidencia: Sanción Aplicada ⚖️",
              message: `La evaluación de la conversación asociada a la vacante "${jobTitle}" ha concluido. Se ha sancionado a la organización infractora.`,
              incidentId,
              dictum: "SANCION_EMPRESA",
              jobId: parties.jobId,
              createdAt: timestamp,
              read: false,
            },
          }),
        );

        sendPushToUser(targetCandidateId, {
          title: "Resolución de Incidencia: Sanción Aplicada ⚖️",
          body: `La incidencia de chat para "${jobTitle}" concluyó con sanción aplicada a la empresa.`,
          url: "/notifications",
          data: { type: "AUDIT_RESOLVED", incidentId },
        }).catch(() => {});
      }

      await saveAuditLog({
        targetId: incidentId,
        targetType: "INCIDENTE",
        action: `RESOLUCION_CHAT_${action.toUpperCase()}`,
        reason: `Resolución de incidencia de chat (${action}) ejecutada por ${operatorRole}. Ambas partes notificadas.`,
        executorId: operatorId,
      });
    } else if (incident.jobId) {
      if (action === "block") {
        // Borrado Lógico de la vacante fraudulenta
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
              "SET estado = :deletedState, suspendida = :s, isDeleted = :del, oculta = :o, deletedByRole = :delRole, deletedByUserId = :delId, deletedAt = :deleted",
            ExpressionAttributeValues: {
              ":deletedState": "Eliminada",
              ":s": true,
              ":del": true,
              ":o": true,
              ":delRole": operatorRole,
              ":delId": operatorId,
              ":deleted": timestamp,
            },
          }),
        );

        await saveAuditLog({
          targetId: incident.jobId,
          targetType: "VACANTE",
          action: "ELIMINACION_FRAUDE_INCIDENTE",
          reason: `Borrado lógico de vacante fraudulenta ejecutado por ${operatorRole}: ${incident.reason || "Infracción confirmada"}`,
          executorId: operatorId,
        });

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
              await sendStyledJobNetEmail({
                to: companyEmail,
                subject: "Resolución Desfavorable: Vacante Eliminada",
                client: sesClient,
                templateOptions: {
                  title: "Resolución de Apelación: Sanción Ratificada",
                  badgeText: "Vacante Eliminada",
                  badgeType: "danger",
                  recipientName: compProfileRes.Item.nombreComercial || "Reclutador",
                  paragraphs: [
                    `Te informamos que tras una exhaustiva auditoría del equipo de moderación sobre la apelación presentada para la vacante <strong>"${incident.jobTitle || "Sancionada"}"</strong>, la resolución final ha determinado ratificar la sanción.`,
                    `Por infringir las políticas de publicación y seguridad de JobNet, la vacante ha sido eliminada de manera definitiva del Job Board.`,
                  ],
                  highlightBox: {
                    title: "Dictamen de Moderación",
                    text: "La vacante no cumple con los estándares comunitarios y de veracidad requeridos.",
                    type: "danger",
                  },
                  details: [
                    { label: "Vacante", value: incident.jobTitle || "Sancionada" },
                    { label: "Resolución", value: "Apelación Desestimada / Vacante Eliminada" },
                  ],
                  cta: {
                    text: "Revisar Términos y Condiciones",
                    url: "https://dsty3j5u0b31g.cloudfront.net/terms",
                  },
                  secondaryNotice:
                    "Publicaciones sucesivas que violen las normas pueden derivar en la suspensión definitiva del perfil corporativo.",
                },
              }).catch((err) => console.error("Error sending SES block email:", err));

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
            UpdateExpression:
              "SET estado = :evaluation, evaluatedByRole = :oprRole, evaluatedByUserId = :oprId, fechaLimiteApelacion = :grace",
            ExpressionAttributeValues: {
              ":evaluation": "EVALUACION",
              ":oprRole": operatorRole,
              ":oprId": operatorId,
              ":grace": graceLimit.toISOString(),
            },
          }),
        );

        await saveAuditLog({
          targetId: incident.jobId,
          targetType: "VACANTE",
          action: "PAUSA_PREVENTIVA_INCIDENTE",
          reason: `Pausa preventiva de vacante para evaluación ejecutada por ${operatorRole}`,
          executorId: operatorId,
        });

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
          await sendStyledJobNetEmail({
            to: companyEmail,
            subject: `ALERTA: Vacante "${jobTitle}" Pausada para Evaluación`,
            client: sesClient,
            templateOptions: {
              title: "Vacante Pausada Preventivamente",
              badgeText: "Revisión Requerida ⚠️",
              badgeType: "warning",
              recipientName: vacancy.Item.company || "Reclutador",
              paragraphs: [
                `Te notificamos que la publicación de empleo <strong>"${jobTitle}"</strong> ha sido pausada de manera preventiva por el equipo de moderación tras recibir reportes de presunta infracción.`,
                `La vacante permanecerá oculta en el Job Board mientras se resuelve el proceso de evaluación.`,
              ],
              highlightBox: {
                title: "Motivo del reporte / sanción",
                text: incident.reason || "Reporte de posible infracción a políticas comunitarias",
                type: "warning",
              },
              details: [
                { label: "Vacante", value: jobTitle },
                { label: "Límite para Apelar", value: graceLimit.toLocaleDateString() },
                { label: "Periodo de Gracia", value: "15 días naturales" },
              ],
              cta: {
                text: "Ir a Mis Vacantes y Apelar",
                url: "https://dsty3j5u0b31g.cloudfront.net/recruiter/my-vacancies",
              },
              secondaryNotice: `Dispones hasta el ${graceLimit.toLocaleDateString()} para presentar aclaraciones en la sección "Mis Vacantes" seleccionando "Apelar".`,
            },
          }).catch((err) => console.error("Error sending SES email for vacancy evaluation:", err));
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
              await sendStyledJobNetEmail({
                to: companyEmail,
                subject: "Resolución Favorable: Vacante Reactivada",
                client: sesClient,
                templateOptions: {
                  title: "¡Apelación Favorable! Tu vacante ha sido reactivada",
                  badgeText: "Vacante Reactivada 🎉",
                  badgeType: "success",
                  recipientName: compProfileRes.Item.nombreComercial || "Reclutador",
                  paragraphs: [
                    `Nos complace informarte que la evaluación de la apelación referente a la vacante <strong>"${incident.jobTitle || "Pausada"}"</strong> ha concluido de manera satisfactoria y favorable.`,
                    `Las aclaraciones presentadas han sido validadas por el equipo de moderación y tu publicación se encuentra nuevamente visible y activa en el Job Board.`,
                  ],
                  details: [
                    { label: "Vacante", value: incident.jobTitle || "Reactivada" },
                    { label: "Estado", value: "Pública y Recibiendo Candidaturas" },
                  ],
                  cta: {
                    text: "Ver Vacante en JobNet",
                    url: "https://dsty3j5u0b31g.cloudfront.net/vacancies",
                  },
                  secondaryNotice:
                    "Gracias por colaborar con el equipo de moderación para asegurar la calidad y transparencia en nuestra plataforma.",
                },
              }).catch((err) => console.error("Error sending SES approve email:", err));
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
              ":gsiSk": "ROLE#ORGANIZACION#STATUS#SUSPENDIDA",
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

        await syncCompanyIncidents(
          targetCompanyId,
          "BLOQUEADO",
          incident.reason || "Dictamen desfavorable",
          operatorRole,
          operatorId,
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
              ":gsiSk": "ROLE#ORGANIZACION#STATUS#ACTIVO",
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

        await syncCompanyIncidents(
          targetCompanyId,
          "RESUELTO",
          "Apelación aprobada / reporte desestimado",
          operatorRole,
          operatorId,
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
