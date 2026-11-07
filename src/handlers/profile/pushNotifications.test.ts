import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockWebPushSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockWebPushSend: vi.fn(),
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
  PutCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  ScanCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: mockWebPushSend,
  },
}));

import {
  savePushSubscription,
  deletePushSubscription,
  getVapidPublicKey,
  notifyCvInteraction,
  getPushSubscribers,
  sendCustomPushNotification,
} from "./notifications";
import {
  sendPushToUser,
  hashEndpoint,
  getAllPushSubscribers,
  parseUserAgent,
} from "../../utils/webPushService";

describe("push notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockWebPushSend.mockReset();
    mockWebPushSend.mockResolvedValue({});
  });

  describe("savePushSubscription handler", () => {
    it("returns 400 when user id is missing", async () => {
      const res: any = await savePushSubscription(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when subscription payload is missing endpoint or keys", async () => {
      const res: any = await savePushSubscription(
        {
          pathParameters: { id: "user-123" },
          body: JSON.stringify({}),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("saves subscription and returns 200 on valid input", async () => {
      const res: any = await savePushSubscription(
        {
          pathParameters: { id: "user-123" },
          body: JSON.stringify({
            subscription: {
              endpoint: "https://push.example.com/sub/123",
              keys: { p256dh: "key-p256dh", auth: "auth-key" },
            },
            userAgent: "Mozilla/5.0",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("deletePushSubscription handler", () => {
    it("returns 400 when user id is missing", async () => {
      const res: any = await deletePushSubscription(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when endpoint is missing", async () => {
      const res: any = await deletePushSubscription(
        {
          pathParameters: { id: "user-123" },
          body: JSON.stringify({}),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("removes subscription and returns 200 on valid input", async () => {
      const res: any = await deletePushSubscription(
        {
          pathParameters: { id: "user-123" },
          body: JSON.stringify({
            endpoint: "https://push.example.com/sub/123",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("getVapidPublicKey handler", () => {
    it("returns the public key with status 200", async () => {
      const res: any = await getVapidPublicKey({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.publicKey).toBeDefined();
      expect(typeof data.publicKey).toBe("string");
    });
  });

  describe("webPushService", () => {
    it("hashes endpoints deterministically", () => {
      const hash1 = hashEndpoint("https://example.com/test");
      const hash2 = hashEndpoint("https://example.com/test");
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });

    it("sends push to user with active subscriptions", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            endpoint: "https://push.example.com/sub/1",
            keys: { p256dh: "key1", auth: "auth1" },
          },
        ],
      });

      const res = await sendPushToUser("user-123", {
        title: "Test Title",
        body: "Test Body",
      });

      expect(res.sent).toBe(1);
      expect(res.failed).toBe(0);
      expect(mockWebPushSend).toHaveBeenCalledTimes(1);
    });

    it("automatically removes expired subscriptions (410 Gone)", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            endpoint: "https://push.example.com/expired-sub",
            keys: { p256dh: "key-exp", auth: "auth-exp" },
          },
        ],
      });

      const goneError: any = new Error("Subscription expired");
      goneError.statusCode = 410;
      mockWebPushSend.mockRejectedValueOnce(goneError);

      const res = await sendPushToUser("user-123", {
        title: "Test",
        body: "Test",
      });

      expect(res.sent).toBe(0);
      expect(res.failed).toBe(1);
      expect(res.removed).toBe(1);
      // Verify delete was sent to DynamoDB for the expired endpoint
      expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("parseUserAgent", () => {
    it("parses Windows and Chrome correctly", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      const parsed = parseUserAgent(ua);
      expect(parsed.browser).toBe("Chrome");
      expect(parsed.os).toBe("Windows 10/11");
      expect(parsed.deviceLabel).toBe("Chrome en Windows 10/11");
    });

    it("parses macOS and Safari correctly", () => {
      const ua =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
      const parsed = parseUserAgent(ua);
      expect(parsed.browser).toBe("Safari");
      expect(parsed.os).toBe("macOS");
      expect(parsed.deviceLabel).toBe("Safari en macOS");
    });

    it("parses Android and Firefox correctly", () => {
      const ua = "Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0";
      const parsed = parseUserAgent(ua);
      expect(parsed.browser).toBe("Firefox");
      expect(parsed.os).toBe("Android");
    });
  });

  describe("getAllPushSubscribers", () => {
    it("returns empty array if no push subscriptions found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const subscribers = await getAllPushSubscribers();
      expect(subscribers).toEqual([]);
    });

    it("groups devices by user and enriches with profile data", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({
          Items: [
            {
              PK: "USER#user-1",
              SK: "PUSH_SUB#hash1",
              endpoint: "https://push.example.com/1",
              userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
              createdAt: "2026-10-14T10:00:00.000Z",
              updatedAt: "2026-10-14T10:00:00.000Z",
            },
          ],
        })
        .mockResolvedValueOnce({
          Item: {
            PK: "USER#user-1",
            SK: "PROFILE",
            nombre: "Juan Perez",
            email: "juan@example.com",
            tipoUsuario: "CANDIDATO",
            fotoPerfil: "https://avatar.test/juan.jpg",
          },
        });

      const subscribers = await getAllPushSubscribers();
      expect(subscribers.length).toBe(1);
      expect(subscribers[0].userId).toBe("user-1");
      expect(subscribers[0].nombre).toBe("Juan Perez");
      expect(subscribers[0].email).toBe("juan@example.com");
      expect(subscribers[0].deviceCount).toBe(1);
      expect(subscribers[0].devices[0].browser).toBe("Chrome");
    });
  });

  describe("getPushSubscribers handler", () => {
    it("returns 200 with subscriber list and counters", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res: any = await getPushSubscribers({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty("subscribers");
      expect(data).toHaveProperty("totalUsers");
      expect(data).toHaveProperty("totalDevices");
    });
  });

  describe("sendCustomPushNotification handler", () => {
    it("returns 400 when title or message is missing", async () => {
      const res: any = await sendCustomPushNotification(
        { body: JSON.stringify({ title: "" }) } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("sends notifications to selected users", async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          {
            endpoint: "https://push.example.com/sub/user1",
            keys: { p256dh: "p256", auth: "auth" },
          },
        ],
      });

      const res: any = await sendCustomPushNotification(
        {
          body: JSON.stringify({
            targetType: "selected",
            userIds: ["user-1"],
            title: "Nueva oferta",
            message: "Revisa esta vacante destacada",
            image: "https://images.test/banner.jpg",
            url: "/vacancies/123",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.targetedUsers).toBe(1);
      expect(data.sent).toBe(1);
    });
  });

  describe("notifyCvInteraction handler (Notificación de Interacción con el CV)", () => {
    it("returns 400 when candidate id is missing", async () => {
      const res: any = await notifyCvInteraction(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Missing candidate id");
    });

    it("saves notification and returns 200 on VIEW action", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            endpoint: "https://push.example.com/sub/cand-1",
            keys: { p256dh: "p256", auth: "auth" },
          },
        ],
      });

      const res: any = await notifyCvInteraction(
        {
          pathParameters: { id: "cand-1" },
          body: JSON.stringify({
            action: "VIEW",
            recruiterName: "Laura Reclutadora",
            companyName: "TechCorp México",
            vacancyTitle: "Frontend Senior",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.action).toBe("VIEW");
      expect(data.sentPush).toBe(true);
      expect(mockWebPushSend).toHaveBeenCalledTimes(1);
    });

    it("saves notification and returns 200 on DOWNLOAD action", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const res: any = await notifyCvInteraction(
        {
          pathParameters: { id: "cand-2" },
          body: JSON.stringify({
            action: "DOWNLOAD",
            companyName: "Banco Innovador",
            vacancyTitle: "Líder Técnico",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.action).toBe("DOWNLOAD");
    });
  });
});
