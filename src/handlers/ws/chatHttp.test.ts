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

import { getChatMessages, sendChatMessageHttp } from "./chatHttp";

describe("chat HTTP handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockApiGwSend.mockReset();
    mockApiGwSend.mockResolvedValue({});
  });

  describe("getChatMessages", () => {
    it("should return 400 if parameters are missing", async () => {
      const res = await getChatMessages({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return messages on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            senderId: "cand-1",
            text: "Hello!",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const res = await getChatMessages(
        { pathParameters: { jobId: "job-1", candidateId: "cand-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const messages = JSON.parse(res.body);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Hello!");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Get chat error"));
      const res = await getChatMessages(
        { pathParameters: { jobId: "job-1", candidateId: "cand-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("sendChatMessageHttp", () => {
    it("should return 400 if path or body parameters are missing", async () => {
      const res1 = await sendChatMessageHttp({ pathParameters: {} } as any, {} as any, () => {});
      expect(res1.statusCode).toBe(400);

      const res2 = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: "invalid-json",
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);

      const res3 = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({}),
        } as any,
        {} as any,
        () => {},
      );
      expect(res3.statusCode).toBe(400);

      const res4 = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ senderId: "u-1" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res4.statusCode).toBe(400);
    });

    it("should save message and push to WebSocket connection if recipient is online", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-1" },
      }); // GetCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-company" }],
      }); // Query connections
      mockApiGwSend.mockResolvedValueOnce({});

      const res = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({
            senderId: "cand-1",
            text: "Adjunto mi CV",
            attachmentUrl: "https://s3/cv.pdf",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it("should handle GoneException and create offline notification in chat HTTP", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-1" },
      }); // GetCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-stale" }],
      }); // Query connections

      const goneErr = new Error("Gone");
      (goneErr as any).statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(goneErr);

      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand stale connection
      mockDynamoSend.mockResolvedValueOnce({}); // createOfflineNotification

      const res = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({
            senderId: "cand-1",
            text: "Hello offline",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should handle non-critical WS error catch block gracefully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockRejectedValueOnce(new Error("WS query fail")); // GetCommand vacancy fails

      const res = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({
            senderId: "cand-1",
            text: "Hello error",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Send chat HTTP error"));

      const res = await sendChatMessageHttp(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ senderId: "cand-1", text: "Hola" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
