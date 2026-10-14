import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { enrichJobItem } from "../../utils/dtoEnricher";

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

export const s3Client = isOffline
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
export const bucketName = process.env.S3_UPLOAD_BUCKET || "jobnet-uploads-prod";

export const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

export { enrichJobItem };
