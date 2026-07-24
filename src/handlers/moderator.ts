import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

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

const sesClient = isOffline
  ? new SESClient({
      endpoint: "http://localhost:4565",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new SESClient({});
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-dev";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

export const getVerificationRequests: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND estatusVerificacion = :status",
        ExpressionAttributeValues: {
          ":sk": "PROFILE",
          ":status": "En revisión",
        },
      }),
    );

    const requests = (result.Items || []).map((item: any) => ({
      companyId: item.PK.replace("USER#", ""),
      companyName: item.nombre || "Sin Nombre",
      taxId: item.taxId || "",
      email: item.email || "",
      docUrl: item.documentoVerificacion || "",
      estatusVerificacion: item.estatusVerificacion || "",
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(requests),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const resolveVerification: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId = event.pathParameters?.companyId;
    if (!companyId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'companyId'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { approve } = body;

    if (approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'approve'" }),
      };
    }

    // Fetch existing profile to ensure it exists and get other attributes
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${companyId}`,
          SK: "PROFILE",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Company profile not found" }),
      };
    }

    const updatedItem = {
      ...existing.Item,
      organizacionVerificada: approve,
      estatusVerificacion: approve ? "Verificada" : "Rechazada",
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
      headers,
      body: JSON.stringify({
        success: true,
        companyId,
        organizacionVerificada: approve,
        estatusVerificacion: updatedItem.estatusVerificacion,
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

export const getIncidents: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND begins_with(PK, :prefix) AND (estatus = :statusPendiente OR estatus = :statusEvaluacion)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "INCIDENT#",
          ":statusPendiente": "PENDIENTE",
          ":statusEvaluacion": "EVALUACION",
        },
      }),
    );

    const incidents = (result.Items || [])
      .map((item: any) => ({
        id: item.PK.replace("INCIDENT#", ""),
        jobId: item.jobId || "",
        jobTitle: item.jobTitle || "Vacante sin título",
        reporter: item.reporter || "Anónimo",
        reason: item.reason || "",
        severity: item.severity || "media",
        infraccion: item.infraccion || "otro",
        estatus: item.estatus || "PENDIENTE",
        fechaCreacion: item.fechaCreacion || "",
      }))
      .sort((a, b) => b.fechaCreacion.localeCompare(a.fechaCreacion));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(incidents),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createIncident: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { jobId, jobTitle, reporter, reason, severity, infraccion } = body;

    if (!reason) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'reason'" }),
      };
    }

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const incidentItem = {
      PK: `INCIDENT#${uuid}`,
      SK: "METADATA",
      jobId: jobId || "",
      jobTitle: jobTitle || "",
      reporter: reporter || "Anónimo",
      reason,
      severity: severity || "media",
      infraccion: infraccion || "otro",
      estatus: "PENDIENTE",
      fechaCreacion: createdAt,
    };

    // Remove empty attributes
    const cleanItem = Object.fromEntries(
      Object.entries(incidentItem).filter(([, v]) => v !== ""),
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: cleanItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: uuid,
        ...cleanItem,
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

export const resolveIncident: APIGatewayProxyHandler = async (event) => {
  try {
    const incidentId = event.pathParameters?.incidentId;
    if (!incidentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'incidentId'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { action } = body;

    if (!action || !["approve", "block", "evaluate"].includes(action)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "Invalid or missing body parameter 'action'. Must be 'approve', 'block' or 'evaluate'",
        }),
      };
    }

    // Fetch existing incident
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Incident not found" }),
      };
    }

    const incident = existing.Item;

    // Update incident status
    const newStatus =
      action === "block"
        ? "BLOQUEADO"
        : action === "evaluate"
          ? "EVALUACION"
          : "RESUELTO";
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `INCIDENT#${incidentId}`,
          SK: "METADATA",
        },
        UpdateExpression:
          "SET estatus = :status, fechaActualizacion = :updated",
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":updated": new Date().toISOString(),
        },
      }),
    );

    if (incident.jobId) {
      if (action === "block") {
        // Soft delete the vacancy (Fase 3: Ejecución de sanción)
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression: "SET estado = :closed, deletedAt = :deleted",
            ExpressionAttributeValues: {
              ":closed": "CERRADA",
              ":deleted": new Date().toISOString(),
            },
          }),
        );
      } else if (action === "evaluate") {
        // Pause vacancy for evaluation (Fase 1: Notificación y pausa)
        const graceLimit = new Date();
        graceLimit.setDate(graceLimit.getDate() + 15);

        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :evaluation, fechaLimiteApelacion = :grace",
            ExpressionAttributeValues: {
              ":evaluation": "EVALUACION",
              ":grace": graceLimit.toISOString(),
            },
          }),
        );

        // Fetch company profile to retrieve email
        const vacancy = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
          }),
        );

        if (vacancy.Item && vacancy.Item.empresaUuid) {
          const companyProfile = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${vacancy.Item.empresaUuid}`,
                SK: "PROFILE",
              },
            }),
          );

          const companyEmail =
            companyProfile.Item?.email || "empresa@jobnet.com";
          const jobTitle = vacancy.Item.titulo || "Vacante";

          // Send warning email via SES
          await sesClient
            .send(
              new SendEmailCommand({
                Source: "noreply@jobnet-platform.com",
                Destination: {
                  ToAddresses: [companyEmail],
                },
                Message: {
                  Subject: {
                    Data: `ALERTA: Vacante "${jobTitle}" Pausada para Evaluación`,
                  },
                  Body: {
                    Text: {
                      Data: `Estimado reclutador,\n\nTu publicación de empleo "${jobTitle}" ha sido pausada temporalmente por moderadores de JobNet debido a reportes de sospecha de infracción:\n\nMotivo del reporte: ${incident.reason}\n\nSe ha iniciado un periodo de gracia de 15 días. Tienes hasta el ${graceLimit.toLocaleDateString()} para apelar esta sanción ingresando a la sección "Mis Vacantes" en tu panel de reclutador y seleccionando la opción "Apelar".\n\nAtentamente,\nEquipo de Moderación de JobNet`,
                    },
                  },
                },
              }),
            )
            .catch((err) =>
              console.error(
                "Error sending SES email for vacancy evaluation:",
                err,
              ),
            );
        }
      } else if (action === "approve") {
        // Reactivate vacancy back to active (Fase 3: Apelación favorable)
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              PK: `VACANCY#${incident.jobId}`,
              SK: "METADATA",
            },
            UpdateExpression:
              "SET estado = :active, fechaLimiteApelacion = :nullVal",
            ExpressionAttributeValues: {
              ":active": "Activa",
              ":nullVal": null,
            },
          }),
        );
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        incidentId,
        estatus: newStatus,
        action,
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

function getLevenshteinDistance(a: string, b: string): number {
  const tmp = [];
  let i, j;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] +
          (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return tmp[a.length][b.length];
}

export const getSuggestedSkills: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND begins_with(PK, :prefix)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "SUGGESTION#SKILL#",
        },
      }),
    );

    const suggestions = (result.Items || []).map((item: any) => ({
      id: item.PK.replace("SUGGESTION#SKILL#", ""),
      name: item.name || "",
      createdAt: item.fechaCreacion || "",
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(suggestions),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { name } = body;

    if (!name) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'name'" }),
      };
    }

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const suggestionItem = {
      PK: `SUGGESTION#SKILL#${uuid}`,
      SK: "METADATA",
      name: name.trim(),
      fechaCreacion: createdAt,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: suggestionItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: uuid,
        ...suggestionItem,
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

export const resolveSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const suggestionId = event.pathParameters?.id;
    if (!suggestionId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { approve, unifyWith } = body;

    if (approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'approve'" }),
      };
    }

    // Fetch existing suggestion
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `SUGGESTION#SKILL#${suggestionId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Skill suggestion not found" }),
      };
    }

    const suggestion = existing.Item;
    const skillName = suggestion.name;

    if (approve) {
      // If no explicit unifyWith is provided, check for similarity duplicates
      if (!unifyWith) {
        // Fetch all catalog skills
        const catalogResult = await docClient.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: "SK = :sk",
            ExpressionAttributeValues: {
              ":sk": "CATALOG",
            },
          }),
        );

        const items = catalogResult.Items || [];
        const skills = items.filter(
          (item: any) => item.category === "Habilidad",
        );

        // Check for similarity
        const duplicate = skills.find((skill: any) => {
          // Exact match
          if (skill.name.toLowerCase() === skillName.toLowerCase()) return true;
          // Levenshtein similarity
          const dist = getLevenshteinDistance(skill.name, skillName);
          return dist <= 2;
        });

        if (duplicate) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              duplicate: true,
              existingName: duplicate.name,
              message: `La habilidad '${skillName}' es muy similar a '${duplicate.name}'.`,
            }),
          };
        }
      }

      // If approved or unified: add to catalog
      const finalName = unifyWith || skillName;
      const uuid = Math.random().toString(36).substring(2, 15);

      // Check if it already exists exactly in catalog to avoid duplicates
      const exactCheck = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "SK = :sk AND valName = :valName",
          ExpressionAttributeValues: {
            ":sk": "CATALOG",
            ":valName": finalName.toLowerCase(),
          },
        }),
      );

      if (!exactCheck.Items || exactCheck.Items.length === 0) {
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `CATALOG#${uuid}`,
              SK: "CATALOG",
              name: finalName,
              valName: finalName.toLowerCase(),
              category: "Habilidad",
              createdAt: new Date().toISOString(),
            },
          }),
        );
      }
    }

    // Delete suggestion
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `SUGGESTION#SKILL#${suggestionId}`,
          SK: "METADATA",
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        action: approve ? "APPROVED" : "REJECTED",
        unified: !!unifyWith,
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

export const getDisputes: APIGatewayProxyHandler = async (event) => {
  try {
    const userId = event.queryStringParameters?.userId;
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND begins_with(PK, :prefix)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":prefix": "DISPUTE#",
        },
      }),
    );

    let disputes = (result.Items || []).map((item: any) => ({
      id: item.PK.replace("DISPUTE#", ""),
      jobId: item.jobId || "",
      jobTitle: item.jobTitle || "Vacante",
      candidateId: item.candidateId || "",
      companyId: item.companyId || "",
      complainantId: item.complainantId || "",
      complainantRole: item.complainantRole || "CANDIDATO",
      complainantName: item.complainantName || "Usuario",
      reason: item.reason || "",
      description: item.description || "",
      attachments: item.attachments || [],
      estatus: item.estatus || "ABIERTA",
      fechaCreacion: item.fechaCreacion || "",
      fechaResolucion: item.fechaResolucion || null,
      notes: item.notes || "",
    }));

    if (userId) {
      disputes = disputes.filter(
        (d) =>
          d.candidateId === userId ||
          d.companyId === userId ||
          d.complainantId === userId,
      );
    }

    disputes.sort((a, b) => b.fechaCreacion.localeCompare(a.fechaCreacion));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(disputes),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createDispute: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const {
      jobId,
      jobTitle,
      candidateId,
      companyId,
      complainantId,
      complainantRole,
      complainantName,
      reason,
      description,
      attachments,
    } = body;

    if (!reason || !complainantId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields 'reason' or 'complainantId'",
        }),
      };
    }

    const disputeId = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const disputeItem: any = {
      PK: `DISPUTE#${disputeId}`,
      SK: "METADATA",
      jobId: jobId || "",
      jobTitle: jobTitle || "",
      candidateId: candidateId || "",
      companyId: companyId || "",
      complainantId,
      complainantRole: complainantRole || "CANDIDATO",
      complainantName: complainantName || "Usuario",
      reason,
      description: description || "",
      attachments: attachments || [],
      estatus: "ABIERTA",
      fechaCreacion: createdAt,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: disputeItem,
      }),
    );

    // Initial system message in dispute chat thread
    const msgTimestamp = new Date().toISOString();
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `DISPUTE#${disputeId}`,
          SK: `MSG#${msgTimestamp}`,
          disputeId,
          senderId: complainantId,
          text: `Reclamo Abierto: ${reason}. ${description ? "Detalle: " + description : ""}`,
          createdAt: msgTimestamp,
        },
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: disputeId,
        ...disputeItem,
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

export const resolveDispute: APIGatewayProxyHandler = async (event) => {
  try {
    const disputeId = event.pathParameters?.disputeId;
    if (!disputeId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'disputeId'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { action, notes } = body;

    if (!action || !["resolve", "reject", "in_review"].includes(action)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "Invalid or missing body parameter 'action'. Must be 'resolve', 'reject' or 'in_review'",
        }),
      };
    }

    const newStatus =
      action === "resolve"
        ? "RESUELTA"
        : action === "reject"
          ? "RECHAZADA"
          : "EN_REVISION";

    const resolvedAt = new Date().toISOString();

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `DISPUTE#${disputeId}`,
          SK: "METADATA",
        },
        UpdateExpression:
          "SET estatus = :st, notes = :notes, fechaResolucion = :fr",
        ExpressionAttributeValues: {
          ":st": newStatus,
          ":notes": notes || "",
          ":fr": resolvedAt,
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        disputeId,
        estatus: newStatus,
        notes: notes || "",
        fechaResolucion: resolvedAt,
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
