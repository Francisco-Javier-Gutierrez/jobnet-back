/* eslint-disable @typescript-eslint/no-explicit-any */
import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
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

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

export const getPosts: APIGatewayProxyHandler = async () => {
  try {
    // Scan all items where PK starts with POST#
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(PK, :pkPrefix)",
        ExpressionAttributeValues: {
          ":pkPrefix": "POST#",
        },
      }),
    );

    const items = result.Items || [];

    // Group items by post UUID
    const postsMap: Record<string, any> = {};

    // First pass: extract metadata (the posts themselves)
    for (const item of items) {
      const postUuid = item.PK.replace("POST#", "");
      if (item.SK === "METADATA") {
        postsMap[postUuid] = {
          uniqueId: postUuid,
          author: item.author || "Anónimo",
          role: item.role || "Candidato",
          authorUuid: item.authorUuid || "",
          content: item.content || "",
          media: item.media || undefined,
          pdfUrl: item.pdfUrl || undefined,
          pdfName: item.pdfName || undefined,
          createdAt: item.createdAt || new Date().toISOString(),
          likesList: [],
          bookmarksList: [],
          comments: [],
        };
      }
    }

    // Second pass: associate likes and comments
    for (const item of items) {
      const postUuid = item.PK.replace("POST#", "");
      const post = postsMap[postUuid];

      // If the post metadata exists in this table
      if (post) {
        if (item.SK.startsWith("LIKE#")) {
          const userUuid = item.SK.replace("LIKE#", "");
          post.likesList.push(userUuid);
        } else if (item.SK.startsWith("BOOKMARK#")) {
          const userUuid = item.SK.replace("BOOKMARK#", "");
          post.bookmarksList.push(userUuid);
        } else if (item.SK.startsWith("COMMENT#")) {
          post.comments.push({
            id: item.SK,
            parentId: item.parentId || null,
            user: item.author || "Usuario",
            text: item.content || "",
            createdAt: item.createdAt || item.SK.replace("COMMENT#", ""),
            isDeleted: item.isDeleted || false,
          });
        }
      }
    }

    // Convert map to array and sort by createdAt descending
    const posts = Object.values(postsMap).sort(
      (a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(posts),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createPost: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { author, role, authorUuid, content, media, pdfUrl, pdfName } = body;

    if (!content && !media && !pdfUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Debe ingresar contenido, imagen o documento PDF.",
        }),
      };
    }

    const postUuid = `post-${Math.random().toString(36).substring(2, 15)}`;
    const createdAt = new Date().toISOString();

    const postItem = {
      PK: `POST#${postUuid}`,
      SK: "METADATA",
      author: author || "Usuario JobNet",
      role: role || "Candidato",
      authorUuid: authorUuid || "anonymous",
      content: content || "",
      media: media || null,
      pdfUrl: pdfUrl || null,
      pdfName: pdfName || null,
      createdAt,
    };

    // Remove null values to comply with NoSQL DynamoDB rules
    const cleanItem = Object.fromEntries(
      Object.entries(postItem).filter(([, v]) => v !== null),
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: cleanItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        uniqueId: postUuid,
        likesList: [],
        bookmarksList: [],
        comments: [],
        ...cleanItem,
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
