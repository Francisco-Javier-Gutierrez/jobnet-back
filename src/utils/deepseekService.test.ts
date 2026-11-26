import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  moderateTextWithDeepSeek,
  moderateImageWithDeepSeek,
  moderateDocumentWithDeepSeek,
  rankCandidatesForVacancyWithDeepSeek,
  DEFAULT_DEEPSEEK_API_KEY,
} from "./deepseekService";

describe("DeepSeek AI Service - Moderation & ATS Ranking", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: "test-fake-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Text Moderation with DeepSeek", () => {
    it("should approve clean professional text", async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: true,
                confidence: 0.99,
                flaggedCategories: [],
                reason: null,
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateTextWithDeepSeek(
        "Buscamos Ingeniero Cloud Senior para entorno AWS.",
        "VACANCY",
      );
      expect(result.safe).toBe(true);
      expect(result.flaggedCategories).toHaveLength(0);
      expect(result.reason).toBeNull();
    });

    it("should flag discriminatory criteria in job vacancy", async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                confidence: 0.98,
                flaggedCategories: ["DISCRIMINATION"],
                reason: "La vacante contiene restricciones discriminatorias por edad y género.",
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateTextWithDeepSeek(
        "Solo mujeres menores de 25 años con excelente presentación.",
        "VACANCY",
      );
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("DISCRIMINATION");
      expect(result.reason).toContain("discriminatorias");
    });

    it("should flag job scam requiring upfront investment", async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                confidence: 0.97,
                flaggedCategories: ["SCAM"],
                reason: "La oferta exige depósito de dinero previo al candidato.",
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateTextWithDeepSeek(
        "Gana $50,000 semanales invirtiendo $500 de depósito previo para papelería.",
        "VACANCY",
      );
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("SCAM");
    });

    it("should handle API failure gracefully without crashing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const result = await moderateTextWithDeepSeek("Texto de prueba");
      expect(result.safe).toBe(true);
      expect(result.confidence).toBe(0.5);
    });
  });

  describe("Image Moderation with DeepSeek", () => {
    it("should evaluate image and approve safe content", async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: true,
                confidence: 0.96,
                flaggedCategories: [],
                reason: null,
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateImageWithDeepSeek(Buffer.from("fake-img"), "image/png");
      expect(result.safe).toBe(true);
      expect(result.flaggedCategories).toHaveLength(0);
    });

    it("should detect inappropriate image content", async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                confidence: 0.99,
                flaggedCategories: ["NSFW"],
                reason: "Contenido explícito para adultos no permitido.",
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateImageWithDeepSeek("data:image/jpeg;base64,1234");
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("NSFW");
    });
  });

  describe("ATS Candidate Ranking with DeepSeek", () => {
    it("should return empty ranking when candidate list is empty", async () => {
      const result = await rankCandidatesForVacancyWithDeepSeek(
        { id: "v1", title: "Dev", description: "Desc" },
        [],
      );
      expect(result.totalEvaluated).toBe(0);
      expect(result.ranking).toHaveLength(0);
    });

    it("should generate sorted candidate ranking with percentages, tiers and justifications", async () => {
      const mockRankingResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Pool de candidatos con alto nivel técnico.",
                ranking: [
                  {
                    candidateId: "c1",
                    name: "Carlos Gómez",
                    titularProfesional: "Senior Full Stack",
                    matchPercentage: 94,
                    tier: "TOP_MATCH",
                    strengths: ["AWS", "Node.js", "TypeScript"],
                    gaps: [],
                    justification:
                      "Cuenta con más de 5 años dominando el stack exacto de la vacante.",
                  },
                  {
                    candidateId: "c2",
                    name: "Laura R.",
                    titularProfesional: "Junior Dev",
                    matchPercentage: 62,
                    tier: "AJUSTE_MODERADO",
                    strengths: ["JavaScript básico"],
                    gaps: ["Falta experiencia en nube"],
                    justification:
                      "Posee bases pero carece de la experiencia senior en AWS requerida.",
                  },
                ],
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockRankingResponse,
      } as any);

      const result = await rankCandidatesForVacancyWithDeepSeek(
        {
          id: "job-101",
          title: "Senior Full Stack AWS",
          description: "Desarrollo de microservicios en Node y Vue.",
          skills: ["AWS", "Node.js", "TypeScript", "Vue"],
        },
        [
          {
            candidateId: "c1",
            name: "Carlos Gómez",
            skills: ["AWS", "Node.js", "TypeScript"],
          },
          {
            candidateId: "c2",
            name: "Laura R.",
            skills: ["JavaScript"],
          },
        ],
      );

      expect(result.jobId).toBe("job-101");
      expect(result.totalEvaluated).toBe(2);
      expect(result.ranking[0].candidateId).toBe("c1");
      expect(result.ranking[0].matchPercentage).toBe(94);
      expect(result.ranking[0].tier).toBe("TOP_MATCH");
      expect(result.ranking[0].tierLabel).toBe("Top Match");
      expect(result.ranking[0].justification).toContain("5 años");

      expect(result.ranking[1].candidateId).toBe("c2");
      expect(result.ranking[1].matchPercentage).toBe(62);
      expect(result.ranking[1].tier).toBe("AJUSTE_MODERADO");
    });
  });
});
