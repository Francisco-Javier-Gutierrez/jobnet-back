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
  SESClient: class {},
  SendEmailCommand: class {},
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
  PutCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import { applyToJob } from "./apply";

describe("applications apply handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  it("should return 400 if id or candidateId is missing", async () => {
    const res1 = await applyToJob({ pathParameters: {} } as any, {} as any, () => {});
    expect(res1.statusCode).toBe(400);

    const res2 = await applyToJob(
      { pathParameters: { id: "job-1" }, body: JSON.stringify({}) } as any,
      {} as any,
      () => {},
    );
    expect(res2.statusCode).toBe(400);
  });

  it("should return 400 if vacancy is closed", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { estado: "CERRADA" },
    });

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "cand-1" }),
      } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("cerrada a nuevas postulaciones");
  });

  it("should return 400 if maxPostulantes limit is reached", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { estado: "Activa", maxPostulantes: 2 },
    }); // GetCommand vacancy
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ candidateId: "c1" }, { candidateId: "c2" }],
    }); // Query applicants count

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "cand-3" }),
      } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("límite máximo de postulantes");
  });

  it("should apply to job successfully creating bidirectional records and chat message", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { estado: "Activa", maxPostulantes: 5 },
    }); // GetCommand vacancy
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query applicants
    mockDynamoSend.mockResolvedValueOnce({}); // Put employer view
    mockDynamoSend.mockResolvedValueOnce({}); // Put candidate view
    mockDynamoSend.mockResolvedValueOnce({}); // Put chat initial message

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({
          candidateId: "cand-1",
          coverLetter: "Interested in the position",
        }),
      } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.jobId).toBe("job-1");
    expect(data.status).toBe("PENDIENTE");
  });

  it("should return 409 if candidate already applied", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { estado: "Activa" } });
    const condError = new Error("Condition failed");
    (condError as any).name = "ConditionalCheckFailedException";
    mockDynamoSend.mockRejectedValueOnce(condError);

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "cand-1" }),
      } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("Ya postulaste");
  });

  it("should return 500 on unexpected database error", async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error("Apply error"));

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({ candidateId: "cand-1" }),
      } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(500);
  });
});
