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

import { sendMessage } from "./messaging";

describe("ws messaging engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockApiGwSend.mockReset();
    mockApiGwSend.mockResolvedValue({});
  });

  describe("sendMessage - Appeal Chat", () => {
    it("should return 400 if appeal message is missing text and attachment", async () => {
      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({ appealId: "app-1", appealCompanyId: "comp-1" }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(400);
    });

    it("should return 403 if appeal is closed via verification request check", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Incident check
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VERIFICATION_REQUEST#app-1", estado: "APROBADO" },
      }); // Verification check

      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({
          appealId: "app-1",
          appealCompanyId: "comp-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(403);
    });

    it("should return 403 if appeal is closed", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#app-1", estado: "RESUELTO" },
      });

      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({
          appealId: "app-1",
          appealCompanyId: "comp-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(403);
    });

    it("should send appeal message with idempotency duplicate check", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Incident check
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Verification check
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ messageId: "msg-1", text: "Prev msg" }],
      }); // Duplicate check

      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({
          appealId: "app-1",
          appealCompanyId: "comp-1",
          messageId: "msg-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).duplicate).toBe(true);
    });

    it("should route appeal message to target connection IDs and ignore sender connection", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Incident check
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Verification check
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Duplicate check
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Item: { sub: "sub-1" },
      }); // Company profile lookup
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { SK: "WS_CONNECTION#conn-sender", userId: "sender-1" },
          { SK: "WS_CONNECTION#conn-other", userId: "other-user" },
        ],
      }); // Target connections for company
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Target connections for moderator
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Target connections for owner sub

      const event = {
        requestContext: {
          connectionId: "conn-sender",
          authorizer: { principalId: "sender-1" },
        },
        body: JSON.stringify({
          appealId: "app-1",
          appealCompanyId: "comp-1",
          text: "Pruebas adjuntas",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it("should handle error in appeal status check and handle GoneException on appeal push with attachment", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Appeal check DB error")); // Error at line 91 (INCIDENT get)
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message with attachment (line 145)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { sub: "different-owner-sub" },
      }); // Company profile lookup (line 158) -> triggers line 170
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-target" }],
      }); // Target connections for company
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Target connections for moderator
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Target connections for owner sub (line 170)

      const goneErr = new Error("Gone");
      (goneErr as any).statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(goneErr); // Line 226

      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand stale connection

      const event = {
        requestContext: {
          connectionId: "conn-sender",
          authorizer: { principalId: "sender-1" },
        },
        body: JSON.stringify({
          appealId: "app-1",
          appealCompanyId: "comp-1",
          text: "Documento adjunto",
          attachmentUrl: "https://s3/evidence.png",
          attachmentType: "image",
          attachmentName: "evidence.png",
          attachmentKey: "k2",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("sendMessage - Job Chat", () => {
    it("should return 400 if required parameters are missing", async () => {
      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({}),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if vacancy is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(404);
    });

    it("should return 403 if sender is neither candidate nor employer", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      });

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "intruder" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(403);
    });

    it("should return 403 if application is closed (RECHAZADO/CONTRATADO/CERRADO)", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      }); // Vacancy get
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "JOB#job-1", SK: "APP#cand-1", status: "RECHAZADO" },
      }); // Application check

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(403);
    });

    it("should send chat message with attachment and push to recipient connection IDs", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      }); // Vacancy get
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Application check
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-recipient" }],
      }); // Query connections

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Buenas tardes",
          attachmentUrl: "https://s3/file.pdf",
          attachmentType: "pdf",
          attachmentName: "file.pdf",
          attachmentKey: "k1",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it("should handle error in application status check and non-410 PostToConnection error gracefully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      }); // Vacancy get
      mockDynamoSend.mockRejectedValueOnce(new Error("App check DB error")); // App check catch (line 300)
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand message
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-500" }],
      }); // Query connections

      mockApiGwSend.mockRejectedValueOnce(new Error("Generic APIGW error 500")); // Line 396
      mockDynamoSend.mockResolvedValueOnce({}); // createOfflineNotification

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola tolerante a fallos",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
    });

    it("should cleanup stale connection if PostToConnection throws 410", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "comp-1" },
      });
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#stale-conn" }],
      });

      const goneError = new Error("Gone");
      (goneError as any).statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(goneError);

      mockDynamoSend.mockResolvedValueOnce({}); // Delete user mapping
      mockDynamoSend.mockResolvedValueOnce({}); // Delete connection metadata
      mockDynamoSend.mockResolvedValueOnce({}); // createOfflineNotification

      const event = {
        requestContext: {
          connectionId: "conn-1",
          authorizer: { principalId: "cand-1" },
        },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on unexpected runtime error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Internal error"));

      const event = {
        requestContext: { connectionId: "conn-1" },
        body: JSON.stringify({
          jobId: "job-1",
          candidateId: "cand-1",
          text: "Hola",
        }),
      } as any;

      const res = await sendMessage(event);
      expect(res.statusCode).toBe(500);
    });
  });
});
