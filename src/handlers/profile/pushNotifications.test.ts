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
} from "./notifications";
import {
  savePushSubscription as saveSubService,
  removePushSubscription as removeSubService,
  sendPushToUser,
  hashEndpoint,
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
      const res: any = await getVapidPublicKey(
        {} as any,
        {} as any,
        () => {},
      );
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
});
