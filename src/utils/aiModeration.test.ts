import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { moderateTextWithAi, moderateImageWithAi, moderateDocumentWithAi } from "./aiModeration";
import { getAiProvider, getAiModel, getAiApiKey, getAiApiUrl } from "./aiConfig";

describe("AI Multimodal Moderation Service (JobNet)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Configuration & Environment Variables", () => {
    it("should resolve default provider and models correctly", () => {
      delete process.env.AI_PROVIDER;
      delete process.env.AI_MODERATION_PROVIDER;
      delete process.env.AI_REASONING_PROVIDER;
      delete process.env.GEMINI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      expect(getAiProvider("moderation")).toBe("deepseek");
      expect(getAiProvider("reasoning")).toBe("deepseek");
      expect(getAiModel("moderation")).toBe("deepseek-chat");
      expect(getAiModel("reasoning")).toBe("deepseek-chat");
    });

    it("should allow distinct model separation for moderation vs reasoning ATS", () => {
      process.env.AI_MODERATION_MODEL = "deepseek-chat";
      process.env.AI_REASONING_MODEL = "deepseek-reasoner";

      expect(getAiModel("moderation")).toBe("deepseek-chat");
      expect(getAiModel("reasoning")).toBe("deepseek-reasoner");
    });

    it("should allow provider switching to gemini via AI_MODERATION_PROVIDER", () => {
      process.env.AI_MODERATION_PROVIDER = "gemini";
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GEMINI_MODERATION_MODEL = "gemini-2.0-flash";

      expect(getAiProvider("moderation")).toBe("gemini");
      expect(getAiModel("moderation")).toBe("gemini-2.0-flash");
      expect(getAiApiKey("moderation")).toBe("test-gemini-key");
    });

    it("should return safe default when no API keys are configured", async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_AI_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODERATION_API_KEY;

      const result = await moderateTextWithAi("Cualquier texto profesional");
      expect(result.safe).toBe(true);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("Text Moderation with DeepSeek / OpenAI provider", () => {
    it("should approve clean professional text with DeepSeek", async () => {
      process.env.AI_MODERATION_PROVIDER = "deepseek";
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: true,
                confidence: 0.98,
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

      const result = await moderateTextWithAi(
        "Buscamos Desarrollador FullStack en CDMX.",
        "VACANCY",
      );
      expect(result.safe).toBe(true);
      expect(result.flaggedCategories).toHaveLength(0);
    });

    it("should flag discriminatory content in comments", async () => {
      process.env.AI_MODERATION_PROVIDER = "deepseek";
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                confidence: 0.95,
                flaggedCategories: ["DISCRIMINATION", "HATE_SPEECH"],
                reason: "El comentario incluye lenguaje denigrante y discriminatorio.",
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateTextWithAi("Comentario ofensivo", "COMMENT");
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("DISCRIMINATION");
      expect(result.reason).toContain("discriminatorio");
    });
  });

  describe("Text Moderation with Gemini provider", () => {
    it("should approve clean text with Gemini provider", async () => {
      process.env.AI_MODERATION_PROVIDER = "gemini";
      process.env.GEMINI_API_KEY = "test-gemini-key";

      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: true,
                    confidence: 0.99,
                    flaggedCategories: [],
                    reason: null,
                  }),
                },
              ],
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const result = await moderateTextWithAi(
        "Excelente oportunidad laboral para frontend.",
        "POST",
      );
      expect(result.safe).toBe(true);
      expect(result.flaggedCategories).toHaveLength(0);
    });
  });

  describe("Transparent Fallback between providers", () => {
    it("should fallback to Gemini when DeepSeek fails", async () => {
      process.env.AI_MODERATION_PROVIDER = "deepseek";
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
      process.env.GEMINI_API_KEY = "test-gemini-key";

      // 1. DeepSeek fails (500)
      vi.spyOn(global, "fetch")
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "DeepSeek Service Unavailable",
        } as any)
        // 2. Gemini fallback succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        safe: true,
                        confidence: 0.94,
                        flaggedCategories: [],
                        reason: null,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        } as any);

      const result = await moderateTextWithAi("Texto moderado con fallback a Gemini");
      expect(result.safe).toBe(true);
    });
  });

  describe("Image Moderation with AI", () => {
    it("should detect inappropriate images with configured provider", async () => {
      process.env.AI_MODERATION_PROVIDER = "deepseek";
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                confidence: 0.99,
                flaggedCategories: ["NSFW"],
                reason: "Contenido explícito no apto para entorno profesional.",
              }),
            },
          },
        ],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockApiResponse,
      } as any);

      const mockBuffer = Buffer.from("fake-image-bytes");
      const result = await moderateImageWithAi(mockBuffer, "image/png");
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("NSFW");
    });
  });

  describe("Document PDF Moderation with AI", () => {
    it("should evaluate document text when provided", async () => {
      process.env.AI_MODERATION_PROVIDER = "deepseek";
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: true,
                confidence: 0.95,
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

      const result = await moderateDocumentWithAi(
        "dummy-pdf",
        "CV de Ingeniero de Software con 5 años de experiencia.",
      );
      expect(result.safe).toBe(true);
    });
  });
});
