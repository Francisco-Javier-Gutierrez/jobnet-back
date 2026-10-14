import { APIGatewayProxyHandler } from "aws-lambda";
import {
  PutCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";
import { createUserNotification } from "../../utils/webPushService";

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

    const applicationData: Record<string, any> = {
      jobId,
      candidateId,
      status: "PENDIENTE",
      appliedAt,
    };

    if (coverLetter) {
      applicationData.coverLetter = coverLetter;
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
    const targetCompanyId =
      jobResult.Item?.empresaUuid || jobResult.Item?.companyId;
    const jobTitle =
      jobResult.Item?.titulo || jobResult.Item?.title || "tu vacante";

    if (targetCompanyId) {
      createUserNotification({
        userId: targetCompanyId,
        title: "Nueva postulación recibida 📄",
        message: `Un candidato se ha postulado a tu vacante "${jobTitle}".`,
        type: "application",
        url: "/vacancies",
        extra: { jobId, candidateId },
      }).catch((err) =>
        console.error("Error creating employer notification:", err),
      );
    }

    createUserNotification({
      userId: candidateId,
      title: "¡Postulación enviada! 🎯",
      message: `Te has postulado con éxito a "${jobTitle}". Te avisaremos de cualquier actualización.`,
      type: "application",
      url: "/candidate/my-applications",
      extra: { jobId },
    }).catch((err) =>
      console.error("Error creating candidate notification:", err),
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
