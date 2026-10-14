import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import {
  docClient,
  tableName,
  headers,
  enrichJobItem,
  enrichPostsWithRelations,
} from "./common";

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

    const vacanciesItems: any[] = [];
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

    const items: any[] = [];
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

    const items: any[] = [];
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

    // Sort bookmarks by when they were saved (newest first)
    items.sort((a, b) => {
      const dateA = a.fechaInteraccion ? new Date(a.fechaInteraccion).getTime() : 0;
      const dateB = b.fechaInteraccion ? new Date(b.fechaInteraccion).getTime() : 0;
      return dateB - dateA;
    });

    const postIds = Array.from(new Set(items.map((i) => i.PK)));
    const total = postIds.length;
    const totalPages = Math.ceil(total / limit);

    // Paginate ONLY the IDs (in-memory, but extremely cheap)
    const paginatedIds = postIds.slice((page - 1) * limit, page * limit);

    const paginated: any[] = [];
    if (paginatedIds.length > 0) {
      const keys = paginatedIds.map((pk) => ({ PK: pk, SK: "METADATA" }));
      const result = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: { Keys: keys },
          },
        }),
      );

      if (result.Responses && result.Responses[tableName]) {
        // Maintain the sorted order from bookmarks
        const fetchedPosts = result.Responses[tableName];
        const postMap = new Map(fetchedPosts.map((p: any) => [p.PK, p]));
        for (const pid of paginatedIds) {
          if (postMap.has(pid)) {
            paginated.push(postMap.get(pid));
          }
        }
      }
    }
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
