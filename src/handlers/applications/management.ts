import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, sesClient, tableName, VALID_STATUSES, headers } from "./common";
import { sendPushToUser } from "../../utils/webPushService";
import { sendStyledJobNetEmail } from "../../utils/emailTemplate";
import { extractAuthContext } from "../../utils/authHelper";
import {
  rankCandidatesForVacancyWithDeepSeek,
  CandidateRankingInput,
} from "../../utils/deepseekService";
import { safeIdSchema } from "../../utils/validator";
import {
  checkUserAiCooldown,
  setUserAiCooldown,
  checkJobAiCooldown,
  setJobAiCooldown,
  AI_COOLDOWN_SECONDS,
} from "../../utils/aiCooldownHelper";

export const AI_RANKING_COOLDOWN_MS = AI_COOLDOWN_SECONDS * 1000;

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
 * GET /candidate/my-applications
 * Returns all applications for a given candidate
 * Security: Only users with role CANDIDATO can access this endpoint.
 */
export const getMyApplications: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    const headerUserRole = (
      event.headers?.["x-user-role"] ||
      event.headers?.["X-User-Role"] ||
      event.headers?.["x-user-type"] ||
      event.headers?.["X-User-Type"] ||
      ""
    )
      .toString()
      .toUpperCase();

    // extractAuthContext falls back to "USER" when a Cognito JWT has no custom:role / custom:tipoUsuario claim
    // (e.g., Google federated sign-in or access tokens). Treat "USER" as unspecified and resolve from DynamoDB profile.
    const rawAuthRole = (auth.role || "").toUpperCase();
    const explicitAuthRole = rawAuthRole && rawAuthRole !== "USER" ? rawAuthRole : "";

    let profileRole = "";
    if (!explicitAuthRole && auth.isAuthenticated && auth.userId) {
      try {
        const profileRes = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${auth.userId}`, SK: "PROFILE" },
          }),
        );
        profileRole = (profileRes.Item?.tipoUsuario || "").toString().toUpperCase();
      } catch (profileErr) {
        console.warn("Could not resolve caller profile role in getMyApplications:", profileErr);
      }
    }

    const rawCallerRole = (explicitAuthRole || profileRole || headerUserRole).toUpperCase();
    const callerRole = rawCallerRole === "CANDIDATE" ? "CANDIDATO" : rawCallerRole;

    // Guard: Only CANDIDATO is allowed to access
    if (callerRole && callerRole !== "CANDIDATO") {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Acceso denegado: solo usuarios con rol CANDIDATO pueden consultar este recurso.",
        }),
      };
    }

    const candidateId =
      event.queryStringParameters?.candidateId ||
      auth.userId ||
      event.headers?.["x-user-id"] ||
      (event.headers?.["X-User-Id"] as string);

    if (!candidateId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing query parameter 'candidateId'",
        }),
      };
    }

    // A candidate cannot inspect another candidate's private applications
    if (auth.userId && candidateId !== auth.userId && callerRole === "CANDIDATO") {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "No tienes permiso para consultar las postulaciones de otro candidato.",
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
        await sendStyledJobNetEmail({
          to: candidateEmail,
          subject: notifTitle,
          client: sesClient,
          templateOptions: {
            title: "Actualización sobre tu Postulación",
            badgeText: "Postulación Descartada",
            badgeType: "danger",
            recipientName:
              candidateProfile.Item?.nombre || candidateProfile.Item?.fullName || "Candidato",
            paragraphs: [
              `Te informamos que el equipo de selección de <strong>${companyName}</strong> ha concluido la revisión de las candidaturas para la vacante <strong>${jobTitle}</strong> y en esta ocasión han decidido no continuar con tu proceso.`,
              `Agradecemos enormemente el tiempo, dedicación e interés que mostraste en participar en la convocatoria.`,
            ],
            highlightBox: {
              title: "Motivo informado por el reclutador",
              text: reasonStr,
              type: "danger",
            },
            details: [
              { label: "Posición", value: jobTitle },
              { label: "Empresa", value: companyName },
              { label: "Estado", value: "Proceso Concluido" },
            ],
            cta: {
              text: "Explorar Nuevas Vacantes",
              url: "https://dsty3j5u0b31g.cloudfront.net/vacancies",
            },
            secondaryNotice:
              "Te recomendamos mantener actualizado tu perfil y continuar postulándote a las oportunidades que se ajusten a tus competencias.",
          },
        }).catch((err) => console.error("Error sending rejection email:", err));
      }
    } else if (status === "EN_CONTACTO") {
      const detailsStr =
        detallesEntrevista || "El equipo de reclutamiento se pondrá en contacto pronto.";
      notifTitle = `Avance en Proceso de Selección: ${jobTitle}`;
      notifMessage = `Tu postulación para "${jobTitle}" avanza a la etapa de contacto. Detalles: ${detailsStr}`;

      // Persist the initial message in the job-candidate chat thread so conversation starts with employer's message
      try {
        const chatMsgId = `msg-${Date.now()}`;
        const companyId =
          jobDetail.Item?.empresaUuid || jobDetail.Item?.companyId || "ORGANIZACION";
        const initialChatText =
          detallesEntrevista && detallesEntrevista.trim()
            ? detallesEntrevista.trim()
            : `¡Hola! Hemos avanzado tu postulación para la vacante "${jobTitle}" a la etapa de contacto directo. Nos pondremos en contacto contigo pronto por este medio para coordinar los siguientes pasos.`;

        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `CHAT#${jobId}#${candidateId}`,
              SK: `MSG#${updatedAt}#${chatMsgId}`,
              messageId: chatMsgId,
              senderId: companyId,
              senderName: companyName,
              text: initialChatText,
              createdAt: updatedAt,
            },
          }),
        );
      } catch (chatErr) {
        console.warn("Could not insert initial chat message for EN_CONTACTO:", chatErr);
      }

      if (candidateEmail) {
        await sendStyledJobNetEmail({
          to: candidateEmail,
          subject: notifTitle,
          client: sesClient,
          templateOptions: {
            title: "¡Tu postulación ha avanzado a la etapa de contacto!",
            badgeText: "Avance en Proceso",
            badgeType: "info",
            recipientName:
              candidateProfile.Item?.nombre || candidateProfile.Item?.fullName || "Candidato",
            paragraphs: [
              `¡Excelentes noticias! El equipo de selección de <strong>${companyName}</strong> está interesado en tu perfil para la vacante <strong>${jobTitle}</strong> y te ha avanzado a la etapa de contacto directo.`,
              `Ya puedes intercambiar mensajes de manera directa con los reclutadores a través del chat integrado en la plataforma.`,
            ],
            highlightBox: {
              title: "Mensaje del equipo de reclutamiento",
              text: detailsStr,
              type: "info",
            },
            details: [
              { label: "Posición", value: jobTitle },
              { label: "Empresa", value: companyName },
              { label: "Fase Actual", value: "En Contacto / Entrevista" },
            ],
            cta: {
              text: "Ver Mis Postulaciones y Mensajes",
              url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
            },
            secondaryNotice:
              "Mantén activas tus notificaciones para no perderte ninguna actualización importante del proceso.",
          },
        }).catch((err) => console.error("Error sending contact email:", err));
      }
    } else if (status === "SELECCIONADO") {
      notifTitle = `¡Fuiste seleccionado! Vacante: ${jobTitle}`;
      notifMessage = `¡Felicidades! Has sido seleccionado para la vacante "${jobTitle}" en "${companyName}".`;

      if (candidateEmail) {
        await sendStyledJobNetEmail({
          to: candidateEmail,
          subject: notifTitle,
          client: sesClient,
          templateOptions: {
            title: "¡Felicidades! Has sido seleccionado",
            badgeText: "Candidato Seleccionado",
            badgeType: "purple",
            recipientName:
              candidateProfile.Item?.nombre || candidateProfile.Item?.fullName || "Candidato",
            paragraphs: [
              `¡Enhorabuena! Nos complace informarte que has sido seleccionado por <strong>${companyName}</strong> para la vacante <strong>${jobTitle}</strong>.`,
              `Tu perfil y trayectoria destacaron entre las postulaciones recibidas. El equipo de reclutamiento se pondrá en contacto contigo en breve para formalizar los siguientes pasos y detalles de la propuesta.`,
            ],
            details: [
              { label: "Posición", value: jobTitle },
              { label: "Empresa", value: companyName },
              { label: "Resolución", value: "Seleccionado para propuesta" },
            ],
            cta: {
              text: "Revisar Estado en JobNet",
              url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
            },
            secondaryNotice:
              "Te recomendamos estar atento a tu correo electrónico y a tus mensajes directos en JobNet.",
          },
        }).catch((err) => console.error("Error sending selection email:", err));
      }
    } else if (status === "CONTRATADO") {
      notifTitle = `¡Felicidades! Fuiste contratado para: ${jobTitle}`;
      notifMessage = `¡Enhorabuena! Oficialmente has sido contratado para la vacante "${jobTitle}" en "${companyName}".`;

      if (candidateEmail) {
        await sendStyledJobNetEmail({
          to: candidateEmail,
          subject: notifTitle,
          client: sesClient,
          templateOptions: {
            title: "¡Contratación Confirmada! Bienvenido al equipo",
            badgeText: "¡Contratado! 🎉",
            badgeType: "success",
            recipientName:
              candidateProfile.Item?.nombre || candidateProfile.Item?.fullName || "Candidato",
            paragraphs: [
              `¡Es oficial! Has completado con total éxito el proceso de selección y has sido formalmente contratado para la posición <strong>${jobTitle}</strong> en <strong>${companyName}</strong>.`,
              `¡Todo el equipo de JobNet y ${companyName} te deseamos el mayor de los éxitos en esta nueva etapa profesional!`,
            ],
            details: [
              { label: "Puesto", value: jobTitle },
              { label: "Empresa", value: companyName },
              { label: "Estatus Final", value: "Contratación Exitosa" },
            ],
            cta: {
              text: "Ir a mi Panel de JobNet",
              url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
            },
            secondaryNotice:
              "¡Gracias por confiar en JobNet para impulsar tu desarrollo y crecimiento laboral!",
          },
        }).catch((err) => console.error("Error sending hired email:", err));
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

/**
 * POST /jobs/{id}/ai-ranking
 * Genera el ranking comparativo de candidatos para el ATS de la vacante usando DeepSeek IA
 */
export const rankJobApplicantsWithAi: APIGatewayProxyHandler = async (event) => {
  try {
    const jobId = event.pathParameters?.id;
    if (!jobId || !safeIdSchema.safeParse(jobId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid path parameter 'id'" }),
      };
    }

    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated && !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: "No autorizado. Inicie sesión para utilizar el ATS con IA.",
        }),
      };
    }

    // 1. Obtener los detalles de la vacante
    const jobRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${jobId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!jobRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Vacante no encontrada" }),
      };
    }

    const job = jobRes.Item;
    const isOwner =
      auth.userId &&
      (auth.userId === job.empresaUuid ||
        auth.userId === job.companyId ||
        (job.empresaUuid && auth.userId.toLowerCase() === String(job.empresaUuid).toLowerCase()));
    const isPrivileged = auth.isAdmin || auth.isModerator;

    if (!isOwner && !isPrivileged) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Solo la organización titular de la vacante puede generar la comparativa con IA.",
        }),
      };
    }

    // 2. Registro de cooldown por vacante en DynamoDB con TTL (24h)
    // Solo cuando el registro esté presente en DynamoDB no deja generar contenido con IA para esta vacante
    if (!isPrivileged && jobId) {
      const cooldownCheck = await checkJobAiCooldown(docClient, tableName, jobId);
      if (cooldownCheck.isBlocked) {
        const totalMinutes = Math.ceil(cooldownCheck.remainingSeconds / 60);
        const remainingHours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;

        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: `Esta vacante ya fue evaluada recientemente. Podrás volver a generar la comparativa con IA en ${remainingHours > 0 ? `${remainingHours}h ` : ""}${remainingMinutes}m.`,
            cooldown: true,
            remainingSeconds: cooldownCheck.remainingSeconds,
            remainingMs: cooldownCheck.remainingMs,
            expiresAt: cooldownCheck.expiresAt,
            jobId,
          }),
        };
      }
    }

    // 3. Obtener todos los postulantes de la vacante
    const appsRes = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `JOB#${jobId}`,
          ":skPrefix": "APP#",
        },
      }),
    );

    const applicants = appsRes.Items || [];

    // 3. Resolver perfiles de los candidatos postulados
    const candidatesInput: CandidateRankingInput[] = await Promise.all(
      applicants.map(async (app) => {
        let profile: any = {};
        try {
          const profileRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${app.candidateId}`,
                SK: "PROFILE",
              },
            }),
          );
          profile = profileRes.Item || {};
        } catch {
          // Fallback a campos en la postulación
        }

        return {
          candidateId: app.candidateId,
          name:
            profile.nombre ||
            profile.name ||
            profile.nombreComercial ||
            app.candidateName ||
            `Candidato (${app.candidateId.substring(0, 8)})`,
          titularProfesional: profile.titularProfesional || profile.titular || "Candidato",
          bio: profile.bio || profile.biografia || profile.descripcion || "",
          skills: profile.habilidades || profile.skills || [],
          experience: profile.experiencia || profile.experience || [],
          education: profile.educacion || profile.education || [],
          coverLetter: app.coverLetter || "",
        };
      }),
    );

    // 4. Invocar DeepSeek para el ranking y comparativa
    const rankingResult = await rankCandidatesForVacancyWithDeepSeek(
      {
        id: jobId,
        title: job.title || job.titulo || "Vacante",
        description: job.description || job.descripcion || "",
        requirements: job.requirements || job.requisitos || [],
        skills: job.skills || job.habilidades || [],
        modality: job.modality || job.modalidad || "",
        salary: job.salary || job.salario || "",
      },
      candidatesInput,
    );

    // 5. Guardar en caché el ranking en DynamoDB para futuras consultas de la vacante
    const timestamp = new Date().toISOString();
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `JOB#${jobId}`,
          SK: "AI_RANKING",
          ...rankingResult,
          updatedAt: timestamp,
        },
      }),
    );

    // 6. Registrar bloqueo con TTL en DynamoDB por vacante (24 horas)
    if (!isPrivileged && jobId) {
      await setJobAiCooldown(
        docClient,
        tableName,
        jobId,
        auth.userId,
        job.empresaUuid,
        "ATS_CANDIDATE_RANKING",
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(rankingResult),
    };
  } catch (error: any) {
    console.error("Error generating ATS candidate ranking with IA:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || "Error al generar ranking con IA" }),
    };
  }
};

/**
 * GET /jobs/{id}/ai-ranking
 * Consulta el último ranking generado con IA para una vacante
 */
export const getJobAiRanking: APIGatewayProxyHandler = async (event) => {
  try {
    const jobId = event.pathParameters?.id;
    if (!jobId || !safeIdSchema.safeParse(jobId).success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid path parameter 'id'" }),
      };
    }

    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated && !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado." }),
      };
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `JOB#${jobId}`,
          SK: "AI_RANKING",
        },
      }),
    );

    let jobCooldown: {
      isBlocked: boolean;
      remainingSeconds: number;
      remainingMs: number;
      expiresAt?: string;
    } = {
      isBlocked: false,
      remainingSeconds: 0,
      remainingMs: 0,
    };
    if (jobId) {
      jobCooldown = await checkJobAiCooldown(docClient, tableName, jobId);
    }

    if (!result.Item) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          hasRanking: false,
          ranking: null,
          jobId,
          jobCooldown,
          userCooldown: jobCooldown, // Compatibilidad retroactiva
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...result.Item,
        hasRanking: true,
        jobCooldown,
        userCooldown: jobCooldown, // Compatibilidad retroactiva
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

/**
 * GET /ai/cooldown
 * Consulta el estado de enfriamiento con TTL en DynamoDB (soporta ?jobId=xxx o por usuario)
 */
export const getUserAiCooldown: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = await extractAuthContext(event);
    if (!auth.isAuthenticated || !auth.userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "No autorizado." }),
      };
    }

    const jobId = event.queryStringParameters?.jobId;
    if (jobId) {
      const jobCooldown = await checkJobAiCooldown(docClient, tableName, jobId);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(jobCooldown),
      };
    }

    const cooldown = await checkUserAiCooldown(docClient, tableName, auth.userId);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(cooldown),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
