import { describe, it, expect } from "vitest";
import { evaluatePreAi } from "./preAiFilter";
import { normalizeForModeration } from "./textNormalizer";

describe("Pre-AI Filtering Engine (Nivel 0 - Costo $0.00)", () => {
  describe("Text Normalization and De-Leetspeak", () => {
    it("should resolve leetspeak numbers and symbols to letters", () => {
      const res = normalizeForModeration("p3nd3j0 y v3rg@");
      expect(res.normalized).toContain("pendejo");
      expect(res.normalized).toContain("verga");
    });

    it("should collapse exaggerated repeated characters", () => {
      const res = normalizeForModeration("peeeendeeejooo");
      expect(res.normalized).toBe("pendejo");
    });

    it("should normalize cyrillic homoglyphs", () => {
      // р en cirílico (U+0440) sustituido por p latina
      const res = normalizeForModeration("\u0440endejo");
      expect(res.normalized).toBe("pendejo");
    });

    it("should preserve ñ while stripping accents", () => {
      const res = normalizeForModeration("Año de experiencia en programación");
      expect(res.normalized).toContain("año");
      expect(res.normalized).toContain("programacion");
    });
  });

  describe("Clean content verification (False Positive Prevention)", () => {
    it("should allow legitimate professional job posts", () => {
      const vacancy =
        "Buscamos Desarrollador Fullstack con 3 años de experiencia en Vue.js y Node.js. Excelente ambiente laboral y prestaciones de ley.";
      const res = evaluatePreAi(vacancy);
      expect(res.isClean).toBe(true);
      expect(res.matches).toHaveLength(0);
      expect(res.explanation).toBeUndefined();
    });

    it("should NOT flag words that contain profanities as substrings (e.g. computadora, salvar, asistente)", () => {
      const text =
        "El asistente técnico reparó la computadora y logró salvar los archivos de la empresa.";
      const res = evaluatePreAi(text);
      expect(res.isClean).toBe(true);
      expect(res.matches).toHaveLength(0);
    });

    it("should handle empty or whitespace text gracefully", () => {
      expect(evaluatePreAi("").isClean).toBe(true);
      expect(evaluatePreAi("   ").isClean).toBe(true);
    });
  });

  describe("Detection of Modern Acronyms (sybau, vtalv, alv, chsm, etc.)", () => {
    it("should detect direct acronym 'sybau'", () => {
      const res = evaluatePreAi("Cállate de una vez sybau");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("sybau");
    });

    it("should detect obfuscated acronym 's.y.b.a.u' or 's y b a u'", () => {
      const res1 = evaluatePreAi("eres un s.y.b.a.u");
      expect(res1.isClean).toBe(false);
      expect(res1.matches).toContain("sybau");

      const res2 = evaluatePreAi("deja de molestar s y b a u");
      expect(res2.isClean).toBe(false);
      expect(res2.matches).toContain("sybau");
    });

    it("should detect direct acronym 'vtalv'", () => {
      const res = evaluatePreAi("vete vtalv de aquí");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("vtalv");
    });

    it("should detect spaced and obfuscated 'v t a l v' or 'v_t_a_l_v'", () => {
      const res = evaluatePreAi("mandalo v_t_a_l_v");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("vtalv");
    });

    it("should detect 'alv', 'chsm', 'ctm', 'hdp', 'stfu'", () => {
      expect(evaluatePreAi("se fue alv").isClean).toBe(false);
      expect(evaluatePreAi("que se vaya a chsm").isClean).toBe(false);
      expect(evaluatePreAi("eres un ctm").isClean).toBe(false);
      expect(evaluatePreAi("vaya hdp").isClean).toBe(false);
      expect(evaluatePreAi("please stfu").isClean).toBe(false);
    });
  });

  describe("Detection of Mexican and Spanish Slurs and Leetspeak", () => {
    it("should detect standard Mexican slurs", () => {
      const res = evaluatePreAi("Este trabajo es una reverenda pendejada");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("pendejada");
    });

    it("should detect leetspeak obfuscation: 'p3nd3j0', 'v3rg@', 'put0'", () => {
      const res1 = evaluatePreAi("eres un p3nd3j0");
      expect(res1.isClean).toBe(false);
      expect(res1.matches).toContain("pendejo");

      const res2 = evaluatePreAi("que te valga v3rg@");
      expect(res2.isClean).toBe(false);
      expect(res2.matches).toContain("verga");

      const res3 = evaluatePreAi("callate p*u*t*o");
      expect(res3.isClean).toBe(false);
      expect(res3.matches).toContain("puto");
    });

    it("should detect hate speech terms", () => {
      const res = evaluatePreAi("no contratamos a ningun naco ni sudaca");
      expect(res.isClean).toBe(false);
      expect(res.categories).toContain("Discurso de Odio y Discriminación");
    });

    it("should detect English profanity and slurs", () => {
      const res = evaluatePreAi("Shut up you stupid asshole");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("asshole");
    });

    it("should detect complex leetspeak and symbol combinations like '$yb@u', 'b!tch', 'a$$hole'", () => {
      expect(evaluatePreAi("eres un $yb@u").isClean).toBe(false);
      expect(evaluatePreAi("you b!tch").isClean).toBe(false);
      expect(evaluatePreAi("what an a$$hole").isClean).toBe(false);
      expect(evaluatePreAi("¡¡¡vtalv!!!").isClean).toBe(false);
      expect(evaluatePreAi("¿que v_t_a_l_v?").isClean).toBe(false);
      expect(evaluatePreAi("vayanse a la ch$m").isClean).toBe(false);
    });

    it("should allow professional text with punctuation, numbers and Spanish characters", () => {
      const text =
        "¡Excelente oportunidad! Se busca Diseñador Gráfico & Programador Web (con 5+ años de experiencia). Salario: $25,000 MXN mensuales netos.";
      const res = evaluatePreAi(text);
      expect(res.isClean).toBe(true);
      expect(res.matches).toHaveLength(0);
    });

    it("should detect scam job offerings", () => {
      const res = evaluatePreAi("Unete a nuestro equipo, inversion inicial requerida y gana miles");
      expect(res.isClean).toBe(false);
      expect(res.matches).toContain("inversion inicial requerida");
    });
  });
});
