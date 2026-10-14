import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
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
}));

import { getProfile, updateProfile, listProfiles } from "./userProfile";

describe("user profile handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getProfile", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getProfile(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 404 if profile not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null });
      const res = await getProfile(
        { pathParameters: { id: "u-999" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("should return enriched profile on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#u-1",
          SK: "PROFILE",
          nombre: "Alice",
          tipoUsuario: "CANDIDATO",
        },
      });

      const res = await getProfile(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.nombre).toBe("Alice");
      expect(data.completenessPercentage).toBeDefined();
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Profile DB error"));
      const res = await getProfile(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("updateProfile", () => {
    it("should return 400 if id is missing", async () => {
      const res = await updateProfile(
        { pathParameters: {} } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(400);
    });

    it("should return 403 if caller is not owner and not privileged", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "USER#u-1", SK: "PROFILE" },
      });

      const event = {
        pathParameters: { id: "u-1" },
        headers: { "x-user-id": "hacker-user", "x-user-role": "CANDIDATE" },
        body: JSON.stringify({ nombre: "Hacked" }),
      } as any;

      const res = await updateProfile(event, {} as any, () => {});
      expect(res.statusCode).toBe(403);
    });

    it("should return 400 if duplicate verification request in progress", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#u-1",
          estatusVerificacion: "En revisión",
        },
      });

      const event = {
        pathParameters: { id: "u-1" },
        headers: { "x-user-id": "u-1" },
        body: JSON.stringify({ estatusVerificacion: "En revisión" }),
      } as any;

      const res = await updateProfile(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should update profile successfully and strip privileged fields if unprivileged", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "USER#u-1",
          SK: "PROFILE",
          tipoUsuario: "CANDIDATO",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { id: "u-1" },
        headers: { "x-user-id": "u-1" },
        body: JSON.stringify({
          nombre: "Alice Smith",
          tipoUsuario: "ADMIN", // Should be stripped
          estadoCuenta: "ACTIVO",
        }),
      } as any;

      const res = await updateProfile(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.nombre).toBe("Alice Smith");
      expect(data.tipoUsuario).toBe("CANDIDATO"); // Stripped back to baseItem
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Update error"));
      const res = await updateProfile(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("listProfiles", () => {
    it("should list and filter profiles by role and query text", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#u-1",
            nombre: "Acme Corp",
            sector: "Tecnología",
          },
          {
            PK: "USER#u-2",
            nombre: "Beta Inc",
            sector: "Educación",
          },
        ],
      });

      const event = {
        queryStringParameters: { tipoUsuario: "EMPRESA", q: "Acme" },
      } as any;

      const res = await listProfiles(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body);
      expect(list).toHaveLength(1);
      expect(list[0].nombre).toBe("Acme Corp");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("List error"));
      const res = await listProfiles({} as any, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });
});
