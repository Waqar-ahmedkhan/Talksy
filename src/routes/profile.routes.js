import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  requestOtp,
  verifyOtp
} from "../controllers/auth.controller.js";
import {
  createProfile,
  getMyProfile,
  getPublicProfiles
} from "../controllers/profiles.controller.js";
import { getUsers } from "../controllers/user.controller.js";

const router = express.Router();

// -------------------- Auth Routes --------------------
// Public routes for authentication
router.post("/request-otp", requestOtp); // Initiate OTP request
router.post("/verify-otp", verifyOtp);   // Verify OTP and get JWT token

// -------------------- User Routes --------------------
// Protected route: Get all users (requires JWT)
router.get("/users", authMiddleware, getUsers);

// -------------------- Profile Routes --------------------
// Protected route: Create or update your profile
router.post("/profiles", authMiddleware, createProfile);

// Protected route: Get logged-in user's profile
router.get("/profiles/me", authMiddleware, getMyProfile);

// Public route: Get public profiles (no auth needed)
router.get("/profiles/public", getPublicProfiles);

export default router;
