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
  sendCustomPushNotification,
  getPushSubscribers,
  notifyCvInteraction,
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

      const res = await getNotifications(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("notif-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Notif DB error"));
      const res = await getNotifications(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
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
        Items: [
          {
            PK: "USER#u-1",
            SK: "NOTIFICATION#2026-01-01#notif-1",
            id: "notif-1",
          },
        ],
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
      const res = await markAllNotificationsRead(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
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

  describe("security and validation for push endpoints", () => {
    it("getPushSubscribers should return 403 for non-admins", async () => {
      const res = await getPushSubscribers(
        { headers: { "x-user-role": "CANDIDATO" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
    });

    it("getPushSubscribers should return 403 for moderators as panel is 100% admin exclusive", async () => {
      const res = await getPushSubscribers(
        { headers: { "x-user-role": "MODERATOR" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("exclusivo para Administradores");
    });

    it("sendCustomPushNotification should return 403 for non-admins", async () => {
      const res = await sendCustomPushNotification(
        {
          headers: { "x-user-role": "CANDIDATO" },
          body: JSON.stringify({ title: "Hi", message: "World" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
    });

    it("sendCustomPushNotification should validate body schema with Zod", async () => {
      const res = await sendCustomPushNotification(
        {
          headers: { "x-user-role": "ADMIN" },
          body: JSON.stringify({ title: "", message: "" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("notifyCvInteraction should return 401 if unauthenticated", async () => {
      const res = await notifyCvInteraction(
        {
          pathParameters: { id: "c-1" },
          headers: {},
          body: JSON.stringify({ action: "VIEW" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(401);
    });
  });
});
