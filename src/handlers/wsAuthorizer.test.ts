import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockVerify } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
}));

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: mockVerify,
    }),
  },
}));

import { handler } from "./wsAuthorizer";

describe("wsAuthorizer handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      COGNITO_USER_POOL_ID: "us-east-1_testpool",
      IS_OFFLINE: "false",
    };
  });

  it("should deny access if no token is provided in query or header", async () => {
    const event = {
      queryStringParameters: null,
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
    expect(res.principalId).toBe("user");
  });

  it("should allow mock user when running in offline or local mode", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-east-1_local";
    const event = {
      queryStringParameters: { token: "dummy-local-token", role: "admin" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("mock-user-id");
    expect(res.context.role).toBe("MODERATOR");
  });

  it("should allow mock user with USER role when not admin in local mode", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-east-1_local";
    const event = {
      queryStringParameters: { token: "dummy-local-token" },
      headers: { "x-user-role": "candidate" },
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("mock-user-id");
    expect(res.context.role).toBe("USER");
  });

  it("should extract token from Bearer Authorization header", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "user-123",
      email: "user@example.com",
      scope: "openid profile jobnet/candidate",
    });

    const event = {
      queryStringParameters: null,
      headers: { Authorization: "Bearer my-valid-access-token" },
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("user-123");
    expect(res.context.role).toBe("USER");
    expect(res.context.scopes).toBe("openid profile jobnet/candidate");
  });

  it("should grant MODERATOR role when token contains jobnet/admin scope", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "admin-123",
      email: "admin@example.com",
      scope: "openid jobnet/admin",
    });

    const event = {
      queryStringParameters: { token: "admin-access-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("admin-123");
    expect(res.context.role).toBe("MODERATOR");
  });

  it("should grant MODERATOR role when token contains jobnet/moderator scope", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "mod-123",
      email: "mod@example.com",
      scp: ["openid", "jobnet/moderator"],
    });

    const event = {
      queryStringParameters: { token: "mod-access-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("mod-123");
    expect(res.context.role).toBe("MODERATOR");
  });

  it("should grant MODERATOR role when cognito:groups contains MODERATOR or ADMIN", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "group-mod-123",
      email: "mod@jobnet.com",
      "cognito:groups": ["MODERATOR"],
    });

    const event = {
      queryStringParameters: { token: "group-mod-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("group-mod-123");
    expect(res.context.role).toBe("MODERATOR");
  });

  it("should recognize custom:role or query role fallback", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "custom-mod-123",
      "custom:role": "MODERATOR",
    });

    const event = {
      queryStringParameters: { token: "custom-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("custom-mod-123");
    expect(res.context.role).toBe("MODERATOR");
  });

  it("should recognize custom:tipoUsuario and handle missing scope/email", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "org-123",
      "custom:tipoUsuario": "ORGANIZACION",
    });

    const event = {
      queryStringParameters: { token: "org-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("org-123");
    expect(res.context.email).toBe("");
    expect(res.context.scopes).toBe("");
  });

  it("should handle unexpected scope types gracefully", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "weird-scope-user",
      scope: 12345,
    });

    const event = {
      queryStringParameters: { token: "weird-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.context.scopes).toBe("");
  });

  it("should handle IS_OFFLINE=true and missing COGNITO_USER_POOL_ID in local mode", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    process.env.IS_OFFLINE = "true";

    const event = {
      queryStringParameters: { token: "local-token" },
      headers: undefined,
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.principalId).toBe("mock-user-id");
  });

  it("should deny policy on verification failure", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Invalid token signature"));

    const event = {
      queryStringParameters: { token: "invalid-token" },
      headers: {},
      methodArn: "arn:aws:execute-api:us-east-1:123456789012:api/stage/$connect",
    };

    const res = await handler(event);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
    expect(res.principalId).toBe("user");
  });
});
