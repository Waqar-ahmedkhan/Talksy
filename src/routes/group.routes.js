// routes/groups.js
import express from "express";
import mongoose from "mongoose";
import Group from "../models/Group.js";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import Block from "../models/Block.js";
import { authenticateToken, formatProfile, normalizePhoneNumber } from "../controllers/profiles.controller.js";

const router = express.Router();

// GET /api/groups - Get all groups for the authenticated user
router.get("/", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[getGroups] Processing request: userId=${req.user._id}, timestamp=${timestamp}`);
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    if (page < 1 || limit < 1 || limit > 100) {
      console.error(`[getGroups] Invalid pagination: page=${page}, limit=${limit}, timestamp=${timestamp}`);
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }

    // Find groups where the user is a member
    const groups = await Group.find({ members: userId })
      .skip(skip)
      .limit(limit)
      .populate("members", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken")
      .populate("admins", "phone displayName")
      .populate("createdBy", "phone displayName")
      .sort({ updatedAt: -1 });

    console.log(`[getGroups] Found ${groups.length} groups for userId=${userId}, timestamp=${timestamp}`);

    // Fetch blocked users to include block status
    const blockedUsers = await Block.find({ blockerId: userId }).select("blockedId");
    const blockedUserIds = new Set(blockedUsers.map(block => block.blockedId.toString()));

    // Fetch contacts for custom names
    const phoneNumbers = groups.flatMap(group => group.members.map(member => normalizePhoneNumber(member.phone)));
    const contacts = await Contact.find({ userId, phone: { $in: phoneNumbers } }).select("phone customName");
    const contactMap = new Map(contacts.map(c => [normalizePhoneNumber(c.phone), c.customName || null]));

    // Fetch user data for online/lastSeen status
    const userIds = groups.flatMap(group => group.members.map(member => member._id));
    const users = await User.find({ _id: { $in: userIds } }).select("phone online lastSeen fcmToken");
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Format group data
    const formattedGroups = groups.map(group => ({
      id: group._id,
      name: group.name,
      channelId: group.channelId || null,
      pictureUrl: group.pictureUrl || null,
      musicUrl: group.musicUrl || null,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      createdBy: formatProfile(group.createdBy, userMap.get(group.createdBy?._id?.toString()), contactMap.get(normalizePhoneNumber(group.createdBy?.phone))),
      admins: group.admins.map(admin => formatProfile(admin, userMap.get(admin._id.toString()), contactMap.get(normalizePhoneNumber(admin.phone)))),
      members: group.members.map(member => {
        const memberUser = userMap.get(member._id.toString());
        return {
          ...formatProfile(member, memberUser, contactMap.get(normalizePhoneNumber(member.phone))),
          isBlocked: blockedUserIds.has(member._id.toString()),
        };
      }),
    }));

    return res.json({
      success: true,
      page,
      limit,
      total: await Group.countDocuments({ members: userId }),
      groups: formattedGroups,
    });
  } catch (err) {
    console.error(`[getGroups] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// POST /api/groups - Create a new group
router.post("/", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[createGroup] Processing request: body=${JSON.stringify(req.body)}, userId=${req.user._id}, timestamp=${timestamp}`);
    const { name, memberPhones, pictureUrl, musicUrl } = req.body;
    const userId = req.user._id;

    if (!name?.trim() || name.length < 3) {
      console.error(`[createGroup] Invalid group name: ${name}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Group name must be at least 3 characters" });
    }

    if (!Array.isArray(memberPhones) || memberPhones.length === 0) {
      console.error(`[createGroup] Invalid memberPhones: ${memberPhones}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "At least one member phone number is required" });
    }

    // Normalize and validate phone numbers
    const normalizedPhones = memberPhones.map(phone => normalizePhoneNumber(phone));
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    const invalidPhones = normalizedPhones.filter(phone => !phoneRegex.test(phone));
    if (invalidPhones.length > 0) {
      console.error(`[createGroup] Invalid phone numbers: ${invalidPhones}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid phone numbers", invalidPhones });
    }

    // Fetch profiles for members
    const profiles = await Profile.find({ phone: { $in: normalizedPhones } });
    const profileMap = new Map(profiles.map(p => [normalizePhoneNumber(p.phone), p]));
    const missingPhones = normalizedPhones.filter(phone => !profileMap.has(phone));
    if (missingPhones.length > 0) {
      console.error(`[createGroup] Profiles not found for phones: ${missingPhones}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Some users not found", missingPhones });
    }

    // Check for blocked users
    const blockedUsers = await Block.find({ blockerId: userId, blockedId: { $in: profiles.map(p => p._id) } });
    if (blockedUsers.length > 0) {
      console.error(`[createGroup] Cannot add blocked users: ${blockedUsers.map(b => b.blockedId)}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot add blocked users to group" });
    }

    // Create group
    const group = new Group({
      name: name.trim(),
      createdBy: userId,
      members: [userId, ...profiles.map(p => p._id)],
      admins: [userId],
      pictureUrl: pictureUrl || null,
      musicUrl: musicUrl || null,
    });
    await group.save();
    console.log(`[createGroup] Group created: groupId=${group._id}, timestamp=${timestamp}`);

    // Populate group data for response
    const populatedGroup = await Group.findById(group._id)
      .populate("members", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken")
      .populate("admins", "phone displayName")
      .populate("createdBy", "phone displayName");

    // Fetch contacts and users for formatting
    const phoneNumbers = populatedGroup.members.map(member => normalizePhoneNumber(member.phone));
    const contacts = await Contact.find({ userId, phone: { $in: phoneNumbers } }).select("phone customName");
    const contactMap = new Map(contacts.map(c => [normalizePhoneNumber(c.phone), c.customName || null]));
    const userIds = populatedGroup.members.map(member => member._id);
    const users = await User.find({ _id: { $in: userIds } }).select("phone online lastSeen fcmToken");
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Format response
    const formattedGroup = {
      id: populatedGroup._id,
      name: populatedGroup.name,
      channelId: populatedGroup.channelId || null,
      pictureUrl: populatedGroup.pictureUrl || null,
      musicUrl: populatedGroup.musicUrl || null,
      createdAt: populatedGroup.createdAt,
      updatedAt: populatedGroup.updatedAt,
      createdBy: formatProfile(populatedGroup.createdBy, userMap.get(populatedGroup.createdBy?._id?.toString()), contactMap.get(normalizePhoneNumber(populatedGroup.createdBy?.phone))),
      admins: populatedGroup.admins.map(admin => formatProfile(admin, userMap.get(admin._id.toString()), contactMap.get(normalizePhoneNumber(admin.phone)))),
      members: populatedGroup.members.map(member => {
        const memberUser = userMap.get(member._id.toString());
        return {
          ...formatProfile(member, memberUser, contactMap.get(normalizePhoneNumber(member.phone))),
          isBlocked: blockedUsers.some(b => b.blockedId.toString() === member._id.toString()),
        };
      }),
    };

    // Emit Socket.IO event for group creation
    const io = req.app.locals.io;
    populatedGroup.members.forEach(member => {
      io.to(member._id.toString()).emit("group_update", {
        groupId: group._id,
        action: "created",
        group: formattedGroup,
      });
    });

    return res.status(201).json({
      success: true,
      message: "Group created successfully",
      group: formattedGroup,
    });
  } catch (err) {
    console.error(`[createGroup] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// PUT /api/groups/:groupId/members - Add members to a group
router.put("/:groupId/members", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[addGroupMembers] Processing request: groupId=${req.params.groupId}, body=${JSON.stringify(req.body)}, userId=${req.user._id}, timestamp=${timestamp}`);
    const { groupId } = req.params;
    const { memberPhones } = req.body;
    const userId = req.user._id;

    if (!mongoose.isValidObjectId(groupId)) {
      console.error(`[addGroupMembers] Invalid groupId: ${groupId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid group ID" });
    }

    if (!Array.isArray(memberPhones) || memberPhones.length === 0) {
      console.error(`[addGroupMembers] Invalid memberPhones: ${memberPhones}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "At least one member phone number is required" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      console.error(`[addGroupMembers] Group not found: groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Group not found" });
    }

    if (!group.admins.includes(userId)) {
      console.error(`[addGroupMembers] User not admin: userId=${userId}, groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(403).json({ success: false, error: "Only admins can add members" });
    }

    // Normalize and validate phone numbers
    const normalizedPhones = memberPhones.map(phone => normalizePhoneNumber(phone));
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    const invalidPhones = normalizedPhones.filter(phone => !phoneRegex.test(phone));
    if (invalidPhones.length > 0) {
      console.error(`[addGroupMembers] Invalid phone numbers: ${invalidPhones}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid phone numbers", invalidPhones });
    }

    // Fetch profiles
    const profiles = await Profile.find({ phone: { $in: normalizedPhones } });
    const profileMap = new Map(profiles.map(p => [normalizePhoneNumber(p.phone), p]));
    const missingPhones = normalizedPhones.filter(phone => !profileMap.has(phone));
    if (missingPhones.length > 0) {
      console.error(`[addGroupMembers] Profiles not found for phones: ${missingPhones}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Some users not found", missingPhones });
    }

    // Check for blocked users
    const blockedUsers = await Block.find({ blockerId: userId, blockedId: { $in: profiles.map(p => p._id) } });
    if (blockedUsers.length > 0) {
      console.error(`[addGroupMembers] Cannot add blocked users: ${blockedUsers.map(b => b.blockedId)}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot add blocked users to group" });
    }

    // Add new members
    const newMemberIds = profiles.map(p => p._id).filter(id => !group.members.includes(id));
    if (newMemberIds.length === 0) {
      console.warn(`[addGroupMembers] No new members to add: groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "All users are already members" });
    }

    group.members.push(...newMemberIds);
    group.updatedAt = new Date();
    await group.save();

    // Populate group data for response
    const populatedGroup = await Group.findById(groupId)
      .populate("members", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken")
      .populate("admins", "phone displayName")
      .populate("createdBy", "phone displayName");

    // Fetch contacts and users
    const phoneNumbers = populatedGroup.members.map(member => normalizePhoneNumber(member.phone));
    const contacts = await Contact.find({ userId, phone: { $in: phoneNumbers } }).select("phone customName");
    const contactMap = new Map(contacts.map(c => [normalizePhoneNumber(c.phone), c.customName || null]));
    const userIds = populatedGroup.members.map(member => member._id);
    const users = await User.find({ _id: { $in: userIds } }).select("phone online lastSeen fcmToken");
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Format response
    const formattedGroup = {
      id: populatedGroup._id,
      name: populatedGroup.name,
      channelId: populatedGroup.channelId || null,
      pictureUrl: populatedGroup.pictureUrl || null,
      musicUrl: populatedGroup.musicUrl || null,
      createdAt: populatedGroup.createdAt,
      updatedAt: populatedGroup.updatedAt,
      createdBy: formatProfile(populatedGroup.createdBy, userMap.get(populatedGroup.createdBy?._id?.toString()), contactMap.get(normalizePhoneNumber(populatedGroup.createdBy?.phone))),
      admins: populatedGroup.admins.map(admin => formatProfile(admin, userMap.get(admin._id.toString()), contactMap.get(normalizePhoneNumber(admin.phone)))),
      members: populatedGroup.members.map(member => {
        const memberUser = userMap.get(member._id.toString());
        return {
          ...formatProfile(member, memberUser, contactMap.get(normalizePhoneNumber(member.phone))),
          isBlocked: blockedUsers.some(b => b.blockedId.toString() === member._id.toString()),
        };
      }),
    };

    // Emit Socket.IO event
    const io = req.app.locals.io;
    newMemberIds.forEach(memberId => {
      io.to(memberId.toString()).emit("group_update", {
        groupId: group._id,
        action: "member_added",
        group: formattedGroup,
      });
    });

    return res.json({
      success: true,
      message: "Members added successfully",
      group: formattedGroup,
    });
  } catch (err) {
    console.error(`[addGroupMembers] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

// DELETE /api/groups/:groupId/members/:memberId - Remove a member from a group
router.delete("/:groupId/members/:memberId", authenticateToken, async (req, res) => {
  const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
  try {
    console.log(`[removeGroupMember] Processing request: groupId=${req.params.groupId}, memberId=${req.params.memberId}, userId=${req.user._id}, timestamp=${timestamp}`);
    const { groupId, memberId } = req.params;
    const userId = req.user._id;

    if (!mongoose.isValidObjectId(groupId) || !mongoose.isValidObjectId(memberId)) {
      console.error(`[removeGroupMember] Invalid ID: groupId=${groupId}, memberId=${memberId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Invalid group or member ID" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      console.error(`[removeGroupMember] Group not found: groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(404).json({ success: false, error: "Group not found" });
    }

    if (!group.admins.includes(userId)) {
      console.error(`[removeGroupMember] User not admin: userId=${userId}, groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(403).json({ success: false, error: "Only admins can remove members" });
    }

    if (!group.members.includes(memberId)) {
      console.error(`[removeGroupMember] Member not in group: memberId=${memberId}, groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "User is not a member of this group" });
    }

    if (group.createdBy.toString() === memberId) {
      console.error(`[removeGroupMember] Cannot remove group creator: memberId=${memberId}, groupId=${groupId}, timestamp=${timestamp}`);
      return res.status(400).json({ success: false, error: "Cannot remove group creator" });
    }

    group.members = group.members.filter(id => id.toString() !== memberId);
    if (group.admins.includes(memberId)) {
      group.admins = group.admins.filter(id => id.toString() !== memberId);
    }
    group.updatedAt = new Date();
    await group.save();

    // Populate group data for response
    const populatedGroup = await Group.findById(groupId)
      .populate("members", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken")
      .populate("admins", "phone displayName")
      .populate("createdBy", "phone displayName");

    // Fetch contacts and users
    const phoneNumbers = populatedGroup.members.map(member => normalizePhoneNumber(member.phone));
    const contacts = await Contact.find({ userId, phone: { $in: phoneNumbers } }).select("phone customName");
    const contactMap = new Map(contacts.map(c => [normalizePhoneNumber(c.phone), c.customName || null]));
    const userIds = populatedGroup.members.map(member => member._id);
    const users = await User.find({ _id: { $in: userIds } }).select("phone online lastSeen fcmToken");
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Format response
    const formattedGroup = {
      id: populatedGroup._id,
      name: populatedGroup.name,
      channelId: populatedGroup.channelId || null,
      pictureUrl: populatedGroup.pictureUrl || null,
      musicUrl: populatedGroup.musicUrl || null,
      createdAt: populatedGroup.createdAt,
      updatedAt: populatedGroup.updatedAt,
      createdBy: formatProfile(populatedGroup.createdBy, userMap.get(populatedGroup.createdBy?._id?.toString()), contactMap.get(normalizePhoneNumber(populatedGroup.createdBy?.phone))),
      admins: populatedGroup.admins.map(admin => formatProfile(admin, userMap.get(admin._id.toString()), contactMap.get(normalizePhoneNumber(admin.phone)))),
      members: populatedGroup.members.map(member => {
        const memberUser = userMap.get(member._id.toString());
        return {
          ...formatProfile(member, memberUser, contactMap.get(normalizePhoneNumber(member.phone))),
          isBlocked: false, // No need to check blocked status here
        };
      }),
    };

    // Emit Socket.IO event
    const io = req.app.locals.io;
    io.to(memberId).emit("group_update", {
      groupId: group._id,
      action: "member_removed",
      group: formattedGroup,
    });

    return res.json({
      success: true,
      message: "Member removed successfully",
      group: formattedGroup,
    });
  } catch (err) {
    console.error(`[removeGroupMember] Error: ${err.message}, timestamp=${timestamp}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
});

export default router;