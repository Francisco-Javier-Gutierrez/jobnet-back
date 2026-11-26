import { Router } from "express";
import jobsRoutes from "./jobs.routes";
import postsRoutes from "./posts.routes";
import profileRoutes from "./profile.routes";
import applicationsRoutes from "./applications.routes";
import chatsRoutes from "./chats.routes";
import moderatorRoutes from "./moderator.routes";
import catalogRoutes from "./catalog.routes";
import adminRoutes from "./admin.routes";
import supportRoutes from "./support.routes";
import miscRoutes from "./misc.routes";
import aiRoutes from "./ai.routes";

const router = Router();

router.use("/jobs", jobsRoutes);
router.use("/posts", postsRoutes);
router.use("/profile", profileRoutes);
router.use("/applications", applicationsRoutes);
router.use("/chats", chatsRoutes);
router.use("/moderator", moderatorRoutes);
router.use("/catalog", catalogRoutes);
router.use("/admin", adminRoutes);
router.use("/support", supportRoutes);
router.use("/candidate/my-applications", applicationsRoutes);
router.use("/ai", aiRoutes);
router.use("/", miscRoutes);

export default router;
