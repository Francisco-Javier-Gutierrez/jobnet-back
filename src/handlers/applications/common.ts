import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";

export const isOffline = process.env.IS_OFFLINE === "true";

export const dbClient = isOffline
  ? new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(dbClient);

export const sesClient = isOffline
  ? new SESClient({
      endpoint: "http://localhost:4565",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new SESClient({});

export const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

export const VALID_STATUSES = [
  "PENDIENTE",
  "EN_CONTACTO",
  "SELECCIONADO",
  "RECHAZADO",
  "CONTRATADO",
];

export const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};
