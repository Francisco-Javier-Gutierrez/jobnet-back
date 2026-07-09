import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIGatewayProxyEvent } from "aws-lambda";

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
  ScanCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getCatalog,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} from "./catalog";

describe("catalog handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCatalog", () => {
    it("should return items correctly on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "CATALOG#1",
            SK: "CATALOG",
            name: "React",
            category: "Habilidad",
            createdAt: "2026-07-09T00:00:00.000Z",
          },
        ],
      });

      const response = await getCatalog({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("React");
    });

    it("should return 500 on DynamoDB error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Dynamo error"));
      const response = await getCatalog({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("Dynamo error");
    });
  });

  describe("createCatalogItem", () => {
    it("should return 400 if name or category is missing", async () => {
      const event = {
        body: JSON.stringify({ name: "" }),
      } as APIGatewayProxyEvent;

      const response = await createCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if item already exists as duplicate", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "CATALOG#1" }],
      });

      const event = {
        body: JSON.stringify({ name: "React", category: "Habilidad" }),
      } as APIGatewayProxyEvent;

      const response = await createCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Ya existe");
    });

    it("should return 201 on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // duplicate check empty
      mockDynamoSend.mockResolvedValueOnce({}); // put success

      const event = {
        body: JSON.stringify({ name: "React", category: "Habilidad", id: "react-1" }),
      } as APIGatewayProxyEvent;

      const response = await createCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe("react-1");
      expect(body.name).toBe("React");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        body: JSON.stringify({ name: "React", category: "Habilidad" }),
      } as APIGatewayProxyEvent;

      const response = await createCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });

  describe("updateCatalogItem", () => {
    it("should return 400 if id path parameter is missing", async () => {
      const event = {
        pathParameters: {},
        body: JSON.stringify({ name: "Vue" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if name is missing in body", async () => {
      const event = {
        pathParameters: { id: "1" },
        body: JSON.stringify({ name: "" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 404 if item does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // GetCommand returns null

      const event = {
        pathParameters: { id: "not-found" },
        body: JSON.stringify({ name: "Vue" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
    });

    it("should return 400 if updating to a duplicate name in same category", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "CATALOG#1",
          SK: "CATALOG",
          name: "React",
          category: "Habilidad",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "CATALOG#2" }], // duplicate exists with other PK
      });

      const event = {
        pathParameters: { id: "1" },
        body: JSON.stringify({ name: "Vue" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Ya existe");
    });

    it("should return 200 on successful update", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "CATALOG#1",
          SK: "CATALOG",
          name: "React",
          category: "Habilidad",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // no duplicate
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand success

      const event = {
        pathParameters: { id: "1" },
        body: JSON.stringify({ name: "Vue" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe("Vue");
    });

    it("should return 500 on server error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        pathParameters: { id: "1" },
        body: JSON.stringify({ name: "Vue" }),
      } as any;

      const response = await updateCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });

  describe("deleteCatalogItem", () => {
    it("should return 400 if id parameter is missing", async () => {
      const event = {
        pathParameters: {},
      } as any;

      const response = await deleteCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 200 on successful deletion", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        pathParameters: { id: "1" },
      } as any;

      const response = await deleteCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const event = {
        pathParameters: { id: "1" },
      } as any;

      const response = await deleteCatalogItem(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
    });
  });
});
