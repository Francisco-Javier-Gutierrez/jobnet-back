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
    "Content-Type,Authorization,x-user-id,x-user-role,X-User-Id,X-User-Role",
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
        likesList,
        bookmarksList,
        comments,
      };
    }),
  );
}

export { enrichProfileItem, enrichJobItem };
