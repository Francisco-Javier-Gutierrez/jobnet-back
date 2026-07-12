import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

const s3Client = isOffline
  ? new S3Client({
      endpoint: "http://localhost:4569",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
      forcePathStyle: true,
    })
  : new S3Client({});

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
const bucketName = process.env.S3_UPLOAD_BUCKET || "jobnet-uploads-dev";

export const getJobs: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "SK = :sk AND begins_with(PK, :pkPrefix)",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":pkPrefix": "VACANCY#",
        },
      }),
    );
    const jobs = (result.Items || []).map((item) => ({
      id: item.PK.replace("VACANCY#", ""),
      title: item.titulo || item.title,
      company: item.company || "Empresa",
      empresaUuid: item.empresaUuid || "",
      lat: item.ubicacion?.lat || item.lat || 0,
      lng: item.ubicacion?.lng || item.lng || 0,
      modalidad: item.modalidad || "Presencial",
      salario: item.salario || 0,
      habilidadesRequeridas: item.habilidadesRequeridas || [],
      descripcion: item.descripcion || "Sin descripción",
      createdAt: item.fechaCreacion || item.createdAt,
    }));
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jobs),
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
    const vacancyUuid = Math.random().toString(36).substring(2);
    const item = {
      PK: `VACANCY#${vacancyUuid}`,
      SK: "METADATA",
      empresaUuid: body.empresaUuid || "mock-empresa-uuid",
      titulo: body.title,
      company: body.company || "Empresa",
      descripcion: body.description || "Sin descripción",
      modalidad: body.modalidad || "Presencial",
      salario: body.salario || 0,
      habilidadesRequeridas: body.habilidadesRequeridas || [],
      ubicacion: {
        lat: body.lat || 0,
        lng: body.lng || 0,
      },
      lat: body.lat || 0,
      lng: body.lng || 0,
      estado: "Activa",
      fechaCreacion: new Date().toISOString(),
    };
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

export const getUploadPresignedUrl: APIGatewayProxyHandler = async () => {
  try {
    const key = `uploads/${Date.now()}-${Math.random().toString(36).substring(2)}`;
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, key }),
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

export const sendNotificationEmail: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { to, subject, message } = body;
    await sesClient.send(
      new SendEmailCommand({
        Source: "noreply@jobnet-platform.com",
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: message } },
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
      body: JSON.stringify({ success: true }),
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

    // Check ownership if empresaUuid is provided
    if (body.empresaUuid && existing.Item.empresaUuid !== body.empresaUuid) {
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
      "habilidadesRequeridas",
      "skills",
      "ubicacion",
      "lat",
      "lng",
      "location",
      "estado",
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
