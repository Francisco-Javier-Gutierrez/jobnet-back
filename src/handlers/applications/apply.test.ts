import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSESSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockSESSend: vi.fn().mockResolvedValue({}),
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
  PutCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
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

  it("should return 400 if vacancy is paused by organization", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { estado: "PAUSADA" },
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
    expect(JSON.parse(res.body).error).toContain(
      "pausada temporalmente por la organización",
    );
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

  it("should return 400 if required screening questions are missing or incomplete", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        estado: "Activa",
        preguntasFiltro: [
          "¿Tienes al menos 3 años en desarrollo web?",
          "¿Cuentas con disponibilidad para viajar a Toluca?",
        ],
      },
    });

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({
          candidateId: "cand-1",
          coverLetter: "Postulándome...",
          // Sin respuestasFiltro
        }),
      } as any,
      {} as any,
      () => {},
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      "preguntas filtro de precalificación",
    );
  });

  it("should succeed when answering all required screening questions", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        estado: "Activa",
        preguntasFiltro: [
          "¿Tienes al menos 3 años en desarrollo web?",
        ],
      },
    });
    mockDynamoSend.mockResolvedValueOnce({}); // Put employer view
    mockDynamoSend.mockResolvedValueOnce({}); // Put candidate view
    mockDynamoSend.mockResolvedValueOnce({}); // Put chat initial message

    const res = await applyToJob(
      {
        pathParameters: { id: "job-1" },
        body: JSON.stringify({
          candidateId: "cand-1",
          coverLetter: "Postulándome...",
          respuestasFiltro: [
            {
              pregunta: "¿Tienes al menos 3 años en desarrollo web?",
              respuesta: "Sí, cuento con 4 años de experiencia comprobable.",
            },
          ],
        }),
      } as any,
      {} as any,
      () => {},
    );

    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.respuestasFiltro).toBeDefined();
    expect(data.respuestasFiltro[0].respuesta).toBe(
      "Sí, cuento con 4 años de experiencia comprobable.",
    );
  });

  it("should dispatch high demand push and SES email when vacancy reaches exactly 50 applicants", async () => {
    // 1. GetCommand vacancy
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        estado: "Activa",
        titulo: "Senior Cloud Engineer",
        empresaUuid: "company-123",
        emailContacto: "hr@company.com",
        alertaAltaDemandaEnviada: false,
      },
    });
    // 2. Put employer-view
    mockDynamoSend.mockResolvedValueOnce({});
    // 3. Put candidate-view
    mockDynamoSend.mockResolvedValueOnce({});
    // 4. Put chat initial message
    mockDynamoSend.mockResolvedValueOnce({});
    // 5. Query applicants count: returns 50
    mockDynamoSend.mockResolvedValueOnce({
      Count: 50,
      Items: new Array(50).fill({ candidateId: "c" }),
    });
    // 6. UpdateCommand to set alertaAltaDemandaEnviada = true
    mockDynamoSend.mockResolvedValueOnce({});

    const { createUserNotification } = await import("../../utils/webPushService");

    const res = await applyToJob(
      {
        pathParameters: { id: "job-50" },
        body: JSON.stringify({ candidateId: "cand-50" }),
      } as any,
      {} as any,
      () => {},
    );

    expect(res.statusCode).toBe(201);
    // Verified push notification for high demand
    expect(createUserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "company-123",
        type: "high_demand",
        title: "Alta demanda de postulaciones",
      }),
    );
    // Verified SES email dispatch
    expect(mockSESSend).toHaveBeenCalledTimes(1);
  });

  it("should not re-dispatch high demand alert if already sent", async () => {
    // 1. GetCommand vacancy with alertaAltaDemandaEnviada = true
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        estado: "Activa",
        titulo: "Senior Cloud Engineer",
        empresaUuid: "company-123",
        emailContacto: "hr@company.com",
        alertaAltaDemandaEnviada: true,
      },
    });
    // 2. Put employer-view
    mockDynamoSend.mockResolvedValueOnce({});
    // 3. Put candidate-view
    mockDynamoSend.mockResolvedValueOnce({});
    // 4. Put chat initial message
    mockDynamoSend.mockResolvedValueOnce({});
    // 5. Query applicants count returns 50
    mockDynamoSend.mockResolvedValueOnce({
      Count: 50,
      Items: new Array(50).fill({ candidateId: "c" }),
    });

    const res = await applyToJob(
      {
        pathParameters: { id: "job-50" },
        body: JSON.stringify({ candidateId: "cand-50" }),
      } as any,
      {} as any,
      () => {},
    );

    expect(res.statusCode).toBe(201);
    expect(mockSESSend).not.toHaveBeenCalled();
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
