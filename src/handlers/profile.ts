import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { enrichProfileItem, enrichJobItem } from "../utils/dtoEnricher";

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

    if (
      body.estatusVerificacion === "En revisión" &&
      baseItem.estatusVerificacion === "En revisión"
    ) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Ya existe una solicitud de verificación en curso.",
        }),
      };
    }

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

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

// Obtener notificaciones del usuario
export const getNotifications: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
        ScanIndexForward: false,
      }),
    );

    const notifications = (result.Items || []).map((item: any) => ({
      id: item.id || item.SK.split("#").pop(),
      type: item.type || "system",
      title: item.title || "",
      message: item.message || "",
      reason: item.reason || null,
      gracePeriodEnd: item.gracePeriodEnd || null,
      createdAt: item.createdAt || "",
      read: item.read ?? false,
      actionRequired: item.actionRequired || false,
      actionType: item.actionType || null,
      companyId: item.PK.replace("USER#", ""),
    }));

    return { statusCode: 200, headers, body: JSON.stringify(notifications) };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Marcar una notificación como leída
export const markNotificationRead: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.pathParameters?.id;
    const notifId = event.pathParameters?.notifId;
    if (!userId || !notifId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing userId or notifId" }),
      };
    }

    // Buscar la SK completa de la notificación por su id parcial
    const queryRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
      }),
    );

    const target = (queryRes.Items || []).find(
      (item: any) => item.id === notifId || item.SK.endsWith(notifId),
    );

    if (!target) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: target.PK, SK: target.SK },
        UpdateExpression: "SET #r = :read",
        ExpressionAttributeNames: { "#r": "read" },
        ExpressionAttributeValues: { ":read": true },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: "Notification marked as read" }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

// Marcar todas las notificaciones como leídas
export const markAllNotificationsRead: APIGatewayProxyHandler = async (
  event,
) => {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const queryRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":skPrefix": "NOTIFICATION#",
        },
      }),
    );

    const unread = (queryRes.Items || []).filter(
      (item: any) => item.read !== true,
    );

    await Promise.all(
      unread.map((item: any) =>
        docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: "SET #r = :read",
            ExpressionAttributeNames: { "#r": "read" },
            ExpressionAttributeValues: { ":read": true },
          }),
        ),
      ),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `${unread.length} notifications marked as read`,
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

export const getProfileVacancies: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id)
      return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

    const page = event.queryStringParameters?.page
      ? parseInt(event.queryStringParameters.page, 10)
      : 1;
    const limit = event.queryStringParameters?.limit
      ? parseInt(event.queryStringParameters.limit, 10)
      : 20;

    let vacanciesItems: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :gsiPk",
          ExpressionAttributeValues: {
            ":gsiPk": "VACANCIES",
          },
          ScanIndexForward: false,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      if (result.Items) {
        vacanciesItems.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const userVacancies = vacanciesItems.filter((v) => v.empresaUuid === id);

    const total = userVacancies.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = userVacancies.slice((page - 1) * limit, page * limit);
    const enriched = paginated.map((v) =>
      enrichJobItem({
        id: v.PK.replace("VACANCY#", ""),
        title: v.titulo || v.title,
        company: v.company || "Empresa",
        empresaUuid: v.empresaUuid || "",
        lat: v.ubicacion?.lat || v.lat || 0,
        lng: v.ubicacion?.lng || v.lng || 0,
        modalidad: v.modalidad || "Presencial",
        salario: v.salario || 0,
        habilidadesRequeridas: v.habilidadesRequeridas || [],
        sectores: v.sectores || [],
        descripcion: v.descripcion || "Sin descripción",
        pdfUrl: v.pdfUrl || "",
        estado: v.estado || "Activa",
        createdAt: v.fechaCreacion || v.createdAt,
        sharesCount: v.sharesCount || 0,
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: enriched,
        total,
        page,
        totalPages,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

async function enrichPostsWithRelations(
  posts: any[],
  client: any,
  table: string,
) {
  if (!posts.length) return [];

  return await Promise.all(
    posts.map(async (post) => {
      const postUuid = post.PK.replace("POST#", "");
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": post.PK,
          },
        }),
      );

      const items = result.Items || [];
      const likesList: string[] = [];
      const bookmarksList: string[] = [];
      const comments: any[] = [];

      for (const item of items) {
        if (item.SK.startsWith("LIKE#")) {
          likesList.push(item.SK.replace("LIKE#", ""));
        } else if (item.SK.startsWith("BOOKMARK#")) {
          bookmarksList.push(item.SK.replace("BOOKMARK#", ""));
        } else if (item.SK.startsWith("COMMENT#")) {
          comments.push({
            id: item.SK,
            parentId: item.parentId || null,
            user: item.author || "Usuario",
            text: item.content || "",
            createdAt: item.createdAt || item.SK.replace("COMMENT#", ""),
            isDeleted: item.isDeleted || false,
          });
        }
      }

      return {
        uniqueId: postUuid,
        author: post.author || "Anónimo",
        role: post.role || "Candidato",
        authorUuid: post.authorUuid || "",
        fotoPerfil: post.fotoPerfil || post.authorAvatar || undefined,
        content: post.content || "",
        media: post.media || undefined,
        pdfUrl: post.pdfUrl || undefined,
        pdfName: post.pdfName || undefined,
        createdAt: post.createdAt || new Date().toISOString(),
        sharesCount: post.sharesCount || 0,
        likesList,
        bookmarksList,
        comments,
      };
    }),
  );
}

export const getProfilePosts: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id)
      return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

    const page = event.queryStringParameters?.page
      ? parseInt(event.queryStringParameters.page, 10)
      : 1;
    const limit = event.queryStringParameters?.limit
      ? parseInt(event.queryStringParameters.limit, 10)
      : 20;

    let items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: {
            ":pk": `POSTS#${id}`,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      if (result.Items) {
        items.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const userPosts = items.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = userPosts.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = userPosts.slice((page - 1) * limit, page * limit);
    const enrichedPaginated = await enrichPostsWithRelations(
      paginated,
      docClient,
      tableName,
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: enrichedPaginated,
        total,
        page,
        totalPages,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export const getProfileBookmarks: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id)
      return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

    const page = event.queryStringParameters?.page
      ? parseInt(event.queryStringParameters.page, 10)
      : 1;
    const limit = event.queryStringParameters?.limit
      ? parseInt(event.queryStringParameters.limit, 10)
      : 20;

    let items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    // Query for all bookmarks made by this user via GSI1
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: {
            ":pk": `BOOKMARK#${id}`,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      if (result.Items) {
        items.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const postIds = Array.from(new Set(items.map((i) => i.PK)));

    const posts: any[] = [];
    if (postIds.length > 0) {
      const chunks = [];
      for (let i = 0; i < postIds.length; i += 100) {
        chunks.push(postIds.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        const keys = chunk.map((pk) => ({ PK: pk, SK: "METADATA" }));
        const result = await docClient.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: { Keys: keys },
            },
          }),
        );

        if (result.Responses && result.Responses[tableName]) {
          posts.push(...result.Responses[tableName]);
        }
      }
    }

    const sortedPosts = posts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = sortedPosts.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = sortedPosts.slice((page - 1) * limit, page * limit);
    const enrichedPaginated = await enrichPostsWithRelations(
      paginated,
      docClient,
      tableName,
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: enrichedPaginated,
        total,
        page,
        totalPages,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
