import { describe, it, expect, vi, beforeEach } from "vitest";

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
  PutCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  applyToJob,
  getJobApplicants,
  getMyApplications,
  updateApplicationStatus,
} from "./applications";

describe("applications handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── applyToJob ──────────────────────────────────────────────────────

  describe("applyToJob", () => {
    it("should return 400 if job id path parameter is missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ candidateId: "user-1" }),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("id");
    });

    it("should return 400 if candidateId is missing from body", async () => {
      const event = {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("candidateId");
    });

    it("should return 201 on successful application", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand for JOB# item
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand for USER# item
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand for CHAT# item

      const event = {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({
          candidateId: "user-1",
          coverLetter: "I am interested",
        }),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.jobId).toBe("job-1");
      expect(body.candidateId).toBe("user-1");
      expect(body.status).toBe("PENDIENTE");
      expect(body.coverLetter).toBe("I am interested");
      expect(body.appliedAt).toBeDefined();
      expect(mockDynamoSend).toHaveBeenCalledTimes(3);
    });

    it("should return 201 with null coverLetter when not provided", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "user-1" }),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.coverLetter).toBeNull();
    });

    it("should return 409 on duplicate application (ConditionalCheckFailedException)", async () => {
      const condError = new Error("Condition not met");
      (condError as any).name = "ConditionalCheckFailedException";
      mockDynamoSend.mockRejectedValueOnce(condError);

      const event = {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "user-1" }),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toContain("Ya postulaste");
    });

    it("should return 500 on generic DynamoDB error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "user-1" }),
      } as any;

      const response = await applyToJob(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  // ─── getJobApplicants ────────────────────────────────────────────────

  describe("getJobApplicants", () => {
    it("should return 400 if job id path parameter is missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await getJobApplicants(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("id");
    });

    it("should return 200 with list of applicants", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "JOB#job-1",
            SK: "APP#user-1",
            candidateId: "user-1",
            jobId: "job-1",
            status: "PENDIENTE",
            coverLetter: "Hi",
            appliedAt: "2026-07-09T00:00:00.000Z",
          },
          {
            PK: "JOB#job-1",
            SK: "APP#user-2",
            candidateId: "user-2",
            jobId: "job-1",
            status: "REVISADO",
            coverLetter: null,
            appliedAt: "2026-07-09T01:00:00.000Z",
          },
        ],
      });

      const event = {
        pathParameters: { id: "job-1" },
      } as any;

      const response = await getJobApplicants(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(2);
      expect(body[0].candidateId).toBe("user-1");
      expect(body[1].status).toBe("REVISADO");
    });

    it("should return empty array when no applicants", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        pathParameters: { id: "job-1" },
      } as any;

      const response = await getJobApplicants(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it("should handle undefined Items from DynamoDB", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { id: "job-1" },
      } as any;

      const response = await getJobApplicants(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it("should return 500 on DynamoDB error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Query failed"));

      const event = {
        pathParameters: { id: "job-1" },
      } as any;

      const response = await getJobApplicants(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("Query failed");
    });
  });

  // ─── getMyApplications ──────────────────────────────────────────────

  describe("getMyApplications", () => {
    it("should return 400 if candidateId query parameter is missing", async () => {
      const event = {
        queryStringParameters: {},
      } as any;

      const response = await getMyApplications(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("candidateId");
    });

    it("should return 400 if queryStringParameters is null", async () => {
      const event = {
        queryStringParameters: null,
      } as any;

      const response = await getMyApplications(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 200 with list of applications for a candidate", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            SK: "APP#job-1",
            candidateId: "user-1",
            jobId: "job-1",
            status: "PENDIENTE",
            coverLetter: "Cover letter",
            appliedAt: "2026-07-09T00:00:00.000Z",
          },
        ],
      });

      const event = {
        queryStringParameters: { candidateId: "user-1" },
      } as any;

      const response = await getMyApplications(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].jobId).toBe("job-1");
    });

    it("should handle undefined Items from DynamoDB", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        queryStringParameters: { candidateId: "user-1" },
      } as any;

      const response = await getMyApplications(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it("should return 500 on DynamoDB error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        queryStringParameters: { candidateId: "user-1" },
      } as any;

      const response = await getMyApplications(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  // ─── updateApplicationStatus ─────────────────────────────────────────

  describe("updateApplicationStatus", () => {
    it("should return 400 if jobId path parameter is missing", async () => {
      const event = {
        pathParameters: { candidateId: "user-1" },
        body: JSON.stringify({ status: "REVISADO" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("jobId");
    });

    it("should return 400 if candidateId path parameter is missing", async () => {
      const event = {
        pathParameters: { jobId: "job-1" },
        body: JSON.stringify({ status: "REVISADO" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("candidateId");
    });

    it("should return 400 if both path parameters are missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ status: "REVISADO" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if status is missing", async () => {
      const event = {
        pathParameters: { jobId: "job-1", candidateId: "user-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Invalid status");
    });

    it("should return 400 if status is invalid", async () => {
      const event = {
        pathParameters: { jobId: "job-1", candidateId: "user-1" },
        body: JSON.stringify({ status: "INVALID_STATUS" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Invalid status");
    });

    it("should return 404 if application does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand returns null

      const event = {
        pathParameters: { jobId: "job-1", candidateId: "user-1" },
        body: JSON.stringify({ status: "REVISADO" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toContain("not found");
    });

    it("should return 200 and update both items on success", async () => {
      // GetCommand: application exists
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "JOB#job-1",
          SK: "APP#user-1",
          status: "PENDIENTE",
        },
      });
      // UpdateCommand for JOB# item
      mockDynamoSend.mockResolvedValueOnce({});
      // UpdateCommand for USER# item
      mockDynamoSend.mockResolvedValueOnce({});
      // GetCommand for candidate profile
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "candidate@example.com" },
      });
      // GetCommand for job details
      mockDynamoSend.mockResolvedValueOnce({
        Item: { titulo: "Software Engineer", company: "Company" },
      });

      const event = {
        pathParameters: { jobId: "job-1", candidateId: "user-1" },
        body: JSON.stringify({
          status: "ENTREVISTA",
          detallesEntrevista: "Lunes 10am",
        }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.jobId).toBe("job-1");
      expect(body.candidateId).toBe("user-1");
      expect(body.status).toBe("ENTREVISTA");
      expect(body.updatedAt).toBeDefined();
      expect(mockDynamoSend).toHaveBeenCalledTimes(5);
    });

    it.each(["PENDIENTE", "REVISADO", "ENTREVISTA", "ACEPTADO", "RECHAZADO"])(
      "should accept valid status '%s'",
      async (status) => {
        mockDynamoSend.mockResolvedValueOnce({
          Item: { PK: "JOB#job-1", SK: "APP#user-1" },
        });
        mockDynamoSend.mockResolvedValueOnce({});
        mockDynamoSend.mockResolvedValueOnce({});
        mockDynamoSend.mockResolvedValueOnce({
          Item: { email: "candidate@example.com" },
        });
        mockDynamoSend.mockResolvedValueOnce({
          Item: { titulo: "SDE", company: "Company" },
        });

        const event = {
          pathParameters: { jobId: "job-1", candidateId: "user-1" },
          body: JSON.stringify({ status }),
        } as any;

        const response = await updateApplicationStatus(
          event,
          {} as any,
          () => {},
        );
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).status).toBe(status);
      },
    );

    it("should return 500 on DynamoDB error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { jobId: "job-1", candidateId: "user-1" },
        body: JSON.stringify({ status: "REVISADO" }),
      } as any;

      const response = await updateApplicationStatus(
        event,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });
});
