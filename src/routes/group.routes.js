import express from "express";
import Group from "../models/Group.js";
import User from "../models/User.js";
import Channel from "../models/Channel.js";
import Chat from "../models/Chat.js";
import { isValidObjectId } from "mongoose";

const router = express.Router();

// Middleware to verify authenticated user
const authMiddleware = (req, res, next) => {
  const userId = req.headers["user-id"]; 
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

    // Emit Socket.IO event
    group.members.forEach((memberId) => {
      const memberSocketId = req.onlineUsers.get(memberId.toString());
      if (memberSocketId) {
        req.io.to(memberSocketId).emit("group_created", { group });
        if (group.musicUrl) {
          req.io.to(memberSocketId).emit("play_group_music", { groupId: group._id, musicUrl: group.musicUrl });
        }
      }
    });

    res.json({ success: true, group });
  } catch (error) {
    console.error("Create group error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update a group
router.put("/groups/:groupId", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, musicUrl } = req.body;
    const userId = req.userId;

    if (!isValidObjectId(groupId)) {
      return res.status(400).json({ success: false, message: "Invalid group ID" });
    }
    if (name && name.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Group name must be at least 3 characters" });
    }
    if (musicUrl && !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(musicUrl)) {
      return res.status(400).json({ success: false, message: "Invalid music URL format" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }
    if (group.createdBy.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (name) group.name = name;
    if (musicUrl !== undefined) group.musicUrl = musicUrl || null;
    group.updatedAt = Date.now();
    await group.save();

    // Emit Socket.IO event
    req.io.to(`group_${groupId}`).emit("group_updated", { group });

    res.json({ success: true, group });
  } catch (error) {
    console.error("Update group error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Add members to a group
router.post("/groups/:groupId/members", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberIds } = req.body;
    const userId = req.userId;

    if (!isValidObjectId(groupId)) {
      return res.status(400).json({ success: false, message: "Invalid group ID" });
    }
    if (!memberIds.every(isValidObjectId)) {
      return res.status(400).json({ success: false, message: "Invalid member IDs" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }
    if (group.createdBy.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const validMembers = await User.find({ _id: { $in: memberIds } });
    if (validMembers.length !== memberIds.length) {
      return res.status(404).json({ success: false, message: "One or more members not found" });
    }

    const existingMembers = group.members.map((id) => id.toString());
    const newMembers = memberIds.filter((id) => !existingMembers.includes(id));

    if (newMembers.length > 0) {
      group.members.push(...newMembers);
      group.updatedAt = Date.now();
      await group.save();

      // Emit Socket.IO events
      const groupRoom = `group_${groupId}`;
      newMembers.forEach((memberId) => {
        const memberSocketId = req.onlineUsers.get(memberId);
        if (memberSocketId) {
          req.io.to(memberSocketId).emit("added_to_group", { group });
          req.io.to(memberSocketId).emit("auto_join_group", { groupId });
          if (group.musicUrl) {
            req.io.to(memberSocketId).emit("play_group_music", { groupId, musicUrl: group.musicUrl });
          }
        }
      });
      group.members.forEach((memberId) => {
        const memberSocketId = req.onlineUsers.get(memberId.toString());
        if (memberSocketId && memberId.toString() !== userId) {
          req.io.to(memberSocketId).emit("group_members_added", { groupId, newMembers });
        }
      });
    }

    res.json({ success: true, group });
  } catch (error) {
    console.error("Add group members error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Remove a member from a group
router.delete("/groups/:groupId/members/:memberId", authMiddleware, async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const userId = req.userId;

    if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
      return res.status(400).json({ success: false, message: "Invalid group or member ID" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }
    if (group.createdBy.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (memberId === group.createdBy.toString()) {
      return res.status(400).json({ success: false, message: "Cannot remove group creator" });
    }

    group.members = group.members.filter((id) => id.toString() !== memberId);
    group.updatedAt = Date.now();
    await group.save();

    // Emit Socket.IO events
    const removedSocketId = req.onlineUsers.get(memberId);
    if (removedSocketId) {
      req.io.to(removedSocketId).emit("removed_from_group", { groupId });
      req.io.to(removedSocketId).emit("stop_group_music", { groupId });
      req.io.sockets.sockets.get(removedSocketId)?.leave(`group_${groupId}`);
    }
    group.members.forEach((mId) => {
      const memberSocketId = req.onlineUsers.get(mId.toString());
      if (memberSocketId) {
        req.io.to(memberSocketId).emit("group_member_removed", { groupId, removedMember: memberId });
      }
    });

    res.json({ success: true, group });
  } catch (error) {
    console.error("Remove group member error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete a group
router.delete("/groups/:groupId", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;

    if (!isValidObjectId(groupId)) {
      return res.status(400).json({ success: false, message: "Invalid group ID" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }
    if (group.createdBy.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    await Group.deleteOne({ _id: groupId });
    await Chat.deleteMany({ groupId });

    // Emit Socket.IO event
    req.io.to(`group_${groupId}`).emit("group_deleted", { groupId });

    res.json({ success: true, message: "Group deleted" });
  } catch (error) {
    console.error("Delete group error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get all channels for a user
router.get("/channels", authMiddleware, async (req, res) => {
  try {
    const channels = await Channel.find({
      $or: [{ members: req.userId }, { admins: req.userId }],
    }).populate("admins members", "displayName");
    res.json({ success: true, channels });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a channel
router.post("/channels", authMiddleware, async (req, res) => {
  try {
    const { name, members = [] } = req.body;
    const userId = req.userId;

    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Channel name must be at least 3 characters" });
    }
    if (!members.every(isValidObjectId)) {
      return res.status(400).json({ success: false, message: "Invalid member IDs" });
    }

    const validMembers = await User.find({ _id: { $in: members } });
    if (validMembers.length !== members.length) {
      return res.status(404).json({ success: false, message: "One or more members not found" });
    }

    const channel = new Channel({
      name,
      admins: [userId],
      members: [...new Set([userId, ...members])],
      createdAt: Date.now(),
    });

    await channel.save();

    // Emit Socket.IO event
    channel.members.forEach((memberId) => {
      const memberSocketId = req.onlineUsers.get(memberId.toString());
      if (memberSocketId) {
        req.io.to(memberSocketId).emit("channel_created", { channel });
      }
    });

    res.json({ success: true, channel });
  } catch (error) {
    console.error("Create channel error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Add members to a channel
router.post("/channels/:channelId/members", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { memberIds } = req.body;
    const userId = req.userId;

    if (!isValidObjectId(channelId)) {
      return res.status(400).json({ success: false, message: "Invalid channel ID" });
    }
    if (!memberIds.every(isValidObjectId)) {
      return res.status(400).json({ success: false, message: "Invalid member IDs" });
    }

    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }
    if (!channel.admins.includes(userId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const validMembers = await User.find({ _id: { $in: memberIds } });
    if (validMembers.length !== memberIds.length) {
      return res.status(404).json({ success: false, message: "One or more members not found" });
    }

    const existingMembers = channel.members.map((id) => id.toString());
    const newMembers = memberIds.filter((id) => !existingMembers.includes(id));

    if (newMembers.length > 0) {
      channel.members.push(...newMembers);
      await channel.save();

      // Emit Socket.IO events
      newMembers.forEach((memberId) => {
        const memberSocketId = req.onlineUsers.get(memberId);
        if (memberSocketId) {
          req.io.to(memberSocketId).emit("added_to_channel", { channel });
        }
      });
      req.io.to(`channel_${channelId}`).emit("channel_members_added", { channelId, newMembers });
    }

    res.json({ success: true, channel });
  } catch (error) {
    console.error("Add channel members error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Remove a member from a channel
router.delete("/channels/:channelId/members/:memberId", authMiddleware, async (req, res) => {
  try {
    const { channelId, memberId } = req.params;
    const userId = req.userId;

    if (!isValidObjectId(channelId) || !isValidObjectId(memberId)) {
      return res.status(400).json({ success: false, message: "Invalid channel or member ID" });
    }

    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }
    if (!channel.admins.includes(userId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    channel.members = channel.members.filter((id) => id.toString() !== memberId);
    await channel.save();

    // Emit Socket.IO events
    const removedSocketId = req.onlineUsers.get(memberId);
    if (removedSocketId) {
      req.io.to(removedSocketId).emit("removed_from_channel", { channelId });
      req.io.sockets.sockets.get(removedSocketId)?.leave(`channel_${channelId}`);
    }
    req.io.to(`channel_${channelId}`).emit("channel_member_removed", { channelId, removedMember: memberId });

    res.json({ success: true, channel });
  } catch (error) {
    console.error("Remove channel member error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get group messages
router.get("/groups/:groupId/messages", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const userId = req.userId;

    if (!isValidObjectId(groupId)) {
      return res.status(400).json({ success: false, message: "Invalid group ID" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }
    if (!group.members.includes(userId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const skip = (page - 1) * limit;
    const messages = await Chat.find({ groupId })
      .populate("senderId", "displayName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    const unreadMessages = messages.filter(
      (msg) => msg.senderId.toString() !== userId && msg.status === "sent"
    );
    if (unreadMessages.length > 0) {
      const unreadIds = unreadMessages.map((msg) => msg._id);
      await Chat.updateMany({ _id: { $in: unreadIds } }, { status: "delivered" });
      req.io.to(`group_${groupId}`).emit("message_status_update", {
        messageIds: unreadIds,
        status: "delivered",
      });
    }

    res.json({
      success: true,
      messages: messages.reverse(),
      hasMore: messages.length === Number(limit),
    });
  } catch (error) {
    console.error("Get group messages error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get channel messages
router.get("/channels/:channelId/messages", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const userId = req.userId;

    if (!isValidObjectId(channelId)) {
      return res.status(400).json({ success: false, message: "Invalid channel ID" });
    }

    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }
    if (!channel.members.includes(userId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const skip = (page - 1) * limit;
    const messages = await Chat.find({ channelId })
      .populate("senderId", "displayName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    res.json({
      success: true,
      messages: messages.reverse(),
      hasMore: messages.length === Number(limit),
    });
  } catch (error) {
    console.error("Get channel messages error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete a message
router.delete("/messages/:messageId", authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { forEveryone = false } = req.body;
    const userId = req.userId;

    if (!isValidObjectId(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message ID" });
    }

    const message = await Chat.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    if (forEveryone && message.senderId.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized to delete for everyone" });
    }

    if (forEveryone) {
      message.content = "This message was deleted";
      message.deletedFor = [];
    } else {
      if (!message.deletedFor.includes(userId)) {
        message.deletedFor.push(userId);
      }
    }

    await message.save();

    // Emit Socket.IO event
    const room = message.groupId ? `group_${message.groupId}` : `channel_${message.channelId}`;
    req.io.to(room).emit("message_deleted", { message });

    res.json({ success: true, message });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get contacts
router.get("/contacts", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const contacts = await User.find({ _id: { $ne: userId } }).select("displayName phone");
    res.json({ success: true, contacts });
  } catch (error) {
    console.error("Get contacts error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get user profile
router.get("/users/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    const user = await User.findById(userId).select("displayName phone avatarUrl online lastSeen");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;