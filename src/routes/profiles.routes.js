import express from "express";
import {
  authenticateToken,
  createProfile,
  getMyProfile,
  getPublicProfiles,
  getProfilesFromContacts
} from "../controllers/profiles.controller.js";

const router = express.Router();

// Protected routes
router.post("/", authenticateToken, createProfile);        // Create or update profile
router.get("/me", authenticateToken, getMyProfile);       // Get current user's profile
router.post("/contacts", authenticateToken, getProfilesFromContacts); // Get profiles from contacts

// Public routes
router.get("/public", getPublicProfiles);                 // Get public profiles

export default router;
