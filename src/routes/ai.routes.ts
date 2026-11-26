import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getUserAiCooldown } from "../handlers/applications";

const router = Router();

// AI Cooldown status (per user TTL)
router.get("/cooldown", adaptHandler(getUserAiCooldown));

export default router;
