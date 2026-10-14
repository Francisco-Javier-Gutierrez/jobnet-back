import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";
import { createUserNotification } from "../../utils/webPushService";

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
    if (!companyId || companyId === "undefined") {
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

    if (
      approve &&
      existing.Item.estadoCuenta &&
      existing.Item.estadoCuenta !== "ACTIVO" &&
      existing.Item.estadoCuenta !== "Activa"
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Solo se puede verificar organizaciones con estatus Activa",
        }),
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

    // Notificar a la empresa por Push y en plataforma
    createUserNotification({
      userId: companyId,
      title: approve ? "¡Empresa Verificada! 🛡️" : "Verificación no aprobada",
      message: approve
        ? "Tu organización ha sido verificada exitosamente en JobNet. Tu insignia de verificación ya está activa."
        : "Tu solicitud de verificación corporativa no fue aprobada. Por favor revisa los documentos fiscales en tu perfil.",
      type: "system",
      url: "/company/verification",
    }).catch((err) =>
      console.error("Error creating verification notification:", err),
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
