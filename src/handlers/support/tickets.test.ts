import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupportTicket,
  getMySupportTickets,
  getAllSupportTickets,
  getSupportTicketMessages,
  sendSupportTicketMessage,
  claimSupportTicket,
  resolveSupportTicket,
} from "./tickets";

vi.mock("../moderator/common", () => {
  return {
    docClient: {
      send: vi.fn(),
    },
    tableName: "jobnet-jobs-test",
    headers: { "Content-Type": "application/json" },
    broadcastSupportEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../utils/moderatorNotifier", () => {
  return {
    notifyAllModerators: vi.fn().mockResolvedValue(["mod-1", "mod-2"]),
  };
});

vi.mock("../../utils/webPushService", () => {
  return {
    sendPushToUser: vi.fn().mockResolvedValue(true),
  };
});

import { docClient } from "../moderator/common";
import { notifyAllModerators } from "../../utils/moderatorNotifier";
import { sendPushToUser } from "../../utils/webPushService";

describe("Support Tickets & Problem Reporting System", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSupportTicket", () => {
    it("should reject unauthenticated caller", async () => {
      const event: any = {
        headers: {},
        body: JSON.stringify({ subject: "Fallo", description: "Detalle del problema" }),
      };

      const res = (await createSupportTicket(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(401);
    });

    it("should reject ticket with missing subject or short description", async () => {
      const event: any = {
        headers: { "x-user-id": "user-cand-1", "x-user-role": "CANDIDATO" },
        body: JSON.stringify({ subject: "Hi", description: "Err" }),
      };

      const res = (await createSupportTicket(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
    });

    it("should create ticket successfully and notify all moderators", async () => {
      (docClient.send as any).mockResolvedValue({});

      const event: any = {
        headers: {
          "x-user-id": "cand-123",
          "x-user-role": "CANDIDATO",
          "x-user-email": "candidato@correo.com",
          "x-user-name": "Juan Perez",
        },
        body: JSON.stringify({
          subject: "No puedo subir mi CV en PDF",
          category: "FALLO_TECNICO",
          description: "La pantalla se queda congelada al subir el archivo.",
          attachments: [{ name: "error.png", url: "https://s3.aws.com/error.png" }],
        }),
      };

      const res = (await createSupportTicket(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.ticket.subject).toBe("No puedo subir mi CV en PDF");
      expect(data.ticket.status).toBe("ABIERTO");
      expect(data.ticket.assignedModeratorId).toBeNull();

      expect(notifyAllModerators).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "NEW_SUPPORT_TICKET",
          title: "Nuevo Reporte de Problema ⚠️",
        }),
      );
    });
  });

  describe("getMySupportTickets", () => {
    it("should return tickets belonging to authenticated user", async () => {
      (docClient.send as any).mockResolvedValue({
        Items: [
          {
            ticketId: "t-1",
            subject: "Duda 1",
            userId: "cand-123",
            createdAt: "2026-11-14T10:00:00Z",
          },
          {
            ticketId: "t-2",
            subject: "Duda 2",
            userId: "cand-123",
            createdAt: "2026-11-14T11:00:00Z",
          },
        ],
      });

      const event: any = {
        headers: { "x-user-id": "cand-123", "x-user-role": "CANDIDATO" },
      };

      const res = (await getMySupportTickets(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const tickets = JSON.parse(res.body);
      expect(tickets.length).toBe(2);
      expect(tickets[0].ticketId).toBe("t-2"); // Descending order
    });
  });

  describe("getAllSupportTickets (Moderator Only)", () => {
    it("should reject non-moderators", async () => {
      const event: any = {
        headers: { "x-user-id": "cand-123", "x-user-role": "CANDIDATO" },
      };

      const res = (await getAllSupportTickets(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(403);
    });

    it("should list community tickets for moderator", async () => {
      (docClient.send as any).mockResolvedValue({
        Items: [
          { ticketId: "t-1", subject: "Problema A", status: "ABIERTO" },
          { ticketId: "t-2", subject: "Problema B", status: "EN_ATENCION" },
        ],
      });

      const event: any = {
        headers: { "x-user-id": "mod-pacog", "x-user-role": "MODERADOR" },
      };

      const res = (await getAllSupportTickets(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const tickets = JSON.parse(res.body);
      expect(tickets.length).toBe(2);
    });
  });

  describe("sendSupportTicketMessage & Concurrency Lock", () => {
    it("should auto-assign unassigned ticket to replying moderator", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: {
            ticketId: "t-100",
            userId: "cand-777",
            subject: "Error de inicio de sesión",
            status: "ABIERTO",
            assignedModeratorId: null,
          },
        })
        .mockResolvedValue({});

      const event: any = {
        pathParameters: { ticketId: "t-100" },
        headers: {
          "x-user-id": "mod-alpha",
          "x-user-role": "MODERATOR",
          "x-user-name": "Mod Alpha",
        },
        body: JSON.stringify({ text: "Hola, revisando tu caso ahora mismo." }),
      };

      const res = (await sendSupportTicketMessage(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.assignedModeratorId).toBe("mod-alpha");
      expect(sendPushToUser).toHaveBeenCalledWith("cand-777", expect.anything());
    });

    it("should accept 'message' property in body and persist both text and message", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: {
            ticketId: "t-100",
            userId: "cand-777",
            subject: "Error de inicio de sesión",
            status: "ABIERTO",
            assignedModeratorId: null,
          },
        })
        .mockResolvedValue({});

      const event: any = {
        pathParameters: { ticketId: "t-100" },
        headers: {
          "x-user-id": "cand-777",
          "x-user-role": "CANDIDATO",
        },
        body: JSON.stringify({ message: "Mensaje usando campo message" }),
      };

      const res = (await sendSupportTicketMessage(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.msg.text).toBe("Mensaje usando campo message");
      expect(data.msg.message).toBe("Mensaje usando campo message");
    });

    it("should BLOCK a second moderator if ticket is already assigned to another moderator", async () => {
      (docClient.send as any).mockResolvedValueOnce({
        Item: {
          ticketId: "t-100",
          userId: "cand-777",
          subject: "Error de inicio de sesión",
          status: "EN_ATENCION",
          assignedModeratorId: "mod-alpha",
          assignedModeratorName: "Mod Alpha",
        },
      });

      const event: any = {
        pathParameters: { ticketId: "t-100" },
        headers: {
          "x-user-id": "mod-beta",
          "x-user-role": "MODERATOR",
          "x-user-name": "Mod Beta",
        },
        body: JSON.stringify({ text: "Yo también quiero responder este ticket." }),
      };

      const res = (await sendSupportTicketMessage(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(403);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("Mod Alpha");
      expect(data.error).toContain("No se permite la intervención concurrente");
    });

    it("should allow ADMIN to intervene even if ticket is assigned to a moderator", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: {
            ticketId: "t-100",
            userId: "cand-777",
            subject: "Error",
            status: "EN_ATENCION",
            assignedModeratorId: "mod-alpha",
            assignedModeratorName: "Mod Alpha",
          },
        })
        .mockResolvedValue({});

      const event: any = {
        pathParameters: { ticketId: "t-100" },
        headers: {
          "x-user-id": "admin-super",
          "x-user-role": "ADMIN",
          "x-user-name": "Super Admin",
        },
        body: JSON.stringify({ text: "Mensaje administrativo de supervisión." }),
      };

      const res = (await sendSupportTicketMessage(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
    });
  });

  describe("claimSupportTicket & resolveSupportTicket", () => {
    it("should allow moderator to explicitly claim an open ticket", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: { ticketId: "t-200", status: "ABIERTO", assignedModeratorId: null },
        })
        .mockResolvedValue({});

      const event: any = {
        pathParameters: { ticketId: "t-200" },
        headers: {
          "x-user-id": "mod-1",
          "x-user-role": "MODERATOR",
          "x-user-name": "Moderador 1",
        },
        body: JSON.stringify({ action: "claim" }),
      };

      const res = (await claimSupportTicket(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.assignedModeratorId).toBe("mod-1");
    });

    it("should resolve ticket and notify owner", async () => {
      (docClient.send as any)
        .mockResolvedValueOnce({
          Item: {
            ticketId: "t-200",
            userId: "user-456",
            subject: "Bug en formulario",
            assignedModeratorId: "mod-1",
            assignedModeratorName: "Moderador 1",
          },
        })
        .mockResolvedValue({});

      const event: any = {
        pathParameters: { ticketId: "t-200" },
        headers: {
          "x-user-id": "mod-1",
          "x-user-role": "MODERATOR",
        },
        body: JSON.stringify({ notes: "Parche desplegado en producción." }),
      };

      const res = (await resolveSupportTicket(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(sendPushToUser).toHaveBeenCalledWith("user-456", expect.anything());
    });
  });
});
