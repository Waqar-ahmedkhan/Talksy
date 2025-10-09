// routes/profileRoutes.js
import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  createProfile,
  getMyProfile,
  getPublicProfiles,
  getProfilesFromContacts,
  getProfileWithChat,
  getChatList,
  upsertContact,
  deleteContact,
  sendMessage,
  deleteConversation,
  deleteMyProfile,
} from "../controllers/profiles.controller.js";

const router = Router();

router.use(authMiddleware);

router.post("/profile", createProfile);
router.get("/profile/me", getMyProfile);
router.get("/profiles/public", getPublicProfiles);
router.post("/profiles/contacts", getProfilesFromContacts);
router.get("/profile/:phone/chat", getProfileWithChat);
router.get("/chats", getChatList);
router.post("/contacts", upsertContact);
router.delete("/contacts/:phone", deleteContact);
router.post("/send-message", sendMessage);
router.delete("/conversation/:phone", deleteConversation);
router.delete("/profile/me", deleteMyProfile);

export default router;
