import { describe, it, expect, vi, beforeEach } from "vitest";

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
  PutCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
}));

import { getPosts, createPost, sharePost } from "./postsCrud";

describe("posts CRUD handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getPosts", () => {
    it("should retrieve posts, assemble relations and enrich author avatars", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#p-1",
            SK: "METADATA",
            author: "Alice",
            authorUuid: "u-1",
            content: "First post",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "POST#p-1",
            SK: "LIKE#u-2",
          },
          {
            PK: "POST#p-1",
            SK: "BOOKMARK#u-3",
          },
          {
            PK: "POST#p-1",
            SK: "COMMENT#2026-01-01T01:00:00.000Z",
            author: "Bob",
            content: "Nice post!",
          },
        ],
      }); // ScanCommand

      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#u-1",
          SK: "PROFILE",
          fotoPerfil: "https://avatar.com/alice.png",
        },
      }); // GetCommand profile

      const res = await getPosts({ queryStringParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const posts = JSON.parse(res.body);
      expect(posts).toHaveLength(1);
      expect(posts[0].uniqueId).toBe("p-1");
      expect(posts[0].likesList).toContain("u-2");
      expect(posts[0].bookmarksList).toContain("u-3");
      expect(posts[0].comments).toHaveLength(1);
      expect(posts[0].fotoPerfil).toBe("https://avatar.com/alice.png");
    });

    it("should filter posts by authorUuid and bookmarkedBy", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#p-1",
            SK: "METADATA",
            authorUuid: "u-1",
            author: "Alice",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "POST#p-1",
            SK: "BOOKMARK#target-user",
          },
          {
            PK: "POST#p-2",
            SK: "METADATA",
            authorUuid: "u-2",
            author: "Bob",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      mockDynamoSend.mockResolvedValue({ Item: null });

      const res = await getPosts(
        {
          queryStringParameters: {
            authorUuid: "u-1",
            bookmarkedBy: "target-user",
          },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const posts = JSON.parse(res.body);
      expect(posts).toHaveLength(1);
      expect(posts[0].uniqueId).toBe("p-1");
    });

    it("should filter posts by authorName alone and handle profile lookup error", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#p-1",
            SK: "METADATA",
            authorUuid: "u-err",
            author: "Alice",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "POST#p-2",
            SK: "METADATA",
            authorUuid: "u-2",
            author: "Bob",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }); // Scan

      mockDynamoSend.mockRejectedValueOnce(new Error("Profile DB fail")); // catch in line 102
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const res = await getPosts(
        {
          queryStringParameters: {
            author: "Alice",
          },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const posts = JSON.parse(res.body);
      expect(posts).toHaveLength(1);
      expect(posts[0].author).toBe("Alice");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Posts DB error"));
      const res = await getPosts({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("createPost", () => {
    it("should return 400 if no content, media, or pdfUrl provided", async () => {
      const res = await createPost({ body: JSON.stringify({}) } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should create a post successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await createPost(
        {
          body: JSON.stringify({
            author: "Alice",
            content: "Hello everyone!",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.author).toBe("Alice");
      expect(data.content).toBe("Hello everyone!");
    });

    it("should reject post if content contains toxic slang or insults (Pre-AI Filter)", async () => {
      const res = await createPost(
        {
          body: JSON.stringify({
            author: "Troll",
            content: "Callate sybau y vete alv",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("Contenido bloqueado por el filtro de seguridad");
      expect(data.details).toContain("sybau");
      expect(data.details).toContain("alv");
      expect(mockDynamoSend).not.toHaveBeenCalled();
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Create post error"));
      const res = await createPost(
        { body: JSON.stringify({ content: "Hello" }) } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("sharePost", () => {
    it("should return 400 if id is missing", async () => {
      const res = await sharePost({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should increment sharesCount on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Attributes: { sharesCount: 3 } });
      const res = await sharePost({ pathParameters: { id: "p-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).sharesCount).toBe(3);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Share post error"));
      const res = await sharePost({ pathParameters: { id: "p-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });
});
