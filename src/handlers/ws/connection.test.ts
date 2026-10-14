import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
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
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
}));

import { connect, disconnect, defaultRoute } from "./connection";

describe("ws connection handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("connect", () => {
    it("should connect regular user successfully", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        requestContext: { connectionId: "conn-1", authorizer: { principalId: "u-1" } },
      } as any;

      const res = await connect(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("Connected");
    });

    it("should connect moderator and save moderator role mapping", async () => {
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValueOnce({});

      const event = {
        requestContext: {
          connectionId: "conn-mod",
          authorizer: { principalId: "mod-1", role: "MODERATOR" },
        },
      } as any;

      const res = await connect(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
    });

    it("should return 500 on database error during connect", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Connect error"));

      const event = {
        requestContext: { connectionId: "conn-1" },
      } as any;

      const res = await connect(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("disconnect", () => {
    it("should disconnect and clean up connection records", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: { userId: "u-1" } }); // Lookup
      mockDynamoSend.mockResolvedValueOnce({}); // Delete user map
      mockDynamoSend.mockResolvedValueOnce({}); // Delete moderator map
      mockDynamoSend.mockResolvedValueOnce({}); // Delete connection meta

      const event = {
        requestContext: { connectionId: "conn-1" },
      } as any;

      const res = await disconnect(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("Disconnected");
    });

    it("should return 500 on database error during disconnect", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Disconnect error"));

      const event = {
        requestContext: { connectionId: "conn-1" },
      } as any;

      const res = await disconnect(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe("defaultRoute", () => {
    it("should handle default route", async () => {
      const res = await defaultRoute({ requestContext: { connectionId: "conn-1" } } as any, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("Default route");
    });
  });
});
