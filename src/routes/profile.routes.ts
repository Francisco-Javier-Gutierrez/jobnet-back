import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import {
  getProfile,
  updateProfile,
  getProfileVacancies,
  getProfilePosts,
  getProfileBookmarks,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  savePushSubscription,
  deletePushSubscription,
  notifyCvInteraction,
} from "../handlers/profile";

const router = Router();

// Profile CRUD & Sub-resources
router.get("/:id", adaptHandler(getProfile));
router.post("/:id", adaptHandler(updateProfile));
router.get("/:id/vacancies", adaptHandler(getProfileVacancies));
router.get("/:id/posts", adaptHandler(getProfilePosts));
router.get("/:id/bookmarks", adaptHandler(getProfileBookmarks));

// In-app Notifications
router.get("/:id/notifications", adaptHandler(getNotifications));
router.post("/:id/notifications/read-all", adaptHandler(markAllNotificationsRead));
router.post("/:id/notifications/:notifId/read", adaptHandler(markNotificationRead));

// Push Subscriptions
router.post("/:id/push-subscriptions", adaptHandler(savePushSubscription));
router.delete("/:id/push-subscriptions", adaptHandler(deletePushSubscription));

// Candidate CV Interaction Alert
router.post("/:id/cv-interaction", adaptHandler(notifyCvInteraction));

export default router;
