import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  parseJsonBody,
  validateSchema,
  validateAndParse,
  safeIdSchema,
  safeText,
  nonNegativeNumber,
  positiveInteger,
  modalidadEnum,
} from "./validator";

describe("validator utility", () => {
  describe("parseJsonBody", () => {
    it("should parse valid JSON string", () => {
      const res = parseJsonBody('{"title": "Dev", "salary": 25000}');
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toEqual({ title: "Dev", salary: 25000 });
      }
    });

    it("should return empty object for empty or null strings", () => {
      expect(parseJsonBody("").data).toEqual({});
      expect(parseJsonBody(null).data).toEqual({});
      expect(parseJsonBody(undefined).data).toEqual({});
    });

    it("should return 400 Bad Request on invalid JSON syntax without throwing 500", () => {
      const res = parseJsonBody('{"broken": json');
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.response.statusCode).toBe(400);
        const parsed = JSON.parse(res.response.body);
        expect(parsed.code).toBe("INVALID_JSON");
      }
    });
  });

  describe("validateSchema", () => {
    const testSchema = z.object({
      name: z.string().min(2),
      age: z.number().int().min(18),
    });

    it("should validate valid data", () => {
      const res = validateSchema({ name: "Carlos", age: 25 }, testSchema);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe("Carlos");
      }
    });

    it("should return 400 with structured field errors on invalid data", () => {
      const res = validateSchema({ name: "A", age: 15 }, testSchema);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.response.statusCode).toBe(400);
        const parsed = JSON.parse(res.response.body);
        expect(parsed.code).toBe("VALIDATION_ERROR");
        expect(parsed.details).toHaveLength(2);
      }
    });
  });

  describe("validateAndParse", () => {
    const jobSchema = z.object({
      title: safeText(3, 100),
      salary: nonNegativeNumber(),
      modalidad: modalidadEnum,
    });

    it("should parse JSON and validate successfully", () => {
      const raw = JSON.stringify({
        title: "Frontend Engineer",
        salary: 45000,
        modalidad: "Remoto",
      });
      const res = validateAndParse(raw, jobSchema);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.salary).toBe(45000);
      }
    });

    it("should reject negative salary", () => {
      const raw = JSON.stringify({
        title: "Frontend Engineer",
        salary: -500,
        modalidad: "Remoto",
      });
      const res = validateAndParse(raw, jobSchema);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.response.statusCode).toBe(400);
      }
    });

    it("should reject invalid modalidad enum", () => {
      const raw = JSON.stringify({
        title: "Frontend Engineer",
        salary: 30000,
        modalidad: "Galáctica",
      });
      const res = validateAndParse(raw, jobSchema);
      expect(res.success).toBe(false);
    });
  });

  describe("primitives", () => {
    it("should disallow # delimiter in safeIdSchema to protect Single-Table Design", () => {
      expect(safeIdSchema.safeParse("user123").success).toBe(true);
      expect(safeIdSchema.safeParse("user#123").success).toBe(false);
      expect(safeIdSchema.safeParse("").success).toBe(false);
    });

    it("should enforce positiveInteger bounds", () => {
      expect(positiveInteger(1, 10).safeParse(5).success).toBe(true);
      expect(positiveInteger(1, 10).safeParse("8").success).toBe(true);
      expect(positiveInteger(1, 10).safeParse(0).success).toBe(false);
      expect(positiveInteger(1, 10).safeParse(11).success).toBe(false);
      expect(positiveInteger(1, 10).safeParse("abc").success).toBe(false);
    });
  });
});
