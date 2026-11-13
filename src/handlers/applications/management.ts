import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import { docClient, sesClient, tableName, VALID_STATUSES, headers } from "./common";
import { sendPushToUser } from "../../utils/webPushService";

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
      updatedAt: item.updatedAt,
      motivoRechazo: item.motivoRechazo || item.rejectionReason || null,
      detallesEntrevista: item.detallesEntrevista || null,
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
      updatedAt: item.updatedAt,
      motivoRechazo: item.motivoRechazo || item.rejectionReason || null,
      detallesEntrevista: item.detallesEntrevista || null,
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
export const updateApplicationStatus: APIGatewayProxyHandler = async (event) => {
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

    if (
      (existing.Item.status === "SELECCIONADO" || existing.Item.status === "CONTRATADO") &&
      status === "RECHAZADO"
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "No se puede descartar a un candidato que ya ha sido seleccionado o contratado.",
        }),
      };
    }

    const updatedAt = new Date().toISOString();

    let updateExp = "SET #status = :status, updatedAt = :updatedAt";
    const expValues: Record<string, any> = {
      ":status": status,
      ":updatedAt": updatedAt,
    };
    if (motivoRechazo) {
      updateExp += ", motivoRechazo = :motivo";
      expValues[":motivo"] = motivoRechazo;
    }
    if (detallesEntrevista) {
      updateExp += ", detallesEntrevista = :detalles";
      expValues[":detalles"] = detallesEntrevista;
    }

    // Update employer-view item
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `JOB#${jobId}`,
          SK: `APP#${candidateId}`,
        },
        UpdateExpression: updateExp,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expValues,
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
        UpdateExpression: updateExp,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expValues,
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
    const jobTitle = jobDetail.Item?.titulo || jobDetail.Item?.title || "Vacante";
    const companyName = jobDetail.Item?.company || "Empresa";

    let notifTitle = "";
    let notifMessage = "";

    if (status === "RECHAZADO") {
      const reasonStr = motivoRechazo || "No se especificó un motivo particular.";
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
    } else if (status === "EN_CONTACTO") {
      const detailsStr =
        detallesEntrevista || "El equipo de reclutamiento se pondrá en contacto pronto.";
      notifTitle = `Avance en Proceso de Selección: ${jobTitle}`;
      notifMessage = `Tu postulación para "${jobTitle}" avanza a la etapa de contacto. Detalles: ${detailsStr}`;

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
                    Data: `Hola,\n\nTe informamos que tu postulación para la vacante "${jobTitle}" en "${companyName}" ha avanzado a la etapa de contacto.\n\nMensaje del equipo de reclutamiento:\n${detailsStr}\n\nYa puedes comunicarte de manera directa con nosotros a través del chat integrado en tu perfil.\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) => console.error("Error sending contact email:", err));
      }
    } else if (status === "SELECCIONADO") {
      notifTitle = `¡Fuiste seleccionado! Vacante: ${jobTitle}`;
      notifMessage = `¡Felicidades! Has sido seleccionado para la vacante "${jobTitle}" en "${companyName}".`;

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
                    Data: `¡Felicidades!\n\nNos complace informarte que has sido seleccionado para la vacante "${jobTitle}" en "${companyName}".\n\nEl equipo de reclutamiento se pondrá en contacto contigo en breve para los pasos finales.\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) => console.error("Error sending selection email:", err));
      }
    } else if (status === "CONTRATADO") {
      notifTitle = `¡Felicidades! Fuiste contratado para: ${jobTitle}`;
      notifMessage = `¡Enhorabuena! Oficialmente has sido contratado para la vacante "${jobTitle}" en "${companyName}".`;

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
                    Data: `¡Enhorabuena!\n\nEs oficial, has sido contratado para la vacante "${jobTitle}" en "${companyName}".\n\n¡Te damos la bienvenida al equipo!\n\nAtentamente,\nEquipo de Reclutamiento de ${companyName}`,
                  },
                },
              },
            }),
          )
          .catch((err) => console.error("Error sending hired email:", err));
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

      try {
        await sendPushToUser(candidateId, {
          title: notifTitle,
          body: notifMessage,
          url: "/candidate/my-applications",
          data: { jobId, type: "APPLICATION_UPDATE" },
        });
      } catch (err) {
        console.error("Error sending application update push:", err);
      }
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
