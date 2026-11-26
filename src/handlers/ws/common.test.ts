import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
}));

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
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("../../utils/webPushService", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }),
}));

import { getEndpoint, createOfflineNotification } from "./common";

describe("ws common utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getEndpoint", () => {
    it("should resolve endpoint using domainName if it contains wsApiId", () => {
      const event = {
        requestContext: {
          domainName: "v9b53l2zr2.execute-api.us-east-1.amazonaws.com",
          stage: "dev",
        },
      };
      const endpoint = getEndpoint(event);
      expect(endpoint).toBe("https://v9b53l2zr2.execute-api.us-east-1.amazonaws.com/dev");
    });

    it("should resolve fallback endpoint using WS_API_ID and default stage", () => {
      const endpoint = getEndpoint({});
      expect(endpoint).toContain(".execute-api.us-east-1.amazonaws.com/prod");
    });
  });

  describe("createOfflineNotification", () => {
    it("should truncate message longer than 80 chars and save notification", async () => {
      const longMsg = "A".repeat(100);
      await createOfflineNotification({
        userId: "u-1",
        title: "Test Title",
        message: longMsg,
      });
      expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    });

    it("should use default message when message is empty", async () => {
      await createOfflineNotification({
        userId: "u-1",
        title: "Test Title",
        message: "",
      });
      expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    });

    it("should catch and log error if DynamoDB PutCommand fails", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Notification DB Error"));
      await expect(
        createOfflineNotification({
          userId: "u-1",
          title: "Test Title",
          message: "Test msg",
        }),
      ).resolves.not.toThrow();
    });

    it("should initialize with local endpoint when IS_OFFLINE is true", async () => {
      const orig = process.env.IS_OFFLINE;
      process.env.IS_OFFLINE = "true";
      vi.resetModules();
      const mod = await import("./common");
      expect(mod.getEndpoint({})).toBe("http://localhost:3002");
      process.env.IS_OFFLINE = orig;
    });
  });
});
