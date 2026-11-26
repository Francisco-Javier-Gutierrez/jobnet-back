import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getPosts, createPost, sharePost } from "../handlers/posts/postsCrud";
import {
  toggleLikePost,
  addCommentPost,
  deleteCommentPost,
  toggleBookmarkPost,
} from "../handlers/posts/interactions";

const router = Router();

// Posts CRUD
router.get("/", adaptHandler(getPosts));
router.post("/", adaptHandler(createPost));

// Post Interactions
router.post("/:id/like", adaptHandler(toggleLikePost));
router.post("/:id/comment", adaptHandler(addCommentPost));
router.delete("/:id/comment/:commentId", adaptHandler(deleteCommentPost));
router.post("/:id/bookmark", adaptHandler(toggleBookmarkPost));
router.post("/:id/share", adaptHandler(sharePost));

export default router;
