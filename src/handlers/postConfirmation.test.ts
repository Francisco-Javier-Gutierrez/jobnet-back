import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostConfirmationTriggerEvent } from "aws-lambda";

const { mockCognitoSend, mockDynamoSend } = vi.hoisted(() => {
  process.env.DYNAMODB_TABLE = "test-table";
  process.env.COGNITO_USER_POOL_ID = "test-pool-id";

  return {
    mockCognitoSend: vi.fn(),
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = mockCognitoSend;
  },
  AdminAddUserToGroupCommand: class {},
}));

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
}));

import { handler } from "./postConfirmation";

describe("postConfirmation handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});
    mockCognitoSend.mockResolvedValue({});
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE: "test-table",
      COGNITO_USER_POOL_ID: "test-pool-id",
    };
  });

  const createEvent = (
    tipoUsuario: string,
    nombre: string,
  ): PostConfirmationTriggerEvent => ({
    version: "1",
    region: "us-east-1",
    userPoolId: "test-pool-id",
    userName: "testuser",
    callerContext: { awsSdkVersion: "1", clientId: "client-id" },
    request: {
      userAttributes: {
        email: "test@example.com",
        sub: "uuid-1234",
        name: nombre,
      },
      clientMetadata: { tipoUsuario, nombre },
    },
    response: {},
    triggerSource: "PostConfirmation_ConfirmSignUp",
  });

  it("should process CANDIDATO user correctly", async () => {
    const event = createEvent("CANDIDATO", "Test Candidato");
    await handler(event, {} as never, () => {});
    expect(mockCognitoSend).toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should process EMPRESA user correctly", async () => {
    const event = createEvent("EMPRESA", "Tech Corp");
    await handler(event, {} as never, () => {});
    expect(mockCognitoSend).toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should process ADMIN user correctly", async () => {
    const event = createEvent("ADMIN", "Admin User");
    await handler(event, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should process MODERATOR user correctly", async () => {
    const event = createEvent("MODERATOR", "Mod User");
    await handler(event, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should fallback to CANDIDATO if no tipoUsuario provided in metadata", async () => {
    const event = createEvent("", "");
    event.request.clientMetadata = undefined;
    await handler(event, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should gracefully handle DynamoDB errors", async () => {
    const event = createEvent("CANDIDATO", "Test");
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB Error"));
    await expect(handler(event, {} as never, () => {})).rejects.toThrow(
      "DynamoDB Error",
    );
  });

  it("should gracefully handle Cognito errors", async () => {
    const event = createEvent("CANDIDATO", "Test");
    mockCognitoSend.mockRejectedValueOnce(new Error("Cognito Error"));
    await expect(handler(event, {} as never, () => {})).resolves.toBeDefined();
  });

  it("should skip Cognito assignment if USER_POOL_ID is undefined", async () => {
    process.env.COGNITO_USER_POOL_ID = "";
    const event = createEvent("CANDIDATO", "Test");
    await handler(event, {} as never, () => {});
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should skip DynamoDB insert if TABLE_NAME is undefined", async () => {
    process.env.DYNAMODB_TABLE = "";
    const event = createEvent("CANDIDATO", "Test");
    await handler(event, {} as never, () => {});
    expect(mockCognitoSend).toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("should handle unknown tipoUsuario gracefully", async () => {
    const event = createEvent("UNKNOWN_ROLE", "Test");
    await handler(event, {} as never, () => {});
    expect(mockDynamoSend).toHaveBeenCalled();
  });
});
