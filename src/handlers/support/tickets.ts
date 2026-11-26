import { APIGatewayProxyHandler } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers, broadcastSupportEvent } from "../moderator/common";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody } from "../../utils/validator";
import { notifyAllModerators } from "../../utils/moderatorNotifier";
import { sendPushToUser } from "../../utils/webPushService";

/**
 * Creates a new support ticket / problem report.
 * Called by CANDIDATO or ORGANIZACION.
 */
export const createSupportTicket: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated || !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado. Inicie sesión para reportar un problema." }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }

    const body = parseResult.data;
    const { subject, category, description, attachments } = body;

    if (!subject || typeof subject !== "string" || subject.trim().length < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "El asunto es requerido (mínimo 3 caracteres)." }),
      };
    }

    if (!description || typeof description !== "string" || description.trim().length < 5) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "La descripción es requerida (mínimo 5 caracteres)." }),
      };
    }

    const ticketId = `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = new Date().toISOString();

    const callerRole = (auth.role || "CANDIDATO").toUpperCase();
    const callerEmail = auth.email || "usuario@jobnet.com";
    const callerName =
      body.userName ||
      body.name ||
      event.headers?.["x-user-name"] ||
      event.headers?.["X-User-Name"] ||
      (callerEmail.includes("@") ? callerEmail.split("@")[0] : "Usuario");

    const validCategory = ["FALLO_TECNICO", "DUDA_GENERAL", "PROBLEMA_CUENTA", "OTRO"].includes(
      category,
    )
      ? category
      : "FALLO_TECNICO";

    const cleanAttachments = Array.isArray(attachments)
      ? attachments.filter((a) => a && typeof a.url === "string")
      : [];

    // 1. Create Ticket Metadata Record
    const ticketMetadata = {
      PK: `SUPPORT#${ticketId}`,
      SK: "METADATA",
      ticketId,
      id: ticketId,
      userId: auth.userId,
      userEmail: callerEmail,
      userName: callerName,
      userRole: callerRole,
      subject: subject.trim(),
      category: validCategory,
      description: description.trim(),
      status: "ABIERTO",
      assignedModeratorId: null,
      assignedModeratorName: null,
      assignedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessage: description.trim(),
      lastMessageAt: timestamp,
      lastSenderRole: "USER",
      lastSenderId: auth.userId,
      GSI1PK: "SUPPORT_TICKETS",
      GSI1SK: `STATUS#ABIERTO#DATE#${timestamp}`,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: ticketMetadata,
      }),
    );

    // 2. Insert First Message in Thread
    const firstMsgId = `msg-${Date.now()}`;
    const initialMessage = {
      PK: `SUPPORT#${ticketId}`,
      SK: `MSG#${timestamp}#${firstMsgId}`,
      messageId: firstMsgId,
      ticketId,
      senderId: auth.userId,
      senderName: callerName,
      senderRole: "USER",
      text: description.trim(),
      message: description.trim(),
      attachments: cleanAttachments,
      createdAt: timestamp,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: initialMessage,
      }),
    );

    // 3. Notify ALL Moderators about the new Problem Report
    notifyAllModerators({
      title: "Nuevo Reporte de Problema ⚠️",
      message: `${callerName} (${callerRole}) ha reportado: "${subject.trim()}".`,
      type: "NEW_SUPPORT_TICKET",
      url: "/mod/support",
      data: { ticketId, category: validCategory },
    }).catch((err) => console.error("Error notifying moderators about support ticket:", err));

    // 4. Broadcast new ticket via WebSocket to all connected moderators and the creator
    const targetKeys: string[] = ["ROLE#MODERATOR", `USER#${auth.userId}`];
    await broadcastSupportEvent(
      targetKeys,
      {
        type: "SUPPORT_TICKET_CREATED",
        action: "receiveSupportTicketCreated",
        ticket: ticketMetadata,
      },
      event,
    ).catch((err) => console.warn("Failed to broadcast support ticket creation:", err));

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        message: "Ticket de soporte creado exitosamente",
        ticket: ticketMetadata,
      }),
    };
  } catch (error: any) {
    console.error("Error creating support ticket:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Returns all tickets submitted by the authenticated user.
 */
export const getMySupportTickets: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated || !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado" }),
      };
    }

    const userEmail =
      auth.email || event.headers?.["x-user-email"] || event.headers?.["X-User-Email"] || "";

    const res = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: userEmail
          ? "SK = :sk AND begins_with(PK, :prefix) AND (userId = :uid OR userEmail = :uemail)"
          : "SK = :sk AND begins_with(PK, :prefix) AND userId = :uid",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "SUPPORT#",
          ":uid": auth.userId,
          ...(userEmail ? { ":uemail": userEmail } : {}),
        },
      }),
    );

    const tickets = (res.Items || []).sort(
      (a: any, b: any) =>
        new Date(b.lastMessageAt || b.createdAt).getTime() -
        new Date(a.lastMessageAt || a.createdAt).getTime(),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(tickets),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Returns all community support tickets.
 * Only accessible to MODERATOR or ADMIN.
 */
export const getAllSupportTickets: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      ""
    ).toUpperCase();

    const isModerator =
      auth.isAdmin ||
      auth.isModerator ||
      headerRole === "MODERATOR" ||
      headerRole === "MODERADOR" ||
      headerRole === "ADMIN";

    if (!isModerator) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Consulta de soporte exclusiva para Moderadores y Administradores.",
        }),
      };
    }

    // Try GSI1 first
    let tickets: any[] = [];
    try {
      const gsiRes = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :gsiPk",
          ExpressionAttributeValues: {
            ":gsiPk": "SUPPORT_TICKETS",
          },
          ScanIndexForward: false,
        }),
      );
      if (gsiRes.Items && gsiRes.Items.length > 0) {
        tickets = gsiRes.Items;
      }
    } catch {
      // Fallback to Scan
    }

    if (tickets.length === 0) {
      const scanRes = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "SK = :sk AND begins_with(PK, :prefix)",
          ExpressionAttributeValues: {
            ":sk": "METADATA",
            ":prefix": "SUPPORT#",
          },
        }),
      );
      tickets = scanRes.Items || [];
    }

    tickets.sort(
      (a: any, b: any) =>
        new Date(b.lastMessageAt || b.createdAt).getTime() -
        new Date(a.lastMessageAt || a.createdAt).getTime(),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(tickets),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Returns all messages within a specific support ticket.
 */
export const getSupportTicketMessages: APIGatewayProxyHandler = async (event) => {
  try {
    const ticketId = event.pathParameters?.ticketId;
    if (!ticketId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro ticketId es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      ""
    ).toUpperCase();

    const isPrivileged =
      auth.isAdmin ||
      auth.isModerator ||
      headerRole === "MODERATOR" ||
      headerRole === "MODERADOR" ||
      headerRole === "ADMIN";

    // 1. Fetch ticket to verify ownership if caller is regular user
    const ticketRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `SUPPORT#${ticketId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!ticketRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Ticket de soporte no encontrado" }),
      };
    }

    const ticket = ticketRes.Item;
    const isOwner =
      auth.userId === ticket.userId || (auth.email && auth.email === ticket.userEmail);
    if (!isPrivileged && !isOwner) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "No tienes permiso para ver los mensajes de este ticket." }),
      };
    }

    // 2. Fetch all messages in chronological order
    const msgsRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `SUPPORT#${ticketId}`,
          ":skPrefix": "MSG#",
        },
        ScanIndexForward: true,
      }),
    );

    const normalizedMessages = (msgsRes.Items || []).map((m: any) => ({
      ...m,
      text: m.text || m.message || "",
      message: m.message || m.text || "",
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ticket,
        messages: normalizedMessages,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Sends a message in a support ticket.
 * Enforces atomic moderator auto-assignment and concurrency lock.
 */
export const sendSupportTicketMessage: APIGatewayProxyHandler = async (event) => {
  try {
    const ticketId = event.pathParameters?.ticketId;
    if (!ticketId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro ticketId es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated || !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado" }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }

    const body = parseResult.data;
    const text = (body.text || body.message || body.content || "").trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    if (!text && attachments.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "El mensaje no puede estar vacío" }),
      };
    }

    // 1. Fetch current ticket metadata
    const ticketRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `SUPPORT#${ticketId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!ticketRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Ticket de soporte no encontrado" }),
      };
    }

    const ticket = ticketRes.Item;
    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      auth.role ||
      ""
    ).toUpperCase();

    const isModeratorCaller =
      auth.isAdmin ||
      auth.isModerator ||
      headerRole === "MODERATOR" ||
      headerRole === "MODERADOR" ||
      headerRole === "ADMIN";

    const timestamp = new Date().toISOString();
    const callerName =
      body.senderName ||
      body.userName ||
      body.name ||
      event.headers?.["x-user-name"] ||
      event.headers?.["X-User-Name"] ||
      (auth.email && auth.email.includes("@") ? auth.email.split("@")[0] : "Moderador");

    // 2. CONCURRENCY LOCK & AUTO-ASSIGNMENT LOGIC FOR MODERATORS
    if (isModeratorCaller) {
      // If ticket is already assigned to a DIFFERENT moderator and caller is not an Admin:
      if (
        ticket.assignedModeratorId &&
        ticket.assignedModeratorId !== auth.userId &&
        !auth.isAdmin &&
        headerRole !== "ADMIN"
      ) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: `Este ticket ya está siendo atendido exclusivamente por el moderador ${
              ticket.assignedModeratorName || "asignado"
            }. No se permite la intervención concurrente para evitar respuestas duplicadas.`,
            assignedModeratorId: ticket.assignedModeratorId,
            assignedModeratorName: ticket.assignedModeratorName,
          }),
        };
      }

      // Auto-assign to current moderator if not assigned yet
      if (!ticket.assignedModeratorId) {
        ticket.assignedModeratorId = auth.userId;
        ticket.assignedModeratorName = callerName;
        ticket.assignedAt = timestamp;
        ticket.status = "EN_ATENCION";

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
            UpdateExpression:
              "SET assignedModeratorId = :mid, assignedModeratorName = :mname, assignedAt = :mat, #st = :status, GSI1SK = :gsiSk, updatedAt = :u",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
              ":mid": auth.userId,
              ":mname": callerName,
              ":mat": timestamp,
              ":status": "EN_ATENCION",
              ":gsiSk": `STATUS#EN_ATENCION#DATE#${timestamp}`,
              ":u": timestamp,
            },
          }),
        );
      }
    } else {
      // Caller is regular user (CANDIDATO / ORGANIZACION) - must be the ticket owner
      const isOwner =
        auth.userId === ticket.userId || (auth.email && auth.email === ticket.userEmail);
      if (!isOwner) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: "No tienes permiso para responder en este ticket." }),
        };
      }
    }

    // 3. Save Message Record
    const msgId = `msg-${Date.now()}`;
    const newMsgItem = {
      PK: `SUPPORT#${ticketId}`,
      SK: `MSG#${timestamp}#${msgId}`,
      messageId: msgId,
      ticketId,
      senderId: auth.userId,
      senderName: callerName,
      senderRole: isModeratorCaller ? "MODERATOR" : "USER",
      text,
      message: text,
      attachments,
      createdAt: timestamp,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: newMsgItem,
      }),
    );

    // 4. Update Ticket lastMessage
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
        UpdateExpression:
          "SET lastMessage = :lm, lastMessageAt = :lmat, lastSenderRole = :lsr, lastSenderId = :lsid, updatedAt = :u",
        ExpressionAttributeValues: {
          ":lm": text || "Archivo adjunto",
          ":lmat": timestamp,
          ":lsr": isModeratorCaller ? "MODERATOR" : "USER",
          ":lsid": auth.userId,
          ":u": timestamp,
        },
      }),
    );

    // 5. Notifications
    if (isModeratorCaller) {
      // Notify ticket owner that moderator replied
      const notifId = Math.random().toString(36).substring(2, 15);
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `USER#${ticket.userId}`,
            SK: `NOTIFICATION#${timestamp}#${notifId}`,
            id: notifId,
            type: "SUPPORT_TICKET_REPLY",
            title: "Respuesta de Soporte JobNet 💬",
            message: `El moderador ${callerName} ha respondido a tu ticket: "${ticket.subject}".`,
            ticketId,
            url: "/support",
            createdAt: timestamp,
            read: false,
          },
        }),
      );

      await sendPushToUser(ticket.userId, {
        title: "Respuesta de Soporte JobNet 💬",
        body: `El moderador ha respondido a tu reporte: "${ticket.subject}".`,
        url: "/support",
        data: { type: "SUPPORT_TICKET_REPLY", ticketId },
      }).catch((e) => console.warn("Failed to send push to ticket owner:", e));
    } else {
      // User sent a message: notify assigned moderator, or all moderators if unassigned
      if (ticket.assignedModeratorId) {
        await sendPushToUser(ticket.assignedModeratorId, {
          title: `Nuevo mensaje en ticket: "${ticket.subject}"`,
          body: `${callerName}: ${text.substring(0, 80)}`,
          url: "/mod/support",
          data: { type: "SUPPORT_TICKET_USER_MESSAGE", ticketId },
        }).catch((e) => console.warn("Failed to push to assigned moderator:", e));
      } else {
        await notifyAllModerators({
          title: `Mensaje de usuario en ticket: "${ticket.subject}"`,
          message: `${callerName}: ${text.substring(0, 80)}`,
          type: "SUPPORT_TICKET_USER_MESSAGE",
          url: "/mod/support",
          data: { ticketId },
        }).catch((e) => console.warn("Failed to notify moderators:", e));
      }
    }

    // 6. Broadcast Real-time Message via WebSocket
    const targetKeys: string[] = [`USER#${ticket.userId}`, "ROLE#MODERATOR"];
    if (ticket.assignedModeratorId && !targetKeys.includes(`USER#${ticket.assignedModeratorId}`)) {
      targetKeys.push(`USER#${ticket.assignedModeratorId}`);
    }

    try {
      const userProfile = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `USER#${ticket.userId}`, SK: "PROFILE" },
        }),
      );
      const ownerSub = userProfile.Item?.sub || userProfile.Item?.cognitoSub;
      if (ownerSub && ownerSub !== ticket.userId && !targetKeys.includes(`USER#${ownerSub}`)) {
        targetKeys.push(`USER#${ownerSub}`);
      }
    } catch {
      // Non-critical
    }

    await broadcastSupportEvent(
      targetKeys,
      {
        type: "SUPPORT_TICKET_MESSAGE",
        action: "receiveSupportMessage",
        ticketId,
        message: newMsgItem,
        assignedModeratorId: ticket.assignedModeratorId || null,
        assignedModeratorName: ticket.assignedModeratorName || null,
        status: ticket.status || "EN_ATENCION",
      },
      event,
      auth.userId,
    ).catch((err) => console.warn("Failed to broadcast support message:", err));

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        status: "ok",
        message: newMsgItem,
        msg: newMsgItem,
        assignedModeratorId: ticket.assignedModeratorId,
        assignedModeratorName: ticket.assignedModeratorName,
      }),
    };
  } catch (error: any) {
    console.error("Error sending support ticket message:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Manually claims or releases a support ticket.
 * Ensures strict concurrency lock.
 */
export const claimSupportTicket: APIGatewayProxyHandler = async (event) => {
  try {
    const ticketId = event.pathParameters?.ticketId;
    if (!ticketId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro ticketId es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      auth.role ||
      ""
    ).toUpperCase();

    const isModerator =
      auth.isAdmin ||
      auth.isModerator ||
      headerRole === "MODERATOR" ||
      headerRole === "MODERADOR" ||
      headerRole === "ADMIN";

    if (!isModerator || !auth.userId) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "Acceso exclusivo para Moderadores y Administradores." }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    const body = parseResult.success ? parseResult.data : {};
    const action = body.action === "release" ? "release" : "claim";

    const ticketRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
      }),
    );

    if (!ticketRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Ticket de soporte no encontrado" }),
      };
    }

    const ticket = ticketRes.Item;
    const timestamp = new Date().toISOString();
    const callerName =
      body.senderName ||
      body.userName ||
      body.name ||
      event.headers?.["x-user-name"] ||
      event.headers?.["X-User-Name"] ||
      (auth.email && auth.email.includes("@") ? auth.email.split("@")[0] : "Moderador");

    if (action === "claim") {
      if (
        ticket.assignedModeratorId &&
        ticket.assignedModeratorId !== auth.userId &&
        !auth.isAdmin &&
        headerRole !== "ADMIN"
      ) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: `El ticket ya fue tomado por el moderador ${ticket.assignedModeratorName}.`,
            assignedModeratorId: ticket.assignedModeratorId,
            assignedModeratorName: ticket.assignedModeratorName,
          }),
        };
      }

      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
          UpdateExpression:
            "SET assignedModeratorId = :mid, assignedModeratorName = :mname, assignedAt = :mat, #st = :status, GSI1SK = :gsiSk, updatedAt = :u",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":mid": auth.userId,
            ":mname": callerName,
            ":mat": timestamp,
            ":status": "EN_ATENCION",
            ":gsiSk": `STATUS#EN_ATENCION#DATE#${timestamp}`,
            ":u": timestamp,
          },
        }),
      );

      await broadcastSupportEvent(
        [`USER#${ticket.userId}`, "ROLE#MODERATOR"],
        {
          type: "SUPPORT_TICKET_CLAIMED",
          action: "receiveSupportTicketClaimed",
          ticketId,
          assignedModeratorId: auth.userId,
          assignedModeratorName: callerName,
          status: "EN_ATENCION",
        },
        event,
      ).catch((err) => console.warn("Failed to broadcast claim event:", err));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: "Ticket asignado exitosamente",
          assignedModeratorId: auth.userId,
          assignedModeratorName: callerName,
          status: "EN_ATENCION",
        }),
      };
    } else {
      // Release
      if (
        ticket.assignedModeratorId &&
        ticket.assignedModeratorId !== auth.userId &&
        !auth.isAdmin &&
        headerRole !== "ADMIN"
      ) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: "Solo el moderador asignado o un Administrador puede liberar este ticket.",
          }),
        };
      }

      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
          UpdateExpression:
            "SET assignedModeratorId = :nullVal, assignedModeratorName = :nullVal, assignedAt = :nullVal, #st = :status, GSI1SK = :gsiSk, updatedAt = :u",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":nullVal": null,
            ":status": "ABIERTO",
            ":gsiSk": `STATUS#ABIERTO#DATE#${timestamp}`,
            ":u": timestamp,
          },
        }),
      );

      await broadcastSupportEvent(
        [`USER#${ticket.userId}`, "ROLE#MODERATOR"],
        {
          type: "SUPPORT_TICKET_CLAIMED",
          action: "receiveSupportTicketClaimed",
          ticketId,
          assignedModeratorId: null,
          assignedModeratorName: null,
          status: "ABIERTO",
        },
        event,
      ).catch((err) => console.warn("Failed to broadcast release event:", err));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: "Ticket liberado para que otro moderador lo atienda",
          status: "ABIERTO",
        }),
      };
    }
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * Resolves / closes a support ticket.
 */
export const resolveSupportTicket: APIGatewayProxyHandler = async (event) => {
  try {
    const ticketId = event.pathParameters?.ticketId;
    if (!ticketId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Parámetro ticketId es requerido" }),
      };
    }

    const auth = await extractAuthContext(event);
    const headerRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      auth.role ||
      ""
    ).toUpperCase();

    const isModerator =
      auth.isAdmin ||
      auth.isModerator ||
      headerRole === "MODERATOR" ||
      headerRole === "MODERADOR" ||
      headerRole === "ADMIN";

    if (!isModerator || !auth.userId) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "Acceso exclusivo para Moderadores y Administradores." }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    const body = parseResult.success ? parseResult.data : {};
    const notes =
      body.resolutionNotes ||
      body.notes ||
      body.message ||
      "Problema resuelto satisfactoriamente por soporte.";

    const ticketRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
      }),
    );

    if (!ticketRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Ticket de soporte no encontrado" }),
      };
    }

    const ticket = ticketRes.Item;
    if (
      ticket.assignedModeratorId &&
      ticket.assignedModeratorId !== auth.userId &&
      !auth.isAdmin &&
      headerRole !== "ADMIN"
    ) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Solo el moderador asignado (${ticket.assignedModeratorName}) o un Administrador puede cerrar este caso.`,
        }),
      };
    }

    const timestamp = new Date().toISOString();

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `SUPPORT#${ticketId}`, SK: "METADATA" },
        UpdateExpression:
          "SET #st = :status, resolutionNotes = :rn, resolvedAt = :ra, GSI1SK = :gsiSk, updatedAt = :u",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":status": "RESUELTO",
          ":rn": notes,
          ":ra": timestamp,
          ":gsiSk": `STATUS#RESUELTO#DATE#${timestamp}`,
          ":u": timestamp,
        },
      }),
    );

    // Notify ticket owner
    const notifId = Math.random().toString(36).substring(2, 15);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${ticket.userId}`,
          SK: `NOTIFICATION#${timestamp}#${notifId}`,
          id: notifId,
          type: "SUPPORT_TICKET_RESOLVED",
          title: "Ticket de Soporte Resuelto ✅",
          message: `Tu ticket "${ticket.subject}" ha sido marcado como Resuelto: "${notes}".`,
          ticketId,
          url: "/support",
          createdAt: timestamp,
          read: false,
        },
      }),
    );

    sendPushToUser(ticket.userId, {
      title: "Ticket de Soporte Resuelto ✅",
      body: `Tu reporte "${ticket.subject}" ha sido resuelto.`,
      url: "/support",
      data: { type: "SUPPORT_TICKET_RESOLVED", ticketId },
    }).catch((e) => console.warn("Failed to push resolution:", e));

    // Insert resolution message into thread
    const resolutionMsgId = `msg-${Date.now()}`;
    const resolutionMsgItem = {
      PK: `SUPPORT#${ticketId}`,
      SK: `MSG#${timestamp}#${resolutionMsgId}`,
      messageId: resolutionMsgId,
      ticketId,
      senderId: auth.userId,
      senderName: ticket.assignedModeratorName || "Moderador",
      senderRole: "MODERATOR",
      text: `[Caso Resuelto]: ${notes}`,
      message: `[Caso Resuelto]: ${notes}`,
      createdAt: timestamp,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: resolutionMsgItem,
      }),
    );

    // Broadcast ticket resolution and resolution message in real time
    await broadcastSupportEvent(
      [`USER#${ticket.userId}`, "ROLE#MODERATOR"],
      {
        type: "SUPPORT_TICKET_RESOLVED",
        action: "receiveSupportTicketResolved",
        ticketId,
        status: "RESUELTO",
        resolutionNotes: notes,
        resolutionMessage: resolutionMsgItem,
      },
      event,
    ).catch((err) => console.warn("Failed to broadcast resolution event:", err));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Ticket de soporte resuelto exitosamente",
        status: "RESUELTO",
        resolutionNotes: notes,
        resolutionMessage: resolutionMsgItem,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
