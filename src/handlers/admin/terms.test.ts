import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockCreateUserNotification, mockGetAllPushSubscribers, mockSaveAuditLog } =
  vi.hoisted(() => ({
    mockDynamoSend: vi.fn(),
    mockCreateUserNotification: vi.fn(),
    mockGetAllPushSubscribers: vi.fn(),
    mockSaveAuditLog: vi.fn(),
  }));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("../../utils/webPushService", () => ({
  createUserNotification: mockCreateUserNotification,
  getAllPushSubscribers: mockGetAllPushSubscribers,
}));

vi.mock("../moderator/common", () => ({
  saveAuditLog: mockSaveAuditLog,
}));

import { getTermsVersion, getTermsHistory, updateTermsAndBroadcast, DEFAULT_TERMS } from "./terms";

describe("Admin Terms & Conditions Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTermsVersion", () => {
    it("should return DEFAULT_TERMS when no item exists in DynamoDB", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await getTermsVersion({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.version).toBe(DEFAULT_TERMS.version);
      expect(body.title).toBe(DEFAULT_TERMS.title);
    });

    it("should return the stored terms version when present", async () => {
      const stored = {
        PK: "CONFIG#TERMS",
        SK: "CURRENT",
        version: "1.2.0",
        title: "Términos Actualizados",
        summary: "Políticas de mediación y privacidad reforzadas.",
        effectiveDate: "2026-11-09",
      };
      mockDynamoSend.mockResolvedValueOnce({ Item: stored });

      const res = await getTermsVersion({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.version).toBe("1.2.0");
      expect(body.summary).toContain("mediación");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB error"));

      const res = await getTermsVersion({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe("DynamoDB error");
    });
  });

  describe("getTermsHistory", () => {
    it("should return 403 when non-admin requests history", async () => {
      const event = {
        headers: { "x-user-role": "CANDIDATO" },
      } as any;

      const res = await getTermsHistory(event, {} as any, () => {});
      expect(res.statusCode).toBe(403);
    });

    it("should return history list when admin requests it", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { version: "1.1.0", effectiveDate: "2026-11-09" },
          { version: "1.0.0", effectiveDate: "2026-08-13" },
        ],
      });

      const event = {
        headers: { "x-user-role": "ADMIN" },
      } as any;

      const res = await getTermsHistory(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
      expect(body.history[0].version).toBe("1.1.0");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("History fetch error"));

      const event = {
        headers: { "x-user-role": "ADMIN" },
      } as any;

      const res = await getTermsHistory(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("updateTermsAndBroadcast", () => {
    it("should return 403 when non-admin attempts to update", async () => {
      const event = {
        headers: { "x-user-role": "MODERATOR" },
        body: JSON.stringify({ version: "2.0.0", summary: "Test", effectiveDate: "2026-11-09" }),
      } as any;

      const res = await updateTermsAndBroadcast(event, {} as any, () => {});
      expect(res.statusCode).toBe(403);
    });

    it("should return 400 when request body is invalid", async () => {
      const event = {
        headers: { "x-user-role": "ADMIN" },
        body: JSON.stringify({ version: "" }),
      } as any;

      const res = await updateTermsAndBroadcast(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should update terms and broadcast in-app + web push notifications", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // Put CURRENT
      mockDynamoSend.mockResolvedValueOnce({}); // Put VERSION#...
      mockSaveAuditLog.mockResolvedValueOnce({});
      mockGetAllPushSubscribers.mockResolvedValueOnce([{ userId: "user-1" }, { userId: "user-2" }]);
      mockCreateUserNotification.mockResolvedValue("notif-1");

      const event = {
        headers: { "x-user-role": "ADMIN", "x-user-id": "admin-1" },
        body: JSON.stringify({
          version: "1.1.0",
          title: "Términos y Condiciones 2026",
          summary: "Actualización de cláusula de mediación y protección de datos.",
          effectiveDate: "2026-11-09",
          notifyUsers: true,
        }),
      } as any;

      const res = await updateTermsAndBroadcast(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.version).toBe("1.1.0");
      expect(body.notifiedCount).toBe(2);

      expect(mockCreateUserNotification).toHaveBeenCalledTimes(2);
      expect(mockSaveAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ACTUALIZACION_TERMINOS_Y_CONDICIONES",
        }),
      );
    });

    it("should update terms without broadcasting when notifyUsers is false", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // Put CURRENT
      mockDynamoSend.mockResolvedValueOnce({}); // Put VERSION#...
      mockSaveAuditLog.mockResolvedValueOnce({});

      const event = {
        headers: { "x-user-role": "ADMIN", "x-user-id": "admin-1" },
        body: JSON.stringify({
          version: "1.1.0",
          summary: "Corrección menor de sintaxis",
          effectiveDate: "2026-11-09",
          notifyUsers: false,
        }),
      } as any;

      const res = await updateTermsAndBroadcast(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.notifiedCount).toBe(0);
      expect(mockCreateUserNotification).not.toHaveBeenCalled();
    });

    it("should return 500 on database error during put", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Dynamo write error"));

      const event = {
        headers: { "x-user-role": "ADMIN" },
        body: JSON.stringify({
          version: "1.1.0",
          summary: "Actualización de prueba",
          effectiveDate: "2026-11-09",
        }),
      } as any;

      const res = await updateTermsAndBroadcast(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe("Dynamo write error");
    });
  });
});
