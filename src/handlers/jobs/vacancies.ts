import { APIGatewayProxyHandler } from "aws-lambda";
import {
  QueryCommand,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { docClient, tableName, enrichJobItem } from "./common";
import { createUserNotification } from "../../utils/webPushService";
import { evaluatePreAi } from "../../utils/preAiFilter";

export const getJobs: APIGatewayProxyHandler = async (event) => {
  try {
    const queryParams = event?.queryStringParameters || {};
    const q = queryParams.q || queryParams.query || "";
    const modalidad = queryParams.modalidad || "";
    const page = queryParams.page ? Number(queryParams.page) : undefined;
    const limit = queryParams.limit ? Number(queryParams.limit) : undefined;
    const companyIdParam =
      queryParams.companyId || queryParams.empresaUuid || "";
    const includePaused =
      queryParams.includePaused === "true" || Boolean(companyIdParam);

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
          salarioConfidencial: Boolean(
            item.salarioConfidencial || item.isSalaryConfidential,
          ),
          isSalaryConfidential: Boolean(
            item.salarioConfidencial || item.isSalaryConfidential,
          ),
          municipio: item.municipio || "Toluca",
          location:
            item.location ||
            (item.municipio ? `${item.municipio}, Estado de México` : "Estado de México"),
          sector: item.sector || (item.sectores && item.sectores[0]) || "General",
          preguntasFiltro: Array.isArray(item.preguntasFiltro)
            ? item.preguntasFiltro
            : Array.isArray(item.screeningQuestions)
              ? item.screeningQuestions
              : [],
          screeningQuestions: Array.isArray(item.preguntasFiltro)
            ? item.preguntasFiltro
            : Array.isArray(item.screeningQuestions)
              ? item.screeningQuestions
              : [],
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
          fechaCierre: item.fechaCierre || item.fechaVigencia,
          fechaVigencia: item.fechaVigencia || item.fechaCierre,
          alertaCaducidadEnviada: Boolean(item.alertaCaducidadEnviada),
          alertaAltaDemandaEnviada: Boolean(item.alertaAltaDemandaEnviada),
          sharesCount: item.sharesCount || 0,
          isDeleted: item.isDeleted || false,
          oculta: item.oculta || false,
        };
        return enrichJobItem(raw);
      })
      .filter((j) => {
        if (j.isDeleted) return false;
        if (j.estado === "Eliminada") return false;

        // Organization specific view: allows viewing own active and paused vacancies
        if (companyIdParam) {
          if (j.empresaUuid !== companyIdParam) return false;
          if (!includePaused && j.estado === "PAUSADA") return false;
          return true;
        }

        // Public searches: hide paused, closed, suspended and hidden vacancies
        if (j.estado === "CERRADA") return false;
        if (j.estado === "PAUSADA") return false;
        if (j.estado === "SUSPENDIDA") return false;
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

    if (companyIdParam) {
      await evaluateAndTriggerVacancyExpirations(items);
    }

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
      salarioConfidencial: Boolean(
        item.salarioConfidencial || item.isSalaryConfidential,
      ),
      isSalaryConfidential: Boolean(
        item.salarioConfidencial || item.isSalaryConfidential,
      ),
      municipio: item.municipio || "Toluca",
      location:
        item.location ||
        (item.municipio ? `${item.municipio}, Estado de México` : "Estado de México"),
      sector: item.sector || (item.sectores && item.sectores[0]) || "General",
      preguntasFiltro: Array.isArray(item.preguntasFiltro)
        ? item.preguntasFiltro
        : Array.isArray(item.screeningQuestions)
          ? item.screeningQuestions
          : [],
      screeningQuestions: Array.isArray(item.preguntasFiltro)
        ? item.preguntasFiltro
        : Array.isArray(item.screeningQuestions)
          ? item.screeningQuestions
          : [],
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

    const title = body.title || body.titulo || "";
    const descripcion = body.descripcion || body.description || "Sin descripción";

    if (title) {
      const titleFilter = evaluatePreAi(title);
      if (!titleFilter.isClean) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            error:
              titleFilter.explanation ||
              "El título de la vacante contiene términos no permitidos.",
            details: titleFilter.matches,
          }),
        };
      }
    }

    if (descripcion && descripcion !== "Sin descripción") {
      const descFilter = evaluatePreAi(descripcion);
      if (!descFilter.isClean) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            error:
              descFilter.explanation ||
              "La descripción de la vacante contiene términos no permitidos.",
            details: descFilter.matches,
          }),
        };
      }
    }

    const modalidad = body.modalidad || body.modality || "Presencial";
    const skills = (body.habilidadesRequeridas || body.skills || []) as string[];
    const resolvedSector = (body.sector || (body.sectores && body.sectores[0]) || "General").trim();
    const resolvedSectors = Array.isArray(body.sectores) && body.sectores.length > 0
      ? body.sectores
      : [resolvedSector];

    const isSalaryConfidential = Boolean(
      body.salarioConfidencial || body.isSalaryConfidential,
    );
    const municipio = body.municipio || "Toluca";
    const location =
      body.location ||
      (municipio ? `${municipio}, Estado de México` : "Estado de México");
    const validQuestions = Array.isArray(body.preguntasFiltro)
      ? body.preguntasFiltro.map((q: any) => String(q).trim()).filter((q: string) => q.length > 0).slice(0, 3)
      : Array.isArray(body.screeningQuestions)
        ? body.screeningQuestions.map((q: any) => String(q).trim()).filter((q: string) => q.length > 0).slice(0, 3)
        : [];

    const item: Record<string, any> = {
      PK: `VACANCY#${vacancyUuid}`,
      SK: "METADATA",
      GSI1PK: "VACANCIES",
      GSI1SK: now,
      empresaUuid:
        body.empresaUuid ||
        (event.requestContext as any)?.authorizer?.jwt?.claims?.sub ||
        "",
      titulo: title,
      title: title,
      company: body.company || "Empresa",
      descripcion,
      description: descripcion,
      modalidad,
      salario: body.salario || body.salarioMinimo || 0,
      salarioMinimo: body.salarioMinimo || body.salario || 0,
      salarioMaximo: body.salarioMaximo || body.salario || 0,
      salarioConfidencial: isSalaryConfidential,
      isSalaryConfidential,
      municipio,
      location,
      sector: resolvedSector,
      sectores: resolvedSectors,
      habilidadesRequeridas: skills,
      skills,
      preguntasFiltro: validQuestions,
      screeningQuestions: validQuestions,
      aptitudes: body.aptitudes || "",
      experienciaAnos: body.experienciaAnos || 0,
      ubicacion: {
        lat: body.lat !== undefined ? body.lat : 19.2826,
        lng: body.lng !== undefined ? body.lng : -99.6557,
      },
      lat: body.lat !== undefined ? body.lat : 19.2826,
      lng: body.lng !== undefined ? body.lng : -99.6557,
      pdfUrl: body.pdfUrl || "",
      pdfName: body.pdfName || "",
      vacantesDisponibles: body.vacantesDisponibles
        ? Number(body.vacantesDisponibles)
        : 1,
      estado: "Activa",
      fechaCreacion: now,
      fechaCierre:
        body.fechaCierre ||
        body.fechaVigencia ||
        body.expirationDate ||
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      fechaVigencia:
        body.fechaCierre ||
        body.fechaVigencia ||
        body.expirationDate ||
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      alertaCaducidadEnviada: false,
      alertaAltaDemandaEnviada: false,
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

    if (body.title || body.titulo) {
      const titleFilter = evaluatePreAi(body.title || body.titulo);
      if (!titleFilter.isClean) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            error:
              titleFilter.explanation ||
              "El título de la vacante contiene términos no permitidos.",
            details: titleFilter.matches,
          }),
        };
      }
    }

    if (body.descripcion || body.description) {
      const descFilter = evaluatePreAi(body.descripcion || body.description);
      if (!descFilter.isClean) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            error:
              descFilter.explanation ||
              "La descripción de la vacante contiene términos no permitidos.",
            details: descFilter.matches,
          }),
        };
      }
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
      "salarioConfidencial",
      "isSalaryConfidential",
      "municipio",
      "location",
      "sector",
      "sectores",
      "preguntasFiltro",
      "screeningQuestions",
      "vacantesDisponibles",
      "maxPostulantes",
      "habilidadesRequeridas",
      "skills",
      "ubicacion",
      "lat",
      "lng",
      "estado",
      "apelacionComentarios",
      "pdfUrl",
      "pdfName",
      "fechaCierre",
      "fechaVigencia",
      "alertaCaducidadEnviada",
      "alertaAltaDemandaEnviada",
    ];

    // Normalize aliases for consistency
    if (body.title !== undefined && body.titulo === undefined) {
      body.titulo = body.title;
    } else if (body.titulo !== undefined && body.title === undefined) {
      body.title = body.titulo;
    }

    if (body.fechaCierre !== undefined && body.fechaVigencia === undefined) {
      body.fechaVigencia = body.fechaCierre;
    } else if (body.fechaVigencia !== undefined && body.fechaCierre === undefined) {
      body.fechaCierre = body.fechaVigencia;
    }

    if (body.descripcion !== undefined && body.description === undefined) {
      body.description = body.descripcion;
    } else if (body.description !== undefined && body.descripcion === undefined) {
      body.descripcion = body.description;
    }

    if (body.skills !== undefined && body.habilidadesRequeridas === undefined) {
      body.habilidadesRequeridas = body.skills;
    } else if (body.habilidadesRequeridas !== undefined && body.skills === undefined) {
      body.skills = body.habilidadesRequeridas;
    }

    if (body.salarioConfidencial !== undefined && body.isSalaryConfidential === undefined) {
      body.isSalaryConfidential = Boolean(body.salarioConfidencial);
    } else if (body.isSalaryConfidential !== undefined && body.salarioConfidencial === undefined) {
      body.salarioConfidencial = Boolean(body.isSalaryConfidential);
    }

    if (body.preguntasFiltro !== undefined && body.screeningQuestions === undefined) {
      body.screeningQuestions = Array.isArray(body.preguntasFiltro)
        ? body.preguntasFiltro.slice(0, 3)
        : [];
      body.preguntasFiltro = body.screeningQuestions;
    } else if (body.screeningQuestions !== undefined && body.preguntasFiltro === undefined) {
      body.preguntasFiltro = Array.isArray(body.screeningQuestions)
        ? body.screeningQuestions.slice(0, 3)
        : [];
      body.screeningQuestions = body.preguntasFiltro;
    }

    if (body.lat !== undefined && body.lng !== undefined && body.ubicacion === undefined) {
      body.ubicacion = { lat: body.lat, lng: body.lng };
    }

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

/**
 * Evalúa las vacantes de la empresa o sistema y dispara recordatorio automático
 * exactamente 3 días antes (o menos) de que se cumpla la fecha de vigencia/cierre estipulada.
 */
export async function evaluateAndTriggerVacancyExpirations(vacancies: any[]): Promise<any[]> {
  const nowMs = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  for (const vacancy of vacancies) {
    try {
      if (!vacancy || vacancy.estado === "CERRADA" || vacancy.estado === "Eliminada") {
        continue;
      }

      const expirationDateStr =
        vacancy.fechaCierre ||
        vacancy.fechaVigencia ||
        (vacancy.createdAt
          ? new Date(new Date(vacancy.createdAt).getTime() + 30 * ONE_DAY_MS).toISOString()
          : null);

      if (!expirationDateStr) continue;

      const expirationMs = new Date(expirationDateStr).getTime();
      const diffMs = expirationMs - nowMs;
      const daysRemaining = Math.ceil(diffMs / ONE_DAY_MS);

      // Si faltan 3 días o menos (y aún no ha expirado) y no se ha emitido recordatorio
      if (
        daysRemaining <= 3 &&
        daysRemaining >= 0 &&
        !vacancy.alertaCaducidadEnviada
      ) {
        const companyId = vacancy.empresaUuid;
        const jobTitle = vacancy.title || vacancy.titulo || "Oferta de empleo";
        const formattedDate = new Date(expirationDateStr).toLocaleDateString("es-MX", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        if (companyId) {
          createUserNotification({
            userId: companyId,
            title: "Recordatorio de vigencia de vacante",
            message: `Tu vacante "${jobTitle}" está a ${daysRemaining === 0 ? "menos de 24 horas" : `${daysRemaining} día(s)`} de cumplir su periodo de vigencia (cierre estipulado: ${formattedDate}).`,
            type: "expiration_reminder",
            url: "/my-vacancies",
            extra: {
              jobId: vacancy.id,
              fechaCierre: expirationDateStr,
              diasRestantes: daysRemaining,
            },
          }).catch((err) =>
            console.error("Error creating vacancy expiration reminder:", err),
          );
        }

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${vacancy.id}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET alertaCaducidadEnviada = :flag, fechaAlertaCaducidad = :fecha",
            ExpressionAttributeValues: {
              ":flag": true,
              ":fecha": new Date().toISOString(),
            },
          }),
        );

        vacancy.alertaCaducidadEnviada = true;
      }
    } catch (e) {
      console.error("Error evaluating vacancy expiration:", e);
    }
  }

  return vacancies;
}

export const checkVacancyExpirations: APIGatewayProxyHandler = async (event) => {
  try {
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
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      if (result.Items) {
        vacanciesItems.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const mappedVacancies = vacanciesItems.map((item) => ({
      id: item.PK.replace("VACANCY#", ""),
      empresaUuid: item.empresaUuid,
      title: item.titulo || item.title,
      estado: item.estado,
      createdAt: item.fechaCreacion || item.createdAt,
      fechaCierre: item.fechaCierre || item.fechaVigencia,
      fechaVigencia: item.fechaVigencia || item.fechaCierre,
      alertaCaducidadEnviada: Boolean(item.alertaCaducidadEnviada),
    }));

    await evaluateAndTriggerVacancyExpirations(mappedVacancies);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        evaluatedCount: mappedVacancies.length,
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
