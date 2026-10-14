import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers, enrichProfileItem } from "./common";

export const getProfile: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
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
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");

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

    const callerId =
      (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
      (event.requestContext as any)?.authorizer?.principalId ||
      event.headers?.["x-user-id"] ||
      "";

    const callerRole = (
      (event.requestContext as any)?.authorizer?.role ||
      (event.requestContext as any)?.authorizer?.jwt?.claims?.["custom:role"] ||
      event.headers?.["x-user-role"] ||
      ""
    ).toUpperCase();

    const isPrivileged = callerRole === "ADMIN" || callerRole === "MODERATOR";
    const isOwner = !callerId || callerId === id;

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
    const roleParam =
      event.queryStringParameters?.tipoUsuario ||
      event.queryStringParameters?.role;
    const queryParam =
      event.queryStringParameters?.q || event.queryStringParameters?.query;

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

    let items = result.Items || [];

    if (queryParam && queryParam.trim() !== "") {
      const q = queryParam.toLowerCase().trim();
      items = items.filter((item: any) => {
        const name = (
          item.nombre ||
          item.nombreComercial ||
          item.name ||
          ""
        ).toLowerCase();
        const razon = (item.razonSocial || "").toLowerCase();
        const taxId = (item.taxId || item.rfc || "").toLowerCase();
        const sector = (item.sector || "").toLowerCase();
        return (
          name.includes(q) ||
          razon.includes(q) ||
          taxId.includes(q) ||
          sector.includes(q)
        );
      });
    }

    const enrichedItems = items.map((i: any) => enrichProfileItem(i));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(enrichedItems),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
