import express from "express";
import Group from "../models/Group.js";
import User from "../models/User.js";
import Channel from "../models/Channel.js";
import { isValidObjectId } from "mongoose";

const router = express.Router();

// Middleware to verify authenticated user
const authMiddleware = (req, res, next) => {
  const userId = req.headers["user-id"]; // Replace with actual auth mechanism
  if (!userId || !isValidObjectId(userId)) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  req.userId = userId;
  next();
};

// Get all groups for a user
router.get("/groups", authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.userId }).populate("members", "displayName");
    res.json({ success: true, groups });
  } catch (error) {
    console.error("Get groups error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a group
router.post("/groups", authMiddleware, async (req, res) => {
  try {
    const { name, channelId, members = [], musicUrl } = req.body;

    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Group name must be at least 3 characters" });
    }
    if (!isValidObjectId(channelId)) {
      return res.status(400).json({ success: false, message: "Invalid channel ID" });
    }
    if (musicUrl && !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(musicUrl)) {
      return res.status(400).json({ success: false, message: "Invalid music URL format" });
    }
    if (!members.every(isValidObjectId)) {
      return res.status(400).json({ success: false, message: "Invalid member IDs" });
    }

    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }

    const validMembers = await User.find({ _id: { $in: members } });
    if (validMembers.length !== members.length) {
      return res.status(404).json({ success: false, message: "One or more members not found" });
    }

    const group = new Group({
      name,
      channelId,
      createdBy: req.userId,
      members: [...new Set([req.userId, ...members])],
      musicUrl: musicUrl || null,
    });

    await group.save();
    res.json({ success: true, group });
  } catch (error) {
    console.error("Create group error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;