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
  QueryCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  connect,
  disconnect,
  defaultRoute,
  sendMessage,
  getChatMessages,
  getDisputeMessages,
} from "./wsHandlers";

describe("wsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("should register connection IDs in DynamoDB successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // Put ws_connection success
      mockDynamoSend.mockResolvedValueOnce({}); // Put user mapping success

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "user-1" },
        },
      } as any;

      const response = await connect(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("Connected");
      expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    });

    it("should return 500 on DynamoDB save failure", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Save failure"));

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "user-1" },
        },
      } as any;

      const response = await connect(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("Save failure");
    });
  });

  describe("disconnect", () => {
    it("should delete connections and mapping on disconnect", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { userId: "user-1" },
      }); // Get ws_connection success
      mockDynamoSend.mockResolvedValueOnce({}); // Delete user connection success
      mockDynamoSend.mockResolvedValueOnce({}); // Delete ws_connection success

      const event = {
        requestContext: {
          connectionId: "conn-1",
        },
      } as any;

      const response = await disconnect(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("Disconnected");
      expect(mockDynamoSend).toHaveBeenCalledTimes(3);
    });

    it("should handle disconnect gracefully if connection lookup is empty", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Connection metadata not found
      mockDynamoSend.mockResolvedValueOnce({}); // Delete connection metadata anyway

      const event = {
        requestContext: {
          connectionId: "conn-1",
        },
      } as any;

      const response = await disconnect(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    });

    it("should return 500 on database error during disconnect", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB disconnect error"));

      const event = {
        requestContext: {
          connectionId: "conn-1",
        },
      } as any;

      const response = await disconnect(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("DB disconnect error");
    });
  });

  describe("defaultRoute", () => {
    it("should hit default route successfully", async () => {
      const event = {
        requestContext: { connectionId: "conn-1" },
      } as any;

      const response = await defaultRoute(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("Default route");
    });
  });

  describe("sendMessage", () => {
    it("should return 400 if required parameters are missing", async () => {
      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "user-1" },
        },
        body: JSON.stringify({ text: "Hello" }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("Missing jobId");
    });

    it("should return 404 if vacancy does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Vacancy not found

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "user-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hello",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Vacancy not found");
    });

    it("should return 403 if sender is not candidate or company", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "company-1" },
      }); // Vacancy success

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "attacker-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hello",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Not authorized");
    });

    it("should save message and push to target connection IDs", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "company-1" },
      }); // Vacancy success
      mockDynamoSend.mockResolvedValueOnce({}); // Save message Put success
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#recipient-conn-1" }],
      }); // Recipient connections query success
      mockApiGwSend.mockResolvedValueOnce({}); // Gateway send success

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
          domainName: "localhost",
          stage: "dev",
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hello Recruiter!",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(200);

      const resBody = JSON.parse(response.body);
      expect(resBody.success).toBe(true);
      expect(resBody.message.text).toBe("Hello Recruiter!");
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it("should cleanup stale connection IDs if PostToConnection fails with 410", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "company-1" },
      }); // Vacancy success
      mockDynamoSend.mockResolvedValueOnce({}); // Save message success
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#stale-conn" }],
      }); // Recipient connections query

      const staleError: any = new Error("Connection gone");
      staleError.statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(staleError); // Stale connection throw 410

      mockDynamoSend.mockResolvedValueOnce({}); // Cleanup user connection mapping
      mockDynamoSend.mockResolvedValueOnce({}); // Cleanup connection metadata

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "company-1" },
          domainName: "localhost",
          stage: "dev",
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hello Candidate!",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(200);
      expect(mockDynamoSend).toHaveBeenCalledTimes(5);
    });

    it("should return 500 on internal message routing error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Routing failed"));

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hello",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("Routing failed");
    });

    it("should route dispute messages to participants and active connections", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "DISPUTE#disp-1",
          SK: "METADATA",
          candidateId: "cand-1",
          companyId: "company-1",
          complainantId: "cand-1",
        },
      }); // Get dispute
      mockDynamoSend.mockResolvedValueOnce({}); // Put dispute message
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-company" }],
      }); // Query active connections for company-1

      mockApiGwSend.mockResolvedValueOnce({});

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
          domainName: "localhost",
          stage: "dev",
        },
        body: JSON.stringify({
          disputeId: "disp-1",
          text: "Additional evidence",
          attachmentUrl: "https://s3.amazonaws.com/proof.pdf",
          attachmentType: "pdf",
          attachmentName: "proof.pdf",
        }),
      } as any;

      const response = await sendMessage(event);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).success).toBe(true);
    });
  });

  describe("getChatMessages", () => {
    it("should return 400 if path parameters are missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await getChatMessages(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Missing parameters");
    });

    it("should return message list sorted chronologically", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { senderId: "cand-1", text: "Hi", createdAt: "2026-07-17T09:00:00Z" },
          {
            senderId: "company-1",
            text: "Hello",
            createdAt: "2026-07-17T09:01:00Z",
          },
        ],
      });

      const event = {
        pathParameters: { jobId: "job-1", candidateId: "cand-1" },
      } as any;

      const response = await getChatMessages(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(2);
      expect(res[0].text).toBe("Hi");
      expect(res[1].text).toBe("Hello");
    });

    it("should return 500 on database error during messages fetch", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("History fetch error"));

      const event = {
        pathParameters: { jobId: "job-1", candidateId: "cand-1" },
      } as any;

      const response = await getChatMessages(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("History fetch error");
    });
  });

  describe("getDisputeMessages", () => {
    it("should return 400 if disputeId is missing", async () => {
      const event = { pathParameters: {} } as any;
      const response = await getDisputeMessages(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return dispute messages list", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            disputeId: "disp-1",
            senderId: "cand-1",
            text: "Problem detail",
            createdAt: "2026-07-24T10:00:00Z",
          },
        ],
      });

      const event = { pathParameters: { disputeId: "disp-1" } } as any;
      const response = await getDisputeMessages(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].text).toBe("Problem detail");
    });
  });
});
