import { APIGatewayProxyHandler } from "aws-lambda";
import {
  QueryCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { docClient, tableName, headers } from "./profile/common";
import { extractAuthContext } from "../utils/authHelper";
import { parseJsonBody } from "../utils/validator";

export interface CommunityCvTemplateItem {
  PK: string;
  SK: string;
  type: string;
  templateId: string;
  GSI1PK: string;
  GSI1SK: string;
  titulo: string;
  rol: string;
  categoria: string;
  nivel: string;
  idioma: "es" | "en" | "bilingual";
  alcance: "SUR_EDOMEX" | "NACIONAL" | "GLOBAL_REMOTO";
  autorId: string;
  autorNombre: string;
  isOfficial?: boolean;
  habilidades: string[];
  biografiaSugerida: string;
  experienciaSugerida: Array<{
    cargo: string;
    empresa: string;
    periodo: string;
    logros: string[];
  }>;
  educacionSugerida: Array<{
    titulo: string;
    institucion: string;
    periodo: string;
  }>;
  translations?: {
    es?: any;
    en?: any;
  };
  stats: {
    usesCount: number;
    likesCount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export const getCvTemplates: APIGatewayProxyHandler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};
    const { idioma, categoria, autorId } = queryParams;

    let items: any[] = [];

    if (autorId) {
      // Query templates created by a specific user
      const queryResult = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :gsi1pk",
          FilterExpression: "autorId = :autorId",
          ExpressionAttributeValues: {
            ":gsi1pk": "CV_TEMPLATES#COMMUNITY",
            ":autorId": autorId,
          },
        }),
      );
      items = queryResult.Items || [];
    } else {
      // Query all community templates via GSI1
      const queryResult = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :gsi1pk",
          ExpressionAttributeValues: {
            ":gsi1pk": "CV_TEMPLATES#COMMUNITY",
          },
        }),
      );
      items = queryResult.Items || [];
    }

    // Filter in-memory if query params provided
    if (idioma) {
      items = items.filter(
        (t) => t.idioma === idioma || (idioma === "es" && t.idioma === "bilingual"),
      );
    }

    if (categoria) {
      items = items.filter((t) => (t.categoria || "").toLowerCase() === categoria.toLowerCase());
    }

    // Sort by usesCount descending, then by createdAt descending
    items.sort((a, b) => {
      const usesA = a.stats?.usesCount || 0;
      const usesB = b.stats?.usesCount || 0;
      if (usesB !== usesA) return usesB - usesA;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ templates: items, count: items.length }),
    };
  } catch (error: unknown) {
    console.error("Error in getCvTemplates:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createCvTemplate: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const userId =
      auth.userId ||
      event.headers?.["x-user-id"] ||
      event.headers?.["X-User-Id"] ||
      event.requestContext?.authorizer?.claims?.sub;

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: "No autorizado. Se requiere x-user-id.",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const {
      titulo,
      rol,
      categoria,
      nivel,
      idioma,
      alcance,
      autorNombre,
      habilidades,
      biografiaSugerida,
      experienciaSugerida,
      educacionSugerida,
    } = body;

    if (!titulo || !rol || !categoria) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Campos obligatorios faltantes: titulo, rol, categoria.",
        }),
      };
    }

    const templateId = randomUUID();
    const now = new Date().toISOString();
    const lang = idioma === "en" || idioma === "bilingual" ? idioma : "es";

    const newItem: CommunityCvTemplateItem = {
      PK: `CV_TEMPLATE#${templateId}`,
      SK: `METADATA#${templateId}`,
      type: "CV_TEMPLATE",
      templateId,
      GSI1PK: "CV_TEMPLATES#COMMUNITY",
      GSI1SK: `${lang}#${now}#${templateId}`,
      titulo: titulo.trim(),
      rol: rol.trim(),
      categoria: categoria.trim().toLowerCase(),
      nivel: nivel || "mid",
      idioma: lang,
      alcance: alcance || (lang === "en" ? "GLOBAL_REMOTO" : "SUR_EDOMEX"),
      autorId: userId,
      autorNombre: autorNombre || "Candidato de JobNet",
      isOfficial: false,
      habilidades: Array.isArray(habilidades) ? habilidades : [],
      biografiaSugerida: biografiaSugerida || "",
      experienciaSugerida: Array.isArray(experienciaSugerida) ? experienciaSugerida : [],
      educacionSugerida: Array.isArray(educacionSugerida) ? educacionSugerida : [],
      translations: body.translations || undefined,
      stats: {
        usesCount: 0,
        likesCount: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: newItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(newItem),
    };
  } catch (error: unknown) {
    console.error("Error in createCvTemplate:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const deleteCvTemplate: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    const userId =
      event.headers["x-user-id"] ||
      event.headers["X-User-Id"] ||
      event.requestContext?.authorizer?.claims?.sub;
    const userRole = (
      event.headers["x-user-role"] ||
      event.headers["X-User-Role"] ||
      ""
    ).toUpperCase();

    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Falta el id de la plantilla." }),
      };
    }

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado." }),
      };
    }

    const templateResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `CV_TEMPLATE#${id}`,
          SK: `METADATA#${id}`,
        },
      }),
    );

    if (!templateResult.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Plantilla no encontrada." }),
      };
    }

    // Only owner or admin can delete
    if (templateResult.Item.autorId !== userId && userRole !== "ADMIN") {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "No tienes permiso para eliminar esta plantilla.",
        }),
      };
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `CV_TEMPLATE#${id}`,
          SK: `METADATA#${id}`,
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: "Plantilla eliminada." }),
    };
  } catch (error: unknown) {
    console.error("Error in deleteCvTemplate:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const useCvTemplate: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Falta el id de la plantilla." }),
      };
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `CV_TEMPLATE#${id}`,
          SK: `METADATA#${id}`,
        },
        UpdateExpression: "SET #stats.#usesCount = if_not_exists(#stats.#usesCount, :zero) + :one",
        ExpressionAttributeNames: {
          "#stats": "stats",
          "#usesCount": "usesCount",
        },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        templateId: id,
        usesCount: result.Attributes?.stats?.usesCount || 1,
      }),
    };
  } catch (error: unknown) {
    console.error("Error in useCvTemplate:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
