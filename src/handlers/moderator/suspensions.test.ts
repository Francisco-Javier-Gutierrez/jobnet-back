import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSESSend, mockApiGwSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockSESSend: vi.fn(),
    mockApiGwSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = mockSESSend;
  },
  SendEmailCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = mockApiGwSend;
  },
  PostToConnectionCommand: class {
    constructor(public params: any) {}
  },
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
  ScanCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  initiateSuspension,
  cancelSuspension,
  confirmSuspension,
  getSuspensionStatus,
  handleSuspensionExpiry,
} from "./suspensions";

describe("moderator suspensions handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockSESSend.mockReset();
    mockSESSend.mockResolvedValue({});
    mockApiGwSend.mockReset();
    mockApiGwSend.mockResolvedValue({});
  });

  describe("initiateSuspension", () => {
    it("should return 400 if companyId is missing", async () => {
      const res = await initiateSuspension({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should initiate suspension successfully with SES email notification", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand initial chat message
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "contact@company.com", nombreComercial: "Acme Corp" },
      }); // GetCommand profile for SES email
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog PutCommand

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ reason: "Fraude", graceDays: 5 }),
      } as any;

      const res = await initiateSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.companyId).toBe("comp-1");
      expect(data.status).toBe("En revisión");
    });

    it("should initiate suspension successfully even if SES send fails", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand initial chat message
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "contact@company.com", nombreComercial: "Acme Corp" },
      }); // GetCommand profile for SES email
      mockSESSend.mockRejectedValueOnce(new Error("SES service down"));
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog PutCommand

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ reason: "Fraude", graceDays: 5 }),
      } as any;

      const res = await initiateSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Initiate DB error"));
      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ reason: "Fraude" }),
      } as any;
      const res = await initiateSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("cancelSuspension", () => {
    it("should return 400 if companyId is missing", async () => {
      const res = await cancelSuspension({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 400 if org has sent less than 3 messages in appeal chat", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // 0 messages

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ notes: "Ok" }),
      } as any;

      const res = await cancelSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("al menos 3 mensajes");
    });

    it("should cancel suspension successfully when org has 3+ messages", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // 3 messages
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({
        Item: { sub: "sub-1" },
      }); // broadcastAppealResolved get profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-1" }],
      }); // broadcastAppealResolved query connections
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // query mod connections

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ notes: "Aclarado" }),
      } as any;

      const res = await cancelSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("Activa");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // getOrgAppealMessageCount succeeds with 3 messages
      mockDynamoSend.mockRejectedValueOnce(new Error("Cancel DB error")); // Next DB operation fails

      const event = { pathParameters: { id: "comp-1" } } as any;
      const res = await cancelSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("confirmSuspension", () => {
    it("should return 400 if companyId is missing", async () => {
      const res = await confirmSuspension({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 400 if org has less than 3 appeal messages", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ reason: "Rechazado" }),
      } as any;

      const res = await confirmSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("al menos 3 mensajes");
    });

    it("should confirm suspension, block account, and hide jobs", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // 3 messages
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "JOB#job-1", SK: "METADATA" }],
      }); // Scan jobs
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand job
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const event = {
        pathParameters: { id: "comp-1" },
        body: JSON.stringify({ reason: "Violación grave de normas" }),
      } as any;

      const res = await confirmSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("Suspendida");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // getOrgAppealMessageCount succeeds with 3 messages
      mockDynamoSend.mockRejectedValueOnce(new Error("Confirm DB error")); // Next DB operation fails

      const event = { pathParameters: { id: "comp-1" } } as any;
      const res = await confirmSuspension(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getSuspensionStatus", () => {
    it("should return 400 if companyId is missing", async () => {
      const res = await getSuspensionStatus({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return suspension status details", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          estatus: "En revisión",
          bloqueada: false,
          suspensionReason: "Reportes",
        },
      }); // Profile lookup
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          gracePeriodEnd: "2026-03-01T00:00:00.000Z",
          reason: "Reportes",
          createdAt: "2026-02-20T00:00:00.000Z",
        },
      }); // Grace period lookup

      const res = await getSuspensionStatus(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.inGracePeriod).toBe(true);
      expect(data.gracePeriodEnd).toBe("2026-03-01T00:00:00.000Z");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const res = await getSuspensionStatus(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("handleSuspensionExpiry", () => {
    it("should process TTL expiration for company suspension stream event", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "JOB#job-1", SK: "METADATA" }],
      }); // ScanCommand jobs
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand job
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const streamEvent = {
        Records: [
          {
            eventName: "REMOVE",
            dynamodb: {
              OldImage: {
                PK: { S: "SUSPENSION#comp-1" },
                SK: { S: "GRACE_PERIOD" },
                companyId: { S: "comp-1" },
                status: { S: "IN_REVIEW" },
              },
            },
          },
        ],
      };

      await expect(handleSuspensionExpiry(streamEvent)).resolves.not.toThrow();
    });

    it("should process TTL expiration for vacancy suspension stream event", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      }); // GetCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const streamEvent = {
        Records: [
          {
            eventName: "REMOVE",
            dynamodb: {
              OldImage: {
                PK: { S: "VACANCY_SUSPENSION#job-1" },
                SK: { S: "GRACE_PERIOD" },
                jobId: { S: "job-1" },
                status: { S: "EVALUACION" },
              },
            },
          },
        ],
      };

      await expect(handleSuspensionExpiry(streamEvent)).resolves.not.toThrow();
    });

    it("should skip non-REMOVE or non-matching records", async () => {
      const streamEvent = {
        Records: [
          { eventName: "INSERT", dynamodb: { OldImage: null } },
          {
            eventName: "REMOVE",
            dynamodb: {
              OldImage: { PK: { S: "OTHER#123" }, SK: { S: "METADATA" } },
            },
          },
        ],
      };

      await expect(handleSuspensionExpiry(streamEvent)).resolves.not.toThrow();
    });
  });
});
