import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

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
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-dev";

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
    const { status } = body;

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

    const updatedAt = new Date().toISOString();

    // Update employer-view item
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `JOB#${jobId}`,
          SK: `APP#${candidateId}`,
        },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":updatedAt": updatedAt,
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
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":updatedAt": updatedAt,
        },
      }),
    );

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
