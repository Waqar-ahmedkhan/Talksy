import express from "express";
import mongoose from "mongoose";
import Block from "../models/Block.js";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import { authenticateToken, formatProfile, normalizePhoneNumber } from "../controllers/profiles.controller.js";

const router = express.Router();

// POST /api/blocks - Block a user
router.post("/", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[blockUser] Processing request: body=${JSON.stringify(req.body)}, userId=${req.user._id}, timestamp=${timestamp}`);
    const { blockedPhone } = req.body;
    const blockerId = req.user._id;

    if (!blockedPhone) {
      console.error(`[blockUser] Missing blockedPhone, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Blocked phone number is required" });
    }

    const normalizedBlockedPhone = normalizePhoneNumber(blockedPhone);
    if (!/^\+?[1-9]\d{1,14}$/.test(normalizedBlockedPhone)) {
      console.error(`[blockUser] Invalid phone number format: ${normalizedBlockedPhone}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid phone number format" });
    }

    const blockedProfile = await Profile.findOne({ phone: normalizedBlockedPhone });
    if (!blockedProfile) {
      console.error(`[blockUser] Profile not found: phone=${normalizedBlockedPhone}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Target user not found" });
    }

    const blockedId = blockedProfile._id;
    if (blockedId.toString() === blockerId.toString()) {
      console.error(`[blockUser] Self-blocking attempted: userId=${blockerId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot block yourself" });
    }

    const existingBlock = await Block.findOne({ blockerId, blockedId });
    if (existingBlock) {
      console.warn(`[blockUser] User already blocked: blockerId=${blockerId}, blockedId=${blockedId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "User already blocked" });
    }

    const block = new Block({ blockerId, blockedId });
    await block.save();
    console.log(`[blockUser] Block created: blockerId=${blockerId}, blockedId=${blockedId}, timestamp=${timestamp}`);

    // Emit Socket.IO event
    const io = req.app.locals.io;
    const blockedUser = await User.findOne({ phone: normalizedBlockedPhone });
    if (blockedUser) {
      io.to(blockedUser._id.toString()).emit("blocked_update", {
        blockerId: blockerId.toString(),
        blocked: true,
      });
      console.log(`[blockUser] Emitted blocked_update to blockedId=${blockedId}, timestamp=${timestamp}`);
    }

    const contact = await Contact.findOne({ userId: blockerId, phone: normalizedBlockedPhone }).select("customName");
    const customName = contact?.customName || null;
    const blockedProfileFormatted = formatProfile(blockedProfile, blockedUser, customName);
    return res.status(201).json({
      success: true,
      message: "User blocked successfully",
      blockedProfile: blockedProfileFormatted,
    });
  } catch (err) {
    console.error(`[blockUser] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// DELETE /api/blocks/:blockedId - Unblock a user
router.delete("/:blockedId", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[unblockUser] Processing request: blockedId=${req.params.blockedId}, userId=${req.user._id}, timestamp=${timestamp}`);
    const blockerId = req.user._id;
    const blockedId = req.params.blockedId;

    if (!mongoose.isValidObjectId(blockedId)) {
      console.error(`[unblockUser] Invalid blockedId format: ${blockedId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid blocked user ID" });
    }

    if (blockedId === blockerId.toString()) {
      console.error(`[unblockUser] Self-unblocking attempted: userId=${blockerId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot unblock yourself" });
    }

    const result = await Block.deleteOne({ blockerId, blockedId });
    if (result.deletedCount === 0) {
      console.warn(`[unblockUser] Block not found: blockerId=${blockerId}, blockedId=${blockedId}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Block not found" });
    }

    console.log(`[unblockUser] Block removed: blockerId=${blockerId}, blockedId=${blockedId}, timestamp=${timestamp}`);

    // Emit Socket.IO event
    const io = req.app.locals.io;
    io.to(blockedId).emit("blocked_update", {
      blockerId: blockerId.toString(),
      blocked: false,
    });
    console.log(`[unblockUser] Emitted blocked_update to blockedId=${blockedId}, timestamp=${timestamp}`);

    const blockedProfile = await Profile.findById(blockedId);
    const blockedUser = await User.findById(blockedId);
    const contact = await Contact.findOne({ userId: blockerId, phone: blockedProfile?.phone }).select("customName");
    const customName = contact?.customName || null;
    const blockedProfileFormatted = formatProfile(blockedProfile, blockedUser, customName);

    return res.json({
      success: true,
      message: "User unblocked successfully",
      blockedProfile: blockedProfileFormatted,
    });
  } catch (err) {
    console.error(`[unblockUser] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// GET /api/blocks - Get list of blocked users
router.get("/", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[getBlockedUsers] Processing request: userId=${req.user._id}, timestamp=${timestamp}`);
    const blockerId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    if (page < 1 || limit < 1 || limit > 100) {
      console.error(`[getBlockedUsers] Invalid pagination: page=${page}, limit=${limit}, timestamp=${timestamp}`);
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }

    const blocks = await Block.find({ blockerId })
      .skip(skip)
      .limit(limit)
      .populate("blockedId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken");
    console.log(`[getBlockedUsers] Found ${blocks.length} blocked users, timestamp=${timestamp}`);

    const blockedUserIds = blocks.map((block) => block.blockedId._id.toString());
    const users = await User.find({ _id: { $in: blockedUserIds } }).select("phone online lastSeen fcmToken");
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const contacts = await Contact.find({
      userId: blockerId,
      phone: { $in: users.map((u) => u.phone) },
    }).select("phone customName");
    const contactMap = new Map(contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null]));

    const blockedProfiles = blocks.map((block) => {
      const blockedProfile = block.blockedId;
      const blockedUser = userMap.get(blockedProfile._id.toString());
      const customName = contactMap.get(normalizePhoneNumber(blockedProfile.phone));
      return formatProfile(blockedProfile, blockedUser, customName);
    });

    return res.json({
      success: true,
      page,
      limit,
      total: await Block.countDocuments({ blockerId }),
      blockedProfiles,
    });
  } catch (err) {
    console.error(`[getBlockedUsers] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// GET /api/blocks/status/:blockedId - Check block status
router.get("/status/:blockedId", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[checkBlockStatus] Processing request: blockedId=${req.params.blockedId}, userId=${req.user._id}, timestamp=${timestamp}`);
    const blockerId = req.user._id;
    const blockedId = req.params.blockedId;

    if (!mongoose.isValidObjectId(blockedId)) {
      console.error(`[checkBlockStatus] Invalid blockedId format: ${blockedId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid blocked user ID" });
    }

    if (blockedId === blockerId.toString()) {
      console.error(`[checkBlockStatus] Self-check attempted: userId=${blockerId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot check block status for yourself" });
    }

    const block = await Block.findOne({ blockerId, blockedId });
    console.log(`[checkBlockStatus] Block ${block ? "found" : "not found"}: blockerId=${blockerId}, blockedId=${blockedId}, timestamp=${timestamp}`);

    return res.json({
      success: true,
      isBlocked: !!block,
      blockedId,
    });
  } catch (err) {
    console.error(`[checkBlockStatus] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

export default router;