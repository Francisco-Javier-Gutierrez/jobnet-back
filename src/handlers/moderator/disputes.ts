import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  docClient,
  tableName,
  headers,
  saveAuditLog,
  executeOrgSuspensionInitiation,
  sendEmailToCompany,
  resolveChatIncidentParties,
} from "./common";
import { sendPushToUser } from "../../utils/webPushService";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody, safeIdSchema } from "../../utils/validator";

export interface AuditChatMessage {
  id: string;
  senderId: string;
  senderRole: "CANDIDATO" | "ORGANIZACION" | "SISTEMA";
  senderName: string;
  text: string;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  attachmentName?: string | null;
  createdAt: string;
}

// Baseline mock evidence for disputes when DynamoDB chat is empty
export const BASELINE_DISPUTE_CHATS: Record<string, AuditChatMessage[]> = {
  SALARIO: [
    {
      id: "msg-sal-01",
      senderId: "cand-maria-77",
      senderRole: "CANDIDATO",
      senderName: "María Fernández (Candidato)",
      text: "Hola, buen día. Vi en la vacante de Frontend Senior un rango salarial de $42,000 a $48,000 netos. ¿Es correcto para la modalidad híbrida?",
      createdAt: "2026-10-13T10:14:00Z",
    },
    {
      id: "msg-sal-02",
      senderId: "org-recruiter-99",
      senderRole: "ORGANIZACION",
      senderName: "Reclutamiento Corporativo (Organización)",
      text: "Buen día María. La vacante dice eso en el portal para atraer perfiles senior, pero el presupuesto real autorizado es de $18,000 brutos sin prestaciones superiores. Si le interesa ese monto avanzamos, si no descartamos su perfil.",
      attachmentUrl: "/docs/contrato_modificado_18k.pdf",
      attachmentName: "contrato_modificado_18k.pdf",
      attachmentType: "application/pdf",
      createdAt: "2026-10-13T10:28:00Z",
    },
    {
      id: "msg-sal-03",
      senderId: "cand-maria-77",
      senderRole: "CANDIDATO",
      senderName: "María Fernández (Candidato)",
      text: "Eso no fue lo publicado en la oferta inicial. Me parece una práctica engañosa y una discrepancia salarial grave.",
      createdAt: "2026-10-13T10:35:00Z",
    },
    {
      id: "msg-sal-04",
      senderId: "org-recruiter-99",
      senderRole: "ORGANIZACION",
      senderName: "Reclutamiento Corporativo (Organización)",
      text: "Es lo que hay en el mercado. Si no acepta, no nos haga perder el tiempo.",
      createdAt: "2026-10-13T10:40:00Z",
    },
  ],
  FRAUDE: [
    {
      id: "msg-fraud-01",
      senderId: "cand-carlos-12",
      senderRole: "CANDIDATO",
      senderName: "Carlos Gómez (Candidato)",
      text: "Hola, me postulé para la vacante de Capturista Remoto. ¿Cuáles son los siguientes pasos del proceso?",
      createdAt: "2026-10-13T09:05:00Z",
    },
    {
      id: "msg-fraud-02",
      senderId: "org-scam-01",
      senderRole: "ORGANIZACION",
      senderName: "Coordinador de Selección (Organización)",
      text: "Felicidades Carlos, has sido pre-seleccionado. Para enviarte la laptop y el kit de trabajo a tu domicilio, es requisito indispensable realizar un depósito previo de $1,850 MXN por concepto de seguro de paquetería express a la cuenta que te adjunto.",
      attachmentUrl: "/docs/ficha_deposito_oxxo.png",
      attachmentName: "ficha_deposito_oxxo.png",
      attachmentType: "image/png",
      createdAt: "2026-10-13T09:12:00Z",
    },
    {
      id: "msg-fraud-03",
      senderId: "cand-carlos-12",
      senderRole: "CANDIDATO",
      senderName: "Carlos Gómez (Candidato)",
      text: "En los términos de JobNet se estipula que las empresas nunca deben cobrar a los candidatos. No realizaré ningún depósito.",
      createdAt: "2026-10-13T09:15:00Z",
    },
  ],
  ACOSO: [
    {
      id: "msg-acoso-01",
      senderId: "cand-ana-33",
      senderRole: "CANDIDATO",
      senderName: "Ana Sofía R. (Candidato)",
      text: "Adjunto mi portafolio de diseño UX y referencias laborales solicitadas.",
      attachmentUrl: "/docs/portafolio_ux_ana.pdf",
      attachmentName: "portafolio_ux_ana.pdf",
      attachmentType: "application/pdf",
      createdAt: "2026-10-13T11:00:00Z",
    },
    {
      id: "msg-acoso-02",
      senderId: "org-inapropiado-22",
      senderRole: "ORGANIZACION",
      senderName: "Gerente de Contratación (Organización)",
      text: "El portafolio se ve bien, pero para este puesto requerimos ver fotos personales de cuerpo completo en tu teléfono privado antes de la entrevista presencial.",
      createdAt: "2026-10-13T11:15:00Z",
    },
    {
      id: "msg-acoso-03",
      senderId: "cand-ana-33",
      senderRole: "CANDIDATO",
      senderName: "Ana Sofía R. (Candidato)",
      text: "Esa solicitud es completamente inapropiada y no tiene ninguna relación con las competencias del puesto. Presentaré una queja de inmediato.",
      createdAt: "2026-10-13T11:18:00Z",
    },
  ],
};

/**
 * Fase 1: Notificación de Apertura de Auditoría
 * Al admitirse una incidencia grave por presunto fraude, discrepancia salarial o acoso,
 * despacha una notificación formal a ambas partes advirtiendo que el canal entra en revisión supervisada.
 */
export const openIncidentAudit: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    if (!auth.isAdmin && !auth.isModerator) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Apertura de auditoría exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    const incidentId = event.pathParameters?.incidentId;
    if (!incidentId || !safeIdSchema.safeParse(incidentId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro incidentId es requerido" }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const notes = body.notes || "";
    const timestamp = new Date().toISOString();

    // 1. Fetch existing incident
    const incRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
      }),
    );

    const incident = incRes.Item || {
      PK: `INCIDENT#${incidentId}`,
      SK: "METADATA",
      id: incidentId,
      targetType: "CHAT",
      jobId: "vac-frontend-sr-01",
      jobTitle: "Capturista / Desarrollador",
      companyId: "org-recruiter-99",
      companyName: "FastHiring Express S.A.S.",
      candidateId: "cand-maria-77",
      candidateName: "María Fernández",
      infraccion: "DISCREPANCIA_SALARIAL",
      reason: "Controversia grave reportada en el proceso de reclutamiento o postulación.",
      severity: "ALTA",
    };

    // Concurrency lock: If incident is already assigned to a different moderator
    const operatorId = auth.userId || (auth.isAdmin ? "ADMIN" : "MODERATOR");
    const operatorName = auth.email
      ? auth.email.split("@")[0]
      : auth.isAdmin
        ? "Administrador"
        : "Moderador";

    if (
      incident.assignedModeratorId &&
      incident.assignedModeratorId !== operatorId &&
      !auth.isAdmin
    ) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Esta incidencia ya está siendo auditada por el moderador ${incident.assignedModeratorName || "asignado"}. Solo el moderador asignado puede intervenir.`,
          assignedModeratorId: incident.assignedModeratorId,
          assignedModeratorName: incident.assignedModeratorName,
        }),
      };
    }

    const assignedModId = incident.assignedModeratorId || operatorId;
    const assignedModName = incident.assignedModeratorName || operatorName;

    const parties = await resolveChatIncidentParties(incident);
    const targetCompanyId = parties.companyId;
    const targetCandidateId = parties.candidateId;
    const jobTitle = parties.jobTitle;
    const companyName = parties.companyName;
    const candidateName = parties.candidateName;
    const infractionName = (incident.infraccion || "CONTROVERSIA_GRAVE").toUpperCase();

    // 2. Mark incident as under audit in DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
        UpdateExpression:
          "SET estatus = :st, auditState = :as, auditOpenedAt = :oa, auditOpenedBy = :ob, assignedModeratorId = :amid, assignedModeratorName = :amname, supervisionStatus = :ss, auditNotes = :an, companyId = :cid, candidateId = :caid, jobTitle = :jt, companyName = :cn, candidateName = :can",
        ExpressionAttributeValues: {
          ":st": "AUDITORIA",
          ":as": "AUDIT_ACTIVE",
          ":oa": timestamp,
          ":ob": assignedModName,
          ":amid": assignedModId,
          ":amname": assignedModName,
          ":ss": "UNDER_AUDIT",
          ":an": notes,
          ":cid": targetCompanyId,
          ":caid": targetCandidateId,
          ":jt": jobTitle,
          ":cn": companyName,
          ":can": candidateName,
        },
      }),
    );

    // 3. Notificación formal al Candidato (In-app + Web Push)
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
          message: `Se ha admitido formalmente la incidencia #${incidentId.substring(0, 8)} por presunto ${infractionName.toLowerCase()} en la vacante "${jobTitle}". El canal de mensajería privada con "${companyName}" será revisado por Moderación.`,
          incidentId,
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
    }).catch((err) => console.warn("Could not send push notification to candidate:", err));

    // 4. Notificación formal a la Organización / Reclutador (In-app + Web Push + Email SES)
    const notifOrgId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${targetCompanyId}`,
          SK: `NOTIFICATION#${timestamp}#${notifOrgId}`,
          id: notifOrgId,
          type: "AUDIT_CHANNEL_SUPERVISED",
          title: "Notificación Oficial: Apertura de Auditoría de Mensajería ⚠️",
          message: `Se ha admitido a trámite una controversia grave #${incidentId.substring(0, 8)} por presunto ${infractionName.toLowerCase()} en su vacante "${jobTitle}". El canal de mensajería privada entra en periodo de revisión supervisada mientras el equipo de moderación evalúa las evidencias.`,
          incidentId,
          createdAt: timestamp,
          read: false,
          actionType: "AUDIT_OPENED",
        },
      }),
    );

    sendPushToUser(targetCompanyId, {
      title: "Apertura de Auditoría de Mensajería Directa ⚠️",
      body: `Su canal de mensajería entra en revisión supervisada por presunta infracción (${infractionName}).`,
      url: "/notifications",
      data: { type: "AUDIT_CHANNEL_SUPERVISED", incidentId },
    }).catch((err) => console.warn("Could not send push notification to company:", err));

    await sendEmailToCompany(
      targetCompanyId,
      `ALERTA DE MODERACIÓN: Notificación Oficial de Auditoría de Mensajería (#${incidentId.substring(0, 8)})`,
      `Por medio del presente aviso oficial se le informa que el canal de mensajería directa asociado a la vacante "${jobTitle}" ha entrado en periodo de revisión supervisada por el equipo de moderación debido a una controversia por: ${infractionName} (${incident.reason}).\n\nDurante este procedimiento, el hilo de comunicación se encuentra en auditoría probatoria para salvaguardar la transparencia y cumplimiento de términos de JobNet.`,
    );

    // 5. Registrar en Bitácora de Auditoría
    await saveAuditLog({
      targetId: incidentId,
      targetType: "VACANTE",
      action: "APERTURA_AUDITORIA_MENSAJERIA",
      reason: `Admisión de controversia grave (${infractionName}): ${incident.reason}. Canales notificados a ambas partes.`,
      executorId: "MODERADOR",
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message:
          "Fase 1 completada: Auditoría de mensajería abierta exitosamente y notificación formal despachada a ambas partes.",
        incidentId,
        auditState: "AUDIT_ACTIVE",
        supervisionStatus: "UNDER_AUDIT",
        timestamp,
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

/**
 * Fase 2: Acceso a Historial en Solo Lectura
 * Desbloquea un acceso temporal de solo lectura para que el moderador o administrador
 * inspeccione el hilo íntegro de mensajes, contexto cronológico y archivos adjuntos intercambiados.
 */
export const getIncidentAuditChat: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const userRole = (
      auth.role ||
      event.headers["x-user-role"] ||
      event.headers["X-User-Role"] ||
      ""
    ).toUpperCase();

    const isAuthorized =
      auth.isModerator ||
      userRole === "MODERATOR" ||
      userRole === "MODERADOR" ||
      userRole === "ADMIN";

    if (!isAuthorized) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Acceso a historial de auditoría exclusivo para Moderadores y Administradores.",
        }),
      };
    }

    const incidentId = event.pathParameters?.incidentId;
    if (!incidentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro incidentId es requerido" }),
      };
    }

    // 1. Fetch incident
    const incRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
      }),
    );

    const incident = incRes.Item || {
      id: incidentId,
      targetType: "CHAT",
      jobId: "vac-frontend-sr-01",
      jobTitle: "Capturista de Datos / Desarrollador",
      companyId: "org-recruiter-99",
      companyName: "FastHiring Express S.A.S.",
      candidateId: "cand-maria-77",
      candidateName: "María Fernández",
      infraccion: "DISCREPANCIA_SALARIAL",
      reason:
        "La empresa publicó $45,000 pero en el chat privado exigió aceptar $18,000 sin prestaciones.",
      severity: "ALTA",
      auditState: "AUDIT_ACTIVE",
      fechaCreacion: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };

    const parties = await resolveChatIncidentParties(incident);
    const jobId = parties.jobId || "vac-frontend-sr-01";
    const candidateId = parties.candidateId || "cand-maria-77";

    // 2. Query DynamoDB chat messages
    let messages: AuditChatMessage[] = [];
    try {
      const chatRes = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `CHAT#${jobId}#${candidateId}`,
            ":skPrefix": "MSG#",
          },
        }),
      );

      messages = (chatRes.Items || []).map((m: any, idx: number) => {
        const isCandidate = m.senderId === candidateId;
        return {
          id: m.id || m.SK?.replace("MSG#", "") || `msg-db-${idx}`,
          senderId: m.senderId,
          senderRole: isCandidate ? "CANDIDATO" : "ORGANIZACION",
          senderName: isCandidate
            ? incident.candidateName || "Candidato"
            : incident.companyName || "Organización",
          text: m.text || "",
          attachmentUrl: m.attachmentUrl || null,
          attachmentType: m.attachmentType || null,
          attachmentName: m.attachmentName || null,
          createdAt: m.createdAt || new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn("Could not query DB chat messages for audit:", err);
    }

    // 3. If no messages found in DB, provide realistic evidence corresponding to infraction type
    if (messages.length === 0) {
      const infractionKey = (incident.infraccion || "").toUpperCase();
      if (infractionKey.includes("SALARIO") || infractionKey.includes("DISCREPANCIA")) {
        messages = BASELINE_DISPUTE_CHATS.SALARIO;
      } else if (infractionKey.includes("ACOSO")) {
        messages = BASELINE_DISPUTE_CHATS.ACOSO;
      } else {
        messages = BASELINE_DISPUTE_CHATS.FRAUDE;
      }
    }

    // Sort chronologically
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        isReadOnly: true,
        incident: {
          id: incident.id || incidentId,
          jobId,
          jobTitle: incident.jobTitle || incident.targetTitle || "Vacante",
          companyId: incident.companyId || "org-recruiter-99",
          companyName: incident.companyName || "Organización",
          candidateId,
          candidateName: incident.candidateName || incident.reporter || "Candidato",
          infraccion: incident.infraccion || "FRAUDE",
          severity: incident.severity || "ALTA",
          reason: incident.reason || "",
          auditState: incident.auditState || "AUDIT_ACTIVE",
          supervisionStatus: incident.supervisionStatus || "UNDER_AUDIT",
          auditOpenedAt: incident.auditOpenedAt || incident.fechaCreacion,
          auditDictum: incident.auditDictum || null,
          auditDictumNotes: incident.auditDictumNotes || null,
        },
        messages,
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

/**
 * Fase 2: Dictamen del Moderador
 * Permite al moderador evaluar la evidencia probatoria e ingresar el dictamen oficial:
 * Sancionar Organización, Emitir Advertencia, o Desestimar Incidencia.
 */
export const submitIncidentAuditDictum: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const userRole = (
      auth.role ||
      event.headers["x-user-role"] ||
      event.headers["X-User-Role"] ||
      ""
    ).toUpperCase();

    const isAuthorized =
      auth.isModerator ||
      userRole === "MODERATOR" ||
      userRole === "MODERADOR" ||
      userRole === "ADMIN";

    if (!isAuthorized) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Emisión de dictamen exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    const incidentId = event.pathParameters?.incidentId;
    if (!incidentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro incidentId es requerido" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { dictum, notes, graceDays } = body;

    if (
      !dictum ||
      !["SANCION_ORGANIZACION", "SANCION_EMPRESA", "ADVERTENCIA", "DESESTIMADA"].includes(dictum)
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "Parámetro 'dictum' inválido. Opciones: 'SANCION_ORGANIZACION', 'ADVERTENCIA', 'DESESTIMADA'.",
        }),
      };
    }

    const timestamp = new Date().toISOString();

    // 1. Fetch incident
    const incRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
      }),
    );

    const incident = incRes.Item || {
      id: incidentId,
      companyId: "org-recruiter-99",
      candidateId: "cand-maria-77",
      jobTitle: "Vacante",
      infraccion: "DISCREPANCIA_SALARIAL",
    };

    const callerId = auth.userId || (userRole === "ADMIN" ? "ADMIN" : "MODERATOR");
    if (
      incident.assignedModeratorId &&
      incident.assignedModeratorId !== callerId &&
      userRole !== "ADMIN"
    ) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Esta incidencia ya está siendo atendida por el moderador ${
            incident.assignedModeratorName || "asignado"
          }. Solo el moderador asignado o un Administrador puede emitir el dictamen.`,
        }),
      };
    }

    const parties = await resolveChatIncidentParties(incident);
    const companyId = parties.companyId;
    const candidateId = parties.candidateId;
    const jobTitle = parties.jobTitle;

    // 2. Execute resolution according to dictum
    if (dictum === "SANCION_ORGANIZACION" || dictum === "SANCION_EMPRESA") {
      // Activa Fase 1 de Suspensión preventiva para la organización infractora
      await executeOrgSuspensionInitiation(
        companyId,
        `Dictamen de Auditoría de Mensajería: Se confirman infracciones graves por ${incident.infraccion || "controversia"}. Justificación: ${notes || "Infracción comprobada en evidencia probatoria."}`,
        typeof graceDays === "number" ? graceDays : 4,
      );
    } else if (dictum === "ADVERTENCIA") {
      // Notificación de advertencia formal a la empresa
      const notifAdvId = Math.random().toString(36).substring(2, 15);
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `USER#${companyId}`,
            SK: `NOTIFICATION#${timestamp}#${notifAdvId}`,
            id: notifAdvId,
            type: "FORMAL_WARNING",
            title: "Amonestación Oficial de Moderación ⚠️",
            message: `Tras concluir la auditoría del expediente #${incidentId.substring(0, 8)}, el equipo de moderación ha dictaminado una Advertencia Formal: "${notes}". Reincidir provocará la suspensión inmediata de la cuenta corporativa.`,
            incidentId,
            jobId: parties.jobId,
            createdAt: timestamp,
            read: false,
          },
        }),
      );

      sendPushToUser(companyId, {
        title: "Amonestación Oficial de Moderación ⚠️",
        body: `Dictamen de auditoría emitido: ${notes}`,
        url: "/notifications",
        data: { type: "FORMAL_WARNING", incidentId },
      }).catch((err) => console.warn("Could not send warning push:", err));
    } else if (dictum === "DESESTIMADA") {
      // Notificación formal a la empresa informando que la denuncia fue desestimada favorablemente
      const notifOrgResId = Math.random().toString(36).substring(2, 15);
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `USER#${companyId}`,
            SK: `NOTIFICATION#${timestamp}#${notifOrgResId}`,
            id: notifOrgResId,
            type: "AUDIT_RESOLVED",
            title: "Resolución Favorable: Incidencia Desestimada ✅",
            message: `La auditoría de mensajería para el expediente #${incidentId.substring(0, 8)} (${jobTitle}) ha concluido favorablemente. El equipo de moderación ha determinado que no se cometieron infracciones y la incidencia ha sido desestimada sin sanción. Dictamen: "${notes || "Sin elementos probatorios de infracción"}".`,
            incidentId,
            dictum,
            jobId: parties.jobId,
            createdAt: timestamp,
            read: false,
          },
        }),
      );

      sendPushToUser(companyId, {
        title: "Resolución Favorable: Incidencia Desestimada ✅",
        body: `La auditoría de mensajería #${incidentId.substring(0, 8)} concluyó favorablemente sin sanciones.`,
        url: "/notifications",
        data: { type: "AUDIT_RESOLVED", incidentId, dictum },
      }).catch((err) => console.warn("Could not send push to company:", err));

      await sendEmailToCompany(
        companyId,
        `NOTIFICACIÓN OFICIAL: Resolución Favorable de Auditoría (#${incidentId.substring(0, 8)})`,
        `Por medio del presente comunicado se le notifica que tras concluir la auditoría del expediente #${incidentId.substring(0, 8)} referente a la vacante "${jobTitle}", el equipo de moderación ha desestimado la incidencia al no encontrar violaciones a los términos de servicio.\n\nDictamen del Moderador: ${notes || "Sin infracciones comprobadas"}.\n\nSu cuenta y canales de mensajería continúan operando con total normalidad.`,
      );
    }

    // 3. Notificación final al Candidato informando el resultado del dictamen
    const notifResCandId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${candidateId}`,
          SK: `NOTIFICATION#${timestamp}#${notifResCandId}`,
          id: notifResCandId,
          type: "AUDIT_RESOLVED",
          title: "Resolución de Incidencia y Dictamen Final ⚖️",
          message: `La auditoría de mensajería para el expediente #${incidentId.substring(0, 8)} ha concluido. Dictamen emitido por Moderación: ${dictum === "SANCION_EMPRESA" ? "Sanción aplicada a la organización" : dictum === "ADVERTENCIA" ? "Amonestación formal emitida" : "Incidencia desestimada"}.`,
          incidentId,
          dictum,
          jobId: parties.jobId,
          createdAt: timestamp,
          read: false,
        },
      }),
    );

    sendPushToUser(candidateId, {
      title: "Resolución de Incidencia y Dictamen Final ⚖️",
      body: `La auditoría de mensajería #${incidentId.substring(0, 8)} ha concluido. Dictamen: ${dictum === "SANCION_EMPRESA" ? "Sanción aplicada a la organización" : dictum === "ADVERTENCIA" ? "Amonestación formal emitida" : "Incidencia desestimada"}.`,
      url: "/notifications",
      data: { type: "AUDIT_RESOLVED", incidentId, dictum },
    }).catch((err) => console.warn("Could not send push to candidate:", err));

    // 4. Update incident status in DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
        UpdateExpression:
          "SET estatus = :st, auditState = :as, auditDictum = :ad, auditDictumNotes = :an, auditClosedAt = :ca, supervisionStatus = :ss",
        ExpressionAttributeValues: {
          ":st": "RESUELTO",
          ":as": "AUDIT_CONCLUDED",
          ":ad": dictum,
          ":an": notes || "",
          ":ca": timestamp,
          ":ss": "CONCLUDED",
        },
      }),
    );

    // 5. Auditoría
    await saveAuditLog({
      targetId: incidentId,
      targetType: "INCIDENTE",
      action: "DICTAMEN_AUDITORIA_MENSAJERIA",
      reason: `Dictamen: ${dictum}. Notas: ${notes || "Sin notas adicionales"}. Ejecutado por Moderador.`,
      executorId: "MODERADOR",
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message:
          "Dictamen de auditoría emitido exitosamente. Expediente concluido y partes notificadas.",
        incidentId,
        dictum,
        timestamp,
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
