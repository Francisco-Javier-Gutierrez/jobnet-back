import { describe, it, expect } from "vitest";
import {
  extractEmailDomain,
  isPublicEmailDomain,
  isCorporateEmailDomain,
  PUBLIC_EMAIL_DOMAINS,
  isBlockedFraudDomain,
  BLOCKED_FRAUD_DOMAINS,
  isValidRfc,
  getRfcType,
} from "./domainVerifier";

describe("Domain Verifier Utility (Verificación Automatizada de Organizaciones)", () => {
  describe("extractEmailDomain", () => {
    it("should extract domain from standard email address", () => {
      expect(extractEmailDomain("reclutador@techsolutions.mx")).toBe("techsolutions.mx");
      expect(extractEmailDomain("RH.TEAM@EMPRESA.COM")).toBe("empresa.com");
    });

    it("should return empty string for invalid emails", () => {
      expect(extractEmailDomain("notanemail")).toBe("");
      expect(extractEmailDomain("")).toBe("");
      expect(extractEmailDomain(null as any)).toBe("");
    });
  });

  describe("isPublicEmailDomain", () => {
    it("should return true for known public email providers", () => {
      expect(isPublicEmailDomain("gmail.com")).toBe(true);
      expect(isPublicEmailDomain("user@gmail.com")).toBe(true);
      expect(isPublicEmailDomain("user@hotmail.com")).toBe(true);
      expect(isPublicEmailDomain("user@outlook.com")).toBe(true);
      expect(isPublicEmailDomain("user@yahoo.com")).toBe(true);
      expect(isPublicEmailDomain("user@icloud.com")).toBe(true);
      expect(isPublicEmailDomain("user@proton.me")).toBe(true);
      expect(isPublicEmailDomain("user@live.com")).toBe(true);
      expect(isPublicEmailDomain("user@zoho.com")).toBe(true);
    });

    it("should return false for private/corporate domains", () => {
      expect(isPublicEmailDomain("techsolutions.mx")).toBe(false);
      expect(isPublicEmailDomain("reclutador@innovatech.com")).toBe(false);
      expect(isPublicEmailDomain("admin@bancoazteca.com.mx")).toBe(false);
      expect(isPublicEmailDomain("contacto@unam.mx")).toBe(false);
    });

    it("should return true for empty or undefined input to prevent false positives", () => {
      expect(isPublicEmailDomain("")).toBe(true);
      expect(isPublicEmailDomain(null as any)).toBe(true);
    });
  });

  describe("isCorporateEmailDomain", () => {
    it("should return true for valid private corporate domains", () => {
      expect(isCorporateEmailDomain("reclutador@techsolutions.mx")).toBe(true);
      expect(isCorporateEmailDomain("talento@innovatech.com")).toBe(true);
      expect(isCorporateEmailDomain("rrhh@corporativonacional.com.mx")).toBe(true);
      expect(isCorporateEmailDomain("techsolutions.mx")).toBe(true);
    });

    it("should return false for public email providers", () => {
      expect(isCorporateEmailDomain("reclutador@gmail.com")).toBe(false);
      expect(isCorporateEmailDomain("empresa@hotmail.com")).toBe(false);
      expect(isCorporateEmailDomain("talento@outlook.com")).toBe(false);
      expect(isCorporateEmailDomain("contacto@yahoo.com")).toBe(false);
      expect(isCorporateEmailDomain("gmail.com")).toBe(false);
    });

    it("should return false for malformed or incomplete domains", () => {
      expect(isCorporateEmailDomain("invalid-domain-without-dot")).toBe(false);
      expect(isCorporateEmailDomain("user@nodot")).toBe(false);
      expect(isCorporateEmailDomain("")).toBe(false);
      expect(isCorporateEmailDomain("   ")).toBe(false);
    });
  });

  describe("PUBLIC_EMAIL_DOMAINS Set", () => {
    it("should contain standard global providers", () => {
      expect(PUBLIC_EMAIL_DOMAINS.has("gmail.com")).toBe(true);
      expect(PUBLIC_EMAIL_DOMAINS.has("hotmail.com")).toBe(true);
      expect(PUBLIC_EMAIL_DOMAINS.has("outlook.com")).toBe(true);
      expect(PUBLIC_EMAIL_DOMAINS.has("yahoo.com")).toBe(true);
    });
  });

  describe("BLOCKED_FRAUD_DOMAINS & isBlockedFraudDomain (RN-3)", () => {
    it("should detect domains on the fraud blacklist", () => {
      expect(isBlockedFraudDomain("recruiter@fraudcorp.com")).toBe(true);
      expect(isBlockedFraudDomain("contacto@estafaslaborales.com")).toBe(true);
      expect(isBlockedFraudDomain("fake-hiring.net")).toBe(true);
      expect(isBlockedFraudDomain("scam-recruiters.org")).toBe(true);
      expect(isBlockedFraudDomain("phishing-jobs.xyz")).toBe(true);
    });

    it("should return false for legitimate domains", () => {
      expect(isBlockedFraudDomain("recruiter@google.com")).toBe(false);
      expect(isBlockedFraudDomain("contacto@techsolutions.mx")).toBe(false);
      expect(isBlockedFraudDomain("talento@gmail.com")).toBe(false);
    });

    it("should return false for empty or invalid values", () => {
      expect(isBlockedFraudDomain("")).toBe(false);
      expect(isBlockedFraudDomain(null as any)).toBe(false);
    });

    it("should have known fraud domains registered in the Set", () => {
      expect(BLOCKED_FRAUD_DOMAINS.has("fraudcorp.com")).toBe(true);
      expect(BLOCKED_FRAUD_DOMAINS.has("estafaslaborales.com")).toBe(true);
      expect(BLOCKED_FRAUD_DOMAINS.has("fake-hiring.net")).toBe(true);
    });
  });

  describe("RFC Syntax Fiscal Validation (isValidRfc & getRfcType)", () => {
    it("should validate valid RFC for Persona Moral (12 characters)", () => {
      expect(isValidRfc("ITE980512AB3")).toBe(true);
      expect(isValidRfc("TDA9510204N9")).toBe(true);
      expect(isValidRfc("BME0101019X8")).toBe(true);
      expect(getRfcType("ITE980512AB3")).toBe("MORAL");
      expect(getRfcType("TDA9510204N9")).toBe("MORAL");
    });

    it("should validate valid RFC for Persona Física (13 characters)", () => {
      expect(isValidRfc("PEGA8801019H2")).toBe(true);
      expect(isValidRfc("GARM850315AA0")).toBe(true);
      expect(isValidRfc("ROAJ901231123")).toBe(true);
      expect(getRfcType("PEGA8801019H2")).toBe("FISICA");
      expect(getRfcType("GARM850315AA0")).toBe("FISICA");
    });

    it("should reject invalid RFC syntaxes", () => {
      expect(isValidRfc("")).toBe(false);
      expect(isValidRfc("12345")).toBe(false);
      expect(isValidRfc("INVALIDRFC123456")).toBe(false);
      expect(isValidRfc("ABCD123456")).toBe(false);
      expect(isValidRfc("ABC123456")).toBe(false);
      expect(isValidRfc("ABCD1234567890")).toBe(false);
      expect(isValidRfc("???8801019H2")).toBe(false);
      expect(getRfcType("INVALID")).toBe("INVALIDO");
      expect(getRfcType("")).toBe("INVALIDO");
    });

    it("should handle lowercase input gracefully after trimming/uppercasing", () => {
      expect(isValidRfc("ite980512ab3")).toBe(true);
      expect(isValidRfc("  pega8801019h2  ")).toBe(true);
    });
  });
});

