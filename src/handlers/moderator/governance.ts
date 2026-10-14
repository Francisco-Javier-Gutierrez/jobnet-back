import { APIGatewayProxyHandler } from "aws-lambda";
import {
  ScanCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  docClient,
  tableName,
  headers,
  saveAuditLog,
} from "./common";

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
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing userId" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
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
      reason:
        reason ||
        (blocked ? "Bloqueo por moderador" : "Desbloqueo por moderador"),
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
