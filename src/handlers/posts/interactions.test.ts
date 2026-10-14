import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("../../utils/webPushService", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }),
  createUserNotification: vi.fn().mockResolvedValue("test-notif-id"),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  toggleLikePost,
  addCommentPost,
  deleteCommentPost,
  toggleBookmarkPost,
} from "./interactions";

describe("posts interactions handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("toggleLikePost", () => {
    it("should return 400 if id or userUuid is missing", async () => {
      const res1 = await toggleLikePost(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(400);

      const res2 = await toggleLikePost(
        { pathParameters: { id: "p-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should like and unlike post", async () => {
      // 1. Like
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      mockDynamoSend.mockResolvedValueOnce({});
      const res1 = await toggleLikePost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).liked).toBe(true);

      // 2. Unlike
      mockDynamoSend.mockResolvedValueOnce({ Item: { PK: "POST#p-1" } });
      mockDynamoSend.mockResolvedValueOnce({});
      const res2 = await toggleLikePost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).liked).toBe(false);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Like post error"));
      const res = await toggleLikePost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("addCommentPost", () => {
    it("should return 400 if id or content is missing", async () => {
      const res1 = await addCommentPost(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(400);

      const res2 = await addCommentPost(
        { pathParameters: { id: "p-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should add comment successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await addCommentPost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ author: "Alice", content: "Great insight!" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.user).toBe("Alice");
      expect(data.text).toBe("Great insight!");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Comment error"));
      const res = await addCommentPost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ content: "Hi" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("deleteCommentPost", () => {
    it("should return 400 if id or commentId is missing", async () => {
      const res = await deleteCommentPost(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if comment does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res = await deleteCommentPost(
        { pathParameters: { id: "p-1", commentId: "c-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should hard delete reply with parentId", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "c-reply", parentId: "c-parent" }],
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await deleteCommentPost(
        { pathParameters: { id: "p-1", commentId: "c-reply" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("DELETED_REPLY");
    });

    it("should soft delete parent comment if it has active child replies", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { SK: "c-parent" },
          { SK: "COMMENT#reply-1", parentId: "c-parent", isDeleted: false },
        ],
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await deleteCommentPost(
        { pathParameters: { id: "p-1", commentId: "c-parent" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("SOFT_DELETED_PARENT");
    });

    it("should hard delete parent comment if it has no child replies", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "c-parent" }],
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await deleteCommentPost(
        { pathParameters: { id: "p-1", commentId: "c-parent" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("DELETED_PARENT");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Delete comment error"));
      const res = await deleteCommentPost(
        { pathParameters: { id: "p-1", commentId: "c-parent" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("toggleBookmarkPost", () => {
    it("should return 400 if id or userUuid is missing", async () => {
      const res = await toggleBookmarkPost(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);

      const res2 = await toggleBookmarkPost(
        { pathParameters: { id: "p-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should toggle bookmark on and off", async () => {
      // 1. Bookmark on
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      mockDynamoSend.mockResolvedValueOnce({});
      const res1 = await toggleBookmarkPost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).bookmarked).toBe(true);

      // 2. Bookmark off
      mockDynamoSend.mockResolvedValueOnce({ Item: { PK: "POST#p-1" } });
      mockDynamoSend.mockResolvedValueOnce({});
      const res2 = await toggleBookmarkPost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).bookmarked).toBe(false);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Bookmark error"));
      const res = await toggleBookmarkPost(
        {
          pathParameters: { id: "p-1" },
          body: JSON.stringify({ userUuid: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
