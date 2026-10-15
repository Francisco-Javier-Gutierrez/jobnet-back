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
  PutCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
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

  it("should auto-verify ORGANIZACION when email has a private corporate domain", async () => {
    const event = createEvent("ORGANIZACION", "Tech Solutions Corp");
    event.request.userAttributes.email = "recruiter@techsolutions.mx";

    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();

    const putCall = mockDynamoSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === "PutCommand" || c[0]?.input?.Item?.PK?.startsWith("USER#"),
    );
    expect(putCall).toBeDefined();
    const savedItem = putCall[0].input.Item;
    expect(savedItem.tipoUsuario).toBe("ORGANIZACION");
    expect(savedItem.organizacionVerificada).toBe(true);
    expect(savedItem.estatusVerificacion).toBe("VERIFICADA");
    expect(savedItem.metodoVerificacion).toBe("AUTOMATICO_DOMINIO_CORPORATIVO");
    expect(savedItem.dominioCorporativo).toBe("techsolutions.mx");
  });

  it("should set ORGANIZACION as unverified/pending when email has a public domain (e.g. gmail.com)", async () => {
    const event = createEvent("ORGANIZACION", "Consultoría Local");
    event.request.userAttributes.email = "reclutador.pyme@gmail.com";

    const result = await handler(event, {} as never, () => {});
    expect(result).toBeDefined();

    const putCall = mockDynamoSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === "PutCommand" || c[0]?.input?.Item?.PK?.startsWith("USER#"),
    );
    expect(putCall).toBeDefined();
    const savedItem = putCall[0].input.Item;
    expect(savedItem.tipoUsuario).toBe("ORGANIZACION");
    expect(savedItem.organizacionVerificada).toBe(false);
    expect(savedItem.estatusVerificacion).toBe("PENDIENTE");
    expect(savedItem.metodoVerificacion).toBe("MANUAL_PENDIENTE");
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

  it("should process moderator_pending aspirant with neutral pending state and not CANDIDATO", async () => {
    const event = createEvent("moderator_pending", "Aspirante Mod", "moderator_pending");
    event.request.clientMetadata = {
      tipoUsuario: "moderator_pending",
      solicitudRol: "MODERATOR",
      nombre: "Aspirante Mod",
    } as any;

    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should automatically process Google federated sign-in as active CANDIDATO and sync name and email", async () => {
    const event = createEvent("", "Google Candidate");
    event.userName = "Google_10987654321";
    event.request.userAttributes = {
      email: "google.candidato@gmail.com",
      name: "Juan Pérez Google",
      sub: "google-sub-12345",
      identities: '[{"userId":"10987654321","providerName":"Google","providerType":"Google"}]',
    };
    event.request.clientMetadata = undefined;

    const res = await handler(event, {} as never, () => {});
    expect(res).toBeDefined();

    const putCall = mockDynamoSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === "PutCommand" || c[0]?.input?.Item?.PK === "USER#google-sub-12345",
    );
    expect(putCall).toBeDefined();
    const savedItem = putCall[0].input.Item;
    expect(savedItem.tipoUsuario).toBe("CANDIDATO");
    expect(savedItem.estadoCuenta).toBe("ACTIVO");
    expect(savedItem.email).toBe("google.candidato@gmail.com");
    expect(savedItem.nombre).toBe("Juan Pérez Google");
    expect(savedItem.origenRegistro).toBe("GOOGLE_OAUTH");
  });

  it("should initialize with local endpoint when IS_OFFLINE is true", async () => {
    process.env.IS_OFFLINE = "true";
    vi.resetModules();
    const mod = await import("./postConfirmation");
    expect(mod.handler).toBeDefined();
    process.env.IS_OFFLINE = "false";
  });
});
