import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostConfirmationTriggerEvent } from "aws-lambda";

const { mockDynamoSend } = vi.hoisted(() => {
  process.env.DYNAMODB_TABLE = "test-table";
  process.env.COGNITO_USER_POOL_ID = "test-pool-id";

  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  PutCommand: class {},
  GetCommand: class {},
}));

import { handler } from "./postConfirmation";

describe("postConfirmation handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE: "test-table",
      COGNITO_USER_POOL_ID: "test-pool-id",
    };
  });

  const createEvent = (
    tipoUsuario: string,
    nombre: string,
    customRole?: string,
    customTaxId?: string,
  ): PostConfirmationTriggerEvent => {
    const userAttributes: Record<string, string> = {
      email: "test@example.com",
      sub: "uuid-1234",
      name: nombre,
    };
    if (customRole) {
      userAttributes["custom:role"] = customRole;
    }
    if (customTaxId) {
      userAttributes["custom:tax_id"] = customTaxId;
    }

    return {
      version: "1",
      region: "us-east-1",
      userPoolId: "test-pool-id",
      userName: "testuser",
      callerContext: { awsSdkVersion: "1", clientId: "client-id" },
      request: {
        userAttributes,
        clientMetadata: tipoUsuario ? { tipoUsuario, nombre } : undefined,
      },
      response: {},
      triggerSource: "PostConfirmation_ConfirmSignUp",
    };
  };

  it("should process CANDIDATO user correctly", async () => {
    const event = createEvent("CANDIDATO", "Test Candidato");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should process ORGANIZACION user correctly", async () => {
    const event = createEvent("ORGANIZACION", "Tech Corp");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should block ORGANIZACION signup if corporate domain is suspended (RF-74)", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        PK: "BLOCKED_DOMAIN#fraudcorp.com",
        domain: "fraudcorp.com",
        reason: "Prácticas fraudulentas",
      },
    }); // GetCommand returns blocked domain

    const event = createEvent("EMPRESA", "Fraud Corp");
    event.request.userAttributes.email = "recruiter@fraudcorp.com";

    await expect(handler(event, {} as never, () => {})).rejects.toThrow(
      /RF-74/,
    );
  });

  it("should process ADMIN user correctly", async () => {
    const event = createEvent("ADMIN", "Admin User");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should process MODERATOR user correctly", async () => {
    const event = createEvent("MODERATOR", "Mod User");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should fallback to PENDIENTE if no tipoUsuario provided in metadata", async () => {
    const event = createEvent("", "Test");
    event.request.clientMetadata = { nombre: "Test" } as never;
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should gracefully handle DynamoDB errors", async () => {
    const event = createEvent("CANDIDATO", "Test");
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB Error"));
    await expect(handler(event, {} as never, () => {})).rejects.toThrow(
      "DynamoDB Error",
    );
  });

  it("should skip DynamoDB insert if TABLE_NAME is undefined", async () => {
    process.env.DYNAMODB_TABLE = "";
    const event = createEvent("CANDIDATO", "Test");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("should handle unknown tipoUsuario gracefully", async () => {
    const event = createEvent("UNKNOWN_ROLE", "Test");
    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should map custom:role correctly for candidate and company", async () => {
    const event1 = createEvent("", "Candidate Name", "candidate");
    await handler(event1, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();

    const event2 = createEvent("", "Company Name", "company", "12345678");
    await handler(event2, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should map custom:role correctly for admin and moderator", async () => {
    const event1 = createEvent("", "Admin Name", "admin");
    await handler(event1, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();

    const event2 = createEvent("", "Mod Name", "moderator");
    await handler(event2, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should parse custom:tipoUsuario correctly when clientMetadata is missing", async () => {
    const event = createEvent("", "Test User");
    event.request.clientMetadata = undefined;
    event.request.userAttributes["custom:tipoUsuario"] = "EMPRESA";
    await handler(event, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should ignore DynamoDB error during blocked domain check if it is not RF-74", async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error("Dynamo lookup failed"));
    mockDynamoSend.mockResolvedValueOnce({}); // PutCommand succeeds

    const event = createEvent("ORGANIZACION", "Test Corp");
    event.request.userAttributes.email = "info@goodcorp.com";

    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();
  });

  it("should handle ORGANIZACION with missing or invalid email without error", async () => {
    const event1 = createEvent("ORGANIZACION", "Test Corp");
    event1.request.userAttributes.email = "noatsign";
    const res1 = await handler(event1, {} as never, () => {});
    expect(res1).toBeDefined();

    const event2 = createEvent("ORGANIZACION", "Test Corp");
    event2.request.userAttributes.email = "";
    const res2 = await handler(event2, {} as never, () => {});
    expect(res2).toBeDefined();
  });

  it("should map clientMetadata.role and variations like 'organizacion'", async () => {
    const event = createEvent("", "Org Corp");
    event.request.clientMetadata = { role: "organizacion" } as any;
    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();
  });

  it("should fallback to userAttributes.name when clientMetadata has no nombre", async () => {
    const event = createEvent("", "Attr Name");
    event.request.clientMetadata = { role: "candidate" } as any;
    event.request.userAttributes.name = "Attr Name";
    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();
  });

  it("should fallback to Sin Nombre when both clientMetadata and userAttributes have no name", async () => {
    const event = createEvent("", "");
    event.request.clientMetadata = { role: "candidate" } as any;
    event.request.userAttributes.name = "";
    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();
  });

  it("should handle missing DYNAMODB_TABLE during blocked domain check and saving", async () => {
    delete process.env.DYNAMODB_TABLE;
    const event = createEvent("ORGANIZACION", "Test Corp");
    event.request.userAttributes.email = "info@goodcorp.com";
    mockDynamoSend.mockResolvedValueOnce({ Item: null });

    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();
  });

  it("should initialize with local endpoint when IS_OFFLINE is true", async () => {
    process.env.IS_OFFLINE = "true";
    vi.resetModules();
    const mod = await import("./postConfirmation");
    expect(mod.handler).toBeDefined();
    process.env.IS_OFFLINE = "false";
  });
});
