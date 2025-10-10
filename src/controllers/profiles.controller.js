import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";
import { normalizePhoneNumber } from "../utils/phone.js"; // New import for normalization

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

    const normalizedPhone = normalizePhoneNumber(decoded.phone); // Normalize here

    // Fetch user from database to get _id
    const user = await User.findOne({ phone: normalizedPhone }).select("_id phone");
    if (!user) {
      console.error(`authenticateToken: No user found for phone: ${normalizedPhone}`);
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Attach user data to request
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
 * Helper: Format profile for response
 */
const formatProfile = (profile, user, customName = null) => {
  console.log(`formatProfile: Formatting profile for phone: ${profile?.phone || "unknown"}, customName: ${customName}`);
  const fallbackCustomName = customName || profile?.displayName || "Unknown"; // Fallback to displayName or "Unknown"
  const formatted = {
    id: profile?._id || null,
    userId: user?._id || null,
    phone: profile?.phone || null,
    displayName: fallbackCustomName, // Use fallback here
    randomNumber: profile?.randomNumber || "",
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: profile?.avatarUrl || "",
    createdAt: profile?.createdAt || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen || null,
    customName: fallbackCustomName,
  };
  console.log(`formatProfile: Formatted profile: ${JSON.stringify(formatted)}`);
  return formatted;
};

/**
 * Generate 11-digit random number
 */
const generateRandom11DigitNumber = () => {
  const randomNumber = Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("");
  console.log(`generateRandom11DigitNumber: Generated number: ${randomNumber}`);
  return randomNumber;
};

/**
 * Create or Update Profile
 */
export const createProfile = async (req, res) => {
  try {
    console.log(`createProfile: Request body: ${JSON.stringify(req.body)}`);
    if (!req.body || typeof req.body !== "object") {
      console.error("createProfile: Missing or invalid request body");
      return res.status(400).json({ success: false, error: "Request body is missing or invalid JSON" });
    }

    const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
    const phone = normalizePhoneNumber(req.user?.phone); // Normalize

    if (!phone) {
      console.error("createProfile: Phone number not found in token");
      return res.status(401).json({ success: false, error: "Phone number not found in token" });
    }
    if (!displayName?.trim()) {
      console.error("createProfile: Display name is required");
      return res.status(400).json({ success: false, error: "Display name is required" });
    }

    let profile = await Profile.findOne({ phone });
    console.log(`createProfile: Profile ${profile ? "found" : "not found"} for phone: ${phone}`);

    if (profile) {
      profile.displayName = displayName.trim();
      profile.isVisible = isVisible;
      profile.isNumberVisible = isNumberVisible;
      profile.avatarUrl = avatarUrl.trim();
      console.log(`createProfile: Updating existing profile for phone: ${phone}`);
    } else {
      profile = new Profile({
        phone,
        displayName: displayName.trim(),
        randomNumber: generateRandom11DigitNumber(),
        isVisible,
        isNumberVisible,
        avatarUrl: avatarUrl.trim(),
      });
      console.log(`createProfile: Creating new profile for phone: ${phone}`);
    }

    await profile.save();
    console.log(`createProfile: Profile saved for phone: ${phone}, _id: ${profile._id}`);

    // Create or update corresponding User entry
    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({
        phone,
        displayName: displayName.trim(),
        online: false,
        lastSeen: new Date(),
      });
      await user.save();
      console.log(`createProfile: New user created for phone: ${phone}, _id: ${user._id}`);
    } else {
      console.log(`createProfile: Existing user found for phone: ${phone}, _id: ${user._id}`);
    }

    // Ensure a Contact record exists for the user's own phone, with fallback customName
    const contact = await Contact.findOneAndUpdate(
      { userId: user._id, phone },
      { customName: displayName.trim() }, // Default to displayName
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`createProfile: Ensured Contact record for phone: ${phone}, customName: ${contact.customName}`);

    const customName = contact?.customName || displayName.trim() || "Unknown";
    console.log(`createProfile: Custom name for phone ${phone}: ${customName}`);

    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formatProfile(profile, user, customName),
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
    const phone = normalizePhoneNumber(req.user.phone); // Normalize
    console.log(`getMyProfile: Fetching profile for phone: ${phone}, userId: ${req.user._id}`);
    const profile = await Profile.findOne({ phone });
    if (!profile) {
      console.error(`getMyProfile: Profile not found for phone: ${phone}`);
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    const user = await User.findOne({ phone });
    console.log(`getMyProfile: User ${user ? "found" : "not found"} for phone: ${phone}`);

    // Fetch customName with fallback
    const contact = await Contact.findOne({ userId: req.user._id, phone }).select("customName");
    const customName = contact?.customName || profile.displayName || "Unknown";
    console.log(`getMyProfile: Custom name for phone ${phone}: ${customName}`);

    return res.json({
      success: true,
      profile: formatProfile(profile, user, customName),
    });
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
    console.log(`getPublicProfiles: Request query: ${JSON.stringify(req.query)}, userId: ${req.user._id}`);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const publicProfiles = await Profile.find({ isVisible: true })
      .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });
    console.log(`getPublicProfiles: Found ${publicProfiles.length} public profiles`);

    const phoneNumbers = publicProfiles.map((p) => normalizePhoneNumber(p.phone)); // Normalize
    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
    console.log(`getPublicProfiles: Found ${users.length} users for phone numbers`);
    const userMap = new Map(users.map((u) => [normalizePhoneNumber(u.phone), u]));

    // Fetch custom names from Contact model with fallback
    const contacts = await Contact.find({ userId: req.user._id, phone: { $in: phoneNumbers } }).select("phone customName");
    console.log(`getPublicProfiles: Found ${contacts.length} contacts for custom names`);
    const contactMap = new Map(contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null]));

    // Apply fallback in mapping
    const profilesWithFallback = publicProfiles.map((profile) => {
      const normPhone = normalizePhoneNumber(profile.phone);
      const customName = contactMap.get(normPhone) || profile.displayName || "Unknown";
      return formatProfile(profile, userMap.get(normPhone), customName);
    });

    const response = {
      success: true,
      page,
      limit,
      profiles: profilesWithFallback,
    };
    console.log(`getPublicProfiles: Response prepared: ${JSON.stringify(response).substring(0, 200)}...`);
    return res.json(response);
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
    console.log(`getProfilesFromContacts: Request body: ${JSON.stringify(req.body)}, userId: ${req.user._id}`);
    const { contacts } = req.body;
    const userId = req.user._id;

    // Validate contacts array
    if (!Array.isArray(contacts) || contacts.length === 0) {
      console.error("getProfilesFromContacts: Contacts array is invalid or empty");
      return res.status(400).json({ success: false, error: "Contacts array is required" });
    }
    console.log(`getProfilesFromContacts: Contacts array validated, length: ${contacts.length}`);

    // Determine if contacts is an array of strings or objects
    let phoneNumbers = [];
    let contactMap = new Map();

    if (typeof contacts[0] === "string") {
      console.log("getProfilesFromContacts: Processing contacts as array of strings");
      phoneNumbers = contacts.map(normalizePhoneNumber); // Normalize
      // Fetch custom names from Contact model
      console.log(`getProfilesFromContacts: Querying Contact model for userId: ${userId}, phones: ${phoneNumbers}`);
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(`getProfilesFromContacts: Found ${userContacts.length} contacts in Contact model`);
      userContacts.forEach((contact) => {
        const normPhone = normalizePhoneNumber(contact.phone);
        console.log(`getProfilesFromContacts: Mapping contact: ${normPhone} -> ${contact.customName || null}`);
        contactMap.set(normPhone, contact.customName || null);
      });
    } else {
      console.log("getProfilesFromContacts: Processing contacts as array of objects");
      for (const contact of contacts) {
        if (!contact.phone || typeof contact.phone !== "string") {
          console.error(`getProfilesFromContacts: Invalid contact: ${JSON.stringify(contact)}`);
          return res.status(400).json({ success: false, error: "Each contact must have a valid phone number" });
        }
        const normPhone = normalizePhoneNumber(contact.phone);
        phoneNumbers.push(normPhone);
        contactMap.set(normPhone, contact.customName || null);
        console.log(`getProfilesFromContacts: Mapping contact: ${normPhone} -> ${contact.customName || null}`);
      }
      // Merge with Contact model data to ensure consistency
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(`getProfilesFromContacts: Found ${userContacts.length} contacts for merging`);
      userContacts.forEach((contact) => {
        const normPhone = normalizePhoneNumber(contact.phone);
        if (!contactMap.has(normPhone)) {
          contactMap.set(normPhone, contact.customName || null);
          console.log(`getProfilesFromContacts: Merged contact: ${normPhone} -> ${contact.customName || null}`);
        }
      });
    }

    // Fetch profiles
    console.log(`getProfilesFromContacts: Querying Profile model for phones: ${phoneNumbers}`);
    const matchedProfiles = await Profile.find({
      phone: { $in: phoneNumbers },
    }).select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");
    console.log(`getProfilesFromContacts: Found ${matchedProfiles.length} profiles`);

    // Fetch user status
    console.log(`getProfilesFromContacts: Querying User model for phones: ${phoneNumbers}`);
    const users = await User.find({
      phone: { $in: phoneNumbers },
    }).select("phone online lastSeen");
    console.log(`getProfilesFromContacts: Found ${users.length} users`);
    const userMap = new Map(users.map((u) => [normalizePhoneNumber(u.phone), u]));

    // Apply fallback
    const profilesWithFallback = matchedProfiles.map((profile) => {
      const normPhone = normalizePhoneNumber(profile.phone);
      const customName = contactMap.get(normPhone) || profile.displayName || "Unknown";
      return formatProfile(profile, userMap.get(normPhone), customName);
    });

    const response = {
      success: true,
      profiles: profilesWithFallback,
    };
    console.log(`getProfilesFromContacts: Response prepared: ${JSON.stringify(response).substring(0, 200)}...`);
    return res.json(response);
  } catch (err) {
    console.error(`getProfilesFromContacts: Error: ${err.message}`);
    return res.status(500).json({ success: false, error: `Server error: ${err.message}` });
  }
};

/**
 * Format chat for response
 */
const formatChat = (chat) => {
  console.log(`formatChat: Formatting chat: ${chat?._id || "unknown"}`);
  const formatted = {
    id: chat?._id || null,
    senderId: chat?.senderId?._id || null,
    receiverId: chat?.receiverId?._id || null,
    type: chat?.type || "text",
    content: chat?.content?.substring(0, 50) + (chat?.content?.length > 50 ? "..." : "") || "",
    duration: chat?.duration || null,
    status: chat?.status || "sent",
    createdAt: chat?.createdAt || null,
    pinned: chat?.pinned || false,
  };
  console.log(`formatChat: Formatted chat: ${JSON.stringify(formatted)}`);
  return formatted;
};

/**
 * Get profile + chat history with target user
 */
export const getProfileWithChat = async (req, res) => {
  try {
    console.log(`getProfileWithChat: Request params: ${JSON.stringify(req.params)}, userId: ${req.user._id}`);
    const myPhone = normalizePhoneNumber(req.user.phone); // Normalize
    const targetPhone = normalizePhoneNumber(req.params.phone); // Normalize

    if (!targetPhone) {
      console.error("getProfileWithChat: Target phone number is required");
      return res.status(400).json({ success: false, error: "Target phone number is required" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(`getProfileWithChat: Profile not found for phone: ${myPhone}`);
      return res.status(404).json({ success: false, error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) {
      console.error(`getProfileWithChat: Profile not found for phone: ${targetPhone}`);
      return res.status(404).json({ success: false, error: "Target profile not found" });
    }

    const targetUser = await User.findOne({ phone: targetPhone });
    console.log(`getProfileWithChat: Target user ${targetUser ? "found" : "not found"} for phone: ${targetPhone}`);

    // Fetch customName with fallback
    const contact = await Contact.findOne({ userId: req.user._id, phone: targetPhone }).select("customName");
    const customName = contact?.customName || targetProfile.displayName || "Unknown";
    console.log(`getProfileWithChat: Custom name for phone ${targetPhone}: ${customName}`);

    const chats = await Chat.find({
      $or: [
        { senderId: myProfile._id, receiverId: targetProfile._id },
        { senderId: targetProfile._id, receiverId: myProfile._id },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50);
    console.log(`getProfileWithChat: Found ${chats.length} chats`);

    const response = {
      success: true,
      profile: formatProfile(targetProfile, targetUser, customName),
      chatHistory: chats.map(formatChat),
    };
    console.log(`getProfileWithChat: Response prepared: ${JSON.stringify(response).substring(0, 200)}...`);
    return res.json(response);
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
    console.log(`getChatList: Request query: ${JSON.stringify(req.query)}, user: ${JSON.stringify(req.user)}`);
    const myPhone = normalizePhoneNumber(req.user?.phone); // Normalize
    const userId = req.user?._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!userId) {
      console.error("getChatList: Missing userId in request");
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing user ID",
      });
    }

    if (page < 1 || limit < 1 || limit > 100) {
      console.error("getChatList: Invalid pagination parameters");
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }
    const skip = (page - 1) * limit;

    console.log(`getChatList: Fetching profile for phone: ${myPhone}`);
    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(`getChatList: Profile not found for phone: ${myPhone}`);
      return res.status(404).json({ success: false, error: "Your profile not found" });
    }
    console.log(`getChatList: My profile found: ${myProfile._id}`);

    console.log(`getChatList: Fetching chats for profile: ${myProfile._id}`);
    const chats = await Chat.find({
      $and: [
        { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
        { receiverId: { $ne: null } },
        { deletedFor: { $ne: myProfile._id } },
      ],
    })
      .sort({ pinned: -1, createdAt: -1 })
      .populate("senderId receiverId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt");
    console.log(`getChatList: Found ${chats.length} chats`);

    if (!chats || chats.length === 0) {
      console.log("getChatList: No chats found");
      return res.json({
        success: true,
        page,
        limit,
        total: 0,
        chats: [],
      });
    }

    const phoneNumbers = [
      ...new Set([
        ...chats.map((chat) => normalizePhoneNumber(chat.senderId?.phone)).filter(Boolean),
        ...chats.map((chat) => normalizePhoneNumber(chat.receiverId?.phone)).filter(Boolean),
      ]),
    ];
    console.log(`getChatList: Phone numbers extracted: ${phoneNumbers}`);

    console.log(`getChatList: Fetching users for phones: ${phoneNumbers}`);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
    console.log(`getChatList: Found ${users.length} users`);
    const userMap = new Map(users.map((u) => [normalizePhoneNumber(u.phone), u]));

    let contactMap = new Map();
    try {
      console.log(`getChatList: Querying Contact model for userId: ${userId}, phones: ${phoneNumbers}`);
      const contacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(`getChatList: Found ${contacts.length} contacts for custom names`);
      contacts.forEach((contact) => {
        const normalizedPhone = normalizePhoneNumber(contact.phone);
        console.log(`getChatList: Mapping contact: ${normalizedPhone} -> ${contact.customName || null}`);
        contactMap.set(normalizedPhone, contact.customName || null);
      });
    } catch (contactError) {
      console.error(`getChatList: Error querying Contact model: ${contactError.message}`);
      // Fallback to Profile displayName
      const profiles = await Profile.find({ phone: { $in: phoneNumbers } }).select("phone displayName");
      profiles.forEach((profile) => {
        const normalizedPhone = normalizePhoneNumber(profile.phone);
        if (!contactMap.has(normalizedPhone)) {
          contactMap.set(normalizedPhone, profile.displayName || "Unknown");
        }
      });
      console.log(`getChatList: Fallback to ${profiles.length} profile display names`);
    }

    const chatMap = new Map();
    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) {
        console.warn(`getChatList: Chat ${chat._id} missing senderId or receiverId`);
        continue;
      }

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

    const formattedChatList = chatList.map((item) => {
      const normalizedPhone = normalizePhoneNumber(item.profile?.phone);
      const customName = contactMap.get(normalizedPhone) || item.profile.displayName || "Unknown";
      return {
        profile: formatProfile(
          item.profile,
          userMap.get(normalizedPhone),
          customName
        ),
        latestMessage: formatChat(item.latestMessage),
        unreadCount: item.unreadCount,
        pinned: item.pinned,
      };
    });
    console.log(`getChatList: Formatted chat list length: ${formattedChatList.length}`);

    const response = {
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formattedChatList,
    };
    console.log(`getChatList: Response prepared: ${JSON.stringify(response).substring(0, 200)}...`);
    return res.json(response);
  } catch (err) {
    console.error(`getChatList: Error: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: err.message,
    });
  }
};

/**
 * Upsert Contact
 */
export const upsertContact = async (req, res) => {
  try {
    console.log(`upsertContact: Request body: ${JSON.stringify(req.body)}, userId: ${req.user._id}`);
    const { phone, customName } = req.body;
    const userId = req.user._id;

    const normalizedPhone = normalizePhoneNumber(phone); // Normalize
    if (!normalizedPhone) {
      console.error("upsertContact: Valid phone number is required");
      return res.status(400).json({ success: false, error: "Valid phone number is required" });
    }

    // Fetch profile to get displayName as fallback
    const profile = await Profile.findOne({ phone: normalizedPhone }).select("displayName");
    const fallbackName = profile?.displayName || "Unknown";

    const contact = await Contact.findOneAndUpdate(
      { userId, phone: normalizedPhone },
      { customName: customName?.trim() || fallbackName },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`upsertContact: Contact saved for phone: ${normalizedPhone}, customName: ${contact.customName}`);

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