import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  moderateTextWithAi,
  moderateImageWithAi,
  moderateDocumentWithAi,
} from "./geminiModeration";

describe("Gemini Multimodal Moderation Service (Nivel 1)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, GEMINI_API_KEY: "test-fake-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Environment without API Key", () => {
    it("should return safe default when GEMINI_API_KEY is not defined", async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_AI_KEY;

      const result = await moderateTextWithAi("Cualquier texto");
      expect(result.safe).toBe(true);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("Text Moderation with AI", () => {
    it("should approve clean professional text", async () => {
      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: true,
                    confidence: 0.98,
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

      const result = await moderateTextWithAi("Buscamos Ingeniero Cloud para Toluca.", "VACANCY");
      expect(result.safe).toBe(true);
      expect(result.flaggedCategories).toHaveLength(0);
    });

    it("should detect discriminatory vacancy requirements (e.g. age or gender limitations)", async () => {
      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: false,
                    confidence: 0.95,
                    flaggedCategories: ["DISCRIMINATION"],
                    reason:
                      "La vacante restringe candidatos por edad y género de forma injustificada.",
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
        "Solo mujeres menores de 25 años con buena presentación",
        "VACANCY",
      );
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("DISCRIMINATION");
      expect(result.reason).toContain("restringe");
    });

    it("should handle API failure gracefully without crashing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Quota exceeded",
      } as any);

      const result = await moderateTextWithAi("Texto de prueba");
      expect(result.safe).toBe(true);
    });
  });

  describe("Image Moderation with AI", () => {
    it("should evaluate image and detect NSFW or violence violations", async () => {
      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: false,
                    confidence: 0.99,
                    flaggedCategories: ["NSFW"],
                    reason: "Contenido explícito no apto para entorno profesional.",
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

      const mockBuffer = Buffer.from("fake-image-bytes");
      const result = await moderateImageWithAi(mockBuffer, "image/jpeg");
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("NSFW");
    });
  });

  describe("Document PDF Moderation with AI", () => {
    it("should evaluate extracted text when provided", async () => {
      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: true,
                    confidence: 0.95,
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

      const result = await moderateDocumentWithAi(
        "dummy-base64",
        "Experiencia laboral: Desarrollador en Google durante 3 años.",
      );
      expect(result.safe).toBe(true);
    });

    it("should evaluate raw PDF binary via inlineData when no text is extracted", async () => {
      const mockApiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    safe: false,
                    confidence: 0.92,
                    flaggedCategories: ["SCAM"],
                    reason: "El PDF contiene enlaces de phishing.",
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

      const mockPdfBuffer = Buffer.from("%PDF-1.4 fake pdf data");
      const result = await moderateDocumentWithAi(mockPdfBuffer);
      expect(result.safe).toBe(false);
      expect(result.flaggedCategories).toContain("SCAM");
    });
  });
});
