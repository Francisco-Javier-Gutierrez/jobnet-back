import { APIGatewayProxyHandler } from "aws-lambda";
import { UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";

// Empresa se une al chat de apelación
export const joinAppeal: APIGatewayProxyHandler = async (event) => {
  try {
    const companyId = event.pathParameters?.id || event.pathParameters?.companyId;
    if (!companyId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyId es requerido" }),
      };
    }

    const timestamp = new Date().toISOString();

    // Actualizar perfil indicando que la empresa inició/accedió a la apelación si no estaba marcado
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        UpdateExpression: "SET apelacionIniciada = :ai, updatedAt = :u",
        ExpressionAttributeValues: {
          ":ai": true,
          ":u": timestamp,
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Unido a la apelación con éxito",
        companyId,
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

export const getAppeals: APIGatewayProxyHandler = async () => {
  try {
    // 1. Fetch organizations under review/appeal
    const orgsResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :gsiPk",
        FilterExpression: "estatus = :st OR estadoCuenta = :ec OR suspensionStatus = :ss",
        ExpressionAttributeValues: {
          ":gsiPk": "PROFILE",
          ":st": "En revisión",
          ":ec": "REVISION",
          ":ss": "IN_REVIEW",
        },
      }),
    );

    // 2. Fetch vacancies under evaluation/appeal
    const vacanciesResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND (estado = :evalState OR banderaRevisionObligatoria = :flag)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":evalState": "EVALUACION",
          ":flag": true,
        },
      }),
    );

    const appeals = [
      ...(orgsResult.Items || []).map((org: any) => ({
        id: org.PK.replace("USER#", ""),
        type: "ORGANIZACION",
        companyId: org.PK.replace("USER#", ""),
        name: org.nombreComercial || org.nombre || org.razonSocial || "Organización en Apelación",
        reason: org.suspensionReason || "Proceso de revisión de cuenta e infracción de normas",
        status: org.estatus || "En revisión",
        gracePeriodEnd: org.suspensionGracePeriodEnd || null,
        createdAt: org.updatedAt || org.fechaCreacion || new Date().toISOString(),
      })),
      ...(vacanciesResult.Items || []).map((vac: any) => ({
        id: vac.PK.replace("VACANCY#", ""),
        type: "VACANTE",
        jobId: vac.PK.replace("VACANCY#", ""),
        companyId: vac.empresaUuid || "",
        name: vac.titulo || "Vacante en evaluación",
        reason:
          vac.motivoSuspensionAutomatica ||
          "Vacante pausada para evaluación por acumulación de reportes",
        status: vac.estado || "EVALUACION",
        gracePeriodEnd: vac.fechaLimiteApelacion || null,
        createdAt: vac.fechaActualizacion || vac.fechaCreacion || new Date().toISOString(),
      })),
    ];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(appeals),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
