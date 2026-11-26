import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "./common";

export const connect: APIGatewayProxyHandler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.requestContext.authorizer?.principalId || "anonymous";
  console.log(`Connection established: ${connectionId} for user ${userId}`);

  try {
    // 1. Save connection ID lookup metadata
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
          userId,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    // 2. Save user-to-connection mapping (include userId for sender exclusion)
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `WS_CONNECTION#${connectionId}`,
          userId,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    // 3. Save moderator broadcast mapping if user is moderator/admin
    const userRole = (event.requestContext.authorizer?.role || "").toUpperCase();
    const isModerator =
      userRole === "MODERATOR" || userRole === "MODERADOR" || userRole === "ADMIN";

    if (isModerator) {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: "ROLE#MODERATOR",
            SK: `WS_CONNECTION#${connectionId}`,
            userId,
            createdAt: new Date().toISOString(),
          },
        }),
      );
    }

    return { statusCode: 200, body: "Connected" };
  } catch (error: any) {
    console.error("Error saving WS connection:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};

export const disconnect: APIGatewayProxyHandler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  console.log(`Connection closed: ${connectionId}`);

  try {
    // 1. Get connection metadata to retrieve userId
    const lookup = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
        },
      }),
    );

    if (lookup.Item) {
      const userId = lookup.Item.userId;
      // Delete user mapping
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `USER#${userId}`,
            SK: `WS_CONNECTION#${connectionId}`,
          },
        }),
      );
    }

    // Delete moderator broadcast mapping
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: "ROLE#MODERATOR",
          SK: `WS_CONNECTION#${connectionId}`,
        },
      }),
    );

    // Delete connection metadata
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `WS_CONNECTION#${connectionId}`,
          SK: "METADATA",
        },
      }),
    );

    return { statusCode: 200, body: "Disconnected" };
  } catch (error: any) {
    console.error("Error deleting WS connection:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};

export const defaultRoute: APIGatewayProxyHandler = async (event: any) => {
  console.log(`Default route hit: ${event.requestContext.connectionId}`);
  return { statusCode: 200, body: "Default route" };
};
