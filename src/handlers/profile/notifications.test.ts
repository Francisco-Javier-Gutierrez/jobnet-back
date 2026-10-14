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
  QueryCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "./notifications";

describe("profile notifications handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getNotifications", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getNotifications({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return notifications list on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#u-1",
            SK: "NOTIFICATION#2026-01-01#notif-1",
            id: "notif-1",
            title: "Nuevo mensaje",
            read: false,
          },
        ],
      });

      const res = await getNotifications({ pathParameters: { id: "u-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("notif-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Notif DB error"));
      const res = await getNotifications({ pathParameters: { id: "u-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("markNotificationRead", () => {
    it("should return 400 if userId or notifId is missing", async () => {
      const res = await markNotificationRead({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if notification is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res = await markNotificationRead(
        { pathParameters: { id: "u-1", notifId: "notif-999" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should mark notification as read", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "USER#u-1", SK: "NOTIFICATION#2026-01-01#notif-1", id: "notif-1" }],
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await markNotificationRead(
        { pathParameters: { id: "u-1", notifId: "notif-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toBe("Notification marked as read");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Mark read error"));
      const res = await markNotificationRead(
        { pathParameters: { id: "u-1", notifId: "notif-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("markAllNotificationsRead", () => {
    it("should return 400 if id is missing", async () => {
      const res = await markAllNotificationsRead({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should mark all unread notifications as read", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { PK: "USER#u-1", SK: "NOTIF#1", read: false },
          { PK: "USER#u-1", SK: "NOTIF#2", read: true },
        ],
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await markAllNotificationsRead(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toContain("1 notifications marked as read");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Mark all error"));
      const res = await markAllNotificationsRead(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
