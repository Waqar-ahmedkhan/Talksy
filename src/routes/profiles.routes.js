import express from "express";
import {
  authenticateToken,
  createProfile,
  getMyProfile,
  getPublicProfiles,
  getProfilesFromContacts,
  getProfileWithChat,
  getChatList, // Added
  deleteUserChat,
} from "../controllers/profiles.controller.js";

const router = express.Router();

// Protected routes

router.post("/delete-chat", authenticateToken, deleteUserChat);
router.post("/", authenticateToken, createProfile);
router.get("/me", authenticateToken, getMyProfile);
router.post("/contacts", authenticateToken, getProfilesFromContacts);
router.get("/with-chat/:phone", authenticateToken, getProfileWithChat);
router.get("/chats", authenticateToken, getChatList);

// Public routes
router.get("/public", getPublicProfiles);

export default router;
