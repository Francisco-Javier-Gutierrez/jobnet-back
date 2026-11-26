import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getTermsVersion } from "../handlers/admin";
import { getVapidPublicKey, listProfiles } from "../handlers/profile";
import { getUserAiCooldown } from "../handlers/applications";
import {
  getUploadPresignedUrl,
  getViewPresignedUrl,
  sendNotificationEmail,
} from "../handlers/jobs/uploads";

const router = Router();

// Storage Presigned URLs & Email Notification
router.get("/upload-url", adaptHandler(getUploadPresignedUrl));
router.get("/view-url", adaptHandler(getViewPresignedUrl));
router.post("/notify", adaptHandler(sendNotificationEmail));

// AI Cooldown status (per user TTL)
router.get("/ai/cooldown", adaptHandler(getUserAiCooldown));

// Public Profiles Directory
router.get("/profiles", adaptHandler(listProfiles));

// Terms Version
router.get("/terms/version", adaptHandler(getTermsVersion));

// VAPID Public Key for Web Push
router.get("/push/vapid-key", adaptHandler(getVapidPublicKey));

export default router;
