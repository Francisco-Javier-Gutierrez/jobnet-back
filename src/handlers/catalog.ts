import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { parseJsonBody, safeIdSchema } from "../utils/validator";

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
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

export const getCatalog: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {
          ":pk": "CATALOG",
        },
      }),
    );
    const items = (result.Items || []).map((item) => ({
      id: item.PK.replace("CATALOG#", ""),
      name: item.name,
      category: item.category,
      createdAt: item.createdAt,
    }));
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(items),
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

export const createCatalogItem: APIGatewayProxyHandler = async (event) => {
  try {
    const parseResult = parseJsonBody(event.body, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
      "Content-Type": "application/json",
    });
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const { name, category, id } = body;
    if (!name || !category || typeof name !== "string" || typeof category !== "string") {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Missing required fields 'name' and 'category'",
        }),
      };
    }

    if (id && !safeIdSchema.safeParse(id).success) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Invalid catalog item id",
        }),
      };
    }

    const itemId = id || Math.random().toString(36).substring(2, 9);

    // Check duplicates
    const existing = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :gsiPk AND GSI1SK = :gsiSk",
        FilterExpression: "valName = :valName",
        ExpressionAttributeValues: {
          ":gsiPk": "CATALOG",
          ":gsiSk": `CATEGORY#${category}`,
          ":valName": name.toLowerCase().trim(),
        },
      }),
    );

    if (existing.Items && existing.Items.length > 0) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: `Ya existe este ${category.toLowerCase()} en el catálogo`,
        }),
      };
    }

    const item = {
      PK: `CATALOG#${itemId}`,
      SK: "CATALOG",
      GSI1PK: "CATALOG",
      GSI1SK: `CATEGORY#${category}`,
      name: name.trim(),
      valName: name.toLowerCase().trim(),
      category,
      createdAt: new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      }),
    );

    return {
      statusCode: 201,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: itemId,
        name: item.name,
        category: item.category,
        createdAt: item.createdAt,
      }),
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

export const updateCatalogItem: APIGatewayProxyHandler = async (event) => {
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
    const { name } = body;
    if (!name) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Missing required field 'name'" }),
      };
    }

    const getResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `CATALOG#${id}`,
          SK: "CATALOG",
        },
      }),
    );

    if (!getResult.Item) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Catalog item not found" }),
      };
    }

    const existingItem = getResult.Item as any;

    const duplicate = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :gsiPk AND GSI1SK = :gsiSk",
        FilterExpression: "valName = :valName AND PK <> :pk",
        ExpressionAttributeValues: {
          ":gsiPk": "CATALOG",
          ":gsiSk": `CATEGORY#${existingItem.category}`,
          ":valName": name.toLowerCase().trim(),
          ":pk": `CATALOG#${id}`,
        },
      }),
    );

    if (duplicate.Items && duplicate.Items.length > 0) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: `Ya existe otro ${existingItem.category.toLowerCase()} con ese nombre`,
        }),
      };
    }

    const updatedItem = {
      ...existingItem,
      name: name.trim(),
      valName: name.toLowerCase().trim(),
      updatedAt: new Date().toISOString(),
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
      body: JSON.stringify({
        id,
        name: updatedItem.name,
        category: updatedItem.category,
        createdAt: updatedItem.createdAt,
      }),
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

export const deleteCatalogItem: APIGatewayProxyHandler = async (event) => {
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

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `CATALOG#${id}`,
          SK: "CATALOG",
        },
      }),
    );

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ success: true }),
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
