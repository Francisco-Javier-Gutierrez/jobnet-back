import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { enrichProfileItem, enrichJobItem } from "../../utils/dtoEnricher";

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
export const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

export const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,x-user-id,x-user-role,x-user-email,x-user-type,X-User-Id,X-User-Role,X-User-Email,X-User-Type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

export async function enrichPostsWithRelations(posts: any[], client: any, table: string) {
  if (!posts.length) return [];

  return await Promise.all(
    posts.map(async (post) => {
      const postUuid = post.PK.replace("POST#", "");
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": post.PK,
          },
        }),
      );

      const items = result.Items || [];
      const likesList: string[] = [];
      const bookmarksList: string[] = [];
      const comments: any[] = [];

      for (const item of items) {
        if (item.SK.startsWith("LIKE#")) {
          likesList.push(item.SK.replace("LIKE#", ""));
        } else if (item.SK.startsWith("BOOKMARK#")) {
          bookmarksList.push(item.SK.replace("BOOKMARK#", ""));
        } else if (item.SK.startsWith("COMMENT#")) {
          comments.push({
            id: item.SK,
            parentId: item.parentId || null,
            user: item.author || "Usuario",
            text: item.content || "",
            createdAt: item.createdAt || item.SK.replace("COMMENT#", ""),
            isDeleted: item.isDeleted || false,
          });
        }
      }

      const resolvedLikesCount =
        typeof post.likesCount === "number"
          ? Math.max(post.likesCount, likesList.length)
          : likesList.length;
      const resolvedBookmarksCount =
        typeof post.bookmarksCount === "number"
          ? Math.max(post.bookmarksCount, bookmarksList.length)
          : bookmarksList.length;
      const resolvedCommentsCount =
        typeof post.commentsCount === "number"
          ? Math.max(post.commentsCount, comments.length)
          : comments.length;

      return {
        uniqueId: postUuid,
        author: post.author || "Anónimo",
        role: post.role || "Candidato",
        authorUuid: post.authorUuid || "",
        fotoPerfil: post.fotoPerfil || post.authorAvatar || undefined,
        content: post.content || "",
        media: post.media || undefined,
        pdfUrl: post.pdfUrl || undefined,
        pdfName: post.pdfName || undefined,
        createdAt: post.createdAt || new Date().toISOString(),
        sharesCount: post.sharesCount || 0,
        likesCount: resolvedLikesCount,
        bookmarksCount: resolvedBookmarksCount,
        commentsCount: resolvedCommentsCount,
        likesList,
        bookmarksList,
        comments,
      };
    }),
  );
}

export async function enrichJobsWithRelations(jobs: any[], client: any, table: string) {
  if (!jobs.length) return [];

  return await Promise.all(
    jobs.map(async (jobItem) => {
      const jId = jobItem.id || (jobItem.PK ? jobItem.PK.replace("VACANCY#", "") : "");
      const likesList: string[] = [];
      const bookmarksList: string[] = [];
      let commentsCount = 0;

      try {
        const result = await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: {
              ":pk": `VACANCY#${jId}`,
            },
          }),
        );

        const items = result.Items || [];
        for (const item of items) {
          if (item.SK && item.SK.startsWith("LIKE#")) {
            likesList.push(item.SK.replace("LIKE#", ""));
          } else if (item.SK && item.SK.startsWith("BOOKMARK#")) {
            bookmarksList.push(item.SK.replace("BOOKMARK#", ""));
          } else if (item.SK && item.SK.startsWith("COMMENT#")) {
            if (!item.isDeleted) {
              commentsCount++;
            }
          }
        }
      } catch {
        // Fallback to empty relations if query fails
      }

      const resolvedLikesCount =
        typeof jobItem.likesCount === "number"
          ? Math.max(jobItem.likesCount, likesList.length)
          : likesList.length;
      const resolvedBookmarksCount =
        typeof jobItem.bookmarksCount === "number"
          ? Math.max(jobItem.bookmarksCount, bookmarksList.length)
          : bookmarksList.length;
      const resolvedCommentsCount =
        typeof jobItem.commentsCount === "number"
          ? Math.max(jobItem.commentsCount, commentsCount)
          : commentsCount;

      const enriched = enrichJobItem(
        {
          ...jobItem,
          id: jId,
          likesList,
          bookmarksList,
          likesCount: resolvedLikesCount,
          bookmarksCount: resolvedBookmarksCount,
          commentsCount: resolvedCommentsCount,
          sharesCount: jobItem.sharesCount || 0,
        },
        undefined,
        new Set([jId]),
      );

      return {
        ...enriched,
        likesList,
        bookmarksList,
        likesCount: resolvedLikesCount,
        bookmarksCount: resolvedBookmarksCount,
        commentsCount: resolvedCommentsCount,
        sharesCount: jobItem.sharesCount || 0,
      };
    }),
  );
}

export { enrichProfileItem, enrichJobItem };
