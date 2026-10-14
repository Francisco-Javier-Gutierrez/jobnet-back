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

export const toggleLikePost: APIGatewayProxyHandler = async (event) => {
  try {
    const postId = event.pathParameters?.id;
    if (!postId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la publicación",
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
      PK: `POST#${postId}`,
      SK: `LIKE#${userUuid}`,
    };

    // Check if the like exists
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      }),
    );

    let liked = false;

    if (existing.Item) {
      // Like exists, remove it
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
        }),
      );
      liked = false;
    } else {
      // Like doesn't exist, create it
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

        // Notificar al autor del post cuando recibe like
        try {
          const postRes = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: `POST#${postId}`, SK: "METADATA" },
            }),
          );
          const postAuthorUuid = postRes.Item?.authorUuid;
          if (postAuthorUuid && postAuthorUuid !== userUuid) {
            createUserNotification({
              userId: postAuthorUuid,
              title: "Le ha gustado tu publicación ❤️",
              message: "A un usuario de JobNet le gustó tu publicación en el feed.",
              type: "like",
              url: "/feed",
              extra: { postId },
            }).catch((err) =>
              console.error("Error creating post like notification:", err),
            );
          }
        } catch (e) {
          console.warn("Could not notify post author on like:", e);
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ liked, postId, userUuid }),
      };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const addCommentPost: APIGatewayProxyHandler = async (event) => {
  try {
    const postId = event.pathParameters?.id;
    if (!postId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la publicación",
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
      PK: `POST#${postId}`,
      SK: sk,
      author: author || "Usuario Anónimo",
      content,
      parentId: parentId || null,
      createdAt,
    };

    // Clean null values
    const cleanItem = Object.fromEntries(
      Object.entries(commentItem).filter(([, v]) => v !== null),
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: cleanItem,
      }),
    );

    // Notificar al autor de la publicación si no es él mismo
    try {
      const postRes = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `POST#${postId}`, SK: "METADATA" },
        }),
      );
      const postAuthorUuid = postRes.Item?.authorUuid;
      const commenterUuid = body.authorUuid || body.userUuid;

      if (postAuthorUuid && postAuthorUuid !== commenterUuid) {
        createUserNotification({
          userId: postAuthorUuid,
          title: "Nuevo comentario en tu publicación 💬",
          message: `${author || "Alguien"} comentó: "${content.substring(0, 80)}"`,
          type: "comment",
          url: "/feed",
          extra: { postId },
        }).catch((err) =>
          console.error("Error creating post comment notification:", err),
        );
      }
    } catch (e) {
      console.warn("Could not notify post author on comment:", e);
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

export const deleteCommentPost: APIGatewayProxyHandler = async (event) => {
  try {
    const postId = event.pathParameters?.id;
    const commentId = event.pathParameters?.commentId;

    if (!postId || !commentId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Faltan parámetros 'id' o 'commentId'" }),
      };
    }

    // Query all items for this post to get the target comment and check children
    const postItems = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `POST#${postId}`,
        },
      }),
    );

    const items = postItems.Items || [];
    const targetComment = items.find((item: any) => item.SK === commentId);

    if (!targetComment) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Comentario no encontrado" }),
      };
    }

    // Level 2 replies (they have parentId) can always be deleted entirely
    const isLevel2 = !!targetComment.parentId;

    if (isLevel2) {
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `POST#${postId}`,
            SK: commentId,
          },
        }),
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          postId,
          commentId,
          action: "DELETED_REPLY",
        }),
      };
    }

    // Level 1 main comments (no parentId)
    // Check if there are other comments that have parentId = commentId
    const hasChildren = items.some(
      (item: any) =>
        item.SK.startsWith("COMMENT#") &&
        item.parentId === commentId &&
        !item.isDeleted,
    );

    if (hasChildren) {
      // Soft delete: update to placeholder
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: `POST#${postId}`,
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
          postId,
          commentId,
          action: "SOFT_DELETED_PARENT",
          isDeleted: true,
        }),
      };
    } else {
      // Hard delete: delete entirely since it has no children
      await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: `POST#${postId}`,
            SK: commentId,
          },
        }),
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          postId,
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

export const toggleBookmarkPost: APIGatewayProxyHandler = async (event) => {
  try {
    const postId = event.pathParameters?.id;
    if (!postId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la publicación",
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
      PK: `POST#${postId}`,
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
            GSI1SK: `POST#${postId}`,
            fechaInteraccion: new Date().toISOString(),
          },
        }),
      );
      bookmarked = true;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ bookmarked, postId, userUuid }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
