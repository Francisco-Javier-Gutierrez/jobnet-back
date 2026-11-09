import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers, enrichProfileItem } from "./common";
import { extractAuthContext } from "../../utils/authHelper";
import { parseJsonBody, safeIdSchema } from "../../utils/validator";

export const getProfile: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id || !safeIdSchema.safeParse(id).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${id}`,
          SK: "PROFILE",
        },
      }),
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Profile not found" }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(enrichProfileItem(result.Item)),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const updateProfile: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id || !safeIdSchema.safeParse(id).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;

    // Fetch existing profile to preserve key properties
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${id}`,
          SK: "PROFILE",
        },
      }),
    );

    const baseItem = existing.Item || {
      PK: `USER#${id}`,
      SK: "PROFILE",
      fechaCreacion: new Date().toISOString(),
      estadoCuenta: "ACTIVO",
    };

    const auth = await extractAuthContext(event);
    const callerId = auth.userId;
    const isPrivileged = auth.isAdmin || auth.isModerator;
    const isOwner = Boolean(callerId) && callerId === id;

    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Not authorized to update this profile",
        }),
      };
    }

    if (
      body.estatusVerificacion === "En revisión" &&
      baseItem.estatusVerificacion === "En revisión"
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Ya existe una solicitud de verificación en curso.",
        }),
      };
    }

    // Sanitize non-privileged updates to prevent privilege escalation
    const safeBody = { ...body };
    if (!isPrivileged) {
      delete safeBody.tipoUsuario;
      delete safeBody.organizacionVerificada;
      delete safeBody.estadoCuenta;
      delete safeBody.bloqueada;
      delete safeBody.fechaFinSuspension;
    }

    const updatedItem: any = {
      ...baseItem,
      ...safeBody,
      PK: `USER#${id}`, // Force PK to stay correct
      SK: "PROFILE", // Force SK to stay correct
      fechaActualizacion: new Date().toISOString(),
    };

    updatedItem.GSI1PK = "PROFILE";
    updatedItem.GSI1SK = `ROLE#${updatedItem.tipoUsuario || "UNKNOWN"}#STATUS#${updatedItem.estadoCuenta || "ACTIVO"}`;

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: updatedItem,
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(updatedItem),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const listProfiles: APIGatewayProxyHandler = async (event) => {
  try {
    const roleParam = event.queryStringParameters?.tipoUsuario || event.queryStringParameters?.role;
    const queryParam = event.queryStringParameters?.q || event.queryStringParameters?.query;

    let keyConditionExpression = "GSI1PK = :gsiPk";
    const expressionValues: Record<string, any> = {
      ":gsiPk": "PROFILE",
    };

    if (roleParam) {
      keyConditionExpression += " AND begins_with(GSI1SK, :gsiSk)";
      expressionValues[":gsiSk"] = `ROLE#${roleParam.toUpperCase()}#`;
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionValues,
      }),
    );

    let profiles = (result.Items || []).map((item) => enrichProfileItem(item));

    if (queryParam) {
      const q = queryParam.toLowerCase();
      profiles = profiles.filter(
        (p) =>
          (p.nombre && p.nombre.toLowerCase().includes(q)) ||
          (p.email && p.email.toLowerCase().includes(q)) ||
          (p.titular && p.titular.toLowerCase().includes(q)) ||
          (p.tituloProfesional && p.tituloProfesional.toLowerCase().includes(q)) ||
          (p.titularProfesional && p.titularProfesional.toLowerCase().includes(q)) ||
          (p.sector && p.sector.toLowerCase().includes(q)),
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(profiles),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
