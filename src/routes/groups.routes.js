const express = require("express");
const jwt = require("jsonwebtoken");
const { isValidObjectId } = require("mongoose");
const { Group, User } = require("./models"); // Adjust path to your models

const router = express.Router();

// Shared in-memory storage for online users (populated by Socket.IO)
const onlineUsers = new Map();

// Middleware to verify JWT
const authMiddleware = async (req, res, next) => {
  const timestamp = new Date().toISOString();
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      console.error(`[AUTH_MIDDLEWARE_ERROR] No token provided, timestamp=${timestamp}`);
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your_jwt_secret");
    const user = await User.findById(decoded.userId);
    if (!user) {
      console.error(`[AUTH_MIDDLEWARE_ERROR] User not found: userId=${decoded.userId}, timestamp=${timestamp}`);
      return res.status(401).json({ success: false, message: "User not found" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(`[AUTH_MIDDLEWARE_ERROR] Invalid token: ${error.message}, timestamp=${timestamp}`);
    res.status(401).json({ success: false, message: "Invalid token", error: error.message });
  }
};

// GET /api/groups - List all groups for the authenticated user
router.get("/", authMiddleware, async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[GET_GROUPS] Fetching groups: userId=${req.user._id}, timestamp=${timestamp}`);
  try {
    const groups = await Group.find({
      $or: [
        { members: req.user._id },
        { admins: req.user._id },
        { createdBy: req.user._id },
      ],
    })
      .populate("members", "username profilePicture")
      .populate("admins", "username profilePicture")
      .populate("createdBy", "username profilePicture")
      .lean();

    const enrichedGroups = groups.map((group) => ({
      ...group,
      members: group.members.map((member) => ({
        ...member,
        status: onlineUsers.has(member._id.toString()) ? "online" : "offline",
      })),
      admins: group.admins.map((admin) => ({
        ...admin,
        status: onlineUsers.has(admin._id.toString()) ? "online" : "offline",
      })),
      createdBy: {
        ...group.createdBy,
        status: onlineUsers.has(group.createdBy._id.toString()) ? "online" : "offline",
      },
    }));

    console.log(`[GET_GROUPS] Found ${groups.length} groups for userId=${req.user._id}, timestamp=${timestamp}`);
    res.json({ success: true, data: enrichedGroups });
  } catch (error) {
    console.error(`[GET_GROUPS_ERROR] Error: ${error.message}, userId=${req.user._id}, timestamp=${timestamp}`);
    res.status(500).json({ success: false, message: "Failed to fetch groups", error: error.message });
  }
});

// GET /api/groups/:groupId - Get details of a specific group
router.get("/:groupId", authMiddleware, async (req, res) => {
  const timestamp = new Date().toISOString();
  const { groupId } = req.params;
  console.log(`[GET_GROUP_DETAILS] Fetching group: groupId=${groupId}, userId=${req.user._id}, timestamp=${timestamp}`);
  try {
    if (!isValidObjectId(groupId)) {
      console.error(`[GET_GROUP_DETAILS_ERROR] Invalid groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, message: "Invalid group ID" });
    }

    const group = await Group.findById(groupId)
      .populate("members", "username profilePicture")
      .populate("admins", "username profilePicture")
      .populate("createdBy", "username profilePicture")
      .lean();

    if (!group) {
      console.error(`[GET_GROUP_DETAILS_ERROR] Group not found: groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    const isMember = group.members.some((m) => m._id.toString() === req.user._id.toString());
    const isAdmin = group.admins.some((a) => a._id.toString() === req.user._id.toString());
    const isCreator = group.createdBy._id.toString() === req.user._id.toString();
    if (!isMember && !isAdmin && !isCreator) {
      console.error(`[GET_GROUP_DETAILS_ERROR] Not authorized: userId=${req.user._id}, groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(403).json({ success: false, message: "Not authorized to access this group" });
    }

    const enrichedGroup = {
      ...group,
      members: group.members.map((member) => ({
        ...member,
        status: onlineUsers.has(member._id.toString()) ? "online" : "offline",
      })),
      admins: group.admins.map((admin) => ({
        ...admin,
        status: onlineUsers.has(admin._id.toString()) ? "online" : "offline",
      })),
      createdBy: {
        ...group.createdBy,
        status: onlineUsers.has(group.createdBy._id.toString()) ? "online" : "offline",
      },
    };

    console.log(`[GET_GROUP_DETAILS] Group fetched: groupId=${groupId}, timestamp=${timestamp}`);
    res.json({ success: true, data: enrichedGroup });
  } catch (error) {
    console.error(`[GET_GROUP_DETAILS_ERROR] Error: ${error.message}, userId=${req.user._id}, timestamp=${timestamp}`);
    res.status(500).json({ success: false, message: "Failed to fetch group details", error: error.message });
  }
});

module.exports = router;