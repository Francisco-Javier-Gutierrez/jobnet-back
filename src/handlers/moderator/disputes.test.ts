import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSesSend, mockPushSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockSesSend: vi.fn(),
    mockPushSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = mockSesSend;
  },
  SendEmailCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = vi.fn().mockResolvedValue({});
  },
  PostToConnectionCommand: class {},
}));

vi.mock("../../utils/webPushService", () => ({
  sendPushToUser: mockPushSend.mockResolvedValue({}),
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
  openIncidentAudit,
  getIncidentAuditChat,
  submitIncidentAuditDictum,
} from "./disputes";

describe("Auditoría de Mensajería para Disputas (Moderador)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});
    mockPushSend.mockResolvedValue({});
  });

  describe("Fase 1: openIncidentAudit (Apertura y Notificación a Ambas Partes)", () => {
    it("should deny access with 403 when user is CANDIDATO or ORGANIZACION", async () => {
      const res: any = await openIncidentAudit(
        {
          headers: { "x-user-role": "CANDIDATO" },
          pathParameters: { incidentId: "inc-101" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Apertura de auditoría exclusiva para Moderadores");
    });

    it("should return 400 if incidentId path parameter is missing", async () => {
      const res: any = await openIncidentAudit(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: {},
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(400);
    });

    it("should admit incident, set AUDITORIA status, and dispatch notifications to both parties", async () => {
      // 1. Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-salary-dispute",
          SK: "METADATA",
          id: "inc-salary-dispute",
          jobId: "vac-frontend-sr-01",
          jobTitle: "Frontend Senior",
          companyId: "org-tech-corp",
          companyName: "Tech Corp Latam",
          candidateId: "cand-maria-77",
          candidateName: "María Fernández",
          infraccion: "DISCREPANCIA_SALARIAL",
          reason: "El reclutador ofreció $18,000 en chat privado pese a que la vacante anunciaba $45,000.",
          severity: "ALTA",
        },
      });

      // 2. UpdateCommand (incident status -> AUDITORIA)
      mockDynamoSend.mockResolvedValueOnce({});
      // 3. PutCommand (candidate notification)
      mockDynamoSend.mockResolvedValueOnce({});
      // 4. PutCommand (company notification)
      mockDynamoSend.mockResolvedValueOnce({});
      // 5. GetCommand (company profile for SES email)
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#org-tech-corp",
          SK: "PROFILE",
          email: "hr@techcorplatam.com",
          nombreComercial: "Tech Corp Latam",
        },
      });
      // 6. PutCommand (saveAuditLog)
      mockDynamoSend.mockResolvedValueOnce({});

      const res: any = await openIncidentAudit(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: { incidentId: "inc-salary-dispute" },
          body: JSON.stringify({ notes: "Admisión formal por discrepancia salarial flagrante." }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.auditState).toBe("AUDIT_ACTIVE");
      expect(body.supervisionStatus).toBe("UNDER_AUDIT");

      // Verify push dispatched to candidate and company
      expect(mockPushSend).toHaveBeenCalledTimes(2);
      expect(mockPushSend).toHaveBeenCalledWith(
        "cand-maria-77",
        expect.objectContaining({
          title: expect.stringContaining("Canal Supervisado"),
        }),
      );
      expect(mockPushSend).toHaveBeenCalledWith(
        "org-tech-corp",
        expect.objectContaining({
          title: expect.stringContaining("Apertura de Auditoría"),
        }),
      );
    });
  });

  describe("Fase 2: getIncidentAuditChat (Acceso a Historial en Solo Lectura)", () => {
    it("should deny access with 403 when called by non-moderator", async () => {
      const res: any = await getIncidentAuditChat(
        {
          headers: { "x-user-role": "CANDIDATO" },
          pathParameters: { incidentId: "inc-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(403);
    });

    it("should return read-only message history and attachments for salary dispute", async () => {
      // 1. Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-salary-dispute",
          SK: "METADATA",
          id: "inc-salary-dispute",
          jobId: "vac-frontend-sr-01",
          jobTitle: "Frontend Senior",
          companyId: "org-tech-corp",
          companyName: "Tech Corp Latam",
          candidateId: "cand-maria-77",
          candidateName: "María Fernández",
          infraccion: "DISCREPANCIA_SALARIAL",
          auditState: "AUDIT_ACTIVE",
        },
      });

      // 2. Query chat messages (empty in DB to trigger realistic baseline evidence)
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const res: any = await getIncidentAuditChat(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: { incidentId: "inc-salary-dispute" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.isReadOnly).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);
      expect(body.messages[0]).toHaveProperty("senderRole");
      expect(body.messages[0]).toHaveProperty("createdAt");

      // Verify attachment exists in evidence
      const withAttachment = body.messages.find((m: any) => m.attachmentUrl);
      expect(withAttachment).toBeDefined();
      expect(withAttachment.attachmentName).toContain(".pdf");
    });

    it("should return read-only message history for fraud dispute", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          id: "inc-fraud-01",
          jobId: "vac-capturista-01",
          infraccion: "FRAUDE",
          auditState: "AUDIT_ACTIVE",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const res: any = await getIncidentAuditChat(
        {
          headers: { "x-user-role": "MODERADOR" },
          pathParameters: { incidentId: "inc-fraud-01" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.messages.some((m: any) => m.text.includes("depósito previo"))).toBe(true);
    });
  });

  describe("Fase 2: submitIncidentAuditDictum (Dictamen del Moderador)", () => {
    it("should return 400 when dictum option is invalid", async () => {
      const res: any = await submitIncidentAuditDictum(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: { incidentId: "inc-1" },
          body: JSON.stringify({ dictum: "INVALID_DICTUM" }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Opciones: 'SANCION_EMPRESA'");
    });

    it("should execute SANCION_EMPRESA dictum with suspension initiation and audit logging", async () => {
      // 1. Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          id: "inc-salary-dispute",
          companyId: "org-tech-corp",
          candidateId: "cand-maria-77",
          infraccion: "DISCREPANCIA_SALARIAL",
        },
      });

      // 2. executeOrgSuspensionInitiation internal mock calls
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand company profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand appeal chat initial msg
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification company
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "hr@tech.com", nombreComercial: "Tech Corp" },
      }); // GetCommand company profile for email
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog (suspension)

      // 3. Candidate resolution notification
      mockDynamoSend.mockResolvedValueOnce({});
      // 4. Update incident status to RESUELTO & AUDIT_CONCLUDED
      mockDynamoSend.mockResolvedValueOnce({});
      // 5. saveAuditLog (dictum)
      mockDynamoSend.mockResolvedValueOnce({});

      const res: any = await submitIncidentAuditDictum(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: { incidentId: "inc-salary-dispute" },
          body: JSON.stringify({
            dictum: "SANCION_EMPRESA",
            notes: "Se confirma discrepancia salarial grave y engaño deliberado a los candidatos.",
            graceDays: 4,
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.dictum).toBe("SANCION_EMPRESA");
      expect(mockPushSend).toHaveBeenCalled();
    });

    it("should record ADVERTENCIA dictum successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          id: "inc-adv-01",
          companyId: "org-minor-fault",
          candidateId: "cand-juan-55",
        },
      });

      // Warning notification put
      mockDynamoSend.mockResolvedValueOnce({});
      // Candidate notification put
      mockDynamoSend.mockResolvedValueOnce({});
      // Incident update
      mockDynamoSend.mockResolvedValueOnce({});
      // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({});

      const res: any = await submitIncidentAuditDictum(
        {
          headers: { "x-user-role": "MODERATOR" },
          pathParameters: { incidentId: "inc-adv-01" },
          body: JSON.stringify({
            dictum: "ADVERTENCIA",
            notes: "Amonestación por ambigüedad en condiciones laborales.",
          }),
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dictum).toBe("ADVERTENCIA");
    });
  });
});
