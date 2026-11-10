import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { docClient, tableName, headers } from "./common";
import { evaluatePreAi } from "../../utils/preAiFilter";
import { moderateTextWithAi } from "../../utils/geminiModeration";
import { moderateS3Media } from "../../utils/s3ModerationHelper";
import { parseJsonBody } from "../../utils/validator";
import { extractAuthContext } from "../../utils/authHelper";

export const getPosts: APIGatewayProxyHandler = async (event) => {
  try {
    const authorUuidParam = event.queryStringParameters?.authorUuid;
    const authorNameParam = event.queryStringParameters?.author;
    const bookmarkedByParam = event.queryStringParameters?.bookmarkedBy;

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
          authorAvatar: item.authorAvatar || item.fotoPerfil || undefined,
          fotoPerfil: item.fotoPerfil || item.authorAvatar || undefined,
          content: item.content || "",
          media: item.media || undefined,
          pdfUrl: item.pdfUrl || undefined,
          pdfName: item.pdfName || undefined,
          createdAt: item.createdAt || new Date().toISOString(),
          sharesCount: item.sharesCount || 0,
          likesCount: typeof item.likesCount === "number" ? item.likesCount : undefined,
          bookmarksCount: typeof item.bookmarksCount === "number" ? item.bookmarksCount : undefined,
          commentsCount: typeof item.commentsCount === "number" ? item.commentsCount : undefined,
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

    Object.values(postsMap).forEach((post: any) => {
      post.likesCount =
        typeof post.likesCount === "number"
          ? Math.max(post.likesCount, post.likesList.length)
          : post.likesList.length;
      post.bookmarksCount =
        typeof post.bookmarksCount === "number"
          ? Math.max(post.bookmarksCount, post.bookmarksList.length)
          : post.bookmarksList.length;
      post.commentsCount =
        typeof post.commentsCount === "number"
          ? Math.max(post.commentsCount, post.comments.length)
          : post.comments.length;
    });

    // Third pass: enrich missing authorAvatar by querying user profiles in DynamoDB
    const authorUuids = Array.from(
      new Set(
        Object.values(postsMap)
          .map((p: any) => p.authorUuid)
          .filter((id) => id && id !== "anonymous"),
      ),
    );

    if (authorUuids.length > 0) {
      const profileResults = await Promise.all(
        authorUuids.map((uid) =>
          docClient
            .send(
              new GetCommand({
                TableName: tableName,
                Key: { PK: `USER#${uid}`, SK: "PROFILE" },
              }),
            )
            .catch(() => ({ Item: null })),
        ),
      );

      const profileMap: Record<string, string> = {};
      profileResults.forEach((res) => {
        if (res.Item && res.Item.PK) {
          const uid = res.Item.PK.replace("USER#", "");
          profileMap[uid] = res.Item.fotoPerfil || res.Item.avatarUrl || res.Item.avatar || "";
        }
      });

      Object.values(postsMap).forEach((p: any) => {
        if (!p.authorAvatar && p.authorUuid && profileMap[p.authorUuid]) {
          p.authorAvatar = profileMap[p.authorUuid];
          p.fotoPerfil = profileMap[p.authorUuid];
        }
      });
    }

    // Convert map to array and sort by createdAt descending
    let posts = Object.values(postsMap).sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    if (authorUuidParam) {
      posts = posts.filter(
        (p: any) =>
          p.authorUuid === authorUuidParam ||
          (authorNameParam && p.author.toLowerCase() === authorNameParam.toLowerCase()),
      );
    } else if (authorNameParam) {
      posts = posts.filter((p: any) => p.author.toLowerCase() === authorNameParam.toLowerCase());
    }

    if (bookmarkedByParam) {
      posts = posts.filter(
        (p: any) => Array.isArray(p.bookmarksList) && p.bookmarksList.includes(bookmarkedByParam),
      );
    }

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
    const parseResult = parseJsonBody(event.body, headers);
    if (!parseResult.success) {
      return parseResult.response;
    }
    const body = parseResult.data;
    const auth = await extractAuthContext(event);

    const { author, role, authorUuid, authorAvatar, fotoPerfil, content, media, pdfUrl, pdfName } =
      body;

    if (!content && !media && !pdfUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Debe ingresar contenido, imagen o documento PDF.",
        }),
      };
    }

    if (content && typeof content === "string" && content.length > 5000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "El contenido de la publicación excede el límite máximo de 5000 caracteres.",
        }),
      };
    }

    if (content) {
      const filterResult = evaluatePreAi(content);
      if (!filterResult.isClean) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error:
              filterResult.explanation ||
              "El contenido infringe las normas de convivencia de JobNet.",
            details: filterResult.matches,
          }),
        };
      }

      const aiModeration = await moderateTextWithAi(content, "POST");
      if (!aiModeration.safe) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: aiModeration.reason || "La publicación infringe las políticas comunitarias.",
            flaggedCategories: aiModeration.flaggedCategories,
          }),
        };
      }
    }

    if (media) {
      const mediaMod = await moderateS3Media(media, "IMAGE");
      if (!mediaMod.safe) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error:
              mediaMod.reason || "La imagen adjunta infringe las políticas de contenido de JobNet.",
            flaggedCategories: mediaMod.flaggedCategories,
          }),
        };
      }
    }

    if (pdfUrl) {
      const pdfMod = await moderateS3Media(pdfUrl, "PDF");
      if (!pdfMod.safe) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error:
              pdfMod.reason ||
              "El documento adjunto infringe las políticas de contenido de JobNet.",
            flaggedCategories: pdfMod.flaggedCategories,
          }),
        };
      }
    }

    const postUuid = `post-${randomUUID()}`;
    const createdAt = new Date().toISOString();

    const postItem = {
      PK: `POST#${postUuid}`,
      SK: "METADATA",
      author: author || "Usuario JobNet",
      role: role || "Candidato",
      authorUuid: auth.userId || authorUuid || "anonymous",
      authorAvatar: authorAvatar || fotoPerfil || null,
      fotoPerfil: fotoPerfil || authorAvatar || null,
      content: content || "",
      media: media || null,
      pdfUrl: pdfUrl || null,
      pdfName: pdfName || null,
      createdAt,
      sharesCount: 0,
      likesCount: 0,
      bookmarksCount: 0,
      commentsCount: 0,
      GSI1PK: `POSTS#${authorUuid || "anonymous"}`,
      GSI1SK: `POST#${postUuid}`,
    };

    // Remove null values to comply with NoSQL DynamoDB rules
    const cleanItem = Object.fromEntries(Object.entries(postItem).filter(([, v]) => v !== null));

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

export const sharePost: APIGatewayProxyHandler = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Falta el parámetro 'id' de la publicación",
        }),
      };
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: `POST#${id}`,
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
