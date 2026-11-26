import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import {
  getAuditLogs,
  getBlockedDomains,
  getModeratorConcurrencyAlerts,
  getVerificationRequests,
  resolveVerification,
  initiateSuspension,
  cancelSuspension,
  confirmSuspension,
  toggleUserBlock,
  getSuspensionStatus,
  getAppeals,
  joinAppeal,
  getIncidents,
  createIncident,
  resolveIncident,
  openIncidentAudit,
  getIncidentAuditChat,
  submitIncidentAuditDictum,
  getSuggestedSkills,
  createSkillSuggestion,
  resolveSkillSuggestion,
} from "../handlers/moderator";
import { getAppealMessages, sendAppealMessageHttp } from "../handlers/wsHandlers";

const router = Router();

// Logs & Governance
router.get("/audit-logs", adaptHandler(getAuditLogs));
router.get("/blocked-domains", adaptHandler(getBlockedDomains));
router.get("/concurrency-alerts", adaptHandler(getModeratorConcurrencyAlerts));

// Verification Requests
router.get("/verifications", adaptHandler(getVerificationRequests));
router.post("/verifications/:companyId/resolve", adaptHandler(resolveVerification));

// Suspensions & Blocks
router.post("/organizations/:id/initiate-suspension", adaptHandler(initiateSuspension));
router.post("/organizations/:id/cancel-suspension", adaptHandler(cancelSuspension));
router.post("/organizations/:id/confirm-suspension", adaptHandler(confirmSuspension));
router.post("/users/:id/block", adaptHandler(toggleUserBlock));
router.get("/organizations/:id/suspension-status", adaptHandler(getSuspensionStatus));

// Appeals
router.get("/appeals", adaptHandler(getAppeals));
router.post("/organizations/:id/join-appeal", adaptHandler(joinAppeal));
router.get("/appeals/:id/messages", adaptHandler(getAppealMessages));
router.post("/appeals/:id/messages", adaptHandler(sendAppealMessageHttp));

// Incidents & Chat Audits
router.get("/incidents", adaptHandler(getIncidents));
router.post("/incidents", adaptHandler(createIncident));
router.post("/incidents/:incidentId/resolve", adaptHandler(resolveIncident));
router.post("/incidents/:incidentId/open-audit", adaptHandler(openIncidentAudit));
router.get("/incidents/:incidentId/audit-chat", adaptHandler(getIncidentAuditChat));
router.post("/incidents/:incidentId/audit-dictum", adaptHandler(submitIncidentAuditDictum));

// Skills Suggestions
router.get("/skills/suggestions", adaptHandler(getSuggestedSkills));
router.post("/skills/suggestions", adaptHandler(createSkillSuggestion));
router.post("/skills/suggestions/:id/resolve", adaptHandler(resolveSkillSuggestion));

export default router;
