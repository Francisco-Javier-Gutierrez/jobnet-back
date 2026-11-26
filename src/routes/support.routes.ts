import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import {
  createSupportTicket,
  getMySupportTickets,
  getAllSupportTickets,
  getSupportTicketMessages,
  sendSupportTicketMessage,
  claimSupportTicket,
  resolveSupportTicket,
} from "../handlers/support/tickets";

const router = Router();

// User & Community Support Routes
router.post("/tickets", adaptHandler(createSupportTicket));
router.get("/my-tickets", adaptHandler(getMySupportTickets));
router.get("/tickets", adaptHandler(getAllSupportTickets));
router.get("/tickets/:ticketId/messages", adaptHandler(getSupportTicketMessages));
router.post("/tickets/:ticketId/messages", adaptHandler(sendSupportTicketMessage));
router.post("/tickets/:ticketId/claim", adaptHandler(claimSupportTicket));
router.post("/tickets/:ticketId/resolve", adaptHandler(resolveSupportTicket));

export default router;
