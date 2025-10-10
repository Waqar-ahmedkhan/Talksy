import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";
import { normalizePhoneNumber } from "../utils/phone.js";

/**
 * Middleware to verify JWT token and fetch user _id
 */
export const authenticateToken = async (req, res, next) => {
  try {
    console.log("authenticateToken: Starting token verification");
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];

    if (!token) {
      console.error("authenticateToken: No token provided");
      return res.status(401).json({ success: false, error: "Access token is required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(`authenticateToken: Token decoded, payload: ${JSON.stringify(decoded)}`);

    if (!decoded.phone) {
      console.error("authenticateToken: Phone number missing in token payload");
      return res.status(403).json({ success: false, error: "Invalid token: Phone number missing" });
    }

    const normalizedPhone = normalizePhoneNumber(decoded.phone);

    const user = await User.findOne({ phone: normalizedPhone }).select("_id phone");
    if (!user) {
      console.error(`authenticateToken: No user found for phone: ${normalizedPhone}`);
      return res.status(404).json({ success: false, error: "User not found" });
    }

    req.user = {
      _id: user._id,
      phone: normalizedPhone,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    console.log(`authenticateToken: User data attached to req.user: ${JSON.stringify(req.user)}`);
    next();
  } catch (err) {
    console.error(`authenticateToken: JWT verification failed: ${err.message}`);
    return res.status(403).json({ success: false, error: "Invalid or expired token" });
  }
};

/**
 * Helper: Get custom name for a phone from viewer's contacts
 */
const getCustomNameForPhone = async (viewerUserId, phone) => {
  if (!viewerUserId || !phone) return null;
  const contact = await Contact.findOne({ userId: viewerUserId, phone }).select("customName").lean();
  return contact?.customName || null;
};

/**
 * Unified profile formatter — resolves customName based on viewer
 */
const formatProfile = async (profile, user, viewerUserId) => {
  if (!profile) return null;

  const normPhone = normalizePhoneNumber(profile.phone);
  const customName = viewerUserId ? await getCustomNameForPhone(viewerUserId, normPhone) : null;
  const nameToUse = customName || profile.displayName || "Unknown";

  return {
    id: profile._id || null,
    userId: user?._id || null,
    phone: profile.phone || null,
    displayName: profile.displayName || "Unknown",
    randomNumber: profile.randomNumber || "",
    isVisible: profile.isVisible ?? false,
    isNumberVisible: profile.isNumberVisible ?? false,
    avatarUrl: profile.avatarUrl || "",
    createdAt: profile.createdAt || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen || null,
    customName: nameToUse,
  };
};

/**
 * Generate 11-digit random number
 */
const generateRandom11DigitNumber = () => {
  return Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("");
};

/**
 * Create or Update Profile
 */
export const createProfile = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ success: false, error: "Request body is missing or invalid JSON" });
    }

    const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
    const phone = normalizePhoneNumber(req.user?.phone);

    if (!phone) {
      return res.status(401).json({ success: false, error: "Phone number not found in token" });
    }
    if (!displayName?.trim()) {
      return res.status(400).json({ success: false, error: "Display name is required" });
    }

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
        randomNumber: generateRandom11DigitNumber(),
        isVisible,
        isNumberVisible,
        avatarUrl: avatarUrl.trim(),
      });
    }

    await profile.save();

    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({
        phone,
        displayName: displayName.trim(),
        online: false,
        lastSeen: new Date(),
        musicUrl: null,
      });
      await user.save();
    }

    // Ensure contact exists
    const existingContact = await Contact.findOne({ userId: user._id, phone });
    if (!existingContact) {
      await Contact.create({
        userId: user._id,
        phone,
        customName: displayName.trim(),
      });
    }

    const formattedProfile = await formatProfile(profile, user, req.user._id);
    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formattedProfile,
    });
  } catch (err) {
    console.error(`createProfile: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get My Profile
 */
export const getMyProfile = async (req, res) => {
  try {
    const phone = normalizePhoneNumber(req.user.phone);
    const profile = await Profile.findOne({ phone });
    if (!profile) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    const user = await User.findOne({ phone });
    const formattedProfile = await formatProfile(profile, user, req.user._id);

    return res.json({ success: true, profile: formattedProfile });
  } catch (err) {
    console.error(`getMyProfile: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/**
 * Get Public Profiles (paginated)
 */
export const getPublicProfiles = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const publicProfiles = await Profile.find({ isVisible: true })
      .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const phoneNumbers = publicProfiles.map(p => normalizePhoneNumber(p.phone));
    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
    const userMap = new Map(users.map(u => [normalizePhoneNumber(u.phone), u]));

    const profiles = [];
    for (const profile of publicProfiles) {
      const user = userMap.get(normalizePhoneNumber(profile.phone));
      const formatted = await formatProfile(profile, user, req.user?._id);
      profiles.push(formatted);
    }

    return res.json({
      success: true,
      page,
      limit,
      profiles,
    });
  } catch (err) {
    console.error(`getPublicProfiles: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/**
 * Get Profiles from Contacts
 */
export const getProfilesFromContacts = async (req, res) => {
  try {
    const { contacts } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "Contacts array is required" });
    }

    let phoneNumbers = [];
    if (typeof contacts[0] === "string") {
      phoneNumbers = contacts.map(normalizePhoneNumber);
    } else {
      for (const contact of contacts) {
        if (!contact.phone || typeof contact.phone !== "string") {
          return res.status(400).json({ success: false, error: "Each contact must have a valid phone number" });
        }
        phoneNumbers.push(normalizePhoneNumber(contact.phone));
      }
    }

    const matchedProfiles = await Profile.find({
      phone: { $in: phoneNumbers },
    }).select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

    const users = await User.find({
      phone: { $in: phoneNumbers },
    }).select("phone online lastSeen musicUrl");
    const userMap = new Map(users.map(u => [normalizePhoneNumber(u.phone), u]));

    const profiles = [];
    for (const profile of matchedProfiles) {
      const user = userMap.get(normalizePhoneNumber(profile.phone));
      const formatted = await formatProfile(profile, user, userId);
      profiles.push(formatted);
    }

    return res.json({
      success: true,
      profiles,
    });
  } catch (err) {
    console.error(`getProfilesFromContacts: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: `Server error: ${err.message}` });
  }
};

/**
 * Format chat for response
 */
const formatChat = (chat) => {
  if (!chat) return null;
  return {
    id: chat._id || null,
    senderId: chat.senderId?._id || null,
    receiverId: chat.receiverId?._id || null,
    channelId: chat.channelId || null,
    groupId: chat.groupId || null,
    type: chat.type || "text",
    content: chat.content?.substring(0, 50) + (chat.content?.length > 50 ? "..." : "") || "",
    fileType: chat.fileType || null,
    fileName: chat.fileName || null,
    duration: chat.duration || null,
    status: chat.status || "sent",
    pinned: chat.pinned || false,
    createdAt: chat.createdAt || null,
  };
};

/**
 * Get profile + chat history with target user
 */
export const getProfileWithChat = async (req, res) => {
  try {
    const myPhone = normalizePhoneNumber(req.user.phone);
    const targetPhone = normalizePhoneNumber(req.params.phone);

    if (!targetPhone) {
      return res.status(400).json({ success: false, error: "Target phone number is required" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ success: false, error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) {
      return res.status(404).json({ success: false, error: "Target profile not found" });
    }

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
    console.error(`getProfileWithChat: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get Chat List
 */
export const getChatList = async (req, res) => {
  try {
    const myPhone = normalizePhoneNumber(req.user?.phone);
    const userId = req.user?._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized: Missing user ID" });
    }

    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, error: "Invalid pagination parameters" });
    }
    const skip = (page - 1) * limit;

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ success: false, error: "Your profile not found" });
    }

    const chats = await Chat.find({
      $and: [
        { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
        { receiverId: { $ne: null } },
        { deletedFor: { $ne: myProfile._id } },
      ],
    })
      .sort({ pinned: -1, createdAt: -1 })
      .populate("senderId receiverId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt");

    if (!chats || chats.length === 0) {
      return res.json({ success: true, page, limit, total: 0, chats: [] });
    }

    const phoneNumbers = [
      ...new Set([
        ...chats.map(c => normalizePhoneNumber(c.senderId?.phone)).filter(Boolean),
        ...chats.map(c => normalizePhoneNumber(c.receiverId?.phone)).filter(Boolean),
      ]),
    ];

    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen musicUrl");
    const userMap = new Map(users.map(u => [normalizePhoneNumber(u.phone), u]));

    const chatMap = new Map();
    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) continue;

      const otherProfileId =
        chat.senderId._id.toString() === myProfile._id.toString()
          ? chat.receiverId._id.toString()
          : chat.senderId._id.toString();

      if (!chatMap.has(otherProfileId)) {
        const otherProfile =
          chat.senderId._id.toString() === myProfile._id.toString() ? chat.receiverId : chat.senderId;
        chatMap.set(otherProfileId, {
          profile: otherProfile,
          latestMessage: chat,
          unreadCount:
            chat.receiverId._id.toString() === myProfile._id.toString() &&
            ["sent", "delivered"].includes(chat.status)
              ? 1
              : 0,
          pinned: chat.pinned,
        });
      } else {
        const existing = chatMap.get(otherProfileId);
        if (new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)) {
          existing.latestMessage = chat;
          existing.pinned = chat.pinned;
        }
        if (
          chat.receiverId._id.toString() === myProfile._id.toString() &&
          ["sent", "delivered"].includes(chat.status)
        ) {
          existing.unreadCount += 1;
        }
      }
    }

    const chatList = Array.from(chatMap.values())
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt);
      })
      .slice(skip, skip + limit);

    // Format all profiles with customName
    const formattedChatList = await Promise.all(
      chatList.map(async (item) => {
        const normPhone = normalizePhoneNumber(item.profile?.phone);
        const user = userMap.get(normPhone);
        const formattedProfile = await formatProfile(item.profile, user, userId);
        return {
          profile: formattedProfile,
          latestMessage: formatChat(item.latestMessage),
          unreadCount: item.unreadCount,
          pinned: item.pinned,
        };
      })
    );

    return res.json({
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formattedChatList,
    });
  } catch (err) {
    console.error(`getChatList: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Upsert Contact
 */
export const upsertContact = async (req, res) => {
  try {
    const { phone, customName } = req.body;
    const userId = req.user._id;

    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, error: "Valid phone number is required" });
    }

    const contact = await Contact.findOneAndUpdate(
      { userId, phone: normalizedPhone },
      { customName: customName?.trim() || "Unknown" },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success: true,
      message: "Contact saved",
      contact: {
        phone: contact.phone,
        customName: contact.customName,
      },
    });
  } catch (err) {
    console.error(`upsertContact: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/**
 * Upsert Multiple Contacts
 */
export const upsertMultipleContacts = async (req, res) => {
  try {
    const { contacts } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "Contacts array is required" });
    }

    const operations = [];
    const phoneNumbers = [];
    for (const contact of contacts) {
      if (!contact.phone || typeof contact.phone !== "string") {
        return res.status(400).json({ success: false, error: "Each contact must have a valid phone number" });
      }
      const normalizedPhone = normalizePhoneNumber(contact.phone);
      phoneNumbers.push(normalizedPhone);
      operations.push({
        updateOne: {
          filter: { userId, phone: normalizedPhone },
          update: { $set: { customName: contact.customName?.trim() || "Unknown" } },
          upsert: true,
        },
      });
    }

    await Contact.bulkWrite(operations);
    const updatedContacts = await Contact.find({ userId, phone: { $in: phoneNumbers } }).select("phone customName");

    return res.json({
      success: true,
      message: "Contacts saved successfully",
      contacts: updatedContacts.map(c => ({
        phone: c.phone,
        customName: c.customName,
      })),
    });
  } catch (err) {
    console.error(`upsertMultipleContacts: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: "Server error", details: err.message });
  }
};