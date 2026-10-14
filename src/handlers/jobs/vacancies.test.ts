import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  PutObjectCommand: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {},
  SendEmailCommand: class {},
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
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
} from "./vacancies";

describe("jobs vacancies handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getJobs", () => {
    it("should return jobs list filtered by active companies and status", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { PK: "USER#comp-active", estadoCuenta: "ACTIVO" },
          { PK: "USER#comp-suspended", estadoCuenta: "SUSPENDIDA" },
        ],
      }); // Query profiles

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-1",
            titulo: "Fullstack Dev",
            company: "Tech Corp",
            empresaUuid: "comp-active",
            estado: "Activa",
            modalidad: "Remoto",
            salario: 50000,
          },
          {
            PK: "VACANCY#job-2",
            titulo: "Suspended Job",
            empresaUuid: "comp-suspended",
            estado: "Activa",
          },
          {
            PK: "VACANCY#job-3",
            titulo: "Closed Job",
            empresaUuid: "comp-active",
            estado: "CERRADA",
          },
        ],
      }); // Query vacancies

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { SK: "LIKE#user-1" },
          { SK: "BOOKMARK#user-2" },
          { SK: "COMMENT#c1", isDeleted: false },
        ],
      }); // Query job-1 interactions

      const res = await getJobs(
        {
          queryStringParameters: { q: "Fullstack", page: "1", limit: "10" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("job-1");
      expect(body.data[0].likesCount).toBe(1);
      expect(body.data[0].bookmarksCount).toBe(1);
      expect(body.data[0].commentsCount).toBe(1);
    });

    it("should handle modality filter mismatch, q mismatch, no search params, temporary suspension, and enrichment failure", async () => {
      const future = new Date(Date.now() + 100000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#comp-temp",
            estadoCuenta: "SUSPENDIDA_TEMPORAL",
            fechaFinSuspension: future,
          },
        ],
      }); // Query profiles
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-match",
            titulo: "Dev",
            modalidad: "Remoto",
            company: "A",
            descripcion: "Desc",
          },
          {
            PK: "VACANCY#job-temp-suspended",
            titulo: "Dev",
            modalidad: "Remoto",
            empresaUuid: "comp-temp",
          },
          {
            PK: "VACANCY#job-modalidad-diff",
            titulo: "Dev",
            modalidad: "Presencial",
            company: "B",
            descripcion: "Desc",
          },
          {
            PK: "VACANCY#job-q-diff",
            titulo: "Designer",
            modalidad: "Remoto",
            company: "C",
            descripcion: "Other",
          },
        ],
      }); // Query vacancies
      mockDynamoSend.mockRejectedValueOnce(
        new Error("Enrichment query failed"),
      ); // Catch in enrichedItems

      const res = await getJobs(
        { queryStringParameters: { q: "Dev", modalidad: "Remoto" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe("job-match");

      // No search params test (line 200)
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "VACANCY#job-1", titulo: "Dev", modalidad: "Remoto" }],
      });
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const resNoParams = await getJobs({} as any, {} as any, () => {});
      expect(resNoParams.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(resNoParams.body))).toBe(true);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Jobs DB error"));
      const res = await getJobs({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getJobById", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getJobById(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if job does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res = await getJobById(
        { pathParameters: { id: "job-999" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return job details with comments and application status if candidateId passed", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-1",
            SK: "METADATA",
            titulo: "Senior Engineer",
            company: "Google",
            empresaUuid: "comp-1",
            estado: "Activa",
          },
          {
            PK: "VACANCY#job-1",
            SK: "LIKE#user-1",
          },
          {
            PK: "VACANCY#job-1",
            SK: "BOOKMARK#user-2",
          },
          {
            PK: "VACANCY#job-1",
            SK: "COMMENT#2026-01-01",
            author: "Alice",
            content: "Great job!",
          },
        ],
      }); // Query job items

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "JOB#job-1",
            SK: "APP#cand-1",
            candidateId: "cand-1",
            status: "EN_PROCESO",
          },
        ],
      }); // Query candidate application

      const res = await getJobById(
        {
          pathParameters: { id: "job-1" },
          queryStringParameters: { candidateId: "cand-1" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);

      const job = JSON.parse(res.body);
      expect(job.title).toBe("Senior Engineer");
      expect(job.comments).toHaveLength(1);
      expect(job.userContext?.isApplied).toBe(true);
      expect(job.userContext?.applicationStatus).toBe("EN_PROCESO");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Job get error"));
      const res = await getJobById(
        { pathParameters: { id: "job-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("createJob", () => {
    it("should create a new vacancy successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        body: JSON.stringify({
          title: "Frontend Architect",
          company: "Acme",
          descripcion: "Build cool apps",
          salarioMinimo: 40000,
          salarioMaximo: 60000,
          maxPostulantes: 50,
        }),
      } as any;

      const res = await createJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.titulo).toBe("Frontend Architect");
      expect(data.maxPostulantes).toBe(50);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Create job error"));
      const res = await createJob(
        { body: JSON.stringify({}) } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("updateJob", () => {
    it("should return 400 if id is missing", async () => {
      const res = await updateJob(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if job does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      const res = await updateJob(
        {
          pathParameters: { id: "job-999" },
          body: JSON.stringify({ title: "New" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return 403 if caller is not owner and not privileged", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "owner-1" },
      });

      const event = {
        pathParameters: { id: "job-1" },
        headers: { "x-user-id": "other-user", "x-user-role": "CANDIDATE" },
        body: JSON.stringify({ title: "New Title" }),
      } as any;

      const res = await updateJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(403);
    });

    it("should return 400 if no valid fields provided to update", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "owner-1" },
      });

      const event = {
        pathParameters: { id: "job-1" },
        headers: { "x-user-id": "owner-1" },
        body: JSON.stringify({ invalidField: "test" }),
      } as any;

      const res = await updateJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should update job successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "owner-1" },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Attributes: { titulo: "Updated Title", salario: 60000 },
      });

      const event = {
        pathParameters: { id: "job-1" },
        headers: { "x-user-id": "owner-1" },
        body: JSON.stringify({ titulo: "Updated Title", salario: 60000 }),
      } as any;

      const res = await updateJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.titulo).toBe("Updated Title");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Update job error"));
      const res = await updateJob(
        { pathParameters: { id: "job-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("deleteJob", () => {
    it("should return 400 if id is missing", async () => {
      const res = await deleteJob(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if job does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      const res = await deleteJob(
        { pathParameters: { id: "job-999" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return 403 if caller is not owner and not privileged", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "owner-1" },
      });

      const event = {
        pathParameters: { id: "job-1" },
        headers: { "x-user-id": "hacker-user", "x-user-role": "CANDIDATE" },
      } as any;

      const res = await deleteJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(403);
    });

    it("should soft delete job successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "VACANCY#job-1", empresaUuid: "owner-1" },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { id: "job-1" },
        headers: { "x-user-id": "owner-1" },
      } as any;

      const res = await deleteJob(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.estado).toBe("CERRADA");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Delete job error"));
      const res = await deleteJob(
        { pathParameters: { id: "job-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
