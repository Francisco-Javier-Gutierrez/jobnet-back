import { APIGatewayProxyHandler } from "aws-lambda";
import {
  QueryCommand,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { docClient, tableName, enrichJobItem } from "./common";

export const getJobs: APIGatewayProxyHandler = async (event) => {
  try {
    const queryParams = event?.queryStringParameters || {};
    const q = queryParams.q || queryParams.query || "";
    const modalidad = queryParams.modalidad || "";
    const page = queryParams.page ? Number(queryParams.page) : undefined;
    const limit = queryParams.limit ? Number(queryParams.limit) : undefined;

    // 1. Fetch all company profiles to check status
    const profilesItems: any[] = [];
    let profilesLastKey: any = undefined;

    do {
      const profilesResult = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :gsiPk",
          ExpressionAttributeValues: {
            ":gsiPk": "PROFILE",
          },
          ExclusiveStartKey: profilesLastKey,
        }),
      );
      if (profilesResult.Items) {
        profilesItems.push(...profilesResult.Items);
      }
      profilesLastKey = profilesResult.LastEvaluatedKey;
    } while (profilesLastKey);

    const suspendedCompanies = new Set<string>();
    profilesItems.forEach((p: any) => {
      const companyId = p.PK.replace("USER#", "");
      if (
        p.estadoCuenta === "SUSPENDIDA" ||
        p.estadoCuenta === "SUSPENDIDA_TEMPORAL"
      ) {
        if (p.estadoCuenta === "SUSPENDIDA_TEMPORAL" && p.fechaFinSuspension) {
          if (new Date() < new Date(p.fechaFinSuspension)) {
            suspendedCompanies.add(companyId);
          }
        } else {
          suspendedCompanies.add(companyId);
        }
      }
    });

    // 2. Fetch all vacancies using GSI1 (Query is much faster and cheaper)
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
          ScanIndexForward: false, // Newest first
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      if (result.Items) {
        vacanciesItems.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    let items = vacanciesItems
      .map((item) => {
        const raw = {
          id: item.PK.replace("VACANCY#", ""),
          title: item.titulo || item.title,
          company: item.company || "Empresa",
          empresaUuid: item.empresaUuid || "",
          lat: item.ubicacion?.lat || item.lat || 0,
          lng: item.ubicacion?.lng || item.lng || 0,
          modalidad: item.modalidad || "Presencial",
          salario: item.salario || 0,
          salarioMinimo: item.salarioMinimo || 0,
          salarioMaximo: item.salarioMaximo || 0,
          habilidadesRequeridas: item.habilidadesRequeridas || [],
          sectores: item.sectores || [],
          descripcion: item.descripcion || "Sin descripción",
          pdfUrl: item.pdfUrl || "",
          pdfName: item.pdfName || "",
          aptitudes: item.aptitudes || "",
          experienciaAnos: item.experienciaAnos || 0,
          vacantesDisponibles: item.vacantesDisponibles
            ? Number(item.vacantesDisponibles)
            : 1,
          maxPostulantes: item.maxPostulantes
            ? Number(item.maxPostulantes)
            : null,
          estado: item.estado || "Activa",
          createdAt: item.fechaCreacion || item.createdAt,
          sharesCount: item.sharesCount || 0,
          isDeleted: item.isDeleted || false,
          oculta: item.oculta || false,
        };
        return enrichJobItem(raw);
      })
      .filter((j) => {
        if (j.estado === "CERRADA") return false;
        if (j.estado === "PAUSADA") return false;
        if (j.estado === "SUSPENDIDA") return false;
        if (j.estado === "Eliminada") return false;
        if (j.isDeleted) return false;
        if (j.oculta) return false;
        if (suspendedCompanies.has(j.empresaUuid)) return false;

        // Manual search filters
        if (q) {
          const searchRegex = new RegExp(q, "i");
          if (
            !searchRegex.test(j.title) &&
            !searchRegex.test(j.company) &&
            !searchRegex.test(j.descripcion)
          ) {
            return false;
          }
        }
        if (modalidad && j.modalidad !== modalidad) {
          return false;
        }
        return true;
      });

    const hasSearchParams = Boolean(q || modalidad || page || limit);
    let bodyContent: any = items;

    if (hasSearchParams) {
      const p = page || 1;
      const l = limit || 20;
      const total = items.length;
      const totalPages = Math.ceil(total / l);
      items = items.slice((p - 1) * l, p * l);

      bodyContent = {
        data: items,
        total,
        page: p,
        totalPages,
        source: "dynamodb",
      };
    }

    // Enrich missing likes, comments and bookmarks per job in the current page slice
    const enrichedItems = await Promise.all(
      items.map(async (j) => {
        try {
          const res = await docClient.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :pk",
              ExpressionAttributeValues: { ":pk": `VACANCY#${j.id}` },
            }),
          );
          const jItems = res.Items || [];
          j.likesList = [];
          j.bookmarksList = [];
          let commentsCount = 0;
          for (const i of jItems) {
            if (i.SK.startsWith("LIKE#")) {
              j.likesList.push(i.SK.replace("LIKE#", ""));
            } else if (i.SK.startsWith("BOOKMARK#")) {
              j.bookmarksList.push(i.SK.replace("BOOKMARK#", ""));
            } else if (i.SK.startsWith("COMMENT#")) {
              if (!i.isDeleted) {
                commentsCount++;
              }
            }
          }
          j.likesCount = j.likesList.length;
          j.bookmarksCount = j.bookmarksList.length;
          j.commentsCount = commentsCount;
          j.sharesCount = j.sharesCount || 0;
        } catch {
          // Ignore error and return base job
        }
        return j;
      }),
    );

    if (hasSearchParams) {
      bodyContent.data = enrichedItems;
    } else {
      bodyContent = enrichedItems;
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyContent),
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

export const getJobById: APIGatewayProxyHandler = async (event) => {
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

    const candidateId =
      event.queryStringParameters?.candidateId ||
      event.queryStringParameters?.userId;

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `VACANCY#${id}`,
        },
      }),
    );

    const items = result.Items || [];
    const metadataItem = items.find((i) => i.SK === "METADATA");

    if (!metadataItem) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    const item = metadataItem;
    const likesList: string[] = [];
    const bookmarksList: string[] = [];
    const comments: any[] = [];

    for (const i of items) {
      if (i.SK.startsWith("LIKE#")) {
        likesList.push(i.SK.replace("LIKE#", ""));
      } else if (i.SK.startsWith("BOOKMARK#")) {
        bookmarksList.push(i.SK.replace("BOOKMARK#", ""));
      } else if (i.SK.startsWith("COMMENT#")) {
        comments.push({
          id: i.SK,
          parentId: i.parentId || null,
          user: i.author || "Usuario",
          text: i.content || "",
          createdAt: i.createdAt || i.SK.replace("COMMENT#", ""),
          isDeleted: i.isDeleted || false,
        });
      }
    }

    item.likesList = likesList;
    item.bookmarksList = bookmarksList;
    item.comments = comments;
    const rawJob = {
      id: item.PK.replace("VACANCY#", ""),
      title: item.titulo || item.title,
      company: item.company || "Empresa",
      empresaUuid: item.empresaUuid || "",
      lat: item.ubicacion?.lat || item.lat || 0,
      lng: item.ubicacion?.lng || item.lng || 0,
      modalidad: item.modalidad || "Presencial",
      salario: item.salario || 0,
      salarioMinimo: item.salarioMinimo || 0,
      salarioMaximo: item.salarioMaximo || 0,
      habilidadesRequeridas: item.habilidadesRequeridas || [],
      sectores: item.sectores || [],
      descripcion: item.descripcion || "Sin descripción",
      pdfUrl: item.pdfUrl || "",
      pdfName: item.pdfName || "",
      aptitudes: item.aptitudes || "",
      experienciaAnos: item.experienciaAnos || 0,
      vacantesDisponibles: item.vacantesDisponibles
        ? Number(item.vacantesDisponibles)
        : 1,
      maxPostulantes: item.maxPostulantes ? Number(item.maxPostulantes) : null,
      estado: item.estado || "Activa",
      createdAt: item.fechaCreacion || item.createdAt,
      sharesCount: item.sharesCount || 0,
      likesList: item.likesList,
      bookmarksList: item.bookmarksList,
      comments: item.comments,
    };

    let appliedJobsMap:
      Map<string, { applicationId: string; status: string }> | undefined;
    if (candidateId) {
      const appResult = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND SK = :sk",
          ExpressionAttributeValues: {
            ":pk": `JOB#${id}`,
            ":sk": `APP#${candidateId}`,
          },
        }),
      );
      appliedJobsMap = new Map();
      if (appResult.Items && appResult.Items.length > 0) {
        const appItem = appResult.Items[0];
        appliedJobsMap.set(id, {
          applicationId: appItem.candidateId,
          status: appItem.status || "PENDIENTE",
        });
      }
    }

    const enriched = enrichJobItem(rawJob, appliedJobsMap);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(enriched),
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

export const createJob: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const vacancyUuid = randomUUID();
    const now = new Date().toISOString();
    const item: Record<string, any> = {
      PK: `VACANCY#${vacancyUuid}`,
      SK: "METADATA",
      GSI1PK: "VACANCIES",
      GSI1SK: now,
      empresaUuid:
        body.empresaUuid ||
        (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
        "",
      titulo: body.title,
      company: body.company || "Empresa",
      descripcion: body.descripcion || "Sin descripción",
      modalidad: body.modalidad || "Presencial",
      salario: body.salario || body.salarioMinimo || 0,
      salarioMinimo: body.salarioMinimo || body.salario || 0,
      salarioMaximo: body.salarioMaximo || body.salario || 0,
      habilidadesRequeridas: body.habilidadesRequeridas || [],
      sectores: body.sectores || [],
      aptitudes: body.aptitudes || "",
      experienciaAnos: body.experienciaAnos || 0,
      ubicacion: {
        lat: body.lat || 0,
        lng: body.lng || 0,
      },
      lat: body.lat || 0,
      lng: body.lng || 0,
      pdfUrl: body.pdfUrl || "",
      pdfName: body.pdfName || "",
      vacantesDisponibles: body.vacantesDisponibles
        ? Number(body.vacantesDisponibles)
        : 1,
      estado: "Activa",
      fechaCreacion: now,
    };

    if (
      body.maxPostulantes !== undefined &&
      body.maxPostulantes !== null &&
      body.maxPostulantes !== ""
    ) {
      item.maxPostulantes = Number(body.maxPostulantes);
    }
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
        id: vacancyUuid,
        ...item,
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

export const updateJob: APIGatewayProxyHandler = async (event) => {
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

    // Verify the job exists and check ownership
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${id}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    // Check ownership
    const callerId =
      (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
      (event.requestContext as any)?.authorizer?.principalId ||
      event.headers?.["x-user-id"] ||
      body.empresaUuid ||
      "";

    const callerRole = (
      (event.requestContext as any)?.authorizer?.role ||
      (event.requestContext as any)?.authorizer?.jwt?.claims?.["custom:role"] ||
      event.headers?.["x-user-role"] ||
      ""
    ).toUpperCase();

    const isPrivileged = callerRole === "ADMIN" || callerRole === "MODERATOR";
    const isOwner =
      !existing.Item.empresaUuid ||
      !callerId ||
      existing.Item.empresaUuid === callerId;

    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Not authorized to update this job" }),
      };
    }

    // Build update expression dynamically
    const allowedFields = [
      "titulo",
      "title",
      "company",
      "descripcion",
      "description",
      "modalidad",
      "salario",
      "salarioMinimo",
      "salarioMaximo",
      "vacantesDisponibles",
      "maxPostulantes",
      "habilidadesRequeridas",
      "skills",
      "sectores",
      "ubicacion",
      "lat",
      "lng",
      "location",
      "estado",
      "apelacionComentarios",
      "pdfUrl",
      "pdfName",
    ];

    const expressionParts: string[] = [];
    const expressionAttrValues: Record<string, any> = {};
    const expressionAttrNames: Record<string, string> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const attrKey = `#${field}`;
        const valKey = `:${field}`;
        expressionParts.push(`${attrKey} = ${valKey}`);
        expressionAttrNames[attrKey] = field;
        expressionAttrValues[valKey] = body[field];
      }
    }

    if (expressionParts.length === 0) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "No valid fields to update" }),
      };
    }

    expressionParts.push("#updatedAt = :updatedAt");
    expressionAttrNames["#updatedAt"] = "updatedAt";
    expressionAttrValues[":updatedAt"] = new Date().toISOString();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${id}`,
          SK: "METADATA",
        },
        UpdateExpression: `SET ${expressionParts.join(", ")}`,
        ExpressionAttributeNames: expressionAttrNames,
        ExpressionAttributeValues: expressionAttrValues,
        ReturnValues: "ALL_NEW",
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
        ...result.Attributes,
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

export const deleteJob: APIGatewayProxyHandler = async (event) => {
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

    // Verify the job exists
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${id}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    const callerId =
      (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
      (event.requestContext as any)?.authorizer?.principalId ||
      event.headers?.["x-user-id"] ||
      event.queryStringParameters?.empresaUuid ||
      "";

    const callerRole = (
      (event.requestContext as any)?.authorizer?.role ||
      (event.requestContext as any)?.authorizer?.jwt?.claims?.["custom:role"] ||
      event.headers?.["x-user-role"] ||
      ""
    ).toUpperCase();

    const isPrivileged = callerRole === "ADMIN" || callerRole === "MODERATOR";
    const isOwner =
      !existing.Item.empresaUuid ||
      !callerId ||
      existing.Item.empresaUuid === callerId;

    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Not authorized to delete this job" }),
      };
    }

    // Soft delete: set estado to CERRADA and add deletedAt timestamp
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${id}`,
          SK: "METADATA",
        },
        UpdateExpression: "SET estado = :estado, deletedAt = :deletedAt",
        ExpressionAttributeValues: {
          ":estado": "CERRADA",
          ":deletedAt": new Date().toISOString(),
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
      body: JSON.stringify({ success: true, id, estado: "CERRADA" }),
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
