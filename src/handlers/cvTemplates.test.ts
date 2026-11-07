import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCvTemplates, createCvTemplate, deleteCvTemplate, useCvTemplate } from "./cvTemplates";
import { docClient } from "./profile/common";

vi.mock("./profile/common", () => ({
  docClient: {
    send: vi.fn(),
  },
  tableName: "jobnet-jobs-prod",
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
}));

describe("Community CV Templates Backend Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCvTemplates", () => {
    it("should return templates sorted by usesCount and filtered by idioma", async () => {
      const mockItems = [
        {
          PK: "CV_TEMPLATE#1",
          templateId: "1",
          titulo: "Frontend React Developer",
          rol: "Frontend Developer",
          categoria: "frontend",
          idioma: "en",
          stats: { usesCount: 50 },
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          PK: "CV_TEMPLATE#2",
          templateId: "2",
          titulo: "Ingeniero Backend Java",
          rol: "Backend Developer",
          categoria: "backend",
          idioma: "es",
          stats: { usesCount: 120 },
          createdAt: "2026-01-02T00:00:00Z",
        },
      ];

      (docClient.send as any).mockResolvedValueOnce({ Items: mockItems });

      const event: any = {
        queryStringParameters: { idioma: "es" },
      };

      const result = (await getCvTemplates(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);
      expect(data.count).toBe(1);
      expect(data.templates[0].templateId).toBe("2");
    });
  });

  describe("createCvTemplate", () => {
    it("should return 401 if x-user-id header is missing", async () => {
      const event: any = {
        headers: {},
        body: JSON.stringify({ titulo: "Test", rol: "Dev", categoria: "tech" }),
      };

      const result = (await createCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(401);
    });

    it("should return 400 if required fields are missing", async () => {
      const event: any = {
        headers: { "x-user-id": "user-123" },
        body: JSON.stringify({ titulo: "Only Title" }),
      };

      const result = (await createCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(400);
    });

    it("should successfully create a new community template with default values", async () => {
      (docClient.send as any).mockResolvedValueOnce({});

      const event: any = {
        headers: { "x-user-id": "user-123" },
        body: JSON.stringify({
          titulo: "Desarrollador Junior Toluca",
          rol: "Frontend Trainee",
          categoria: "frontend",
          idioma: "es",
          habilidades: ["HTML", "CSS", "JavaScript"],
          biografiaSugerida: "Egresado entusiasta",
        }),
      };

      const result = (await createCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(201);
      const data = JSON.parse(result.body);
      expect(data.PK).toMatch(/^CV_TEMPLATE#/);
      expect(data.GSI1PK).toBe("CV_TEMPLATES#COMMUNITY");
      expect(data.idioma).toBe("es");
      expect(data.alcance).toBe("SUR_EDOMEX");
      expect(data.autorId).toBe("user-123");
      expect(data.stats.usesCount).toBe(0);
    });
  });

  describe("deleteCvTemplate", () => {
    it("should prevent non-owners and non-admins from deleting templates", async () => {
      (docClient.send as any).mockResolvedValueOnce({
        Item: {
          PK: "CV_TEMPLATE#1",
          SK: "METADATA#1",
          autorId: "owner-999",
        },
      });

      const event: any = {
        pathParameters: { id: "1" },
        headers: { "x-user-id": "hacker-123" },
      };

      const result = (await deleteCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(403);
    });

    it("should allow owners to delete their template", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: {
            PK: "CV_TEMPLATE#1",
            SK: "METADATA#1",
            autorId: "owner-123",
          },
        })
        .mockResolvedValueOnce({});

      const event: any = {
        pathParameters: { id: "1" },
        headers: { "x-user-id": "owner-123" },
      };

      const result = (await deleteCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);
      expect(data.success).toBe(true);
    });
  });

  describe("useCvTemplate", () => {
    it("should increment usesCount on template usage", async () => {
      (docClient.send as any).mockResolvedValueOnce({
        Attributes: {
          stats: { usesCount: 42 },
        },
      });

      const event: any = {
        pathParameters: { id: "template-abc" },
      };

      const result = (await useCvTemplate(event, {} as any, () => {})) as any;
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);
      expect(data.usesCount).toBe(42);
      expect(data.templateId).toBe("template-abc");
    });
  });
});
