import { APIGatewayProxyHandler } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";
import { createUserNotification } from "../../utils/webPushService";

export const toggleLikeJob: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la vacante",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { userUuid } = body;

    if (!userUuid) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el identificador 'userUuid' en el cuerpo",
        }),
      };
    }

    const key = {
      PK: `VACANCY#${id}`,
      SK: `LIKE#${userUuid}`,
    };

    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      }),
    );

    let liked = false;
    if (existing.Item) {
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
        }),
      );
      liked = false;
    } else {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...key,
            fechaInteraccion: new Date().toISOString(),
          },
        }),
      );
      liked = true;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ liked, id, userUuid }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const addCommentJob: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la vacante",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { author, content, parentId } = body;

    if (!content) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Falta el contenido del comentario" }),
      };
    }

    const createdAt = new Date().toISOString();
    const sk = `COMMENT#${createdAt}`;

    const commentItem = {
      PK: `VACANCY#${id}`,
      SK: sk,
      author: author || "Usuario Anónimo",
      content,
      parentId: parentId || null,
      createdAt,
    };

    const cleanItem = Object.fromEntries(
      Object.entries(commentItem).filter(([, v]) => v !== null),
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: cleanItem,
      }),
    );

    // Notificar a la empresa de la vacante
    try {
      const jobRes = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `VACANCY#${id}`, SK: "METADATA" },
        }),
      );
      const targetCompany =
        jobRes.Item?.empresaUuid || jobRes.Item?.companyId;
      const jobTitle =
        jobRes.Item?.titulo || jobRes.Item?.title || "tu vacante";

      if (targetCompany) {
        createUserNotification({
          userId: targetCompany,
          title: "Nuevo comentario en tu vacante 💬",
          message: `${author || "Un candidato"} comentó en "${jobTitle}": "${content.substring(0, 80)}"`,
          type: "comment",
          url: `/jobs/${id}`,
          extra: { jobId: id },
        }).catch((err) =>
          console.error("Error creating job comment notification:", err),
        );
      }
    } catch (e) {
      console.warn("Could not notify company on job comment:", e);
    }

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        id: sk,
        parentId: parentId || null,
        user: author || "Usuario Anónimo",
        text: content,
        createdAt,
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

export const deleteCommentJob: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    const commentId = event.pathParameters?.commentId;

    if (!id || !commentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Faltan parámetros 'id' o 'commentId'" }),
      };
    }

    const jobItems = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `VACANCY#${id}`,
        },
      }),
    );

    const items = jobItems.Items || [];
    const targetComment = items.find((item: any) => item.SK === commentId);

    if (!targetComment) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Comentario no encontrado" }),
      };
    }

    const isLevel2 = !!targetComment.parentId;

    if (isLevel2) {
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${id}`,
            SK: commentId,
          },
        }),
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          id,
          commentId,
          action: "DELETED_REPLY",
        }),
      };
    }

    const hasChildren = items.some(
      (item: any) =>
        item.SK.startsWith("COMMENT#") &&
        item.parentId === commentId &&
        !item.isDeleted,
    );

    if (hasChildren) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${id}`,
            SK: commentId,
          },
          UpdateExpression:
            "SET content = :deletedText, author = :deletedAuthor, isDeleted = :isDeleted",
          ExpressionAttributeValues: {
            ":deletedText": "Comentario no disponible",
            ":deletedAuthor": "Eliminado",
            ":isDeleted": true,
          },
        }),
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          id,
          commentId,
          action: "SOFT_DELETED_PARENT",
          isDeleted: true,
        }),
      };
    } else {
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `VACANCY#${id}`,
            SK: commentId,
          },
        }),
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          id,
          commentId,
          action: "DELETED_PARENT",
        }),
      };
    }
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const toggleBookmarkJob: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la vacante",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { userUuid } = body;

    if (!userUuid) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el identificador 'userUuid' en el cuerpo",
        }),
      };
    }

    const key = {
      PK: `VACANCY#${id}`,
      SK: `BOOKMARK#${userUuid}`,
    };

    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      }),
    );

    let bookmarked = false;

    if (existing.Item) {
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
        }),
      );
      bookmarked = false;
    } else {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...key,
            GSI1PK: `BOOKMARK#${userUuid}`,
            GSI1SK: `VACANCY#${id}`,
            fechaInteraccion: new Date().toISOString(),
          },
        }),
      );
      bookmarked = true;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ bookmarked, id, userUuid }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const shareJob: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la vacante",
        }),
      };
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${id}`,
          SK: "METADATA",
        },
        UpdateExpression: "ADD sharesCount :inc",
        ExpressionAttributeValues: {
          ":inc": 1,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        id,
        sharesCount: result.Attributes?.sharesCount || 1,
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
