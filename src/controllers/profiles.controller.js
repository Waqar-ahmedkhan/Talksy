// controllers/profile.controller.js
import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";

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
      return res
        .status(401)
        .json({ success: false, error: "Access token is required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(
      `authenticateToken: Token decoded, payload: ${JSON.stringify(decoded)}`
    );

    if (!decoded.phone) {
      console.error("authenticateToken: Phone number missing in token payload");
      return res
        .status(403)
        .json({ success: false, error: "Invalid token: Phone number missing" });
    }

    // Fetch user from database to get _id
    const user = await User.findOne({ phone: decoded.phone }).select(
      "_id phone"
    );
    if (!user) {
      console.error(
        `authenticateToken: No user found for phone: ${decoded.phone}`
      );
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Attach user data to request
    req.user = {
      _id: user._id,
      phone: decoded.phone,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    console.log(
      `authenticateToken: User data attached to req.user: ${JSON.stringify(
        req.user
      )}`
    );
    next();
  } catch (err) {
    console.error(`authenticateToken: JWT verification failed: ${err.message}`);
    return res
      .status(403)
      .json({ success: false, error: "Invalid or expired token" });
  }
};

/**
 * Helper: Format profile for response
 */
export const formatProfile = (profile, user, customName = null) => {
  const phone = profile?.phone || "unknown";
  console.log(`formatProfile: Formatting profile for phone: ${phone}, customName: ${customName}`);

  const formatted = {
    id: profile?._id || null,
    userId: user?._id || null,
    phone: profile?.phone || null,

    // 🧠 Show custom name first, otherwise number, otherwise displayName
    displayName:
      customName ||
      (profile?.isNumberVisible && profile?.phone) ||
      profile?.displayName ||
      "Unknown",

    randomNumber: profile?.randomNumber || "",
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: profile?.avatarUrl || "",
    createdAt: profile?.createdAt || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen || null,

    // 🧩 Always return customName separately too
    customName: customName || null,
  };

  console.log(`formatProfile: Formatted profile: ${JSON.stringify(formatted)}`);
  return formatted;
};



/**
 * Generate 11-digit random number
 */
const generateRandom11DigitNumber = () => {
  const randomNumber = Array.from({ length: 11 }, () =>
    Math.floor(Math.random() * 10)
  ).join("");
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
      return res.status(400).json({
        success: false,
        error: "Request body is missing or invalid JSON",
      });
    }

    const {
      displayName,
      isVisible = false,
      isNumberVisible = false,
      avatarUrl = "",
    } = req.body;
    const phone = req.user?.phone;

    if (!phone) {
      console.error("createProfile: Phone number not found in token");
      return res
        .status(401)
        .json({ success: false, error: "Phone number not found in token" });
    }
    if (!displayName?.trim()) {
      console.error("createProfile: Display name is required");
      return res
        .status(400)
        .json({ success: false, error: "Display name is required" });
    }

    let profile = await Profile.findOne({ phone });
    console.log(
      `createProfile: Profile ${
        profile ? "found" : "not found"
      } for phone: ${phone}`
    );

    if (profile) {
      profile.displayName = displayName.trim();
      profile.isVisible = isVisible;
      profile.isNumberVisible = isNumberVisible;
      profile.avatarUrl = avatarUrl.trim();
      console.log(
        `createProfile: Updating existing profile for phone: ${phone}`
      );
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
    console.log(
      `createProfile: Profile saved for phone: ${phone}, _id: ${profile._id}`
    );

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
      console.log(
        `createProfile: New user created for phone: ${phone}, _id: ${user._id}`
      );
    } else {
      console.log(
        `createProfile: Existing user found for phone: ${phone}, _id: ${user._id}`
      );
    }

    // Fetch customName (optional, as user rarely assigns customName to self)
    const contact = await Contact.findOne({
      userId: req.user._id,
      phone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(`createProfile: Custom name for phone ${phone}: ${customName}`);

    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formatProfile(profile, user, customName),
    });
  } catch (err) {
    console.error(`createProfile: Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get My Profile
 */
export const getMyProfile = async (req, res) => {
  try {
    console.log(
      `getMyProfile: Fetching profile for phone: ${req.user.phone}, userId: ${req.user._id}`
    );
    const profile = await Profile.findOne({ phone: req.user.phone });
    if (!profile) {
      console.error(
        `getMyProfile: Profile not found for phone: ${req.user.phone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    const user = await User.findOne({ phone: req.user.phone });
    console.log(
      `getMyProfile: User ${user ? "found" : "not found"} for phone: ${
        req.user.phone
      }`
    );

    // Fetch customName (optional, as user rarely assigns customName to self)
    const contact = await Contact.findOne({
      userId: req.user._id,
      phone: req.user.phone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(
      `getMyProfile: Custom name for phone ${req.user.phone}: ${customName}`
    );

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
    console.log(
      `getPublicProfiles: Request query: ${JSON.stringify(
        req.query
      )}, userId: ${req.user._id}`
    );
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const publicProfiles = await Profile.find({ isVisible: true })
      .select(
        "displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone"
      )
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });
    console.log(
      `getPublicProfiles: Found ${publicProfiles.length} public profiles`
    );

    const phoneNumbers = publicProfiles.map((p) => p.phone);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select(
      "phone online lastSeen"
    );
    console.log(
      `getPublicProfiles: Found ${users.length} users for phone numbers`
    );
    const userMap = new Map(users.map((u) => [u.phone, u]));

    // Fetch custom names from Contact model
    const contacts = await Contact.find({
      userId: req.user._id,
      phone: { $in: phoneNumbers },
    }).select("phone customName");
    console.log(
      `getPublicProfiles: Found ${contacts.length} contacts for custom names`
    );
    const contactMap = new Map(
      contacts.map((c) => [c.phone, c.customName || null])
    );

    const response = {
      success: true,
      page,
      limit,
      profiles: publicProfiles.map((profile) =>
        formatProfile(
          profile,
          userMap.get(profile.phone),
          contactMap.get(profile.phone)
        )
      ),
    };
    console.log(
      `getPublicProfiles: Response prepared: ${JSON.stringify(
        response
      ).substring(0, 200)}...`
    );
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
    console.log(
      `getProfilesFromContacts: Request body: ${JSON.stringify(
        req.body
      )}, userId: ${req.user._id}`
    );
    const { contacts } = req.body;
    const userId = req.user._id;

    // Validate contacts array
    if (!Array.isArray(contacts) || contacts.length === 0) {
      console.error(
        "getProfilesFromContacts: Contacts array is invalid or empty"
      );
      return res
        .status(400)
        .json({ success: false, error: "Contacts array is required" });
    }
    console.log(
      `getProfilesFromContacts: Contacts array validated, length: ${contacts.length}`
    );

    // Determine if contacts is an array of strings or objects
    let phoneNumbers = [];
    let contactMap = new Map();

    if (typeof contacts[0] === "string") {
      console.log(
        "getProfilesFromContacts: Processing contacts as array of strings"
      );
      phoneNumbers = contacts;
      // Fetch custom names from Contact model
      console.log(
        `getProfilesFromContacts: Querying Contact model for userId: ${userId}, phones: ${phoneNumbers}`
      );
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(
        `getProfilesFromContacts: Found ${userContacts.length} contacts in Contact model`
      );
      userContacts.forEach((contact) => {
        console.log(
          `getProfilesFromContacts: Mapping contact: ${contact.phone} -> ${
            contact.customName || null
          }`
        );
        contactMap.set(contact.phone, contact.customName || null);
      });
    } else {
      console.log(
        "getProfilesFromContacts: Processing contacts as array of objects"
      );
      for (const contact of contacts) {
        if (!contact.phone || typeof contact.phone !== "string") {
          console.error(
            `getProfilesFromContacts: Invalid contact: ${JSON.stringify(
              contact
            )}`
          );
          return res.status(400).json({
            success: false,
            error: "Each contact must have a valid phone number",
          });
        }
        phoneNumbers.push(contact.phone);
        contactMap.set(contact.phone, contact.customName || null);
        console.log(
          `getProfilesFromContacts: Mapping contact: ${contact.phone} -> ${
            contact.customName || null
          }`
        );
      }
      // Merge with Contact model data to ensure consistency
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(
        `getProfilesFromContacts: Found ${userContacts.length} contacts for merging`
      );
      userContacts.forEach((contact) => {
        if (!contactMap.has(contact.phone)) {
          contactMap.set(contact.phone, contact.customName || null);
          console.log(
            `getProfilesFromContacts: Merged contact: ${contact.phone} -> ${
              contact.customName || null
            }`
          );
        }
      });
    }

    // Fetch profiles
    console.log(
      `getProfilesFromContacts: Querying Profile model for phones: ${phoneNumbers}`
    );
    const matchedProfiles = await Profile.find({
      phone: { $in: phoneNumbers },
    }).select(
      "displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone"
    );
    console.log(
      `getProfilesFromContacts: Found ${matchedProfiles.length} profiles`
    );

    // Fetch user status
    console.log(
      `getProfilesFromContacts: Querying User model for phones: ${phoneNumbers}`
    );
    const users = await User.find({
      phone: { $in: phoneNumbers },
    }).select("phone online lastSeen");
    console.log(`getProfilesFromContacts: Found ${users.length} users`);
    const userMap = new Map(users.map((u) => [u.phone, u]));

    const response = {
      success: true,
      profiles: matchedProfiles.map((profile) =>
        formatProfile(
          profile,
          userMap.get(profile.phone),
          contactMap.get(profile.phone)
        )
      ),
    };
    console.log(
      `getProfilesFromContacts: Response prepared: ${JSON.stringify(
        response
      ).substring(0, 200)}...`
    );
    return res.json(response);
  } catch (err) {
    console.error(`getProfilesFromContacts: Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: `Server error: ${err.message}` });
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
    content:
      chat?.content?.substring(0, 50) +
        (chat?.content?.length > 50 ? "..." : "") || "",
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
    console.log(
      `getProfileWithChat: Request params: ${JSON.stringify(
        req.params
      )}, userId: ${req.user._id}`
    );
    const myPhone = req.user.phone;
    const targetPhone = req.params.phone;

    if (!targetPhone) {
      console.error("getProfileWithChat: Target phone number is required");
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(
        `getProfileWithChat: Profile not found for phone: ${myPhone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({ phone: targetPhone });
    if (!targetProfile) {
      console.error(
        `getProfileWithChat: Profile not found for phone: ${targetPhone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Target profile not found" });
    }

    const targetUser = await User.findOne({ phone: targetPhone });
    console.log(
      `getProfileWithChat: Target user ${
        targetUser ? "found" : "not found"
      } for phone: ${targetPhone}`
    );

    // Fetch customName for target profile
    const contact = await Contact.findOne({
      userId: req.user._id,
      phone: targetPhone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(
      `getProfileWithChat: Custom name for phone ${targetPhone}: ${customName}`
    );

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
    console.log(
      `getProfileWithChat: Response prepared: ${JSON.stringify(
        response
      ).substring(0, 200)}...`
    );
    return res.json(response);
  } catch (err) {
    console.error(`getProfileWithChat: Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Normalize phone number
 */
const normalizePhoneNumber = (phone) => {
  if (!phone) return phone;
  let normalized = phone.trim();
  if (!normalized.startsWith("+")) {
    normalized = `+${normalized}`;
  }
  normalized = normalized.replace(/[\s-]/g, "");
  console.log(
    `normalizePhoneNumber: Normalized phone: ${phone} -> ${normalized}`
  );
  return normalized;
};

/**
 * Get Chat List
 */

// export const getChatList = async (req, res) => {
//   try {
//     const userId = req.user._id;
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;
//     const skip = (page - 1) * limit;

//     const myProfile = await User.findById(userId).lean();
//     if (!myProfile) {
//       return res
//         .status(404)
//         .json({ success: false, message: "User not found" });
//     }

//     const chats = await Chat.find({
//       $or: [{ senderId: userId }, { receiverId: userId }],
//     })
//       .sort({ updatedAt: -1 })
//       .skip(skip)
//       .limit(limit)
//       .populate("senderId receiverId")
//       .lean();

//     // get user contacts to map custom names
//     const contacts = await Contact.find({ ownerId: userId }).lean();
//     const contactMap = new Map();

//     contacts.forEach((c) => {
//       const phone = normalizePhoneNumber(c.contactPhone);
//       if (phone) contactMap.set(phone, c.customName);
//     });

//     // get all users' online status
//     const allUsers = await User.find(
//       {},
//       { phone: 1, online: 1, lastSeen: 1 }
//     ).lean();
//     const userMap = new Map();
//     allUsers.forEach((u) => {
//       const phone = normalizePhoneNumber(u.phone);
//       if (phone) userMap.set(phone, { online: u.online, lastSeen: u.lastSeen });
//     });

//     const chatMap = new Map();

//     for (const chat of chats) {
//       if (!chat.senderId || !chat.receiverId) continue;

//       const isSender =
//         chat.senderId._id.toString() === myProfile._id.toString();
//       const otherProfile = isSender ? chat.receiverId : chat.senderId;
//       const otherPhone = normalizePhoneNumber(otherProfile.phone);

//       // 1️⃣ pick custom name if available
//       const customName = contactMap.get(otherPhone) || null;

//       // 2️⃣ logic: if no customName -> show phone (if visible) -> else show displayName
//       let displayName;
//       if (customName) {
//         displayName = customName;
//       } else if (otherProfile.isNumberVisible !== false) {
//         displayName = otherProfile.phone;
//       } else {
//         displayName = otherProfile.displayName || "Unknown";
//       }

//       const userStatus = userMap.get(otherPhone) || {};

//       if (!chatMap.has(otherProfile._id.toString())) {
//         chatMap.set(otherProfile._id.toString(), {
//           id: otherProfile._id,
//           phone: otherProfile.phone,
//           displayName,
//           customName: customName || null,
//           randomNumber: otherProfile.randomNumber || "",
//           avatarUrl: otherProfile.avatarUrl || "",
//           online: userStatus.online || false,
//           lastSeen: userStatus.lastSeen || null,
//           latestMessage: formatChat(chat),
//         });
//       }
//     }

//     const chatList = Array.from(chatMap.values());

//     return res.json({
//       success: true,
//       page,
//       limit,
//       total: chatList.length,
//       chats: chatList,
//     });
//   } catch (error) {
//     console.error("[getChatList Error]", error);
//     return res
//       .status(500)
//       .json({ success: false, message: "Internal Server Error" });
//   }
// };

// const getChatList = async (req, res) => {
//   const { userId, page = 1, limit = 100 } = req.query;

//   if (!userId) {
//     return res.json({
//       success: false,
//       message: "userId is required",
//       chats: [],
//     });
//   }

//   try {
//     const skip = (page - 1) * limit;

//     const myProfile = await Profile.findOne({ userId });
//     if (!myProfile) {
//       return res.json({
//         success: false,
//         message: "Profile not found",
//         chats: [],
//       });
//     }

//     const myPhone = normalizePhoneNumber(myProfile.phone);
//     const contacts = await Contact.find({ userPhone: myPhone });
//     const contactMap = new Map(contacts.map(c => [normalizePhoneNumber(c.phone), c.customName]));
//     const userPhones = [...new Set([...contacts.map(c => normalizePhoneNumber(c.phone)), myPhone])];
//     const profiles = await Profile.find({ phone: { $in: userPhones } });
//     const profileMap = new Map(profiles.map(p => [normalizePhoneNumber(p.phone), p]));
//     const users = await User.find({ phone: { $in: userPhones } });
//     const userMap = new Map(users.map(u => [normalizePhoneNumber(u.phone), u]));

//     const chats = await Chat.find({
//       $or: [
//         { senderId: myProfile._id },
//         { receiverId: myProfile._id },
//       ],
//     })
//       .populate("senderId receiverId")
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(parseInt(limit));

//     const chatMap = new Map();

//     for (const chat of chats) {
//       if (!chat.senderId || !chat.receiverId) continue;

//       const isSender = chat.senderId._id.toString() === myProfile._id.toString();
//       const otherProfile = isSender ? chat.receiverId : chat.senderId;
//       const otherPhone = normalizePhoneNumber(otherProfile.phone);

//       const customName = contactMap.get(otherPhone) || null;
//       const userStatus = userMap.get(otherPhone) || {};

//       // ✅ Determine display name with priority:
//       let displayName;
//       if (customName) {
//         displayName = customName;
//       } else if (otherProfile.isNumberVisible) {
//         displayName = otherProfile.phone;
//       } else {
//         displayName = otherProfile.displayName || "Unknown";
//       }

//       if (!chatMap.has(otherProfile._id.toString())) {
//         chatMap.set(otherProfile._id.toString(), {
//           id: otherProfile._id,
//           phone: otherProfile.phone,
//           displayName,
//           customName,
//           randomNumber: otherProfile.randomNumber || "",
//           avatarUrl: otherProfile.avatarUrl || "",
//           online: userStatus.online || false,
//           lastSeen: userStatus.lastSeen || null,
//           latestMessage: formatChat(chat),
//         });
//       }
//     }

//     const chatList = Array.from(chatMap.values());

//     return res.json({
//       success: true,
//       page: Number(page),
//       limit: Number(limit),
//       total: chatList.length,
//       chats: chatList,
//     });
//   } catch (error) {
//     console.error("[GET_CHAT_LIST_ERROR]", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching chat list",
//       error: error.message,
//       chats: [],
//     });
//   }
// };

export const getChatList = async (req, res) => {
  try {
    console.log(`getChatList: Request query: ${JSON.stringify(req.query)}, user: ${JSON.stringify(req.user)}`);
    const myPhone = normalizePhoneNumber(req.user?.phone);
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
      console.log("getChatList: Proceeding without custom names due to Contact query error");
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
      return {
        profile: formatProfile(
          item.profile,
          userMap.get(normalizedPhone),
          contactMap.get(normalizedPhone)
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

// export const getChatList = async (req, res) => {
//   try {
//     const userId = req.user._id;
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;
//     const skip = (page - 1) * limit;

//     // Fetch current user profile
//     const myProfile = await User.findById(userId).lean();
//     if (!myProfile) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found",
//       });
//     }

//     // Fetch chat records
//     const chats = await Chat.find({
//       $or: [{ senderId: userId }, { receiverId: userId }],
//     })
//       .sort({ updatedAt: -1 })
//       .skip(skip)
//       .limit(limit)
//       .populate("senderId receiverId")
//       .lean();

//     // Get user contacts to map custom names
//     const contacts = await Contact.find({ ownerId: userId }).lean();
//     const contactMap = new Map();
//     contacts.forEach((c) => {
//       const phone = normalizePhoneNumber(c.contactPhone);
//       if (phone) contactMap.set(phone, c.customName);
//     });

//     // Fetch all users' online status
//     const allUsers = await User.find(
//       {},
//       { phone: 1, online: 1, lastSeen: 1 }
//     ).lean();
//     const userMap = new Map();
//     allUsers.forEach((u) => {
//       const phone = normalizePhoneNumber(u.phone);
//       if (phone) userMap.set(phone, { online: u.online, lastSeen: u.lastSeen });
//     });

//     const chatMap = new Map();

//     for (const chat of chats) {
//       if (!chat.senderId || !chat.receiverId) continue;

//       const isSender =
//         chat.senderId._id.toString() === myProfile._id.toString();
//       const otherProfile = isSender ? chat.receiverId : chat.senderId;
//       const otherPhone = normalizePhoneNumber(otherProfile.phone);

//       // 1️⃣ Pick custom name if available
//       const customName = contactMap.get(otherPhone) || null;

//       // 2️⃣ Logic for display name:
//       // If custom name → use it
//       // Else if phone visible → use phone
//       // Else → use displayName
//       let displayName;
//       if (customName) {
//         displayName = customName;
//       } else if (otherProfile.isNumberVisible) {
//         displayName = otherProfile.phone;
//       } else {
//         displayName = otherProfile.displayName || "Unknown";
//       }

//       // 3️⃣ Get user online status
//       const userStatus = userMap.get(otherPhone) || {};

//       // 4️⃣ Build chat entry if not already added
//       if (!chatMap.has(otherProfile._id.toString())) {
//         chatMap.set(otherProfile._id.toString(), {
//           id: otherProfile._id,
//           phone: otherProfile.phone,
//           displayName,
//           customName: customName || null,
//           randomNumber: otherProfile.randomNumber || "",
//           avatarUrl: otherProfile.avatarUrl || "",
//           online: userStatus.online || false,
//           lastSeen: userStatus.lastSeen || null,
//           latestMessage: formatChat(chat),
//         });
//       }
//     }

//     const chatList = Array.from(chatMap.values());

//     return res.json({
//       success: true,
//       page,
//       limit,
//       total: chatList.length,
//       chats: chatList,
//     });
//   } catch (err) {
//     console.error(`getChatList: Error: ${err.message}`);
//     return res.status(500).json({
//       success: false,
//       error: "Server error",
//       details: err.message,
//     });
//   }
// };

export const upsertContact = async (req, res) => {
  try {
    console.log(
      `upsertContact: Request body: ${JSON.stringify(req.body)}, userId: ${
        req.user._id
      }`
    );
    const { phone, customName } = req.body;
    const userId = req.user._id;

    if (!phone || typeof phone !== "string") {
      console.error("upsertContact: Valid phone number is required");
      return res
        .status(400)
        .json({ success: false, error: "Valid phone number is required" });
    }

    const contact = await Contact.findOneAndUpdate(
      { userId, phone },
      { customName: customName?.trim() || null },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    console.log(
      `upsertContact: Contact saved for phone: ${phone}, customName: ${customName}`
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
