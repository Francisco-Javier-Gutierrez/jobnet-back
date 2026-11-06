import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractAuthContext, getVerifier } from "./authHelper";

describe("authHelper utility", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      IS_OFFLINE: "false",
      COGNITO_USER_POOL_ID: "us-east-1_testpool",
    };
  });

  it("should return empty unauthenticated context when event is null or empty", async () => {
    process.env.NODE_ENV = "production";
    const res = await extractAuthContext(null);
    expect(res.isAuthenticated).toBe(false);
    expect(res.userId).toBe("");
    expect(res.isModerator).toBe(false);
  });

  it("should extract auth from API Gateway JWT claims", async () => {
    process.env.NODE_ENV = "production";
    const event = {
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: "user-jwt-123",
              email: "jwt@example.com",
              "custom:role": "MODERATOR",
            },
          },
        },
      },
    };

    const res = await extractAuthContext(event);
    expect(res.isAuthenticated).toBe(true);
    expect(res.userId).toBe("user-jwt-123");
    expect(res.email).toBe("jwt@example.com");
    expect(res.role).toBe("MODERATOR");
    expect(res.isModerator).toBe(true);
  });

  it("should extract candidate role correctly from claims", async () => {
    process.env.NODE_ENV = "production";
    const event = {
      requestContext: {
        authorizer: {
          claims: {
            sub: "cand-123",
            "custom:tipoUsuario": "CANDIDATO",
          },
        },
      },
    };

    const res = await extractAuthContext(event);
    expect(res.isAuthenticated).toBe(true);
    expect(res.userId).toBe("cand-123");
    expect(res.role).toBe("CANDIDATO");
    expect(res.isModerator).toBe(false);
  });

  it("should handle test mode fallback headers", async () => {
    process.env.NODE_ENV = "test";
    const event = {
      headers: {
        "x-user-id": "test-mod",
        "x-user-role": "ADMIN",
      },
    };

    const res = await extractAuthContext(event);
    expect(res.isAuthenticated).toBe(true);
    expect(res.userId).toBe("test-mod");
    expect(res.role).toBe("ADMIN");
    expect(res.isModerator).toBe(true);
  });

  it("should return null verifier when in local or test mode", () => {
    process.env.IS_OFFLINE = "true";
    const v = getVerifier();
    expect(v).toBeNull();
  });
});
