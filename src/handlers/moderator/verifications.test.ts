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

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {},
  PostToConnectionCommand: class {},
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
  ScanCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
}));

import { getVerificationRequests, resolveVerification } from "./verifications";

describe("moderator verifications handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
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
          },
        ],
      });

      const response = await getVerificationRequests({} as any, {} as any, () => {});
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
      expect(res[1].companyName).toBe("Sin Nombre");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getVerificationRequests({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveVerification", () => {
    it("should return 400 if companyId is missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if approve is missing", async () => {
      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 404 if company profile is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });

      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
    });

    it("should return 400 if approving an organization whose estadoCuenta is not Activa/ACTIVO", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#comp-1",
          SK: "PROFILE",
          estadoCuenta: "SUSPENDIDA",
        },
      });

      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Solo se puede verificar");
    });

    it("should approve verification successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#comp-1",
          SK: "PROFILE",
          nombre: "Corp",
          estadoCuenta: "ACTIVO",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.estatusVerificacion).toBe("Verificada");
      expect(res.organizacionVerificada).toBe(true);
    });

    it("should reject verification successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#comp-1",
          SK: "PROFILE",
          nombre: "Corp",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({ approve: false }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.estatusVerificacion).toBe("Rechazada");
      expect(res.organizacionVerificada).toBe(false);
    });

    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { companyId: "comp-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveVerification(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });
});
