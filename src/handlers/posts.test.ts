/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIGatewayProxyEvent } from "aws-lambda";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  ScanCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getPosts,
  createPost,
  toggleLikePost,
  addCommentPost,
  deleteCommentPost,
} from "./posts";

describe("posts handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({ Item: null });
  });

  describe("getPosts", () => {
    it("should return sorted and grouped posts on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#post-1",
            SK: "METADATA",
            author: "Francisco Tech",
            role: "EMPRESA",
            authorUuid: "user-1",
            content: "Hola mundo",
            media: "image.png",
            pdfUrl: "doc.pdf",
            pdfName: "Doc",
            createdAt: "2026-07-16T12:00:00.000Z",
          },
          {
            PK: "POST#post-1",
            SK: "LIKE#user-2",
          },
          {
            PK: "POST#post-1",
            SK: "COMMENT#2026-07-16T12:10:00.000Z",
            commentUuid: "comment-1",
            author: "Candidato 1",
            content: "Buen post!",
            createdAt: "2026-07-16T12:10:00.000Z",
          },
          // A like and comment for a non-existing post (should be ignored safely)
          {
            PK: "POST#post-none",
            SK: "LIKE#user-3",
          },
          {
            PK: "POST#post-none",
            SK: "COMMENT#2026-07-16T12:10:00.000Z",
          },
          // Another post to verify date sorting
          {
            PK: "POST#post-2",
            SK: "METADATA",
            author: "Moderador",
            role: "MODERATOR",
            content: "Otro post",
            createdAt: "2026-07-16T13:00:00.000Z",
          },
        ],
      });

      const response = await getPosts({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const posts = JSON.parse(response.body);
      expect(posts).toHaveLength(2);

      // Verify sorting: post-2 is newer than post-1
      expect(posts[0].uniqueId).toBe("post-2");
      expect(posts[1].uniqueId).toBe("post-1");

      // Verify post-1 content grouping
      const post1 = posts[1];
      expect(post1.likesList).toEqual(["user-2"]);
      expect(post1.comments).toHaveLength(1);
      expect(post1.comments[0].id).toBe("COMMENT#2026-07-16T12:10:00.000Z");
      expect(post1.comments[0].user).toBe("Candidato 1");
      expect(post1.comments[0].text).toBe("Buen post!");
    });

    it("should handle empty items array gracefully", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const response = await getPosts({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it("should return 500 on DynamoDB scan error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Dynamo scan error"));
      const response = await getPosts({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("Dynamo scan error");
    });
  });

  describe("createPost", () => {
    it("should return 400 if content, media, and pdfUrl are all missing", async () => {
      const event = {
        body: JSON.stringify({ content: "", media: "", pdfUrl: "" }),
      } as APIGatewayProxyEvent;

      const response = await createPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Debe ingresar");
    });

    it("should create a post successfully and remove null attributes", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        body: JSON.stringify({
          author: "Admin User",
          role: "ADMIN",
          authorUuid: "admin-1",
          content: "Este es un post",
          // media and pdfUrl left blank to check null cleaning
        }),
      } as APIGatewayProxyEvent;

      const response = await createPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const post = JSON.parse(response.body);
      expect(post.uniqueId).toContain("post-");
      expect(post.author).toBe("Admin User");
      expect(post.role).toBe("ADMIN");
      expect(post.content).toBe("Este es un post");
      expect(post.media).toBeUndefined();
      expect(post.pdfUrl).toBeUndefined();
    });

    it("should fallback to defaults when properties are missing in body", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        body: JSON.stringify({
          content: "Hola",
        }),
      } as APIGatewayProxyEvent;

      const response = await createPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const post = JSON.parse(response.body);
      expect(post.author).toBe("Usuario JobNet");
      expect(post.role).toBe("Candidato");
      expect(post.authorUuid).toBe("anonymous");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        body: JSON.stringify({ content: "test" }),
      } as APIGatewayProxyEvent;

      const response = await createPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });

  describe("toggleLikePost", () => {
    it("should return 400 if postId path parameter is missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ userUuid: "user-1" }),
      } as any;

      const response = await toggleLikePost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain(
        "Falta el parámetro 'id'",
      );
    });

    it("should return 400 if userUuid is missing in body", async () => {
      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await toggleLikePost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain(
        "Falta el identificador 'userUuid'",
      );
    });

    it("should add a like if it does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand returns null (like does not exist)
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({ userUuid: "user-1" }),
      } as any;

      const response = await toggleLikePost(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.liked).toBe(true);
      expect(result.postId).toBe("post-1");
      expect(result.userUuid).toBe("user-1");
    });

    it("should remove a like if it already exists", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "POST#post-1",
          SK: "LIKE#user-1",
        },
      }); // GetCommand returns existing like
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand success

      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({ userUuid: "user-1" }),
      } as any;

      const response = await toggleLikePost(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.liked).toBe(false);
    });

    it("should return 500 on database error during toggle", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({ userUuid: "user-1" }),
      } as any;

      const response = await toggleLikePost(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });

  describe("addCommentPost", () => {
    it("should return 400 if postId path parameter is missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ content: "test" }),
      } as any;

      const response = await addCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if content is missing", async () => {
      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({ content: "" }),
      } as any;

      const response = await addCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should add a comment successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({
          author: "Candidato",
          content: "Hola mundo",
          parentId: "parent-1",
        }),
      } as any;

      const response = await addCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const res = JSON.parse(response.body);
      expect(res.user).toBe("Candidato");
      expect(res.text).toBe("Hola mundo");
      expect(res.parentId).toBe("parent-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        pathParameters: { id: "post-1" },
        body: JSON.stringify({ content: "test" }),
      } as any;

      const response = await addCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });

  describe("deleteCommentPost", () => {
    it("should return 400 if path parameters are missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await deleteCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should delete a comment successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "POST#post-1", SK: "comment-1", parentId: null }],
      }); // QueryCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand success

      const event = {
        pathParameters: { id: "post-1", commentId: "comment-1" },
      } as any;

      const response = await deleteCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.postId).toBe("post-1");
      expect(res.commentId).toBe("comment-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        pathParameters: { id: "post-1", commentId: "comment-1" },
      } as any;

      const response = await deleteCommentPost(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });
});
