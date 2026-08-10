/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getVerificationRequests,
  resolveVerification,
  getIncidents,
  createIncident,
  resolveIncident,
  getSuggestedSkills,
  createSkillSuggestion,
  resolveSkillSuggestion,
  getAuditLogs,
  getBlockedDomains,
} from "./moderator";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = vi.fn().mockResolvedValue({});
  },
  SendEmailCommand: class {
    constructor(public params: any) {}
  },
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
  QueryCommand: class {
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
}));

describe("moderator handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVerificationRequests", () => {
    it("should return verification requests on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#company-1",
            SK: "PROFILE",
            nombre: "Francisco Tech",
            taxId: "RFC123",
            email: "test@company.com",
            documentoVerificacion: "https://s3/file.pdf",
            estatusVerificacion: "En revisión",
          },
          {
            PK: "USER#company-2",
            SK: "PROFILE",
            // Missing optional fields to test defaults
          },
        ],
      });

      const response = await getVerificationRequests(
        {} as any,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual({
        companyId: "company-1",
        companyName: "Francisco Tech",
        taxId: "RFC123",
        email: "test@company.com",
        docUrl: "https://s3/file.pdf",
        estatusVerificacion: "En revisión",
      });
      expect(res[1]).toEqual({
        companyId: "company-2",
        companyName: "Sin Nombre",
        taxId: "",
        email: "",
        docUrl: "",
        estatusVerificacion: "",
      });
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getVerificationRequests(
        {} as any,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveVerification", () => {
    it("should return 400 if companyId is missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing path parameter 'companyId'",
      );
    });

    it("should return 400 if approve is missing", async () => {
      const event = {
        pathParameters: { companyId: "company-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing body parameter 'approve'",
      );
    });

    it("should return 404 if company profile is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand empty

      const event = {
        pathParameters: { companyId: "company-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Company profile not found");
    });

    it("should approve verification successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#company-1",
          SK: "PROFILE",
          nombre: "Francisco Tech",
          taxId: "RFC123",
          documentoVerificacion: "https://s3/file.pdf",
          estatusVerificacion: "En revisión",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        pathParameters: { companyId: "company-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.companyId).toBe("company-1");
      expect(res.organizacionVerificada).toBe(true);
      expect(res.estatusVerificacion).toBe("Verificada");
    });

    it("should reject verification successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#company-1",
          SK: "PROFILE",
          nombre: "Francisco Tech",
          taxId: "RFC123",
          documentoVerificacion: "https://s3/file.pdf",
          estatusVerificacion: "En revisión",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        pathParameters: { companyId: "company-1" },
        body: JSON.stringify({ approve: false }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.companyId).toBe("company-1");
      expect(res.organizacionVerificada).toBe(false);
      expect(res.estatusVerificacion).toBe("Rechazada");
    });

    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { companyId: "company-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("getIncidents", () => {
    it("should return sorted incidents on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "INCIDENT#inc-1",
            SK: "METADATA",
            jobId: "job-1",
            jobTitle: "Dev Vacancy",
            reporter: "candidato@test.com",
            reason: "Fake job description",
            severity: "alta",
            infraccion: "fraude",
            fechaCreacion: "2026-07-16T12:00:00.000Z",
          },
          {
            PK: "INCIDENT#inc-2",
            SK: "METADATA",
            fechaCreacion: "2026-07-17T12:00:00.000Z", // newer, should sort first
          },
        ],
      });

      const response = await getIncidents({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(2);
      expect(res[0].id).toBe("inc-2"); // newer first
      expect(res[1].id).toBe("inc-1");
      expect(res[1]).toEqual({
        id: "inc-1",
        jobId: "job-1",
        jobTitle: "Dev Vacancy",
        postId: "",
        postTitle: "",
        companyId: "",
        companyName: "",
        targetId: "job-1",
        targetTitle: "Dev Vacancy",
        targetType: "VACANTE",
        reporter: "candidato@test.com",
        reason: "Fake job description",
        severity: "alta",
        infraccion: "fraude",
        estatus: "PENDIENTE",
        fechaCreacion: "2026-07-16T12:00:00.000Z",
      });
    });

    it("should return 500 on database error during get", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getIncidents({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("createIncident", () => {
    it("should return 400 if reason is missing", async () => {
      const event = {
        body: JSON.stringify({ jobId: "job-1" }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing body parameter 'reason'",
      );
    });

    it("should create incident successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // ScanCommand success for reports count

      const event = {
        body: JSON.stringify({
          jobId: "job-1",
          jobTitle: "Dev Job",
          reporter: "user@test.com",
          reason: "Spam",
          severity: "media",
          infraccion: "contenido",
        }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.id).toBeDefined();
      expect(res.jobId).toBe("job-1");
      expect(res.jobTitle).toBe("Dev Job");
      expect(res.reason).toBe("Spam");
      expect(res.severity).toBe("media");
      expect(res.infraccion).toBe("contenido");
      expect(res.estatus).toBe("PENDIENTE");
    });

    it("should trigger automatic vacancy evaluation (RF-72) when 5 or more reports accumulate in less than 12 hours", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success for new incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: Array(5).fill({ PK: "INCIDENT#1", SK: "METADATA" }),
      }); // ScanCommand returns 5 incidents
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand success setting EVALUACION
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success for saveAuditLog

      const event = {
        body: JSON.stringify({
          jobId: "job-fraud-123",
          jobTitle: "Fake Offer",
          reporter: "victim@test.com",
          reason: "Scam",
        }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.autoSuspended).toBe(true);
      expect(res.incidentCount).toBe(5);
    });

    it("should return 500 on database error during create", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        body: JSON.stringify({ reason: "Spam" }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveIncident", () => {
    it("should return 400 if incidentId is missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing path parameter 'incidentId'",
      );
    });

    it("should return 400 if action is invalid or missing", async () => {
      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "invalid" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Invalid or missing body parameter 'action'. Must be 'approve', 'block' or 'evaluate'",
      );
    });

    it("should return 404 if incident is not found", async () => {
      mockDynamoSend.mockImplementation(async () => {
        return { Item: null };
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Incident not found");
    });

    it("should approve incident successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              companyId: "comp-1",
              estatus: "EVALUACION",
            },
          };
        if (
          input.KeyConditionExpression?.includes(":pk") &&
          input.ExpressionAttributeValues?.[":pk"]?.startsWith("APPEAL_CHAT")
        )
          return {
            Items: [
              { senderId: "comp-1" },
              { senderId: "comp-1" },
              { senderId: "comp-1" },
            ],
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.incidentId).toBe("inc-1");
      expect(res.estatus).toBe("RESUELTO");
    });

    it("should block incident and vacancy successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              companyId: "comp-1",
              estatus: "EVALUACION",
            },
          };
        if (pk === "VACANCY#job-1")
          return {
            Item: {
              PK: "VACANCY#job-1",
              SK: "METADATA",
              titulo: "Dev Job",
              empresaUuid: "comp-1",
            },
          };
        if (pk === "USER#comp-1")
          return {
            Item: {
              PK: "USER#comp-1",
              SK: "PROFILE",
              email: "company@test.com",
            },
          };
        if (
          input.KeyConditionExpression?.includes(":pk") &&
          input.ExpressionAttributeValues?.[":pk"]?.startsWith("APPEAL_CHAT")
        )
          return {
            Items: [
              { senderId: "comp-1" },
              { senderId: "comp-1" },
              { senderId: "comp-1" },
            ],
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "block" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.incidentId).toBe("inc-1");
      expect(res.estatus).toBe("BLOQUEADO");
    });
    it("should evaluate incident and pause vacancy successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              reason: "Sospechosa",
              companyId: "comp-1",
            },
          };
        if (pk === "VACANCY#job-1")
          return {
            Item: {
              PK: "VACANCY#job-1",
              SK: "METADATA",
              titulo: "Dev Job",
              empresaUuid: "comp-1",
            },
          };
        if (pk === "USER#comp-1")
          return {
            Item: {
              PK: "USER#comp-1",
              SK: "PROFILE",
              email: "company@test.com",
            },
          };
        if (input.ExpressionAttributeValues?.[":pk"] === "APPEAL_CHAT")
          return {
            Items: [
              { senderId: "comp-1" },
              { senderId: "comp-1" },
              { senderId: "comp-1" },
            ],
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "evaluate" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.estatus).toBe("EVALUACION");
    });
    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("getSuggestedSkills", () => {
    it("should return suggested skills on success", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        if (input.FilterExpression?.includes("skillPrefix")) {
          return {
            Items: [
              {
                PK: "SUGGESTION#SKILL#skill-1",
                SK: "METADATA",
                name: "Vue 4",
                fechaCreacion: "2026-07-16T12:00:00.000Z",
              },
            ],
          };
        }
        return { Items: [] };
      });

      const response = await getSuggestedSkills({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        id: "skill-1",
        name: "Vue 4",
        category: "Habilidad",
        createdAt: "2026-07-16T12:00:00.000Z",
        hasDuplicate: false,
        existingName: null,
      });
    });

    it("should return 500 on database error during get", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getSuggestedSkills({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("createSkillSuggestion", () => {
    it("should return 400 if name is missing", async () => {
      const event = {
        body: JSON.stringify({}),
      } as any;

      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing body parameter 'name'",
      );
    });

    it("should create skill suggestion successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        body: JSON.stringify({ name: "Nuxt 4" }),
      } as any;

      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.id).toBeDefined();
      expect(res.name).toBe("Nuxt 4");
    });

    it("should return 500 on database error during create", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        body: JSON.stringify({ name: "Nuxt 4" }),
      } as any;

      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveSkillSuggestion", () => {
    it("should return 400 if id is missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing path parameter 'id'",
      );
    });

    it("should return 400 if approve is missing", async () => {
      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe(
        "Missing body parameter 'approve'",
      );
    });

    it("should return 404 if suggestion is not found", async () => {
      mockDynamoSend.mockImplementation(async () => {
        return { Item: null };
      });

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Suggestion not found");
    });

    it("should approve skill without duplicate or with unifyWith successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "SUGGESTION#SKILL#skill-1")
          return {
            Item: {
              PK: "SUGGESTION#SKILL#skill-1",
              SK: "METADATA",
              name: "Nuxt 4",
            },
          };
        return { Items: [] }; // for scans
      });

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.action).toBe("APPROVED");
    });

    it("should reject suggested skill successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "SUGGESTION#SKILL#skill-1")
          return {
            Item: {
              PK: "SUGGESTION#SKILL#skill-1",
              SK: "METADATA",
              name: "Nuxt 4",
            },
          };
        return {};
      });

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: false }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.action).toBe("REJECTED");
    });

    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("getAuditLogs", () => {
    it("should fetch audit logs successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "AUDIT#aud-1",
            SK: "METADATA",
            auditId: "aud-1",
            targetId: "job-100",
            targetType: "VACANTE",
            action: "SUSPENSION_AUTOMATICA_RF72",
            reason: "Acumulación de 5 reportes",
            executorId: "SISTEMA_AUTOGUARDIA",
            timestamp: "2026-07-24T18:00:00.000Z",
            fecha: "2026-07-24",
            hora: "18:00:00",
          },
        ],
      });

      const response = await getAuditLogs({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const logs = JSON.parse(response.body);
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe("aud-1");
      expect(logs[0].targetId).toBe("job-100");
      expect(logs[0].action).toBe("SUSPENSION_AUTOMATICA_RF72");
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
            PK: "BLOCKED_DOMAIN#scam.com",
            SK: "METADATA",
            domain: "scam.com",
            blockedAt: "2026-07-24T18:00:00.000Z",
            reason: "Phishing site",
          },
        ],
      });

      const response = await getBlockedDomains({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const domains = JSON.parse(response.body);
      expect(domains).toHaveLength(1);
      expect(domains[0].domain).toBe("scam.com");
      expect(domains[0].reason).toBe("Phishing site");
    });

    it("should return 500 on database error in getBlockedDomains", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB domain error"));
      const response = await getBlockedDomains({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB domain error");
    });
  });
});
