import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getUsers } from "../controllers/user.controller.js";

const router = express.Router();

// Protected route
router.get("/", authMiddleware, getUsers); // Get all users

export default router;
