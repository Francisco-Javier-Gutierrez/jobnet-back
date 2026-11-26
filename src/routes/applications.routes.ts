import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getMyApplications, updateApplicationStatus } from "../handlers/applications";

const router = Router();

router.get("/", adaptHandler(getMyApplications));
router.get("/my-applications", adaptHandler(getMyApplications));
router.put("/:jobId/:candidateId/status", adaptHandler(updateApplicationStatus));

export default router;
