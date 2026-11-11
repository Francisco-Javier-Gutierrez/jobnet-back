import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import { docClient, sesClient, tableName, headers } from "./common";
import { createUserNotification } from "../../utils/webPushService";
import { parseJsonBody, safeIdSchema } from "../../utils/validator";
import { extractAuthContext } from "../../utils/authHelper";

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
    if (!jobId || !safeIdSchema.safeParse(jobId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing or invalid path parameter 'id'",
        }),
      };
    }

    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const auth = await extractAuthContext(event);
    const candidateId = auth.userId || body.candidateId;
    const { coverLetter } = body;

    if (!candidateId || !safeIdSchema.safeParse(candidateId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing required field 'candidateId'" }),
      };
    }

    if (coverLetter && typeof coverLetter === "string" && coverLetter.length > 5000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "La carta de presentación no debe exceder los 5000 caracteres.",
        }),
      };
    }

    const targetJobId = jobId.startsWith("VACANCY#") ? jobId.replace(/^VACANCY#/i, "") : jobId;
    const cleanJobId = jobId.replace(/^(VACANCY#|JOB#)/i, "");

    // Verify vacancy maxPostulantes limit
    let jobResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${cleanJobId}`,
          SK: "METADATA",
        },
      }),
    );
    if (!jobResult.Item) {
      jobResult = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `JOB#${cleanJobId}`,
            SK: "METADATA",
          },
        }),
      );
    }

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

      if (jobResult.Item.estado === "PAUSADA") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Esta vacante se encuentra pausada temporalmente por la organización.",
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
              error: "Se ha alcanzado el límite máximo de postulantes para esta vacante.",
            }),
          };
        }
      }

      // Validate required screening questions (preguntas filtro)
      const screeningQuestions: string[] =
        jobResult.Item.preguntasFiltro || jobResult.Item.screeningQuestions || [];
      if (screeningQuestions.length > 0) {
        const respuestasFiltro = body.respuestasFiltro;
        let hasMissingAnswers = false;

        if (!respuestasFiltro) {
          hasMissingAnswers = true;
        } else if (Array.isArray(respuestasFiltro)) {
          for (const q of screeningQuestions) {
            const match = respuestasFiltro.find(
              (r: any) =>
                (typeof r === "object" && r?.pregunta === q && r?.respuesta?.trim()) ||
                (typeof r === "string" && r.trim().length > 0),
            );
            if (!match) {
              hasMissingAnswers = true;
              break;
            }
          }
        } else if (typeof respuestasFiltro === "object") {
          for (const q of screeningQuestions) {
            if (!respuestasFiltro[q]?.trim()) {
              hasMissingAnswers = true;
              break;
            }
          }
        }

        if (hasMissingAnswers) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error:
                "Debes responder obligatoriamente a todas las preguntas filtro de precalificación requeridas por la empresa.",
            }),
          };
        }
      }
    }

    const appliedAt = new Date().toISOString();

    const applicationData: Record<string, any> = {
      jobId,
      candidateId,
      status: "PENDIENTE",
      appliedAt,
    };

    if (coverLetter) {
      applicationData.coverLetter = coverLetter;
    }

    if (body.cvUrl) {
      applicationData.cvUrl = body.cvUrl;
    }

    if (body.cvFileName) {
      applicationData.cvFileName = body.cvFileName;
    }

    if (body.respuestasFiltro) {
      applicationData.respuestasFiltro = body.respuestasFiltro;
    }

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

    // Disparar Notificaciones Push y almacenar en DynamoDB
    const rawCompanyId =
      jobResult.Item?.empresaUuid ||
      jobResult.Item?.companyId ||
      jobResult.Item?.empresaId ||
      jobResult.Item?.userId ||
      jobResult.Item?.usuarioUuid ||
      jobResult.Item?.createdBy;
    const targetCompanyId = rawCompanyId ? String(rawCompanyId).replace(/^USER#/i, "") : "";
    const jobTitle = jobResult.Item?.titulo || jobResult.Item?.title || "tu vacante";

    // Notificación de confirmación al candidato (siempre)
    createUserNotification({
      userId: candidateId,
      title: "¡Postulación enviada! 🎯",
      message: `Te has postulado con éxito a "${jobTitle}". Te avisaremos de cualquier actualización.`,
      type: "application",
      url: "/candidate/my-applications",
      extra: { jobId: targetJobId },
    }).catch((err) => console.error("Error creating candidate notification:", err));

    // Consulta de conteo para notificaciones agrupadas a la organización y alerta de alta demanda
    try {
      const countRes = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `JOB#${jobId}`,
            ":skPrefix": "APP#",
          },
          Select: "COUNT",
        }),
      );
      const queryCount = countRes.Count ?? (countRes.Items ? countRes.Items.length : undefined);
      const totalApplicants = queryCount !== undefined ? queryCount : 1;

      // Restricción de notificaciones a la organización:
      // Se notifica en la 1ra postulación ("Nueva postulación recibida 📄")
      // y posteriormente cada 5 postulaciones acumuladas (5, 10, 15, 20...)
      // para evitar saturar a las empresas ante múltiples candidatos.
      if (targetCompanyId) {
        if (totalApplicants === 1) {
          createUserNotification({
            userId: targetCompanyId,
            title: "Nueva postulación recibida 📄",
            message: `Un candidato se ha postulado a tu vacante "${jobTitle}".`,
            type: "application",
            url: "/vacancies",
            extra: { jobId: targetJobId, candidateId, totalApplicants: 1 },
          }).catch((err) => console.error("Error creating employer notification:", err));
        } else if (totalApplicants > 1 && totalApplicants % 5 === 0) {
          createUserNotification({
            userId: targetCompanyId,
            title: "Nuevas postulaciones recibidas 📄",
            message: `Tu vacante "${jobTitle}" ha alcanzado ${totalApplicants} postulaciones acumuladas.`,
            type: "application",
            url: "/vacancies",
            extra: { jobId: targetJobId, totalApplicants },
          }).catch((err) => console.error("Error creating batched employer notification:", err));
        }
      }

      if (totalApplicants === 50 && !jobResult.Item?.alertaAltaDemandaEnviada && targetCompanyId) {
        // 1. Notificación push en la plataforma
        createUserNotification({
          userId: targetCompanyId,
          title: "Alta demanda de postulaciones",
          message: `Tu vacante "${jobTitle}" ha alcanzado exactamente 50 postulantes.`,
          type: "high_demand",
          url: `/applicants?jobId=${jobId}`,
          extra: { jobId, totalApplicants: 50 },
        }).catch((pushErr) =>
          console.error("Error sending high demand push notification:", pushErr),
        );

        // 2. Correo electrónico automático a la organización
        let companyEmail =
          jobResult.Item?.emailContacto || jobResult.Item?.contactEmail || jobResult.Item?.email;

        if (!companyEmail) {
          try {
            const compProfile = await docClient.send(
              new GetCommand({
                TableName: tableName,
                Key: {
                  PK: `USER#${targetCompanyId}`,
                  SK: "PROFILE",
                },
              }),
            );
            companyEmail = compProfile.Item?.email || compProfile.Item?.correoElectronico;
          } catch (profileErr) {
            console.error("Error fetching company profile for high demand email:", profileErr);
          }
        }

        if (companyEmail) {
          sesClient
            .send(
              new SendEmailCommand({
                Source: "noreply@franciscojgh.com",
                Destination: { ToAddresses: [companyEmail] },
                Message: {
                  Subject: {
                    Data: `Aviso de alta demanda: 50 postulantes en "${jobTitle}"`,
                  },
                  Body: {
                    Text: {
                      Data: `Hola,\n\nTe informamos que tu oferta de empleo "${jobTitle}" ha alcanzado exactamente 50 postulaciones.\n\nPuedes ingresar a JobNet para revisar los perfiles de los candidatos y dar seguimiento a los procesos de selección.\n\nAtentamente,\nEquipo JobNet`,
                    },
                  },
                },
              }),
            )
            .catch((sesErr) => console.error("Error sending high demand email:", sesErr));
        }

        // 3. Marcar bandera para evitar envíos duplicados
        docClient
          .send(
            new UpdateCommand({
              TableName: tableName,
              Key: {
                PK: `VACANCY#${jobId}`,
                SK: "METADATA",
              },
              UpdateExpression:
                "SET alertaAltaDemandaEnviada = :flag, fechaAlertaAltaDemanda = :fecha",
              ExpressionAttributeValues: {
                ":flag": true,
                ":fecha": new Date().toISOString(),
              },
            }),
          )
          .catch((updateErr) => console.error("Error updating high demand alert flag:", updateErr));
      }
    } catch (countError) {
      console.warn("Could not check applicants count for high demand alert:", countError);
    }

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
