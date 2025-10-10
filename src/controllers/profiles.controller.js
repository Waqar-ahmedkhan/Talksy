import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";
import Block from "../models/Block.js";
import { normalizePhoneNumber } from "../utils/phone.js";

// ========== MIDDLEWARE ==========
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, error: "Access token required" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.phone) return res.status(403).json({ success: false, error: "Invalid token" });

    const normalizedPhone = normalizePhoneNumber(decoded.phone);
    const user = await User.findOne({ phone: normalizedPhone }).select("_id phone");
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    req.user = { _id: user._id, phone: normalizedPhone };
    next();
  } catch (err) {
    return res.status(403).json({ success: false, error: "Invalid or expired token" });
  }
};

// ========== HELPER: Get customName ==========
const getCustomName = async (viewerUserId, targetPhone) => {
  if (!viewerUserId || !targetPhone) return null;
  const contact = await Contact.findOne({ 
    userId: viewerUserId, 
    phone: targetPhone // Already normalized!
  }).select("customName").lean();
  return contact?.customName || null;
};

// ========== HELPER: Format Profile ==========
const formatProfile = async (profile, user, viewerUserId) => {
  if (!profile) return null;

  const customName = viewerUserId ? await getCustomName(viewerUserId, profile.phone) : null;
  const nameToUse = customName || profile.displayName || "Unknown";

  return {
    id: profile._id.toString(),
    userId: user?._id?.toString() || null,
    phone: profile.phone,
    displayName: profile.displayName,
    customName: nameToUse,
    randomNumber: profile.randomNumber || "",
    isVisible: profile.isVisible,
    isNumberVisible: profile.isNumberVisible,
    avatarUrl: profile.avatarUrl || "",
    createdAt: profile.createdAt,
    online: user?.online || false,
    lastSeen: user?.lastSeen || null,
  };
};

// ========== PROFILE ENDPOINTS ==========
export const createProfile = async (req, res) => {
  try {
    const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ success: false, error: "Display name required" });

    const phone = req.user.phone; // Already normalized!
    let profile = await Profile.findOne({ phone });
    
    if (profile) {
      profile.displayName = displayName.trim();
      profile.isVisible = isVisible;
      profile.isNumberVisible = isNumberVisible;
      profile.avatarUrl = avatarUrl.trim();
    } else {
      profile = new Profile({
        phone,
        displayName: displayName.trim(),
        randomNumber: Math.random().toString().slice(2, 13).padEnd(11, '0'),
        isVisible,
        isNumberVisible,
        avatarUrl: avatarUrl.trim(),
      });
    }
    await profile.save();

    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone, displayName: displayName.trim() });
      await user.save();
    }

    // Ensure contact exists
    await Contact.findOneAndUpdate(
      { userId: user._id, phone },
      { customName: displayName.trim() },
      { upsert: true, new: true }
    );

    const formatted = await formatProfile(profile, user, req.user._id);
    return res.status(201).json({ success: true, profile: formatted });
  } catch (err) {
    console.error("createProfile error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getMyProfile = async (req, res) => {
  try {
    const profile = await Profile.findOne({ phone: req.user.phone });
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });

    const user = await User.findOne({ phone: req.user.phone });
    const formatted = await formatProfile(profile, user, req.user._id);
    return res.json({ success: true, profile: formatted });
  } catch (err) {
    console.error("getMyProfile error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getPublicProfiles = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const profiles = await Profile.find({ isVisible: true })
      .select("phone displayName randomNumber isVisible isNumberVisible avatarUrl createdAt")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const phones = profiles.map(p => p.phone);
    const users = await User.find({ phone: { $in: phones } });
    const userMap = new Map(users.map(u => [u.phone, u]));

    const formattedProfiles = [];
    for (const profile of profiles) {
      const user = userMap.get(profile.phone);
      const formatted = await formatProfile(profile, user, req.user?._id);
      formattedProfiles.push(formatted);
    }

    return res.json({ success: true, page, limit, profiles: formattedProfiles });
  } catch (err) {
    console.error("getPublicProfiles error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getProfilesFromContacts = async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "Contacts array required" });
    }

    const phones = contacts.map(c => 
      typeof c === 'string' 
        ? normalizePhoneNumber(c) 
        : normalizePhoneNumber(c.phone)
    ).filter(Boolean);

    const profiles = await Profile.find({ phone: { $in: phones } });
    const users = await User.find({ phone: { $in: phones } });
    const userMap = new Map(users.map(u => [u.phone, u]));

    const formattedProfiles = [];
    for (const profile of profiles) {
      const user = userMap.get(profile.phone);
      const formatted = await formatProfile(profile, user, req.user._id);
      formattedProfiles.push(formatted);
    }

    return res.json({ success: true, profiles: formattedProfiles });
  } catch (err) {
    console.error("getProfilesFromContacts error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// ========== CHAT ENDPOINTS ==========
const formatChat = (chat) => ({
  id: chat._id.toString(),
  senderId: chat.senderId?._id?.toString(),
  receiverId: chat.receiverId?._id?.toString(),
  content: chat.content?.substring(0, 50) + (chat.content?.length > 50 ? "..." : "") || "",
  status: chat.status || "sent",
  createdAt: chat.createdAt,
});

export const getProfileWithChat = async (req, res) => {
  try {
    const targetPhone = normalizePhoneNumber(req.params.phone);
    if (!targetPhone) return res.status(400).json({ success: false, error: "Valid phone required" });

    const myProfile = await Profile.findOne({ phone: req.user.phone });
    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) return res.status(404).json({ success: false, error: "Profile not found" });

    const targetUser = await User.findOne({ phone: targetPhone });
    const chats = await Chat.find({
      $or: [
        { senderId: myProfile._id, receiverId: targetProfile._id },
        { senderId: targetProfile._id, receiverId: myProfile._id },
      ],
    }).sort({ createdAt: -1 }).limit(50);

    const formattedProfile = await formatProfile(targetProfile, targetUser, req.user._id);
    return res.json({
      success: true,
      profile: formattedProfile,
      chatHistory: chats.map(formatChat),
    });
  } catch (err) {
    console.error("getProfileWithChat error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getChatList = async (req, res) => {
  try {
    const myProfile = await Profile.findOne({ phone: req.user.phone });
    if (!myProfile) return res.status(404).json({ success: false, error: "Profile not found" });

    const chats = await Chat.find({
      $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }],
      receiverId: { $ne: null },
      deletedFor: { $ne: myProfile._id },
    })
      .sort({ pinned: -1, createdAt: -1 })
      .populate("senderId receiverId", "phone displayName");

    if (!chats.length) {
      return res.json({ success: true, chats: [], total: 0 });
    }

    // Get unique target phones
    const targetPhones = [...new Set(
      chats.map(c => 
        c.senderId.phone === req.user.phone 
          ? c.receiverId?.phone 
          : c.senderId?.phone
      ).filter(Boolean)
    )];

    // Fetch profiles and users
    const profiles = await Profile.find({ phone: { $in: targetPhones } });
    const users = await User.find({ phone: { $in: targetPhones } });
    const profileMap = new Map(profiles.map(p => [p.phone, p]));
    const userMap = new Map(users.map(u => [u.phone, u]));

    // Build chat map (group by target)
    const chatMap = new Map();
    for (const chat of chats) {
      const isOutgoing = chat.senderId.phone === req.user.phone;
      const targetPhone = isOutgoing ? chat.receiverId?.phone : chat.senderId?.phone;
      if (!targetPhone) continue;

      if (!chatMap.has(targetPhone)) {
        chatMap.set(targetPhone, {
          profile: profileMap.get(targetPhone),
          user: userMap.get(targetPhone),
          latestMessage: chat,
          unreadCount: isOutgoing ? 0 : (["sent", "delivered"].includes(chat.status) ? 1 : 0),
          pinned: chat.pinned,
        });
      } else {
        const existing = chatMap.get(targetPhone);
        if (chat.createdAt > existing.latestMessage.createdAt) {
          existing.latestMessage = chat;
          existing.pinned = chat.pinned;
        }
        if (!isOutgoing && ["sent", "delivered"].includes(chat.status)) {
          existing.unreadCount += 1;
        }
      }
    }

    // Format all
    const formattedChats = [];
    for (const [phone, data] of chatMap) {
      const formattedProfile = await formatProfile(data.profile, data.user, req.user._id);
      formattedChats.push({
        profile: formattedProfile,
        latestMessage: formatChat(data.latestMessage),
        unreadCount: data.unreadCount,
        pinned: data.pinned,
      });
    }

    // Sort: pinned first, then by latest message
    formattedChats.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt);
    });

    return res.json({ success: true, chats: formattedChats, total: formattedChats.length });
  } catch (err) {
    console.error("getChatList error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// ========== CONTACT MANAGEMENT ==========
export const upsertContact = async (req, res) => {
  try {
    const { phone, customName } = req.body;
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, error: "Invalid phone" });

    const contact = await Contact.findOneAndUpdate(
      { userId: req.user._id, phone: normalizedPhone },
      { customName: customName?.trim() || "Unknown" },
      { upsert: true, new: true }
    );

    return res.json({ 
      success: true, 
      contact: { phone: contact.phone, customName: contact.customName } 
    });
  } catch (err) {
    console.error("upsertContact error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const upsertMultipleContacts = async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts)) return res.status(400).json({ success: false, error: "Contacts must be array" });

    const operations = contacts.map(c => ({
      updateOne: {
        filter: { userId: req.user._id, phone: normalizePhoneNumber(c.phone) },
        update: { $set: { customName: c.customName?.trim() || "Unknown" } },
        upsert: true,
      }
    })).filter(op => op.updateOne.filter.phone);

    if (operations.length > 0) await Contact.bulkWrite(operations);

    const savedContacts = await Contact.find({ 
      userId: req.user._id, 
      phone: { $in: operations.map(op => op.updateOne.filter.phone) } 
    });
    
    return res.json({
      success: true,
      contacts: savedContacts.map(c => ({ phone: c.phone, customName: c.customName }))
    });
  } catch (err) {
    console.error("upsertMultipleContacts error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// ========== BLOCKING ==========
export const blockUser = async (req, res) => {
  try {
    const { phone } = req.body;
    const targetPhone = normalizePhoneNumber(phone);
    if (!targetPhone) return res.status(400).json({ success: false, error: "Invalid phone" });

    const targetUser = await User.findOne({ phone: targetPhone });
    if (!targetUser) return res.status(404).json({ success: false, error: "User not found" });
    if (targetUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, error: "Cannot block yourself" });
    }

    await Block.findOneAndUpdate(
      { blockerId: req.user._id, blockedId: targetUser._id },
      {},
      { upsert: true }
    );

    return res.json({ success: true, message: "User blocked" });
  } catch (err) {
    console.error("blockUser error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const { phone } = req.body;
    const targetPhone = normalizePhoneNumber(phone);
    if (!targetPhone) return res.status(400).json({ success: false, error: "Invalid phone" });

    const targetUser = await User.findOne({ phone: targetPhone });
    if (!targetUser) return res.status(404).json({ success: false, error: "User not found" });

    await Block.deleteOne({ blockerId: req.user._id, blockedId: targetUser._id });
    return res.json({ success: true, message: "User unblocked" });
  } catch (err) {
    console.error("unblockUser error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getBlockedProfiles = async (req, res) => {
  try {
    const blocks = await Block.find({ blockerId: req.user._id });
    const blockedUserIds = blocks.map(b => b.blockedId);
    if (!blockedUserIds.length) return res.json({ success: true, blockedProfiles: [] });

    const blockedUsers = await User.find({ _id: { $in: blockedUserIds } });
    const phones = blockedUsers.map(u => u.phone);
    const profiles = await Profile.find({ phone: { $in: phones } });
    const userMap = new Map(blockedUsers.map(u => [u.phone, u]));

    const blockedProfiles = [];
    for (const profile of profiles) {
      const user = userMap.get(profile.phone);
      const formatted = await formatProfile(profile, user, req.user._id);
      blockedProfiles.push(formatted);
    }

    return res.json({ success: true, blockedProfiles });
  } catch (err) {
    console.error("getBlockedProfiles error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};