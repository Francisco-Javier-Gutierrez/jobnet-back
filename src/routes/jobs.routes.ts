import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
  checkVacancyExpirations,
} from "../handlers/jobs/vacancies";
import {
  toggleLikeJob,
  addCommentJob,
  deleteCommentJob,
  toggleBookmarkJob,
  shareJob,
} from "../handlers/jobs/interactions";
import {
  applyToJob,
  getJobApplicants,
  getJobAiRanking,
  rankJobApplicantsWithAi,
} from "../handlers/applications";

const router = Router();

// Vacancies CRUD
router.get("/", adaptHandler(getJobs));
router.post("/", adaptHandler(createJob));
router.get("/check-expirations", adaptHandler(checkVacancyExpirations));
router.post("/check-expirations", adaptHandler(checkVacancyExpirations));
router.get("/:id", adaptHandler(getJobById));
router.put("/:id", adaptHandler(updateJob));
router.delete("/:id", adaptHandler(deleteJob));

// Vacancy Interactions
router.post("/:id/like", adaptHandler(toggleLikeJob));
router.post("/:id/comment", adaptHandler(addCommentJob));
router.delete("/:id/comment/:commentId", adaptHandler(deleteCommentJob));
router.post("/:id/bookmark", adaptHandler(toggleBookmarkJob));
router.post("/:id/share", adaptHandler(shareJob));

// Vacancy Applications & AI Ranking
router.post("/:id/apply", adaptHandler(applyToJob));
router.get("/:id/applicants", adaptHandler(getJobApplicants));
router.get("/:id/ai-ranking", adaptHandler(getJobAiRanking));
router.post("/:id/ai-ranking", adaptHandler(rankJobApplicantsWithAi));

export default router;
