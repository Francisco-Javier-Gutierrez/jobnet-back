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
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import {
  getSuggestedSkills,
  createSkillSuggestion,
  resolveSkillSuggestion,
  getLevenshteinDistance,
} from "./skills";

describe("moderator skills handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getLevenshteinDistance", () => {
    it("should calculate correct edit distances", () => {
      expect(getLevenshteinDistance("react", "react")).toBe(0);
      expect(getLevenshteinDistance("react", "reactjs")).toBe(2);
      expect(getLevenshteinDistance("kitten", "sitting")).toBe(3);
    });
  });

  describe("getSuggestedSkills", () => {
    it("should return suggested skills on success and match duplicate catalog items", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "SUGGESTION#SKILL#skill-1",
            SK: "METADATA",
            name: "React Native",
            category: "Habilidad",
            fechaCreacion: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "SUGGESTION#SECTOR#sector-1",
            SK: "METADATA",
            name: "Fintech",
            category: "Sector",
          },
        ],
      });

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "CATALOG#cat-1",
            name: "React",
            category: "Habilidad",
          },
          {
            PK: "CATALOG#cat-2",
            name: "Fintech",
            category: "Sector",
          },
        ],
      });

      const response = await getSuggestedSkills(
        { queryStringParameters: { category: "Habilidad" } } as any,
        {} as any,
        () => {},
      );
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(1);
      expect(res[0].name).toBe("React Native");
      expect(res[0].category).toBe("Habilidad");
    });

    it("should return 500 on database error during get", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getSuggestedSkills({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("createSkillSuggestion", () => {
    it("should return 400 if name is missing", async () => {
      const event = { body: JSON.stringify({}) } as any;
      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should create skill suggestion successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        body: JSON.stringify({ name: "Kubernetes", category: "Habilidad" }),
      } as any;

      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.name).toBe("Kubernetes");
      expect(res.category).toBe("Habilidad");
    });

    it("should return 500 on database error during create", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        body: JSON.stringify({ name: "Kubernetes" }),
      } as any;

      const response = await createSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveSkillSuggestion", () => {
    it("should return 400 if id is missing", async () => {
      const event = { pathParameters: {} } as any;
      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if approve is missing", async () => {
      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({}),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 404 if suggestion is not found", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Skill check
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Sector check

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
    });

    it("should approve skill without duplicate and add brand new catalog item", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "SUGGESTION#SKILL#skill-1",
          SK: "METADATA",
          name: "Golang",
          category: "Habilidad",
        },
      }); // GetCommand suggestion
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // exactCheck QueryCommand
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand catalog
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand suggestion

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.action).toBe("APPROVED");
    });

    it("should approve skill suggestion with unifyMode REPLACE_EXISTING", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "SUGGESTION#SKILL#skill-1", name: "ReactJS", category: "Habilidad" },
      }); // Suggestion lookup
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "CATALOG#cat-1", name: "React" }],
      }); // Catalog lookup
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand catalog
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand suggestion

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({
          approve: true,
          unifyWith: "React",
          unifyMode: "REPLACE_EXISTING",
        }),
      } as any;

      const res = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("APPROVED");
    });

    it("should approve skill suggestion with unifyMode KEEP_EXISTING", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "SUGGESTION#SKILL#skill-1", name: "ReactJS", category: "Habilidad" },
      }); // Suggestion lookup
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand suggestion

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({
          approve: true,
          unifyWith: "React",
          unifyMode: "KEEP_EXISTING",
        }),
      } as any;

      const res = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("APPROVED");
    });

    it("should reject suggested skill successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "SUGGESTION#SKILL#skill-1",
          SK: "METADATA",
          name: "Golang",
          category: "Habilidad",
        },
      }); // GetCommand suggestion
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: false }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.action).toBe("REJECTED");
    });

    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { id: "skill-1" },
        body: JSON.stringify({ approve: true }),
      } as any;

      const response = await resolveSkillSuggestion(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });
});
