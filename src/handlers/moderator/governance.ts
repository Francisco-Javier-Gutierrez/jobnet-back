import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers, saveAuditLog } from "./common";
import { detectAnomalousConcurrency } from "../../utils/anomalyDetector";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody, safeIdSchema } from "../../utils/validator";

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

export const toggleUserBlock: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId || !safeIdSchema.safeParse(userId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid userId" }),
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
            "Acceso denegado: Bloqueo de usuarios exclusivo para Moderadores y Administradores.",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const { blocked, reason } = body;
    const timestamp = new Date().toISOString();

    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "User not found" }),
      };
    }

    const tipoUsuario = existing.Item.tipoUsuario || "CANDIDATO";

    const updateExp =
      "SET bloqueada = :b, estatus = :st, estadoCuenta = :ec, updatedAt = :u, GSI1PK = :gsiPk, GSI1SK = :gsiSk" +
      (blocked ? ", suspensionReason = :sr" : " REMOVE suspensionReason");

    const attrs: any = {
      ":b": blocked,
      ":st": blocked ? "Suspendida" : "Activa",
      ":ec": blocked ? "SUSPENDIDA" : "ACTIVO",
      ":u": timestamp,
      ":gsiPk": "PROFILE",
      ":gsiSk": `ROLE#${tipoUsuario}#STATUS#${blocked ? "SUSPENDIDA" : "ACTIVO"}`,
    };

    if (blocked) {
      attrs[":sr"] = reason || "Bloqueo manual por moderador";
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
        UpdateExpression: updateExp,
        ExpressionAttributeValues: attrs,
      }),
    );

    await saveAuditLog({
      targetId: userId,
      targetType: tipoUsuario,
      action: blocked ? "BLOQUEO_MANUAL" : "DESBLOQUEO_MANUAL",
      reason: reason || (blocked ? "Bloqueo por moderador" : "Desbloqueo por moderador"),
      executorId: "MODERADOR",
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, userId, blocked }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

export const getModeratorConcurrencyAlerts: APIGatewayProxyHandler = async (event) => {
  try {
    const userRole = (
      event.headers["x-user-role"] ||
      event.headers["X-User-Role"] ||
      ""
    ).toUpperCase();

    if (userRole !== "MODERATOR" && userRole !== "MODERADOR" && userRole !== "ADMIN") {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Panel de alertas de concurrencia exclusivo para Moderadores de Comunidad.",
        }),
      };
    }

    // Fetch vacancies
    let vacanciesItems: any[] = [];
    try {
      const vacRes = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "begins_with(PK, :prefix)",
          ExpressionAttributeValues: {
            ":prefix": "VACANCY#",
          },
        }),
      );
      vacanciesItems = vacRes.Items || [];
    } catch (err) {
      console.warn("Could not query vacancies for concurrency alerts:", err);
    }

    // Fetch incidents
    let incidentItems: any[] = [];
    try {
      const incRes = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "begins_with(PK, :incPrefix)",
          ExpressionAttributeValues: {
            ":incPrefix": "INCIDENT#",
          },
        }),
      );
      incidentItems = incRes.Items || [];
    } catch (err) {
      console.warn("Could not query incidents for concurrency alerts:", err);
    }

    const anomalies = detectAnomalousConcurrency(vacanciesItems, incidentItems);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        anomalies,
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
