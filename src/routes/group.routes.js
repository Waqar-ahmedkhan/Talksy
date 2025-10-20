import express from "express";
import { authenticateToken } from "../controllers/profiles.controller.js";
import { getGroupChatList } from "../controllers/group.controller.js";

const router = express.Router();

router.get("/chats", authenticateToken, getGroupChatList);

export default router;
