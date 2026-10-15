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
      const res = await getJobApplicants(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
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
});
