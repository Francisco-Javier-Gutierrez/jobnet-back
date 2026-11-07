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

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  ScanCommand: class {
    constructor(public params: any) {}
  },
}));

import { joinAppeal, getAppeals } from "./appeals";

describe("moderator appeals handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("joinAppeal", () => {
    it("should return 400 if companyId is missing", async () => {
      const res = await joinAppeal({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should mark apelacionIniciada = true on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const res = await joinAppeal(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.companyId).toBe("comp-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Join DB error"));
      const res = await joinAppeal(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getAppeals", () => {
    it("should return combined list of org and vacancy appeals", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#comp-1",
            nombreComercial: "Acme Corp",
            suspensionReason: "Sospecha",
            estatus: "En revisión",
          },
        ],
      }); // Query orgs

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-1",
            titulo: "Suspended Vacancy",
            estado: "EVALUACION",
            empresaUuid: "comp-1",
          },
        ],
      }); // Scan vacancies

      const res = await getAppeals({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const appeals = JSON.parse(res.body);
      expect(appeals).toHaveLength(2);
      expect(appeals[0].type).toBe("ORGANIZACION");
      expect(appeals[0].companyId).toBe("comp-1");
      expect(appeals[1].type).toBe("VACANTE");
      expect(appeals[1].jobId).toBe("job-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Appeals DB error"));
      const res = await getAppeals({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });
});
