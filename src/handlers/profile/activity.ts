import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import {
  docClient,
  tableName,
  headers,
  enrichPostsWithRelations,
  enrichJobsWithRelations,
} from "./common";

export const getProfileVacancies: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

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
    const enriched = await enrichJobsWithRelations(paginated, docClient, tableName);

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
    if (!id) return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

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
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = userPosts.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = userPosts.slice((page - 1) * limit, page * limit);
    const enrichedPaginated = await enrichPostsWithRelations(paginated, docClient, tableName);

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
    if (!id) return { statusCode: 400, headers, body: '{"error":"Missing id"}' };

    // Directiva de privacidad y protección de datos: elementos guardados son estrictamente privados y confidenciales
    const callerId =
      (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
      (event.requestContext as any)?.authorizer?.principalId ||
      event.headers?.["x-user-id"] ||
      event.headers?.["X-User-Id"] ||
      "";

    const callerRole = (
      (event.requestContext as any)?.authorizer?.role ||
      (event.requestContext as any)?.authorizer?.jwt?.claims?.["custom:role"] ||
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      ""
    ).toUpperCase();

    const isPrivileged = callerRole === "ADMIN" || callerRole === "MODERATOR";
    const isOwner = callerId === id;

    if (callerId && !isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error:
            "Acceso denegado: Por directivas de privacidad y protección de datos, los elementos guardados se conservan de forma estrictamente privada y confidencial, siendo accesibles únicamente por el propio usuario.",
        }),
      };
    }

    const page = event.queryStringParameters?.page
      ? parseInt(event.queryStringParameters.page, 10)
      : 1;
    const limit = event.queryStringParameters?.limit
      ? parseInt(event.queryStringParameters.limit, 10)
      : 20;
    const typeFilter = (event.queryStringParameters?.type || "all").toLowerCase();

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

    let filteredItems = items;
    if (typeFilter === "posts") {
      filteredItems = items.filter(
        (i) => (i.PK && i.PK.startsWith("POST#")) || (i.GSI1SK && i.GSI1SK.startsWith("POST#")),
      );
    } else if (typeFilter === "jobs" || typeFilter === "vacancies") {
      filteredItems = items.filter(
        (i) =>
          (i.PK && i.PK.startsWith("VACANCY#")) || (i.GSI1SK && i.GSI1SK.startsWith("VACANCY#")),
      );
    }

    // Sort bookmarks by when they were saved (newest first)
    filteredItems.sort((a, b) => {
      const dateA = a.fechaInteraccion ? new Date(a.fechaInteraccion).getTime() : 0;
      const dateB = b.fechaInteraccion ? new Date(b.fechaInteraccion).getTime() : 0;
      return dateB - dateA;
    });

    const itemKeys = Array.from(new Set(filteredItems.map((i) => i.PK)));
    const total = itemKeys.length;
    const totalPages = Math.ceil(total / limit);

    // Paginate ONLY the IDs (in-memory, but extremely cheap)
    const paginatedIds = itemKeys.slice((page - 1) * limit, page * limit);

    const paginatedRaw: any[] = [];
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
        const fetchedItems = result.Responses[tableName];
        const itemMap = new Map(fetchedItems.map((p: any) => [p.PK, p]));
        for (const pid of paginatedIds) {
          if (itemMap.has(pid)) {
            paginatedRaw.push(itemMap.get(pid));
          }
        }
      }
    }

    const rawPosts = paginatedRaw.filter((i) => i.PK && i.PK.startsWith("POST#"));
    const rawJobs = paginatedRaw.filter((i) => i.PK && i.PK.startsWith("VACANCY#"));

    const enrichedPosts =
      rawPosts.length > 0 ? await enrichPostsWithRelations(rawPosts, docClient, tableName) : [];

    const enrichedJobs =
      rawJobs.length > 0 ? await enrichJobsWithRelations(rawJobs, docClient, tableName) : [];

    const enrichedMap = new Map<string, any>();
    for (const p of enrichedPosts) {
      enrichedMap.set(`POST#${p.uniqueId}`, p);
    }
    for (const j of enrichedJobs) {
      enrichedMap.set(`VACANCY#${j.id}`, j);
    }

    const enrichedPaginated: any[] = [];
    for (const raw of paginatedRaw) {
      if (enrichedMap.has(raw.PK)) {
        enrichedPaginated.push(enrichedMap.get(raw.PK));
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: enrichedPaginated,
        posts: enrichedPosts,
        jobs: enrichedJobs,
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
