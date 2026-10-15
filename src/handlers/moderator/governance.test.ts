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

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {},
  SendEmailCommand: class {},
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = mockApiGwSend;
  },
  PostToConnectionCommand: class {},
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
  getAuditLogs,
  getBlockedDomains,
  toggleUserBlock,
  getModeratorConcurrencyAlerts,
} from "./governance";
import {
  blockCorporateDomain,
  saveAuditLog,
  getOrgAppealMessageCount,
  executeOrgSuspensionInitiation,
  broadcastAppealResolved,
  getEndpoint,
} from "./common";

describe("moderator governance handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("saveAuditLog & blockCorporateDomain & helpers", () => {
    it("should save audit log item with default executor", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      const item = await saveAuditLog({
        targetId: "t-1",
        targetType: "VACANTE",
        action: "TEST_ACTION",
        reason: "Test reason",
      });
      expect(item.executorId).toBe("MODERATOR_SYSTEM");
      expect(item.action).toBe("TEST_ACTION");
    });

    it("should return 0 in getOrgAppealMessageCount on DB catch error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Count error"));
      const count = await getOrgAppealMessageCount("comp-1");
      expect(count).toBe(0);
    });

    it("should handle profile lookup error in executeOrgSuspensionInitiation gracefully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // ScanCommand jobs
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockRejectedValueOnce(new Error("Profile lookup failure")); // GetCommand profile catch
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const res = await executeOrgSuspensionInitiation({
        companyId: "comp-1",
        reason: "Spam",
      });
      expect(res.gracePeriodEnd).toBeDefined();
    });

    it("should skip public provider email domains when blocking corporate domains", async () => {
      await blockCorporateDomain("gmail.com", "Test");
      await blockCorporateDomain("outlook.com", "Test");
      await blockCorporateDomain("hotmail.com", "Test");
      await blockCorporateDomain("yahoo.com", "Test");
      await blockCorporateDomain("", "Test");
      expect(mockDynamoSend).not.toHaveBeenCalled();
    });

    it("should broadcast appeal resolved message and cleanup 410 stale connections", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { sub: "owner-sub-1" },
      }); // GetCommand company profile
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-comp" }],
      }); // Query company connections
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-mod" }],
      }); // Query moderator connections
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "WS_CONNECTION#conn-stale" }],
      }); // Query owner sub connections

      mockApiGwSend.mockResolvedValueOnce({}); // comp send
      mockApiGwSend.mockResolvedValueOnce({}); // mod send
      const goneErr = new Error("Gone");
      (goneErr as any).statusCode = 410;
      mockApiGwSend.mockRejectedValueOnce(goneErr); // stale send

      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand stale connection

      await broadcastAppealResolved("comp-1", "RESUELTO", {
        requestContext: { domainName: "lzvcx59zaa.execute-api.com", stage: "prod" },
      });

      expect(mockApiGwSend).toHaveBeenCalledTimes(3);
    });

    it("should resolve endpoint using domainName if it includes wsApiId in moderator common", () => {
      const endpoint = getEndpoint({
        requestContext: { domainName: "lzvcx59zaa.execute-api.us-east-1.amazonaws.com", stage: "dev" },
      });
      expect(endpoint).toBe("https://lzvcx59zaa.execute-api.us-east-1.amazonaws.com/dev");
    });

    it("should return localhost endpoint when IS_OFFLINE is true in moderator common", async () => {
      const orig = process.env.IS_OFFLINE;
      process.env.IS_OFFLINE = "true";
      vi.resetModules();
      const mod = await import("./common");
      expect(mod.getEndpoint({})).toBe("http://localhost:3002");
      process.env.IS_OFFLINE = orig;
    });
  });

  describe("getAuditLogs", () => {
    it("should fetch audit logs successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "AUDIT#1",
            SK: "METADATA",
            targetId: "job-1",
            targetType: "VACANTE",
            action: "PAUSA",
            reason: "Sospecha",
            executorId: "mod-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            fecha: "2026-01-01",
            hora: "00:00:00",
          },
          {
            PK: "AUDIT#2",
            SK: "METADATA",
            timestamp: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const response = await getAuditLogs({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const logs = JSON.parse(response.body);
      expect(logs).toHaveLength(2);
      expect(logs[0].id).toBe("2");
      expect(logs[1].id).toBe("1");
    });

    it("should return 500 on database error in getAuditLogs", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB audit error"));
      const response = await getAuditLogs({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB audit error");
    });
  });

  describe("getBlockedDomains", () => {
    it("should fetch blocked domains successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "BLOCKED_DOMAIN#spam.com",
            SK: "METADATA",
            domain: "spam.com",
            blockedAt: "2026-01-01T00:00:00.000Z",
            reason: "Phishing",
            companyId: "comp-1",
          },
        ],
      });

      const response = await getBlockedDomains({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const domains = JSON.parse(response.body);
      expect(domains).toHaveLength(1);
      expect(domains[0].domain).toBe("spam.com");
    });

    it("should return 500 on database error in getBlockedDomains", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB domain error"));
      const response = await getBlockedDomains({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB domain error");
    });
  });

  describe("toggleUserBlock", () => {
    it("should return 400 if userId is missing", async () => {
      const res = await toggleUserBlock({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if user does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const res = await toggleUserBlock(
        {
          pathParameters: { id: "user-1" },
          body: JSON.stringify({ blocked: true }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should block user successfully with reason and audit log", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#user-1",
          SK: "PROFILE",
          tipoUsuario: "CANDIDATO",
        },
      }); // Get profile
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog PutCommand

      const res = await toggleUserBlock(
        {
          pathParameters: { id: "user-1" },
          body: JSON.stringify({ blocked: true, reason: "Spam masivo" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.blocked).toBe(true);
    });

    it("should unblock user successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#user-1",
          SK: "PROFILE",
          tipoUsuario: "EMPRESA",
        },
      }); // Get profile
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog PutCommand

      const res = await toggleUserBlock(
        {
          pathParameters: { id: "user-1" },
          body: JSON.stringify({ blocked: false }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.blocked).toBe(false);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Block DB error"));
      const res = await toggleUserBlock(
        {
          pathParameters: { id: "user-1" },
          body: JSON.stringify({ blocked: true }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getModeratorConcurrencyAlerts (Detección de Concurrencia Anómala para Moderadores)", () => {
    it("should deny access with 403 when user is CANDIDATO or ORGANIZACION", async () => {
      const res: any = await getModeratorConcurrencyAlerts(
        {
          headers: { "x-user-role": "CANDIDATO" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("exclusivo para Moderadores de Comunidad");
    });

    it("should allow access and return baseline anomalies when called by MODERATOR", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Vacancies
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Incidents

      const res: any = await getModeratorConcurrencyAlerts(
        {
          headers: { "x-user-role": "MODERATOR" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.anomalies).toBeDefined();
      expect(body.anomalies.length).toBeGreaterThan(0);
    });

    it("should detect anomalous concurrency of > 10 vacancies in < 1h for moderator", async () => {
      const now = Date.now();
      const rapidVacancies = Array.from({ length: 13 }, (_, i) => ({
        PK: `VACANCY#spam-${i}`,
        empresaUuid: "org-bot-recruiter-55",
        company: "Bot Express S.A.",
        fechaCreacion: new Date(now - i * 2 * 60 * 1000).toISOString(),
      }));

      mockDynamoSend.mockResolvedValueOnce({ Items: rapidVacancies });
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const res: any = await getModeratorConcurrencyAlerts(
        {
          headers: { "x-user-role": "MODERATOR" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const detected = body.anomalies.find(
        (a: any) => a.organizationId === "org-bot-recruiter-55",
      );
      expect(detected).toBeDefined();
      expect(detected.type).toBe("RAPID_VACANCIES");
      expect(detected.count).toBe(13);
      expect(detected.threshold).toBe(10);
      expect(detected.timeWindow).toBe("< 1 hora");
    });

    it("should detect anomalous concurrency of > 5 reports in < 1h for moderator", async () => {
      const now = Date.now();
      const surgeReports = Array.from({ length: 8 }, (_, i) => ({
        PK: `INCIDENT#rep-${i}`,
        companyId: "org-scam-99",
        companyName: "Scam & Co",
        fechaCreacion: new Date(now - i * 3 * 60 * 1000).toISOString(),
      }));

      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      mockDynamoSend.mockResolvedValueOnce({ Items: surgeReports });

      const res: any = await getModeratorConcurrencyAlerts(
        {
          headers: { "x-user-role": "MODERADOR" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const detected = body.anomalies.find(
        (a: any) => a.organizationId === "org-scam-99",
      );
      expect(detected).toBeDefined();
      expect(detected.type).toBe("REPORT_SURGE");
      expect(detected.count).toBe(8);
      expect(detected.threshold).toBe(5);
    });
  });
});
