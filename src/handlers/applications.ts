import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
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

const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

const VALID_STATUSES = [
  "PENDIENTE",
  "REVISADO",
  "ENTREVISTA",
  "ACEPTADO",
  "RECHAZADO",
];

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

/**
 * POST /jobs/{id}/apply
 * Body: { candidateId, coverLetter? }
 * Creates two items for bidirectional querying:
 *   PK=JOB#<jobId>, SK=APP#<candidateId>  (employer view)
 *   PK=USER#<candidateId>, SK=APP#<jobId>  (candidate view)
 */
export const applyToJob: APIGatewayProxyHandler = async (event) => {
  try {
    const jobId = event.pathParameters?.id;
    if (!jobId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { candidateId, coverLetter } = body;

    if (!candidateId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing required field 'candidateId'" }),
      };
    }

    // Verify vacancy maxPostulantes limit
    const jobResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${jobId}`,
          SK: "METADATA",
        },
      }),
    );

    if (jobResult.Item) {
      if (jobResult.Item.estado === "CERRADA") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Esta vacante se encuentra cerrada a nuevas postulaciones.",
          }),
        };
      }

      const maxPostulantes = jobResult.Item.maxPostulantes;
      if (maxPostulantes && Number(maxPostulantes) > 0) {
        const applicantsResult = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": `JOB#${jobId}`,
              ":skPrefix": "APP#",
            },
          }),
        );

        const currentCount = (applicantsResult.Items || []).length;
        if (currentCount >= Number(maxPostulantes)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error:
                "Se ha alcanzado el límite máximo de postulantes para esta vacante.",
            }),
          };
        }
      }
    }

    const appliedAt = new Date().toISOString();

    const applicationData = {
      jobId,
      candidateId,
      status: "PENDIENTE",
      coverLetter: coverLetter || null,
      appliedAt,
    };

    // Write employer-view item (PK=JOB#, SK=APP#candidateId)
    // ConditionExpression prevents duplicate applications
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `JOB#${jobId}`,
          SK: `APP#${candidateId}`,
          ...applicationData,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );

    // Write candidate-view item (PK=USER#, SK=APP#jobId)
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${candidateId}`,
          SK: `APP#${jobId}`,
          ...applicationData,
        },
      }),
    );

    // Write initial chat message to the DynamoDB Chat table (so it matches Easy Apply flow)
    const chatTimestamp = new Date().toISOString();
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `CHAT#${jobId}#${candidateId}`,
          SK: `MSG#${chatTimestamp}`,
          senderId: candidateId,
          text: coverLetter || "Me he postulado a esta vacante.",
          createdAt: chatTimestamp,
        },
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(applicationData),
    };
  } catch (error: unknown) {
    if ((error as any).name === "ConditionalCheckFailedException") {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: "Ya postulaste a esta vacante" }),
      };
    }
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * GET /jobs/{id}/applicants
 * Returns all applicants for a given job
 */
export const getJobApplicants: APIGatewayProxyHandler = async (event) => {
  try {
    const jobId = event.pathParameters?.id;
    if (!jobId) {
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
          ":pk": `JOB#${jobId}`,
          ":skPrefix": "APP#",
        },
      }),
    );

    const applicants = (result.Items || []).map((item) => ({
      candidateId: item.candidateId,
      jobId: item.jobId,
      status: item.status,
      coverLetter: item.coverLetter,
      appliedAt: item.appliedAt,
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(applicants),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * GET /applications?candidateId=xxx
 * Returns all applications for a given candidate
 */
export const getMyApplications: APIGatewayProxyHandler = async (event) => {
  try {
    const candidateId = event.queryStringParameters?.candidateId;
    if (!candidateId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing query parameter 'candidateId'",
        }),
      };
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${candidateId}`,
          ":skPrefix": "APP#",
        },
      }),
    );

    const applications = (result.Items || []).map((item) => ({
      candidateId: item.candidateId,
      jobId: item.jobId,
      status: item.status,
      coverLetter: item.coverLetter,
      appliedAt: item.appliedAt,
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(applications),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

/**
 * PUT /applications/{jobId}/{candidateId}/status
 * Body: { status }
 * Updates both the JOB# and USER# items
 */
export const updateApplicationStatus: APIGatewayProxyHandler = async (
  event,
) => {
  try {
    const jobId = event.pathParameters?.jobId;
    const candidateId = event.pathParameters?.candidateId;

    if (!jobId || !candidateId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing path parameters 'jobId' and/or 'candidateId'",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { status, motivoRechazo, detallesEntrevista } = body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Invalid status. Allowed values: ${VALID_STATUSES.join(", ")}`,
        }),
      };
    }

    // Verify the application exists
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `JOB#${jobId}`,
          SK: `APP#${candidateId}`,
        },
      }),
    );

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Application not found" }),
      };
    }

    if (existing.Item.status === "ACEPTADO" && status === "RECHAZADO") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "No se puede descartar a un candidato que ya ha sido aceptado.",
        }),
      };
    }

    const updatedAt = new Date().toISOString();

    // Update employer-view item
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `JOB#${jobId}`,
          SK: `APP#${candidateId}`,
        },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, motivoRechazo = :motivo, detallesEntrevista = :detalles",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":updatedAt": updatedAt,
          ":motivo": motivoRechazo || null,
          ":detalles": detallesEntrevista || null,
        },
      }),
    );

    // Update candidate-view item
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${candidateId}`,
          SK: `APP#${jobId}`,
        },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, motivoRechazo = :motivo, detallesEntrevista = :detalles",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":updatedAt": updatedAt,
          ":motivo": motivoRechazo || null,
          ":detalles": detallesEntrevista || null,
        },
      }),
    );

    // Fetch candidate profile to get email
    const candidateProfile = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${candidateId}`,
          SK: "PROFILE",
        },
      }),
    );

    // Fetch job details to get title
    const jobDetail = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${jobId}`,
          SK: "METADATA",
        },
      }),
    );

    const candidateEmail = candidateProfile.Item?.email;
    const jobTitle =
      jobDetail.Item?.titulo || jobDetail.Item?.title || "Vacante";
    const companyName = jobDetail.Item?.company || "Empresa";

    let notifTitle = "";
    let notifMessage = "";

    if (status === "RECHAZADO") {
      const reasonStr =
        motivoRechazo || "No se especificó un motivo particular.";
      notifTitle = `Actualización de Postulación: ${jobTitle}`;
      notifMessage = `Tu postulación para la vacante "${jobTitle}" en "${companyName}" ha sido descartada. Motivo: ${reasonStr}`;

      if (candidateEmail) {
        await sesClient
          .send(
            new SendEmailCommand({
              Source: "noreply@franciscojgh.com",
              Destination: { ToAddresses: [candidateEmail] },
              Message: {
                Subject: { Data: notifTitle },
                Body: {
                  Text: {
                    Data: `Hola,\n\nTe informamos que tu postulación para la vacante "${jobTitle}" en "${companyName}" ha sido descartada.\n\nMotivo del descarte:\n${reasonStr}\n\nAgradecemos mucho tu interés y participación en el proceso.\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) => console.error("Error sending rejection email:", err));
      }
    } else if (status === "ENTREVISTA") {
      const detailsStr =
        detallesEntrevista ||
        "El equipo de reclutamiento se pondrá en contacto pronto para definir hora y canal.";
      notifTitle = `Invitación a Entrevista: ${jobTitle}`;
      notifMessage = `¡Felicidades! Tu postulación para "${jobTitle}" ha avanzado a entrevistas. Detalles: ${detailsStr}`;

      if (candidateEmail) {
        await sesClient
          .send(
            new SendEmailCommand({
              Source: "noreply@franciscojgh.com",
              Destination: { ToAddresses: [candidateEmail] },
              Message: {
                Subject: { Data: notifTitle },
                Body: {
                  Text: {
                    Data: `¡Felicidades!\n\nTu postulación para la vacante "${jobTitle}" en "${companyName}" ha avanzado a la fase de entrevistas.\n\nDetalles de la entrevista:\n${detailsStr}\n\nPor favor mantente al pendiente para más indicaciones.\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) => console.error("Error sending interview email:", err));
      }
    } else if (status === "ACEPTADO") {
      notifTitle = `¡Fuiste aceptado! Vacante: ${jobTitle}`;
      notifMessage = `¡Felicidades! Has sido aceptado para la vacante "${jobTitle}" en "${companyName}". El equipo se pondrá en contacto contigo pronto.`;

      if (candidateEmail) {
        await sesClient
          .send(
            new SendEmailCommand({
              Source: "noreply@franciscojgh.com",
              Destination: { ToAddresses: [candidateEmail] },
              Message: {
                Subject: { Data: notifTitle },
                Body: {
                  Text: {
                    Data: `¡Felicidades!\n\nNos complace informarte que has sido seleccionado para la vacante "${jobTitle}" en "${companyName}".\n\nEl equipo de reclutamiento se pondrá en contacto contigo en breve para los siguientes pasos.\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) =>
            console.error("Error sending acceptance email:", err),
          );
      }
    }

    if (notifTitle && notifMessage) {
      const notifId = Math.random().toString(36).substring(2, 15);
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `USER#${candidateId}`,
            SK: `NOTIFICATION#${updatedAt}#${notifId}`,
            id: notifId,
            type: "APPLICATION_UPDATE",
            title: notifTitle,
            message: notifMessage,
            jobId,
            createdAt: updatedAt,
            read: false,
          },
        }),
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ jobId, candidateId, status, updatedAt }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
