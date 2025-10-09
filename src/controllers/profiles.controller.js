// controllers/profileController.js
import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import Chat from "../models/Chat.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import Block from "../models/Block.js";

/**
 * Helper: Format profile for response
 */
const formatProfile = (profile, user, customName = null) => ({
  id: profile?._id || null,
  userId: user?._id || null,
  phone: profile?.phone || null,
  displayName: customName || profile?.displayName || "Unknown",
  randomNumber: profile?.randomNumber || "",
  isVisible: profile?.isVisible ?? false,
  isNumberVisible: profile?.isNumberVisible ?? false,
  avatarUrl: profile?.avatarUrl || "",
  createdAt: profile?.createdAt || null,
  online: user?.online ?? false,
  lastSeen: user?.lastSeen || null,
});

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
      return res.status(400).json({ error: "Request body is missing or invalid JSON" });
    }

    const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
    const phone = req.user?.phone;

    if (!phone) return res.status(401).json({ error: "Phone number not found in token" });
    if (!displayName?.trim()) return res.status(400).json({ error: "Display name is required" });

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
      });
      await user.save();
    }

    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formatProfile(profile, user),
    });
  } catch (err) {
    console.error("createProfile error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};

/**
 * Get My Profile
 */
export const getMyProfile = async (req, res) => {
  try {
    const profile = await Profile.findOne({ phone: req.user.phone });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const user = await User.findOne({ phone: req.user.phone });

    return res.json({ success: true, profile: formatProfile(profile, user) });
  } catch (err) {
    console.error("getMyProfile error:", err);
    res.status(500).json({ error: "Server error" });
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

    const phoneNumbers = publicProfiles.map((p) => p.phone);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
    const userMap = new Map(users.map((u) => [u.phone, u]));

    return res.json({
      success: true,
      page,
      limit,
      profiles: publicProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
    });
  } catch (err) {
    console.error("getPublicProfiles error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Get Profiles from Contacts
 */
export const getProfilesFromContacts = async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: "Contacts array is required" });
    }

    const customContacts = await Contact.find({
      userId: req.user._id,
      phone: { $in: contacts }
    });
    const customNameMap = new Map(customContacts.map(c => [c.phone, c.customName]));

    const matchedProfiles = await Profile.find({ phone: { $in: contacts } })
      .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

    const phoneNumbers = matchedProfiles.map(p => p.phone);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
    const userMap = new Map(users.map(u => [u.phone, u]));

    return res.json({
      success: true,
      profiles: matchedProfiles.map(profile => 
        formatProfile(profile, userMap.get(profile.phone), customNameMap.get(profile.phone))
      ),
    });
  } catch (err) {
    console.error("getProfilesFromContacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Get profile + chat history with target user
 */
export const getProfileWithChat = async (req, res) => {
  try {
    const myPhone = req.user.phone;
    const targetPhone = req.params.phone;

    if (!targetPhone) {
      return res.status(400).json({ error: "Target phone number is required" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) {
      return res.status(404).json({ error: "Target profile not found" });
    }

    const targetUser = await User.findOne({ phone: targetPhone });

    const customContact = await Contact.findOne({
      userId: req.user._id,
      phone: targetPhone
    });

    const chats = await Chat.find({
      $or: [
        { senderId: myProfile._id, receiverId: targetProfile._id },
        { senderId: targetProfile._id, receiverId: myProfile._id },
      ],
      deletedFor: { $ne: myProfile._id } // Exclude deleted chats
    })
      .sort({ createdAt: -1 })
      .limit(50);

    return res.json({
      success: true,
      profile: formatProfile(targetProfile, targetUser, customContact?.customName),
      chatHistory: chats.map(chat => ({
        id: chat?._id || null,
        senderId: chat?.senderId?._id || null,
        receiverId: chat?.receiverId?._id || null,
        type: chat?.type || "text",
        content: chat?.content || "",
        duration: chat?.duration || null,
        status: chat?.status || "sent",
        createdAt: chat?.createdAt || null,
        pinned: chat?.pinned || false,
      })),
    });
  } catch (err) {
    console.error("getProfileWithChat error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

/**
 * Get Chat List
 */
export const getChatList = async (req, res) => {
  try {
    const myPhone = req.user.phone;
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
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
      return res.json({
        success: true,
        page,
        limit,
        total: 0,
        chats: [],
      });
    }

    // Collect all unique contact phones
    const contactPhones = [
      ...new Set(
        chats
          .map(chat => {
            if (chat.senderId?._id.toString() !== myProfile._id.toString()) return chat.senderId?.phone;
            if (chat.receiverId?._id.toString() !== myProfile._id.toString()) return chat.receiverId?.phone;
            return null;
          })
          .filter(Boolean)
      ),
    ];

    const users = await User.find({ phone: { $in: contactPhones } }).select("phone online lastSeen");
    const userMap = new Map(users.map(u => [u.phone, u]));

    const customContacts = await Contact.find({
      userId: userId,
      phone: { $in: contactPhones }
    });
    const customNameMap = new Map(customContacts.map(c => [c.phone, c.customName]));

    const chatMap = new Map();
    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) continue;

      const isSenderMe = chat.senderId._id.toString() === myProfile._id.toString();
      const otherProfile = isSenderMe ? chat.receiverId : chat.senderId;

      if (!otherProfile?.phone) continue;

      const otherProfileId = otherProfile._id.toString();

      if (!chatMap.has(otherProfileId)) {
        chatMap.set(otherProfileId, {
          profile: otherProfile,
          latestMessage: chat,
          unreadCount: (!isSenderMe && ["sent", "delivered"].includes(chat.status)) ? 1 : 0,
          pinned: chat.pinned,
        });
      } else {
        const existing = chatMap.get(otherProfileId);
        if (new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)) {
          existing.latestMessage = chat;
          existing.pinned = chat.pinned;
        }
        if (!isSenderMe && ["sent", "delivered"].includes(chat.status)) {
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

    const formattedChatList = chatList.map(item => ({
      profile: formatProfile(item.profile, userMap.get(item.profile.phone), customNameMap.get(item.profile.phone)),
      latestMessage: {
        id: item.latestMessage?._id || null,
        senderId: item.latestMessage?.senderId?._id || null,
        receiverId: item.latestMessage?.receiverId?._id || null,
        type: item.latestMessage?.type || "text",
        content: item.latestMessage?.content?.substring(0, 50) + (item.latestMessage?.content?.length > 50 ? "..." : "") || "",
        duration: item.latestMessage?.duration || null,
        status: item.latestMessage?.status || "sent",
        createdAt: item.latestMessage?.createdAt || null,
        pinned: item.latestMessage?.pinned || false,
      },
      unreadCount: item.unreadCount,
      pinned: item.pinned,
    }));

    return res.json({
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formattedChatList,
    });
  } catch (err) {
    console.error("getChatList error:", err);
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
    const { phone, customName } = req.body;
    const userId = req.user._id;

    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Valid phone number is required" });
    }

    const contact = await Contact.findOneAndUpdate(
      { userId, phone },
      { customName: customName?.trim() || null },
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
    console.error("upsertContact error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/**
 * Delete Contact
 */
export const deleteContact = async (req, res) => {
  try {
    const { phone } = req.params;
    const userId = req.user._id;

    const result = await Contact.findOneAndDelete({ userId, phone });

    if (!result) {
      return res.status(404).json({ error: "Contact not found" });
    }

    return res.json({ success: true, message: "Contact deleted" });
  } catch (err) {
    console.error("deleteContact error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/**
 * Send Message
 */
export const sendMessage = async (req, res) => {
  try {
    const myPhone = req.user.phone;
    const { receiverPhone, type = "text", content, duration } = req.body;

    if (!receiverPhone) {
      return res.status(400).json({ error: "Receiver phone number is required" });
    }

    if (type === "text" && !content?.trim()) {
      return res.status(400).json({ error: "Content is required for text messages" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ error: "Your profile not found" });
    }

    const receiverProfile = await Profile.findOne({ phone: receiverPhone });
    if (!receiverProfile) {
      return res.status(404).json({ error: "Receiver profile not found" });
    }

    // Check if blocked
    const isBlocked = await Block.findOne({ blockerId: myProfile._id, blockedId: receiverProfile._id }) || 
                      await Block.findOne({ blockerId: receiverProfile._id, blockedId: myProfile._id });
    if (isBlocked) {
      return res.status(403).json({ error: "Cannot send message to blocked user" });
    }

    const newChat = new Chat({
      senderId: myProfile._id,
      receiverId: receiverProfile._id,
      type,
      content: content?.trim(),
      duration,
      status: "sent",
      pinned: false,
      deletedFor: [],
    });

    await newChat.save();

    return res.json({
      success: true,
      message: "Message sent",
      chat: {
        id: newChat._id,
        senderId: newChat.senderId,
        receiverId: newChat.receiverId,
        type: newChat.type,
        content: newChat.content,
        duration: newChat.duration,
        status: newChat.status,
        createdAt: newChat.createdAt,
        pinned: newChat.pinned,
      },
    });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};

/**
 * Delete Conversation (soft delete for current user)
 */
export const deleteConversation = async (req, res) => {
  try {
    const myPhone = req.user.phone;
    const targetPhone = req.params.phone;

    if (!targetPhone) {
      return res.status(400).json({ error: "Target phone number is required" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) {
      return res.status(404).json({ error: "Target profile not found" });
    }

    const updateResult = await Chat.updateMany(
      {
        $or: [
          { senderId: myProfile._id, receiverId: targetProfile._id },
          { senderId: targetProfile._id, receiverId: myProfile._id },
        ],
      },
      { $addToSet: { deletedFor: myProfile._id } }
    );

    return res.json({
      success: true,
      message: "Conversation deleted for you. Old messages won't show in future chats.",
      modifiedCount: updateResult.modifiedCount,
    });
  } catch (err) {
    console.error("deleteConversation error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};

/**
 * Delete My Profile (hard delete all data)
 */
export const deleteMyProfile = async (req, res) => {
  try {
    const myPhone = req.user.phone;
    const userId = req.user._id;

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Delete contacts
    await Contact.deleteMany({ userId });

    // Delete chats
    await Chat.deleteMany({
      $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }],
    });

    // Delete blocks
    await Block.deleteMany({
      $or: [{ blockerId: userId }, { blockedId: userId }],
    });

    // Delete profile and user
    await Profile.deleteOne({ _id: myProfile._id });
    await User.deleteOne({ _id: userId });

    return res.json({
      success: true,
      message: "Profile and all related data deleted successfully",
    });
  } catch (err) {
    console.error("deleteMyProfile error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};












// import jwt from "jsonwebtoken";
// import Profile from "../models/Profile.js";
// import Chat from "../models/Chat.js";
// import User from "../models/User.js";

// /**
//  * Middleware to verify JWT token
//  */
// export const authenticateToken = (req, res, next) => {
//   try {
//     const authHeader = req.headers["authorization"];
//     const token = authHeader?.split(" ")[1];

//     if (!token) {
//       return res.status(401).json({ error: "Access token is required" });
//     }

//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     req.user = decoded; // { phone, iat, exp }
//     next();
//   } catch (err) {
//     console.error("JWT verification failed:", err.message);
//     return res.status(403).json({ error: "Invalid or expired token" });
//   }
// };

// /**
//  * Helper: Format profile for response
//  */
// const formatProfile = (profile, user) => ({
//   id: profile?._id || null,               // Profile ID
//   userId: user?._id || null,              // 👈 CRITICAL: User ID for sockets
//   phone: profile?.phone || null,
//   displayName: profile?.displayName || "Unknown",
//   randomNumber: profile?.randomNumber || "",
//   isVisible: profile?.isVisible ?? false,
//   isNumberVisible: profile?.isNumberVisible ?? false,
//   avatarUrl: profile?.avatarUrl || "",
//   createdAt: profile?.createdAt || null,
//   online: user?.online ?? false,
//   lastSeen: user?.lastSeen || null,
// });

// /**
//  * Generate 11-digit random number
//  */
// const generateRandom11DigitNumber = () => {
//   return Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("");
// };

// /**
//  * Create or Update Profile
//  */
// export const createProfile = async (req, res) => {
//   try {
//     if (!req.body || typeof req.body !== "object") {
//       return res.status(400).json({ error: "Request body is missing or invalid JSON" });
//     }

//     const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
//     const phone = req.user?.phone;

//     if (!phone) return res.status(401).json({ error: "Phone number not found in token" });
//     if (!displayName?.trim()) return res.status(400).json({ error: "Display name is required" });

//     let profile = await Profile.findOne({ phone });

//     if (profile) {
//       profile.displayName = displayName.trim();
//       profile.isVisible = isVisible;
//       profile.isNumberVisible = isNumberVisible;
//       profile.avatarUrl = avatarUrl.trim();
//     } else {
//       profile = new Profile({
//         phone,
//         displayName: displayName.trim(),
//         randomNumber: generateRandom11DigitNumber(),
//         isVisible,
//         isNumberVisible,
//         avatarUrl: avatarUrl.trim(),
//       });
//     }

//     await profile.save();

//     // Create or update corresponding User entry
//     let user = await User.findOne({ phone });
//     if (!user) {
//       user = new User({
//         phone,
//         displayName: displayName.trim(),
//         online: false,
//         lastSeen: new Date(),
//       });
//       await user.save();
//     }

//     return res.status(201).json({
//       success: true,
//       message: "Profile saved successfully",
//       profile: formatProfile(profile, user),
//     });
//   } catch (err) {
//     console.error("createProfile error:", err);
//     return res.status(500).json({ error: "Server error", details: err.message });
//   }
// };

// /**
//  * Get My Profile
//  */
// export const getMyProfile = async (req, res) => {
//   try {
//     const profile = await Profile.findOne({ phone: req.user.phone });
//     if (!profile) return res.status(404).json({ error: "Profile not found" });

//     const user = await User.findOne({ phone: req.user.phone });

//     return res.json({ success: true, profile: formatProfile(profile, user) });
//   } catch (err) {
//     console.error("getMyProfile error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// };

// /**
//  * Get Public Profiles (paginated)
//  */
// export const getPublicProfiles = async (req, res) => {
//   try {
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;
//     const skip = (page - 1) * limit;

//     const publicProfiles = await Profile.find({ isVisible: true })
//       .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone")
//       .skip(skip)
//       .limit(limit)
//       .sort({ createdAt: -1 });

//     const phoneNumbers = publicProfiles.map((p) => p.phone);
//     const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
//     const userMap = new Map(users.map((u) => [u.phone, u]));

//     return res.json({
//       success: true,
//       page,
//       limit,
//       profiles: publicProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
//     });
//   } catch (err) {
//     console.error("getPublicProfiles error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// };

// /**
//  * Get Profiles from Contacts
//  */
// export const getProfilesFromContacts = async (req, res) => {
//   try {
//     const { contacts } = req.body;
//     if (!Array.isArray(contacts) || contacts.length === 0) {
//       return res.status(400).json({ error: "Contacts array is required" });
//     }

//     const matchedProfiles = await Profile.find({ phone: { $in: contacts } })
//       .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

//     const phoneNumbers = matchedProfiles.map((p) => p.phone);
//     const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
//     const userMap = new Map(users.map((u) => [u.phone, u]));

//     return res.json({
//       success: true,
//       profiles: matchedProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
//     });
//   } catch (err) {
//     console.error("getProfilesFromContacts error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// };

// /**
//  * Format chat for response
//  */
// const formatChat = (chat) => ({
//   id: chat?._id || null,
//   senderId: chat?.senderId?._id || null,
//   receiverId: chat?.receiverId?._id || null,
//   type: chat?.type || "text",
//   content: chat?.content?.substring(0, 50) + (chat?.content?.length > 50 ? "..." : "") || "",
//   duration: chat?.duration || null,
//   status: chat?.status || "sent",
//   createdAt: chat?.createdAt || null,
//   pinned: chat?.pinned || false,
// });

// /**
//  * Get profile + chat history with target user
//  */
// export const getProfileWithChat = async (req, res) => {
//   try {
//     const myPhone = req.user.phone;
//     const targetPhone = req.params.phone;

//     if (!targetPhone) {
//       return res.status(400).json({ error: "Target phone number is required" });
//     }

//     const myProfile = await Profile.findOne({ phone: myPhone });
//     if (!myProfile) {
//       return res.status(404).json({ error: "Your profile not found" });
//     }

//     const targetProfile = await Profile.findOne({ phone: targetPhone });
//     if (!targetProfile) {
//       return res.status(404).json({ error: "Target profile not found" });
//     }

//     const targetUser = await User.findOne({ phone: targetPhone });

//     const chats = await Chat.find({
//       $or: [
//         { senderId: myProfile._id, receiverId: targetProfile._id },
//         { senderId: targetProfile._id, receiverId: myProfile._id },
//       ],
//     })
//       .sort({ createdAt: -1 })
//       .limit(50);

//     return res.json({
//       success: true,
//       profile: formatProfile(targetProfile, targetUser),
//       chatHistory: chats.map(formatChat),
//     });
//   } catch (err) {
//     console.error("getProfileWithChat error:", err);
//     res.status(500).json({ error: "Server error", details: err.message });
//   }
// };

// export const getChatList = async (req, res) => {
//   try {
//     const myPhone = req.user.phone;
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;

//     if (page < 1 || limit < 1 || limit > 100) {
//       return res.status(400).json({
//         success: false,
//         error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
//       });
//     }
//     const skip = (page - 1) * limit;

//     const myProfile = await Profile.findOne({ phone: myPhone });
//     if (!myProfile) {
//       return res.status(404).json({ success: false, error: "Your profile not found" });
//     }

//     const chats = await Chat.find({
//       $and: [
//         { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
//         { receiverId: { $ne: null } },
//         { deletedFor: { $ne: myProfile._id } },
//       ],
//     })
//       .sort({ pinned: -1, createdAt: -1 })
//       .populate("senderId receiverId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt");

//     if (!chats || chats.length === 0) {
//       return res.json({
//         success: true,
//         page,
//         limit,
//         total: 0,
//         chats: [],
//       });
//     }

//     const phoneNumbers = [
//       ...new Set([
//         ...chats.map((chat) => chat.senderId?.phone).filter(Boolean),
//         ...chats.map((chat) => chat.receiverId?.phone).filter(Boolean),
//       ]),
//     ];
//     const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
//     const userMap = new Map(users.map((u) => [u.phone, u]));

//     const chatMap = new Map();
//     for (const chat of chats) {
//       if (!chat.senderId || !chat.receiverId) {
//         console.warn(`Chat ${chat._id} missing senderId or receiverId`);
//         continue;
//       }

//       const otherProfileId =
//         chat.senderId._id.toString() === myProfile._id.toString()
//           ? chat.receiverId._id.toString()
//           : chat.senderId._id.toString();

//       if (!chatMap.has(otherProfileId)) {
//         const otherProfile =
//           chat.senderId._id.toString() === myProfile._id.toString() ? chat.receiverId : chat.senderId;
//         chatMap.set(otherProfileId, {
//           profile: otherProfile,
//           latestMessage: chat,
//           unreadCount:
//             chat.receiverId._id.toString() === myProfile._id.toString() &&
//             ["sent", "delivered"].includes(chat.status)
//               ? 1
//               : 0,
//           pinned: chat.pinned,
//         });
//       } else {
//         const existing = chatMap.get(otherProfileId);
//         if (new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)) {
//           existing.latestMessage = chat;
//           existing.pinned = chat.pinned;
//         }
//         if (
//           chat.receiverId._id.toString() === myProfile._id.toString() &&
//           ["sent", "delivered"].includes(chat.status)
//         ) {
//           existing.unreadCount += 1;
//         }
//       }
//     }

//     const chatList = Array.from(chatMap.values())
//       .sort((a, b) => {
//         if (a.pinned && !b.pinned) return -1;
//         if (!a.pinned && b.pinned) return 1;
//         return new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt);
//       })
//       .slice(skip, skip + limit);

//     const formattedChatList = chatList.map((item) => ({
//       profile: formatProfile(item.profile, userMap.get(item.profile?.phone)),
//       latestMessage: formatChat(item.latestMessage),
//       unreadCount: item.unreadCount,
//       pinned: item.pinned,
//     }));

//     return res.json({
//       success: true,
//       page,
//       limit,
//       total: chatMap.size,
//       chats: formattedChatList,
//     });
//   } catch (err) {
//     console.error("getChatList error:", err);
//     return res.status(500).json({
//       success: false,
//       error: "Server error",
//       details: err.message,
//     });
//   }
// };



// export const upsertContact = async (req, res) => {
//   try {
//     const { phone, customName } = req.body;
//     const userId = req.user._id;

//     if (!phone || typeof phone !== "string") {
//       return res.status(400).json({ error: "Valid phone number is required" });
//     }

//     const contact = await Contact.findOneAndUpdate(
//       { userId, phone },
//       { customName: customName?.trim() || null },
//       { new: true, upsert: true, setDefaultsOnInsert: true }
//     );

//     return res.json({
//       success: true,
//       message: "Contact saved",
//       contact: {
//         phone: contact.phone,
//         customName: contact.customName,
//       },
//     });
//   } catch (err) {
//     console.error("upsertContact error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// };






























// // import jwt from "jsonwebtoken";
// //    import Profile from "../models/Profile.js";
// //    import Chat from "../models/Chat.js";
// //    import User from "../models/User.js"; // Import User model for online status

// //    /**
// //     * Middleware to verify JWT token
// //     */
// //    export const authenticateToken = (req, res, next) => {
// //      try {
// //        const authHeader = req.headers["authorization"];
// //        const token = authHeader?.split(" ")[1];

// //        if (!token) {
// //          return res.status(401).json({ error: "Access token is required" });
// //        }

// //        const decoded = jwt.verify(token, process.env.JWT_SECRET);
// //        req.user = decoded; // { phone, iat, exp }
// //        next();
// //      } catch (err) {
// //        console.error("JWT verification failed:", err.message);
// //        return res.status(403).json({ error: "Invalid or expired token" });
// //      }
// //    };

// //    /**
// //     * Helper: Format profile for response
// //     */
// //    const formatProfile = (profile, user) => ({
// //      id: profile?._id || null,
// //      phone: profile?.phone || null,
// //      displayName: profile?.displayName || "Unknown",
// //      randomNumber: profile?.randomNumber || "",
// //      isVisible: profile?.isVisible ?? false,
// //      isNumberVisible: profile?.isNumberVisible ?? false,
// //      avatarUrl: profile?.avatarUrl || "",
// //      createdAt: profile?.createdAt || null,
// //      online: user?.online ?? false,
// //      lastSeen: user?.lastSeen || null,
// //    });

// //    /**
// //     * Generate 11-digit random number
// //     */
// //    const generateRandom11DigitNumber = () => {
// //      return Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("");
// //    };

// //    /**
// //     * Create or Update Profile
// //     */
// //    export const createProfile = async (req, res) => {
// //      try {
// //        console.log("Request headers:", req.headers); // Debug
// //        console.log("Request body:", req.body); // Debug
// //        if (!req.body || typeof req.body !== "object") {
// //          return res.status(400).json({ error: "Request body is missing or invalid JSON" });
// //        }

// //        const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
// //        const phone = req.user?.phone;

// //        if (!phone) return res.status(401).json({ error: "Phone number not found in token" });
// //        if (!displayName?.trim()) return res.status(400).json({ error: "Display name is required" });

// //        let profile = await Profile.findOne({ phone });

// //        if (profile) {
// //          profile.displayName = displayName.trim();
// //          profile.isVisible = isVisible;
// //          profile.isNumberVisible = isNumberVisible;
// //          profile.avatarUrl = avatarUrl.trim();
// //        } else {
// //          profile = new Profile({
// //            phone,
// //            displayName: displayName.trim(),
// //            randomNumber: generateRandom11DigitNumber(),
// //            isVisible,
// //            isNumberVisible,
// //            avatarUrl: avatarUrl.trim(),
// //          });
// //        }

// //        await profile.save();

// //        // Create or update corresponding User entry
// //        let user = await User.findOne({ phone });
// //        if (!user) {
// //          user = new User({
// //            phone,
// //            displayName: displayName.trim(),
// //            online: false,
// //            lastSeen: new Date(),
// //          });
// //          await user.save();
// //        }

// //        return res.status(201).json({
// //          success: true,
// //          message: "Profile saved successfully",
// //          profile: formatProfile(profile, user),
// //        });
// //      } catch (err) {
// //        console.error("createProfile error:", err);
// //        return res.status(500).json({ error: "Server error", details: err.message });
// //      }
// //    };

// //    /**
// //     * Get My Profile
// //     */
// //    export const getMyProfile = async (req, res) => {
// //      try {
// //        const profile = await Profile.findOne({ phone: req.user.phone });
// //        if (!profile) return res.status(404).json({ error: "Profile not found" });

// //        const user = await User.findOne({ phone: req.user.phone });

// //        return res.json({ success: true, profile: formatProfile(profile, user) });
// //      } catch (err) {
// //        console.error("getMyProfile error:", err);
// //        res.status(500).json({ error: "Server error" });
// //      }
// //    };

// //    /**
// //     * Get Public Profiles (paginated)
// //     */
// //    export const getPublicProfiles = async (req, res) => {
// //      try {
// //        const page = parseInt(req.query.page) || 1;
// //        const limit = parseInt(req.query.limit) || 20;
// //        const skip = (page - 1) * limit;

// //        const publicProfiles = await Profile.find({ isVisible: true })
// //          .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone")
// //          .skip(skip)
// //          .limit(limit)
// //          .sort({ createdAt: -1 });

// //        const phoneNumbers = publicProfiles.map((p) => p.phone);
// //        const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
// //        const userMap = new Map(users.map((u) => [u.phone, u]));

// //        return res.json({
// //          success: true,
// //          page,
// //          limit,
// //          profiles: publicProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
// //        });
// //      } catch (err) {
// //        console.error("getPublicProfiles error:", err);
// //        res.status(500).json({ error: "Server error" });
// //      }
// //    };

// //    /**
// //     * Get Profiles from Contacts
// //     */
// //    export const getProfilesFromContacts = async (req, res) => {
// //      try {
// //        const { contacts } = req.body;
// //        if (!Array.isArray(contacts) || contacts.length === 0) {
// //          return res.status(400).json({ error: "Contacts array is required" });
// //        }

// //        const matchedProfiles = await Profile.find({ phone: { $in: contacts } })
// //          .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

// //        const phoneNumbers = matchedProfiles.map((p) => p.phone);
// //        const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
// //        const userMap = new Map(users.map((u) => [u.phone, u]));

// //        return res.json({
// //          success: true,
// //          profiles: matchedProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
// //        });
// //      } catch (err) {
// //        console.error("getProfilesFromContacts error:", err);
// //        res.status(500).json({ error: "Server error" });
// //      }
// //    };

// //    /**
// //     * Format chat for response
// //     */
// //    const formatChat = (chat) => ({
// //      id: chat?._id || null,
// //      senderId: chat?.senderId?._id || null,
// //      receiverId: chat?.receiverId?._id || null,
// //      type: chat?.type || "text",
// //      content: chat?.content?.substring(0, 50) + (chat?.content?.length > 50 ? "..." : "") || "", // Truncate to 50 chars
// //      duration: chat?.duration || null,
// //      status: chat?.status || "sent",
// //      createdAt: chat?.createdAt || null,
// //      pinned: chat?.pinned || false, // Include pinned status
// //    });

// //    /**
// //     * Get profile + chat history with target user
// //     */
// //    export const getProfileWithChat = async (req, res) => {
// //      try {
// //        const myPhone = req.user.phone;
// //        const targetPhone = req.params.phone;

// //        if (!targetPhone) {
// //          return res.status(400).json({ error: "Target phone number is required" });
// //        }

// //        // Find my profile to get my _id
// //        const myProfile = await Profile.findOne({ phone: myPhone });
// //        if (!myProfile) {
// //          return res.status(404).json({ error: "Your profile not found" });
// //        }

// //        // Find target profile to get their _id
// //        const targetProfile = await Profile.findOne({ phone: targetPhone });
// //        if (!targetProfile) {
// //          return res.status(404).json({ error: "Target profile not found" });
// //        }

// //        // Find target user for online status
// //        const targetUser = await User.findOne({ phone: targetPhone });

// //        // Find chat history using _id (both directions)
// //        const chats = await Chat.find({
// //          $or: [
// //            { senderId: myProfile._id, receiverId: targetProfile._id },
// //            { senderId: targetProfile._id, receiverId: myProfile._id },
// //          ],
// //        })
// //          .sort({ createdAt: -1 }) // Newest first
// //          .limit(50); // Last 50 messages for performance

// //        return res.json({
// //          success: true,
// //          profile: formatProfile(targetProfile, targetUser),
// //          chatHistory: chats.map(formatChat),
// //        });
// //      } catch (err) {
// //        console.error("getProfileWithChat error:", err);
// //        res.status(500).json({ error: "Server error", details: err.message });
// //      }
// //    };

  
// //    export const getChatList = async (req, res) => {
// //      try {
// //        const myPhone = req.user.phone;
// //        const page = parseInt(req.query.page) || 1;
// //        const limit = parseInt(req.query.limit) || 20;

// //        // Validate pagination parameters
// //        if (page < 1 || limit < 1 || limit > 100) {
// //          return res.status(400).json({
// //            success: false,
// //            error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
// //          });
// //        }
// //        const skip = (page - 1) * limit;

// //        // Find my profile
// //        const myProfile = await Profile.findOne({ phone: myPhone });
// //        if (!myProfile) {
// //          return res.status(404).json({ success: false, error: "Your profile not found" });
// //        }

// //        const chats = await Chat.find({
// //          $and: [
// //            { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
// //            { receiverId: { $ne: null } }, 
// //            { deletedFor: { $ne: myProfile._id } }, 
// //          ],
// //        })
// //          .sort({ pinned: -1, createdAt: -1 })
// //          .populate("senderId receiverId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt");

// //        // If no chats exist, return empty list
// //        if (!chats || chats.length === 0) {
// //          return res.json({
// //            success: true,
// //            page,
// //            limit,
// //            total: 0,
// //            chats: [],
// //          });
// //        }

// //        const phoneNumbers = [
// //          ...new Set([
// //            ...chats.map((chat) => chat.senderId?.phone).filter(Boolean),
// //            ...chats.map((chat) => chat.receiverId?.phone).filter(Boolean),
// //          ]),
// //        ];
// //        const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
// //        const userMap = new Map(users.map((u) => [u.phone, u]));

// //        const chatMap = new Map();
// //        for (const chat of chats) {
// //          if (!chat.senderId || !chat.receiverId) {
// //            console.warn(`Chat ${chat._id} missing senderId or receiverId`);
// //            continue;
// //          }

// //          const otherProfileId =
// //            chat.senderId._id.toString() === myProfile._id.toString()
// //              ? chat.receiverId._id.toString()
// //              : chat.senderId._id.toString();

// //          if (!chatMap.has(otherProfileId)) {
// //            const otherProfile =
// //              chat.senderId._id.toString() === myProfile._id.toString() ? chat.receiverId : chat.senderId;
// //            chatMap.set(otherProfileId, {
// //              profile: otherProfile,
// //              latestMessage: chat,
// //              unreadCount:
// //                chat.receiverId._id.toString() === myProfile._id.toString() &&
// //                ["sent", "delivered"].includes(chat.status)
// //                  ? 1
// //                  : 0,
// //              pinned: chat.pinned,
// //            });
// //          } else {
// //            const existing = chatMap.get(otherProfileId);
// //            if (new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)) {
// //              existing.latestMessage = chat;
// //              existing.pinned = chat.pinned;
// //            }
// //            if (
// //              chat.receiverId._id.toString() === myProfile._id.toString() &&
// //              ["sent", "delivered"].includes(chat.status)
// //            ) {
// //              existing.unreadCount += 1;
// //            }
// //          }
// //        }

// //        const chatList = Array.from(chatMap.values())
// //          .sort((a, b) => {
// //            if (a.pinned && !b.pinned) return -1;
// //            if (!a.pinned && b.pinned) return 1;
// //            return new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt);
// //          })
// //          .slice(skip, skip + limit);

// //        const formattedChatList = chatList.map((item) => ({
// //          profile: formatProfile(item.profile, userMap.get(item.profile?.phone)),
// //          latestMessage: formatChat(item.latestMessage),
// //          unreadCount: item.unreadCount,
// //          pinned: item.pinned,
// //        }));

// //        return res.json({
// //          success: true,
// //          page,
// //          limit,
// //          total: chatMap.size,
// //          chats: formattedChatList,
// //        });
// //      } catch (err) {
// //        console.error("getChatList error:", err);
// //        return res.status(500).json({
// //          success: false,
// //          error: "Server error",
// //          details: err.message,
// //        });
// //      }
// //    };


