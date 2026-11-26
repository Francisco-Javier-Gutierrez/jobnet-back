import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSESSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockSESSend: vi.fn(),
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
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getJobApplicants,
  getMyApplications,
  updateApplicationStatus,
  getJobAiRanking,
  rankJobApplicantsWithAi,
  getUserAiCooldown,
} from "./management";

describe("applications management handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockSESSend.mockReset();
    mockSESSend.mockResolvedValue({});
  });

  describe("getJobApplicants", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getJobApplicants({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return applicants list on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
            status: "PENDIENTE",
            appliedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const res = await getJobApplicants(
        { pathParameters: { id: "job-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].candidateId).toBe("cand-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Applicants DB error"));
      const res = await getJobApplicants(
        { pathParameters: { id: "job-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getMyApplications", () => {
    it("should return 400 if candidateId is missing", async () => {
      const res = await getMyApplications(
        { queryStringParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 403 if non-candidate role (e.g. ORGANIZACION, MODERATOR) tries to access", async () => {
      const resOrg = await getMyApplications(
        {
          queryStringParameters: { candidateId: "cand-1" },
          headers: { "x-user-role": "ORGANIZACION", "x-user-id": "org-1" },
        } as any,
        {} as any,
        () => {},
      );
      expect(resOrg.statusCode).toBe(403);
      expect(JSON.parse(resOrg.body).error).toContain("solo usuarios con rol CANDIDATO");

      const resMod = await getMyApplications(
        {
          queryStringParameters: { candidateId: "cand-1" },
          headers: { "x-user-role": "MODERATOR", "x-user-id": "mod-1" },
        } as any,
        {} as any,
        () => {},
      );
      expect(resMod.statusCode).toBe(403);
    });

    it("should return 403 if a candidate attempts to query another candidate's applications", async () => {
      const res = await getMyApplications(
        {
          queryStringParameters: { candidateId: "cand-other" },
          headers: { "x-user-role": "CANDIDATO", "x-user-id": "cand-me" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("No tienes permiso");
    });

    it("should return candidate applications on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
            status: "RECHAZADO",
            motivoRechazo: "Perfil cubierto",
            appliedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const res = await getMyApplications(
        { queryStringParameters: { candidateId: "cand-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].status).toBe("RECHAZADO");
      expect(data[0].motivoRechazo).toBe("Perfil cubierto");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("My apps error"));
      const res = await getMyApplications(
        { queryStringParameters: { candidateId: "cand-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });

    it("should resolve CANDIDATO role from DynamoDB profile when JWT authorizer has no custom:role claim", async () => {
      // First DynamoDB call: GetCommand for USER#cand-1 PROFILE
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "USER#cand-1", SK: "PROFILE", tipoUsuario: "CANDIDATO" },
      });
      // Second DynamoDB call: QueryCommand for applications
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
            status: "EN_CONTACTO",
            appliedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const res = await getMyApplications(
        {
          queryStringParameters: { candidateId: "cand-1" },
          requestContext: {
            authorizer: {
              jwt: { claims: { sub: "cand-1", email: "cand@test.com" } },
            },
          },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].jobId).toBe("job-1");
    });

    it("should return 403 when JWT has no custom:role and DynamoDB profile is ORGANIZACION", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "USER#org-1", SK: "PROFILE", tipoUsuario: "ORGANIZACION" },
      });

      const res = await getMyApplications(
        {
          queryStringParameters: { candidateId: "org-1" },
          requestContext: {
            authorizer: {
              jwt: { claims: { sub: "org-1", email: "org@test.com" } },
            },
          },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe("updateApplicationStatus", () => {
    it("should return 400 if path parameters or status is invalid", async () => {
      const res1 = await updateApplicationStatus(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(400);

      const res2 = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "INVALID_STATUS" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(400);
    });

    it("should return 404 if application does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "EN_CONTACTO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return 400 when attempting to reject already selected or hired candidate", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { status: "SELECCIONADO" },
      });

      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "RECHAZADO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("No se puede descartar");
    });

    it("should update status to RECHAZADO, send rejection email and create in-app notification", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } }); // Get app
      mockDynamoSend.mockResolvedValueOnce({}); // Update employer view
      mockDynamoSend.mockResolvedValueOnce({}); // Update candidate view
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      }); // Get candidate profile
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Senior Developer", company: "Meta" },
      }); // Get vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // Put in-app notification

      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({
            status: "RECHAZADO",
            motivoRechazo: "Perfil no compatible",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(mockSESSend).toHaveBeenCalledTimes(1);
    });

    it("should update status to EN_CONTACTO, send contact email", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } }); // Get app
      mockDynamoSend.mockResolvedValueOnce({}); // Update employer view
      mockDynamoSend.mockResolvedValueOnce({}); // Update candidate view
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      }); // Get candidate profile
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Senior Developer", company: "Meta" },
      }); // Get vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // Put chat message
      mockDynamoSend.mockResolvedValueOnce({}); // Put in-app notification

      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({
            status: "EN_CONTACTO",
            detallesEntrevista: "Entrevista técnica mañana a las 10am",
          }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(mockSESSend).toHaveBeenCalledTimes(1);
      expect(
        mockDynamoSend.mock.calls.some(
          (c: any) =>
            (c[0]?.params?.Item?.PK === "CHAT#job-1#cand-1" ||
              c[0]?.input?.Item?.PK === "CHAT#job-1#cand-1") &&
            (c[0]?.params?.Item?.text === "Entrevista técnica mañana a las 10am" ||
              c[0]?.input?.Item?.text === "Entrevista técnica mañana a las 10am"),
        ),
      ).toBe(true);
    });

    it("should update status to SELECCIONADO and CONTRATADO", async () => {
      // 1. SELECCIONADO
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Senior Developer", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res1 = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "SELECCIONADO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(200);

      // 2. CONTRATADO
      mockDynamoSend.mockResolvedValueOnce({
        Item: { status: "SELECCIONADO" },
      });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Senior Developer", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const res2 = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "CONTRATADO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(200);
    });

    it("should handle email sending failures gracefully across all status transitions", async () => {
      // 1. RECHAZADO error
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Dev", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});
      mockSESSend.mockRejectedValueOnce(new Error("SES Error 1"));

      await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "RECHAZADO" }),
        } as any,
        {} as any,
        () => {},
      );

      // 2. EN_CONTACTO error
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Dev", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});
      mockSESSend.mockRejectedValueOnce(new Error("SES Error 2"));

      await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "EN_CONTACTO" }),
        } as any,
        {} as any,
        () => {},
      );

      // 3. SELECCIONADO error
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Dev", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});
      mockSESSend.mockRejectedValueOnce(new Error("SES Error 3"));

      await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "SELECCIONADO" }),
        } as any,
        {} as any,
        () => {},
      );

      // 4. CONTRATADO error
      mockDynamoSend.mockResolvedValueOnce({ Item: { status: "PENDIENTE" } });
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "cand@test.com" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Dev", company: "Meta" },
      });
      mockDynamoSend.mockResolvedValueOnce({});
      mockSESSend.mockRejectedValueOnce(new Error("SES Error 4"));

      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "CONTRATADO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Update status error"));
      const res = await updateApplicationStatus(
        {
          pathParameters: { jobId: "job-1", candidateId: "cand-1" },
          body: JSON.stringify({ status: "EN_CONTACTO" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("rankJobApplicantsWithAi & getJobAiRanking", () => {
    it("should return 400 if jobId is missing in rankJobApplicantsWithAi", async () => {
      const res = await rankJobApplicantsWithAi({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if vacancy is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Vacancy Get
      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-999" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return 403 if user is not the company owner of the vacancy", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "other-comp" },
      });
      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1", "x-user-role": "ORGANIZACION" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
    });

    it("should generate and return candidate ranking for vacancy owner and save TTL cooldown", async () => {
      // 1. Vacancy Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#job-1",
          title: "Senior Node.js Developer",
          empresaUuid: "comp-1",
          skills: ["Node.js", "TypeScript"],
        },
      });
      // 2. Job Cooldown Get (checkJobAiCooldown) -> No cooldown record present
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      // 3. Query Applicants
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
            coverLetter: "Gran experiencia en Node.",
          },
        ],
      });
      // 4. Candidate Profile Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#cand-1",
          nombre: "Mario López",
          titularProfesional: "Full Stack Engineer",
          skills: ["Node.js", "TypeScript", "AWS"],
        },
      });
      // 5. Put cached vacancy ranking
      mockDynamoSend.mockResolvedValueOnce({});
      // 6. Put job cooldown with TTL
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.jobId).toBe("job-1");
      expect(body.ranking).toBeDefined();
    });

    it("should return 429 when vacancy has an active cooldown record with TTL in DynamoDB", async () => {
      const futureTtl = Math.floor(Date.now() / 1000) + 7200; // 2 horas restantes
      // 1. Vacancy Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#job-1",
          title: "Senior Node.js Developer",
          empresaUuid: "comp-1",
        },
      });
      // 2. Job Cooldown Get -> Record present with active TTL
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "JOB#job-1",
          SK: "AI_COOLDOWN",
          jobId: "job-1",
          ttl: futureTtl,
          expiresAt: new Date(futureTtl * 1000).toISOString(),
        },
      });

      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.cooldown).toBe(true);
      expect(body.error).toContain("Esta vacante ya fue evaluada recientemente");
      expect(body.remainingSeconds).toBeGreaterThan(0);
      expect(body.expiresAt).toBeDefined();
    });

    it("should allow privileged user (ADMIN/MODERATOR) to bypass job cooldown", async () => {
      // 1. Vacancy Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#job-1",
          title: "Senior Node.js Developer",
          empresaUuid: "comp-1",
        },
      });
      // Privileged bypasses cooldown check!
      // 2. Query Applicants
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
          },
        ],
      });
      // 3. Candidate Profile Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#cand-1",
          nombre: "Mario López",
        },
      });
      // 4. Put cached ranking
      mockDynamoSend.mockResolvedValueOnce({});
      // Privileged does not put cooldown!

      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "admin-1", "x-user-role": "ADMIN" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
    });

    it("should allow generation if job cooldown TTL has already elapsed", async () => {
      const pastTtl = Math.floor(Date.now() / 1000) - 300; // Expiró hace 5 minutos
      // 1. Vacancy Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#job-1",
          title: "Senior Node.js Developer",
          empresaUuid: "comp-1",
        },
      });
      // 2. Job Cooldown Get -> Past TTL
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "JOB#job-1",
          SK: "AI_COOLDOWN",
          jobId: "job-1",
          ttl: pastTtl,
        },
      });
      // 3. Query Applicants
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            candidateId: "cand-1",
            jobId: "job-1",
          },
        ],
      });
      // 4. Candidate Profile Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#cand-1",
          nombre: "Mario López",
        },
      });
      // 5. Put cached ranking
      mockDynamoSend.mockResolvedValueOnce({});
      // 6. Put job cooldown
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await rankJobApplicantsWithAi(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
    });

    it("getJobAiRanking should return cached ranking and job cooldown if exists", async () => {
      // 1. Vacancy ranking Get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "JOB#job-1",
          SK: "AI_RANKING",
          jobId: "job-1",
          ranking: [{ candidateId: "cand-1", matchPercentage: 95 }],
        },
      });
      // 2. Job Cooldown Get
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const res = await getJobAiRanking(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ranking[0].matchPercentage).toBe(95);
      expect(body.jobCooldown.isBlocked).toBe(false);
      expect(body.userCooldown.isBlocked).toBe(false);
    });

    it("getJobAiRanking should return 200 with hasRanking: false if no ranking has been generated yet", async () => {
      // 1. Ranking Get -> null
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      // 2. Job Cooldown Get -> null
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const res = await getJobAiRanking(
        {
          pathParameters: { id: "job-1" },
          headers: { "x-user-id": "comp-1" },
        } as any,
        {} as any,
        () => {},
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.hasRanking).toBe(false);
      expect(body.ranking).toBeNull();
      expect(body.jobCooldown.isBlocked).toBe(false);
    });

    it("getUserAiCooldown should return 401 if unauthenticated and 200 with cooldown status when authenticated", async () => {
      // Unauthenticated
      const unauthRes = await getUserAiCooldown({ headers: {} } as any, {} as any, () => {});
      expect(unauthRes.statusCode).toBe(401);

      // Authenticated with no cooldown
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      const authRes = await getUserAiCooldown(
        { headers: { "x-user-id": "user-test" } } as any,
        {} as any,
        () => {},
      );
      expect(authRes.statusCode).toBe(200);
      const body = JSON.parse(authRes.body);
      expect(body.isBlocked).toBe(false);

      // Authenticated with jobId query param
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      const jobCooldownRes = await getUserAiCooldown(
        {
          headers: { "x-user-id": "user-test" },
          queryStringParameters: { jobId: "job-101" },
        } as any,
        {} as any,
        () => {},
      );
      expect(jobCooldownRes.statusCode).toBe(200);
    });
  });
});
