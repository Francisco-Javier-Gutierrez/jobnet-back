import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getAdminAnalytics, getTermsHistory, updateTermsAndBroadcast } from "../handlers/admin";
import { getPushSubscribers, sendCustomPushNotification } from "../handlers/profile";

const router = Router();

router.get("/analytics", adaptHandler(getAdminAnalytics));
router.get("/terms/history", adaptHandler(getTermsHistory));
router.post("/terms/update", adaptHandler(updateTermsAndBroadcast));
router.get("/push-subscribers", adaptHandler(getPushSubscribers));
router.post("/push-broadcast", adaptHandler(sendCustomPushNotification));

export default router;
