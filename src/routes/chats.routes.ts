import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import { getChatMessages, sendChatMessageHttp } from "../handlers/wsHandlers";

const router = Router();

router.get("/:jobId/:candidateId/messages", adaptHandler(getChatMessages));
router.post("/:jobId/:candidateId/messages", adaptHandler(sendChatMessageHttp));

export default router;
