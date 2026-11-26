import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSESSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
    mockSESSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = mockSESSend;
  },
  SendEmailCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = vi.fn();
  },
  PostToConnectionCommand: class {},
}));

vi.mock("../../utils/webPushService", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }),
  createUserNotification: vi.fn().mockResolvedValue("test-notif-id"),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  ScanCommand: class {
    constructor(public params: any) {}
  },
  GetCommand: class {
    constructor(public params: any) {}
  },
  PutCommand: class {
    constructor(public params: any) {}
  },
  UpdateCommand: class {
    constructor(public params: any) {}
  },
  DeleteCommand: class {
    constructor(public params: any) {}
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
}));

import { getIncidents, createIncident, resolveIncident } from "./incidents";

describe("moderator incidents handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockSESSend.mockReset();
    mockSESSend.mockResolvedValue({});
  });

  describe("getIncidents", () => {
    it("should return sorted incidents on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "INCIDENT#inc-1",
            SK: "METADATA",
            jobId: "job-1",
            jobTitle: "Senior React Dev",
            reporter: "user-1",
            reason: "Spam",
            severity: "alta",
            estatus: "PENDIENTE",
            fechaCreacion: "2026-01-01T10:00:00.000Z",
          },
          {
            PK: "INCIDENT#inc-2",
            SK: "METADATA",
            postId: "post-1",
            postTitle: "My Post",
            estatus: "EVALUACION",
            fechaCreacion: "2026-01-02T10:00:00.000Z",
          },
          {
            PK: "INCIDENT#inc-3",
            SK: "METADATA",
            companyId: "comp-1",
            companyName: "Acme",
            estatus: "PENDIENTE",
            fechaCreacion: "2025-12-01T10:00:00.000Z",
          },
        ],
      });

      const response = await getIncidents({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res).toHaveLength(3);
      expect(res[0].id).toBe("inc-2");
      expect(res[0].targetType).toBe("POST");
      expect(res[1].id).toBe("inc-1");
      expect(res[1].targetType).toBe("VACANTE");
      expect(res[2].id).toBe("inc-3");
      expect(res[2].targetType).toBe("ORGANIZACION");
    });

    it("should return 500 on database error during get", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));
      const response = await getIncidents({} as any, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("createIncident", () => {
    it("should return 400 if reason is missing", async () => {
      const event = { body: JSON.stringify({}) } as any;
      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("Missing body parameter 'reason'");
    });

    it("should create incident successfully without triggering auto-evaluation if < 5 reports", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ PK: "INCIDENT#1" }], // Only 1 report
      }); // ScanCommand recent reports

      const event = {
        body: JSON.stringify({
          jobId: "job-1",
          jobTitle: "Dev Job",
          reason: "Salario sospechoso",
          severity: "alta",
        }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.autoSuspended).toBe(false);
      expect(res.incidentCount).toBe(1);
    });

    it("should trigger automatic vacancy evaluation (RF-72) when 5 or more reports accumulate in less than 12 hours", async () => {
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { PK: "INCIDENT#1" },
          { PK: "INCIDENT#2" },
          { PK: "INCIDENT#3" },
          { PK: "INCIDENT#4" },
          { PK: "INCIDENT#5" },
        ],
      }); // 5 reports
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand audit log

      const event = {
        body: JSON.stringify({
          jobId: "job-1",
          jobTitle: "Dev Job",
          reason: "Fraude masivo",
          severity: "alta",
        }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(201);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.autoSuspended).toBe(true);
      expect(res.incidentCount).toBe(5);
    });

    it("should return 500 on database error during create", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        body: JSON.stringify({
          jobId: "job-1",
          reason: "Reporte de prueba",
        }),
      } as any;

      const response = await createIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });

  describe("resolveIncident", () => {
    it("should return 400 if incidentId is missing", async () => {
      const event = { pathParameters: {} } as any;
      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if action is invalid or missing", async () => {
      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "invalid_action" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
    });

    it("should return 404 if incident is not found and vacancy fallback fails", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Incident get
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Vacancy get fallback

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Incident not found");
    });

    it("should use vacancy fallback if incident does not exist directly", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Incident get
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "VACANCY#vac-1",
          SK: "METADATA",
          titulo: "Fallback Job",
          empresaUuid: "comp-1",
        },
      }); // Vacancy get
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand synthetic incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // getOrgAppealMessageCount
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "USER#comp-1", SK: "PROFILE", email: "company@test.com" },
      }); // GetCommand company profile for SES
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile apelacionIniciada = false

      const event = {
        pathParameters: { incidentId: "vac-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).estatus).toBe("RESUELTO");
    });

    it("should return 400 if org has less than 3 appeal messages on job incident resolution", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-1",
          SK: "METADATA",
          jobId: "job-1",
          companyId: "comp-1",
          estatus: "EVALUACION",
        },
      });
      mockDynamoSend.mockResolvedValueOnce({ Items: [{ senderId: "comp-1" }] }); // Only 1 msg

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("al menos 3 mensajes");
    });

    it("should block incident and delete fraudulent vacancy with SES and domain block", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              reason: "Vacante falsa",
              companyId: "comp-1",
            },
          };
        if (pk === "VACANCY#job-1")
          return {
            Item: {
              PK: "VACANCY#job-1",
              SK: "METADATA",
              titulo: "Fake Job",
              empresaUuid: "comp-1",
            },
          };
        if (pk === "USER#comp-1")
          return {
            Item: {
              PK: "USER#comp-1",
              SK: "PROFILE",
              email: "company@test.com",
            },
          };
        if (
          input.KeyConditionExpression?.includes(":pk") &&
          input.ExpressionAttributeValues?.[":pk"]?.startsWith("APPEAL_CHAT")
        )
          return {
            Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "block" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.incidentId).toBe("inc-1");
      expect(res.estatus).toBe("BLOQUEADO");
    });

    it("should evaluate incident and pause vacancy successfully", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              reason: "Sospechosa",
              companyId: "comp-1",
            },
          };
        if (pk === "VACANCY#job-1")
          return {
            Item: {
              PK: "VACANCY#job-1",
              SK: "METADATA",
              titulo: "Dev Job",
              empresaUuid: "comp-1",
            },
          };
        if (pk === "USER#comp-1")
          return {
            Item: {
              PK: "USER#comp-1",
              SK: "PROFILE",
              email: "company@test.com",
            },
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "evaluate" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);

      const res = JSON.parse(response.body);
      expect(res.success).toBe(true);
      expect(res.estatus).toBe("EVALUACION");
    });

    it("should approve job incident and restore vacancy to active", async () => {
      mockDynamoSend.mockImplementation(async (command: any) => {
        const input = command.input || command.params;
        const pk = input.Key?.PK;
        if (pk === "INCIDENT#inc-1")
          return {
            Item: {
              PK: "INCIDENT#inc-1",
              SK: "METADATA",
              jobId: "job-1",
              companyId: "comp-1",
            },
          };
        if (pk === "USER#comp-1")
          return {
            Item: {
              email: "company@test.com",
            },
          };
        if (
          input.KeyConditionExpression?.includes(":pk") &&
          input.ExpressionAttributeValues?.[":pk"]?.startsWith("APPEAL_CHAT")
        )
          return {
            Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
          };
        return {};
      });

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).estatus).toBe("RESUELTO");
    });

    it("should handle org-level incident evaluation", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-org-1", companyId: "comp-1" },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand initial chat message
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "comp@test.com" },
      }); // Get profile for SES
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident

      const res = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-org-1" },
          body: JSON.stringify({ action: "evaluate" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).estatus).toBe("EVALUACION");
    });

    it("should handle SES email failure during evaluate and approve without failing the request", async () => {
      // 1. Evaluate with SES error
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-1",
          jobId: "job-1",
          companyId: "comp-1",
          estatus: "PENDIENTE",
        },
      }); // Get incident
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident (line 376)
      mockDynamoSend.mockResolvedValueOnce({}); // Put grace period (line 533)
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy (line 546)
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-1", titulo: "Senior Dev" },
      }); // Get vacancy (line 562)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "comp@test.com" },
      }); // Get profile (line 573)
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification (line 589)
      mockSESSend.mockRejectedValueOnce(new Error("SES Evaluate Error"));

      const res1 = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-1" },
          body: JSON.stringify({ action: "evaluate" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res1.statusCode).toBe(200);
      expect(mockSESSend).toHaveBeenCalled();

      // 2. Approve with SES error
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-1", jobId: "job-1", companyId: "comp-1" },
      }); // Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // Appeal msg count (3 messages)
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident
      mockDynamoSend.mockResolvedValueOnce({}); // Delete grace period
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "comp@test.com" },
      }); // Get profile
      mockSESSend.mockRejectedValueOnce(new Error("SES Approve Error"));
      mockDynamoSend.mockResolvedValueOnce({}); // Update appeal chat
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Company profile for broadcast
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Connection query 1
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Connection query 2

      const res2 = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-1" },
          body: JSON.stringify({ action: "approve" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res2.statusCode).toBe(200);
    });

    it("should handle incident without companyId and lookup vacancy to retrieve companyId", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-no-comp",
          jobId: "job-100",
          estatus: "PENDIENTE",
        },
      }); // Get incident (no companyId)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-found-1" },
      }); // Get vacancy (lines 332-342)
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident
      mockDynamoSend.mockResolvedValueOnce({}); // Put grace period
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-found-1", titulo: "Found Job" },
      }); // Get vacancy (line 562)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "found@comp.com" },
      }); // Get profile
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification

      const res = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-no-comp" },
          body: JSON.stringify({ action: "evaluate" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should handle error in block and approve domain/profile lookup gracefully", async () => {
      // 1. Block with SES error and domain block
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-b", jobId: "job-1", companyId: "comp-1" },
      }); // Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // 3 appeal messages
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident
      mockDynamoSend.mockResolvedValueOnce({}); // Delete grace period
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification
      mockDynamoSend.mockResolvedValueOnce({
        Item: { empresaUuid: "comp-1" },
      }); // Vacancy get
      mockDynamoSend.mockResolvedValueOnce({
        Item: { email: "fraud@fakecorp.com" },
      }); // Profile get
      mockSESSend.mockRejectedValueOnce(new Error("SES Block Error")); // SES send error (line 496)
      mockDynamoSend.mockResolvedValueOnce({}); // Put blocked domain
      mockDynamoSend.mockResolvedValueOnce({}); // Put audit log
      mockDynamoSend.mockResolvedValueOnce({}); // Update profile chat

      const resBlock = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-b" },
          body: JSON.stringify({ action: "block" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(resBlock.statusCode).toBe(200);

      // 1b. Block with domain lookup error (line 508)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-b2", jobId: "job-1", companyId: "comp-1" },
      }); // Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // 3 appeal messages
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident
      mockDynamoSend.mockResolvedValueOnce({}); // Delete grace period
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification
      mockDynamoSend.mockRejectedValueOnce(new Error("Vacancy get failure for domain block")); // Line 508
      mockDynamoSend.mockResolvedValueOnce({}); // Update profile chat

      const resBlock2 = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-b2" },
          body: JSON.stringify({ action: "block" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(resBlock2.statusCode).toBe(200);

      // 2. Approve with profile lookup error (line 727)
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-a", jobId: "job-1", companyId: "comp-1" },
      }); // Get incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ senderId: "comp-1" }, { senderId: "comp-1" }, { senderId: "comp-1" }],
      }); // 3 appeal messages
      mockDynamoSend.mockResolvedValueOnce({}); // Update incident
      mockDynamoSend.mockResolvedValueOnce({}); // Delete grace period
      mockDynamoSend.mockResolvedValueOnce({}); // Update vacancy
      mockDynamoSend.mockResolvedValueOnce({}); // Put notification
      mockDynamoSend.mockRejectedValueOnce(new Error("Profile lookup failure for approve")); // Line 727
      mockDynamoSend.mockResolvedValueOnce({}); // Update profile chat
      mockDynamoSend.mockResolvedValueOnce({ Item: null }); // Broadcast profile
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Broadcast q1
      mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Broadcast q2

      const resApprove = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-a" },
          body: JSON.stringify({ action: "approve" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(resApprove.statusCode).toBe(200);
    });

    it("should handle org-level incident block", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-org-1", companyId: "comp-1" },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification

      const res = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-org-1" },
          body: JSON.stringify({ action: "block" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).estatus).toBe("BLOQUEADO");
    });

    it("should handle org-level incident approve", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-org-1", companyId: "comp-1" },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // DeleteCommand grace period
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification

      const res = await resolveIncident(
        {
          pathParameters: { incidentId: "inc-org-1" },
          body: JSON.stringify({ action: "approve" }),
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).estatus).toBe("RESUELTO");
    });

    it("should handle post incident and delete all post items", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-post-1", postId: "post-100" },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { PK: "POST#post-100", SK: "METADATA" },
          { PK: "POST#post-100", SK: "LIKE#user-1" },
        ],
      }); // Query post items
      mockDynamoSend.mockResolvedValueOnce({}); // Delete metadata
      mockDynamoSend.mockResolvedValueOnce({}); // Delete like

      const event = {
        pathParameters: { incidentId: "inc-post-1" },
        body: JSON.stringify({ action: "block" }),
      } as any;

      const res = await resolveIncident(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
    });

    it("should handle candidate incident and suspend candidate profile", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { PK: "INCIDENT#inc-cand-1", targetCandidateId: "cand-100" },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand candidate profile
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand notification

      const event = {
        pathParameters: { incidentId: "inc-cand-1" },
        body: JSON.stringify({ action: "block" }),
      } as any;

      const res = await resolveIncident(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
    });

    it("should handle CHAT incident evaluation and notify BOTH candidate and company that it will be reviewed", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-chat-01",
          targetType: "CHAT",
          targetId: "job-50#cand-70",
          jobId: "job-50",
          jobTitle: "Diseñador UI",
          candidateId: "cand-70",
          companyId: "comp-90",
        },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident status (EVALUACION)
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident auditState
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand candidate notification
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand company notification
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const event = {
        pathParameters: { incidentId: "inc-chat-01" },
        body: JSON.stringify({ action: "evaluate" }),
      } as any;

      const res = await resolveIncident(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).estatus).toBe("EVALUACION");
    });

    it("should handle CHAT incident approval and notify BOTH candidate and company of favorable resolution", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: {
          PK: "INCIDENT#inc-chat-02",
          targetType: "CHAT",
          targetId: "job-50#cand-70",
          jobId: "job-50",
          jobTitle: "Diseñador UI",
          candidateId: "cand-70",
          companyId: "comp-90",
        },
      }); // GetCommand incident
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident status (RESUELTO)
      mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand incident auditState
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand candidate notification
      mockDynamoSend.mockResolvedValueOnce({}); // PutCommand company notification
      mockDynamoSend.mockResolvedValueOnce({}); // saveAuditLog

      const event = {
        pathParameters: { incidentId: "inc-chat-02" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const res = await resolveIncident(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).estatus).toBe("RESUELTO");
    });

    it("should return 500 on database error during resolve", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DB error"));

      const event = {
        pathParameters: { incidentId: "inc-1" },
        body: JSON.stringify({ action: "approve" }),
      } as any;

      const response = await resolveIncident(event, {} as any, () => {});
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toBe("DB error");
    });
  });
});
