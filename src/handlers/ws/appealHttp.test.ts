import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockApiGwSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockApiGwSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = mockApiGwSend;
  },
  PostToConnectionCommand: class {
    constructor(public params: any) {}
  },
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
  GetCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import { getAppealMessages, sendAppealMessageHttp } from "./appealHttp";

describe("appeal HTTP handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockApiGwSend.mockReset();
    mockApiGwSend.mockResolvedValue({});
  });

  describe("getAppealMessages", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getAppealMessages(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return appeal messages filtering out join system messages", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            companyId: "comp-1",
            senderId: "ADMIN",
            text: "Official notice",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            isJoinMessage: true,
            text: "La empresa se ha unido al chat",
          },
        ],
      });

      const res = await getAppealMessages(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const messages = JSON.parse(res.body);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Official notice");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Appeal messages error"));
      const res = await getAppealMessages(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("sendAppealMessageHttp", () => {
    it("should return 400 if id or companyId or text is missing", async () => {
      const res1 = await sendAppealMessageHttp(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(400);

      const res2 = await sendAppealMessageHttp(
        { pathParameters: { id: "comp-1" }, body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);

      const res3 = await sendAppealMessageHttp(
        {
          pathParameters: { id: "comp-1" },
          body: JSON.stringify({ companyId: "comp-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res3.statusCode).toBe(400);
    });

    it("should handle duplicate messageId idempotently", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ messageId: "msg-duplicate-123", text: "Duplicate text" }],
      });

      const res = await sendAppealMessageHttp(
        {
          pathParameters: { id: "comp-1" },
          body: JSON.stringify({
            companyId: "comp-1",
            messageId: "msg-duplicate-123",
            text: "Hello",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).duplicate).toBe(true);
    });

    it("should save appeal message and push to WebSocket connections", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Item: { sub: "sub-1" },
      }); // GetCommand profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-1", userId: "other-mod" }],
      }); // Query connections company
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-mod", userId: "other-mod" }],
      }); // Query connections mod
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query connections owner sub
      mockApiGwSend.mockResolvedValue({});

      const res = await sendAppealMessageHttp(
        {
          pathParameters: { id: "comp-1" },
          body: JSON.stringify({
            companyId: "comp-1",
            senderId: "comp-1",
            text: "Adjuntamos comprobante",
            attachmentUrl: "https://s3/file.png",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(mockApiGwSend).toHaveBeenCalled();
    });

    it("should handle GoneException on WebSocket push and create offline notification", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-stale", userId: "other" }],
      }); // Query company connections
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query mod connections

      const goneErr = new Error("Gone");
      (goneErr as any).statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(goneErr);

      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand stale connection
      mockDynamoSend.mockResolvedValueOnce({}); // createOfflineNotification PutCommand

      const res = await sendAppealMessageHttp(
        {
          pathParameters: { id: "comp-1" },
          body: JSON.stringify({
            companyId: "comp-1",
            senderId: "mod-1",
            text: "Offline notice",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Send appeal error"));

      const res = await sendAppealMessageHttp(
        {
          pathParameters: { id: "comp-1" },
          body: JSON.stringify({ companyId: "comp-1", text: "Test" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
