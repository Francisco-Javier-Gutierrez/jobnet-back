import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  PutObjectCommand: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {},
  SendEmailCommand: class {},
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
  toggleLikeJob,
  addCommentJob,
  deleteCommentJob,
  toggleBookmarkJob,
  shareJob,
} from "./interactions";

describe("jobs interactions handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("toggleLikeJob", () => {
    it("should return 400 if id or userUuid is missing", async () => {
      const res1 = await toggleLikeJob({ pathParameters: {} } as any, {} as any, () => {});
      expect(res1.statusCode).toBe(400);

      const res2 = await toggleLikeJob(
        { pathParameters: { id: "job-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should like job if not previously liked", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand

      const res = await toggleLikeJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).liked).toBe(true);
    });

    it("should unlike job if already liked", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: { PK: "VACANCY#job-1" } }); // GetCommand
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand

      const res = await toggleLikeJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).liked).toBe(false);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Like DB error"));
      const res = await toggleLikeJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("addCommentJob", () => {
    it("should return 400 if id or content is missing", async () => {
      const res1 = await addCommentJob({ pathParameters: {} } as any, {} as any, () => {});
      expect(res1.statusCode).toBe(400);

      const res2 = await addCommentJob(
        { pathParameters: { id: "job-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should add comment successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await addCommentJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ author: "Bob", content: "Great salary" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.user).toBe("Bob");
      expect(data.text).toBe("Great salary");
    });

    it("should reject comment on vacancy if content contains toxic words or slurs", async () => {
      const res = await addCommentJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({
            author: "Troll",
            content: "Que porqueria de trabajo chsm",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("Contenido bloqueado por el filtro de seguridad");
      expect(data.details).toContain("chsm");
      expect(mockDynamoSend).not.toHaveBeenCalled();
    });

    it("should reject comment on vacancy if content is flagged by AI moderation", async () => {
      const aiMod = await import("../../utils/aiModeration");
      const spyAi = vi.spyOn(aiMod, "moderateTextWithAi").mockResolvedValueOnce({
        safe: false,
        confidence: 0.98,
        flaggedCategories: ["SCAM"],
        reason: "El comentario promociona esquemas fraudulentos.",
      });

      const res = await addCommentJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({
            author: "Scammer",
            content: "Gana dinero fácil invirtiendo en cripto piramidal aquí: bit.ly/fake",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("El comentario promociona esquemas fraudulentos.");
      expect(data.flaggedCategories).toContain("SCAM");
      expect(mockDynamoSend).not.toHaveBeenCalled();
      spyAi.mockRestore();
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Comment error"));
      const res = await addCommentJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ content: "Hi" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("deleteCommentJob", () => {
    it("should return 400 if id or commentId is missing", async () => {
      const res = await deleteCommentJob({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if comment does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res = await deleteCommentJob(
        { pathParameters: { id: "job-1", commentId: "c-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should hard delete level 2 reply", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "c-2", parentId: "c-1" }],
      });
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand

      const res = await deleteCommentJob(
        { pathParameters: { id: "job-1", commentId: "c-2" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("DELETED_REPLY");
    });

    it("should soft delete parent comment if it has active child replies", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "c-1" }, { SK: "COMMENT#reply-1", parentId: "c-1", isDeleted: false }],
      });
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand

      const res = await deleteCommentJob(
        { pathParameters: { id: "job-1", commentId: "c-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("SOFT_DELETED_PARENT");
    });

    it("should hard delete parent comment if it has no children", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "c-1" }],
      });
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand

      const res = await deleteCommentJob(
        { pathParameters: { id: "job-1", commentId: "c-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("DELETED_PARENT");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Delete comment DB error"));
      const res = await deleteCommentJob(
        { pathParameters: { id: "job-1", commentId: "c-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("toggleBookmarkJob", () => {
    it("should return 400 if id or userUuid is missing", async () => {
      const res = await toggleBookmarkJob({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);

      const res2 = await toggleBookmarkJob(
        { pathParameters: { id: "job-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should toggle bookmark on and off", async () => {
      // 1. Bookmark on
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      mockDynamoSend.mockResolvedValueOnce({});
      const res1 = await toggleBookmarkJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).bookmarked).toBe(true);

      // 2. Bookmark off
      mockDynamoSend.mockResolvedValueOnce({ Item: { PK: "VACANCY#job-1" } });
      mockDynamoSend.mockResolvedValueOnce({});
      const res2 = await toggleBookmarkJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).bookmarked).toBe(false);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Bookmark DB error"));
      const res = await toggleBookmarkJob(
        {
          pathParameters: { id: "job-1" },
          body: JSON.stringify({ userUuid: "u1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("shareJob", () => {
    it("should return 400 if id is missing", async () => {
      const res = await shareJob({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should increment sharesCount and return updated count", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Attributes: { sharesCount: 5 } });
      const res = await shareJob({ pathParameters: { id: "job-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).sharesCount).toBe(5);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Share DB error"));
      const res = await shareJob({ pathParameters: { id: "job-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });
});
