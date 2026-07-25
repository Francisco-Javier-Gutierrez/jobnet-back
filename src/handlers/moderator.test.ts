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
  getDisputes,
  createDispute,
  resolveDispute,
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
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand empty

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Incident not found");
    });

    it("should approve incident successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-1",
          SK: "METADATA",
          jobId: "job-1",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand success for incident status

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
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-1",
          SK: "METADATA",
          jobId: "job-1",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand success for incident status
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand success for vacancy status

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
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-1",
          SK: "METADATA",
          jobId: "job-1",
          reason: "Sospechosa",
        },
      }); // GetCommand incident success
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident success
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand vacancy success
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#job-1",
          SK: "METADATA",
          titulo: "Dev Job",
          empresaUuid: "comp-1",
        },
      }); // GetCommand vacancy success
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "USER#comp-1", SK: "PROFILE", email: "company@test.com" },
      }); // GetCommand company profile success

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
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "SUGGESTION#SKILL#skill-1",
            SK: "METADATA",
            name: "Vue 4",
            fechaCreacion: "2026-07-16T12:00:00.000Z",
          },
        ],
      });

      const response = await getSuggestedSkills({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        id: "skill-1",
        name: "Vue 4",
        createdAt: "2026-07-16T12:00:00.000Z",
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
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand empty

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe(
        "Skill suggestion not found",
      );
    });

    it("should detect duplicate / similar skill in catalog", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "SUGGESTION#SKILL#skill-1",
          SK: "METADATA",
          name: "ReactJS",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "CATALOG#1",
            SK: "CATALOG",
            name: "React",
            category: "Habilidad",
          },
        ],
      }); // ScanCommand catalog success (ReactJS vs React levenshtein is 2, so it matches similarity)

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.duplicate).toBe(true);
      expect(res.existingName).toBe("React");
    });

    it("should approve skill without duplicate or with unifyWith successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "SUGGESTION#SKILL#skill-1",
          SK: "METADATA",
          name: "Nuxt 4",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "CATALOG#1",
            SK: "CATALOG",
            name: "React",
            category: "Habilidad",
          },
        ],
      }); // ScanCommand catalog success
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // exactCheck scan empty
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand catalog success
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand success

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
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "SUGGESTION#SKILL#skill-1",
          SK: "METADATA",
          name: "Nuxt 4",
        },
      }); // GetCommand success
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand success

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

  describe("disputes handlers", () => {
    it("should fetch disputes successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "DISPUTE#disp-1",
            SK: "METADATA",
            reason: "Non-responsive company",
            estatus: "ABIERTA",
            fechaCreacion: "2026-07-24T12:00:00Z",
          },
        ],
      });

      const event = { queryStringParameters: {} } as any;
      const response = await getDisputes(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].reason).toBe("Non-responsive company");
    });

    it("should create dispute successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // Put metadata
      mockDynamoSend.mockResolvedValueOnce({}); // Put initial msg

      const event = {
        body: JSON.stringify({
          jobId: "job-1",
          complainantId: "cand-1",
          reason: "Offer terms modified unexpectedly",
        }),
      } as any;

      const response = await createDispute(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).success).toBe(true);
    });

    it("should return 400 when missing required fields in createDispute", async () => {
      const event = { body: JSON.stringify({}) } as any;
      const response = await createDispute(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should resolve dispute successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = {
        pathParameters: { disputeId: "disp-1" },
        body: JSON.stringify({ action: "resolve", notes: "Reviewed and settled" }),
      } as any;

      const response = await resolveDispute(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).estatus).toBe("RESUELTA");
    });
  });
});
