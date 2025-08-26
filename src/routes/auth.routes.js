import express from "express";
import { requestOtp, verifyOtp } from "../controllers/auth.controller.js";

const router = express.Router();

// Public auth routes
router.post("/request-otp", requestOtp);
router.post("/verify-otp", verifyOtp);

export default router;
