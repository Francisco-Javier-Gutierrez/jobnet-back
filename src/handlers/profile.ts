import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { enrichProfileItem } from "../utils/dtoEnricher";

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
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-dev";

export const getProfile: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
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
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Profile not found" }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(enrichProfileItem(result.Item)),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
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
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
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

    const updatedItem = {
      ...baseItem,
      ...body,
      PK: `USER#${id}`, // Force PK to stay correct
      SK: "PROFILE", // Force SK to stay correct
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
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updatedItem),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
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

    let filterExpression = "SK = :sk";
    const expressionValues: Record<string, any> = {
      ":sk": "PROFILE",
    };

    if (roleParam) {
      filterExpression += " AND tipoUsuario = :role";
      expressionValues[":role"] = roleParam.toUpperCase();
    }

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: filterExpression,
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
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(enrichedItems),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
