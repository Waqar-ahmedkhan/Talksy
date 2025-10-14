import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";

export const authenticateToken = async (req, res, next) => {
  try {
    console.log("[authenticateToken] Starting token verification");
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];

    if (!token) {
      console.error("[authenticateToken] No token provided");
      return res
        .status(401)
        .json({ success: false, error: "Access token is required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(
      `[authenticateToken] Token decoded: phone=${decoded.phone}, iat=${decoded.iat}, exp=${decoded.exp}`
    );

    if (!decoded.phone) {
      console.error(
        "[authenticateToken] Phone number missing in token payload"
      );
      return res
        .status(403)
        .json({ success: false, error: "Invalid token: Phone number missing" });
    }

    const user = await User.findOne({ phone: decoded.phone }).select(
      "_id phone"
    );
    if (!user) {
      console.error(
        `[authenticateToken] No user found for phone: ${decoded.phone}`
      );
      return res.status(404).json({ success: false, error: "User not found" });
    }

    req.user = {
      _id: user._id,
      phone: decoded.phone,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    console.log(
      `[authenticateToken] User attached: userId=${user._id}, phone=${decoded.phone}`
    );
    next();
  } catch (err) {
    console.error(
      `[authenticateToken] JWT verification failed: ${err.message}`
    );
    return res
      .status(403)
      .json({ success: false, error: "Invalid or expired token" });
  }
};

export const formatProfile = (profile, user, customName = null) => {
  const phone = profile?.phone || "";
  const name = customName || profile?.displayName || "Unknown";
  const displayName = name && phone ? name : name || phone || "Unknown";

  const formatted = {
    id: profile?._id || null,
    userId: user?._id || null,
    phone,
    displayName,
    randomNumber: profile?.randomNumber || "",
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: profile?.avatarUrl || "",
    fcmToken: profile?.fcmToken || "", // Include FCM token
    createdAt: profile?.createdAt || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen || null,
    customName: customName || null,
  };

  console.log(
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${customName}, fcmToken=${
      formatted.fcmToken ? "provided" : "empty"
    }`
  );
  return formatted;
};

/**
 * Generate 11-digit random number
 */
const generateRandom11DigitNumber = () => {
  const randomNumber = Array.from({ length: 11 }, () =>
    Math.floor(Math.random() * 10)
  ).join("");
  console.log(`[generateRandom11DigitNumber] Generated: ${randomNumber}`);
  return randomNumber;
};

/**
 * Normalize phone number
 */
export const normalizePhoneNumber = (phone) => {
  if (!phone) {
    console.warn("[normalizePhoneNumber] No phone number provided");
    return phone;
  }
  let normalized = phone.trim();
  if (!normalized.startsWith("+")) {
    normalized = `+${normalized}`;
  }
  normalized = normalized.replace(/[\s-]/g, "");
  console.log(`[normalizePhoneNumber] Normalized: ${phone} -> ${normalized}`);
  return normalized;
};

/**
 * Format chat for response
 */
const formatChat = (chat) => {
  const chatId = chat?._id || "unknown";
  console.log(`[formatChat] Formatting chat: id=${chatId}`);
  const formatted = {
    id: chatId,
    senderId: chat?.senderId?._id || null,
    receiverId: chat?.receiverId?._id || null,
    type: chat?.type || "text",
    content:
      chat?.content?.substring(0, 50) +
        (chat?.content?.length > 50 ? "..." : "") || "",
    duration: chat?.duration || null,
    fileName: chat?.fileName || null,
    status: chat?.status || "sent",
    createdAt: chat?.createdAt || null,
    pinned: chat?.pinned || false,
  };
  console.log(
    `[formatChat] Formatted chat: id=${chatId}, type=${formatted.type}, content=${formatted.content}`
  );
  return formatted;
};

export const createProfile = async (req, res) => {
  try {
    console.log(
      `[createProfile] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user._id}`
    );
    if (!req.body || typeof req.body !== "object") {
      console.error("[createProfile] Missing or invalid request body");
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
      fcmToken = "",
    } = req.body;
    const phone = req.user?.phone;

    if (!phone) {
      console.error("[createProfile] Phone number not found in token");
      return res
        .status(401)
        .json({ success: false, error: "Phone number not found in token" });
    }
    if (!displayName?.trim()) {
      console.error("[createProfile] Display name is required");
      return res
        .status(400)
        .json({ success: false, error: "Display name is required" });
    }
    if (fcmToken && typeof fcmToken !== "string") {
      console.error("[createProfile] Invalid FCM token format");
      return res
        .status(400)
        .json({ success: false, error: "FCM token must be a string" });
    }
    if (
      fcmToken &&
      (fcmToken.trim().length < 50 || fcmToken.trim().length > 500)
    ) {
      console.error("[createProfile] Invalid FCM token length");
      return res
        .status(400)
        .json({ success: false, error: "Invalid FCM token length" });
    }

    let profile = await Profile.findOne({ phone });
    console.log(
      `[createProfile] Profile ${
        profile ? "found" : "not found"
      } for phone=${phone}`
    );

    if (profile) {
      profile.displayName = displayName.trim();
      profile.isVisible = isVisible;
      profile.isNumberVisible = isNumberVisible;
      profile.avatarUrl = avatarUrl.trim();
      if (fcmToken.trim()) {
        profile.fcmToken = fcmToken.trim();
      }
      console.log(
        `[createProfile] Updating profile: phone=${phone}, fcmToken=${
          fcmToken ? "provided" : "empty"
        }`
      );
    } else {
      profile = new Profile({
        phone,
        displayName: displayName.trim(),
        randomNumber: generateRandom11DigitNumber(),
        isVisible,
        isNumberVisible,
        avatarUrl: avatarUrl.trim(),
        fcmToken: fcmToken.trim(),
      });
      console.log(
        `[createProfile] Creating new profile: phone=${phone}, fcmToken=${
          fcmToken ? "provided" : "empty"
        }`
      );
    }

    await profile.save();
    console.log(
      `[createProfile] Profile saved: phone=${phone}, profileId=${profile._id}`
    );

    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({
        phone,
        displayName: displayName.trim(),
        online: false,
        lastSeen: new Date(),
        fcmToken: fcmToken.trim(),
      });
      await user.save();
      console.log(
        `[createProfile] New user created: phone=${phone}, userId=${user._id}`
      );
    } else {
      if (fcmToken.trim()) {
        user.fcmToken = fcmToken.trim();
        await user.save();
      }
      console.log(
        `[createProfile] User found: phone=${phone}, userId=${user._id}`
      );
    }

    const contact = await Contact.findOne({
      userId: req.user._id,
      phone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(
      `[createProfile] Custom name for phone=${phone}: ${customName}`
    );

    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formatProfile(profile, user, customName),
    });
  } catch (err) {
    console.error(`[createProfile] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

export const getMyProfile = async (req, res) => {
  try {
    console.log(
      `[getMyProfile] Fetching profile: phone=${req.user.phone}, userId=${req.user._id}`
    );
    const profile = await Profile.findOne({ phone: req.user.phone });
    if (!profile) {
      console.error(
        `[getMyProfile] Profile not found: phone=${req.user.phone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    const user = await User.findOne({ phone: req.user.phone });
    console.log(
      `[getMyProfile] User ${user ? "found" : "not found"}: phone=${
        req.user.phone
      }`
    );

    const contact = await Contact.findOne({
      userId: req.user._id,
      phone: req.user.phone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(
      `[getMyProfile] Custom name: phone=${req.user.phone}, customName=${customName}`
    );

    return res.json({
      success: true,
      profile: formatProfile(profile, user, customName),
    });
  } catch (err) {
    console.error(`[getMyProfile] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

export const getPublicProfiles = async (req, res) => {
  try {
    console.log(
      `[getPublicProfiles] Processing request: query=${JSON.stringify(
        req.query
      )}, userId=${req.user._id}`
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
      `[getPublicProfiles] Found ${publicProfiles.length} public profiles`
    );

    const phoneNumbers = publicProfiles.map((p) => p.phone);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select(
      "phone online lastSeen"
    );
    console.log(`[getPublicProfiles] Found ${users.length} users`);
    const userMap = new Map(users.map((u) => [u.phone, u]));

    const contacts = await Contact.find({
      userId: req.user._id,
      phone: { $in: phoneNumbers },
    }).select("phone customName");
    console.log(`[getPublicProfiles] Found ${contacts.length} contacts`);
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
      `[getPublicProfiles] Response ready: profiles=${response.profiles.length}`
    );
    return res.json(response);
  } catch (err) {
    console.error(`[getPublicProfiles] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get Profiles from Contacts
 */
export const getProfilesFromContacts = async (req, res) => {
  try {
    console.log(
      `[getProfilesFromContacts] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user._id}`
    );
    const { contacts } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      console.error(
        "[getProfilesFromContacts] Invalid or empty contacts array"
      );
      return res
        .status(400)
        .json({ success: false, error: "Contacts array is required" });
    }
    console.log(
      `[getProfilesFromContacts] Validated contacts: count=${contacts.length}`
    );

    let phoneNumbers = [];
    let contactMap = new Map();

    if (typeof contacts[0] === "string") {
      console.log("[getProfilesFromContacts] Processing contacts as strings");
      phoneNumbers = contacts;
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(
        `[getProfilesFromContacts] Found ${userContacts.length} contacts`
      );
      userContacts.forEach((contact) => {
        const normalizedPhone = normalizePhoneNumber(contact.phone);
        console.log(
          `[getProfilesFromContacts] Mapping contact: phone=${normalizedPhone}, customName=${
            contact.customName || null
          }`
        );
        contactMap.set(normalizedPhone, contact.customName || null);
      });
    } else {
      console.log("[getProfilesFromContacts] Processing contacts as objects");
      for (const contact of contacts) {
        if (!contact.phone || typeof contact.phone !== "string") {
          console.error(
            `[getProfilesFromContacts] Invalid contact: ${JSON.stringify(
              contact
            )}`
          );
          return res.status(400).json({
            success: false,
            error: "Each contact must have a valid phone number",
          });
        }
        phoneNumbers.push(contact.phone);
        contactMap.set(
          normalizePhoneNumber(contact.phone),
          contact.customName || null
        );
      }
      const userContacts = await Contact.find({
        userId,
        phone: { $in: phoneNumbers },
      }).select("phone customName");
      console.log(
        `[getProfilesFromContacts] Found ${userContacts.length} contacts for merging`
      );
      userContacts.forEach((contact) => {
        const normalizedPhone = normalizePhoneNumber(contact.phone);
        if (!contactMap.has(normalizedPhone)) {
          console.log(
            `[getProfilesFromContacts] Merging contact: phone=${normalizedPhone}, customName=${
              contact.customName || null
            }`
          );
          contactMap.set(normalizedPhone, contact.customName || null);
        }
      });
    }

    const matchedProfiles = await Profile.find({
      phone: { $in: phoneNumbers },
    }).select(
      "displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone"
    );
    console.log(
      `[getProfilesFromContacts] Found ${matchedProfiles.length} profiles`
    );

    const users = await User.find({ phone: { $in: phoneNumbers } }).select(
      "phone online lastSeen"
    );
    console.log(`[getProfilesFromContacts] Found ${users.length} users`);
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
      `[getProfilesFromContacts] Response ready: profiles=${response.profiles.length}`
    );
    return res.json(response);
  } catch (err) {
    console.error(`[getProfilesFromContacts] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get Profile + Chat History with Target User
 */
export const getProfileWithChat = async (req, res) => {
  const timestamp = new Date().toISOString();
  try {
    console.log(
      `[getProfileWithChat] Processing request: params=${JSON.stringify(
        req.params
      )}, userId=${req.user._id} at ${timestamp}`
    );

    const myPhone = req.user.phone;
    const targetPhone = req.params.phone;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    if (!targetPhone) {
      console.error(
        `[getProfileWithChat] Target phone number is required at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }

    if (page < 1 || limit < 1 || limit > 100) {
      console.error(
        `[getProfileWithChat] Invalid pagination: page=${page}, limit=${limit} at ${timestamp}`
      );
      return res.status(400).json({
        success: false,
        error:
          "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }

    // Fetch profiles in a single query
    const [myProfile, targetProfile] = await Promise.all([
      Profile.findOne({ phone: myPhone }).lean(),
      Profile.findOne({ phone: targetPhone }).lean(),
    ]);

    if (!myProfile) {
      console.error(
        `[getProfileWithChat] Profile not found: phone=${myPhone} at ${timestamp}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    if (!targetProfile) {
      console.error(
        `[getProfileWithChat] Profile not found: phone=${targetPhone} at ${timestamp}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Target profile not found" });
    }

    // Check if blocked
    const blocked = await Block.findOne({
      $or: [
        { blockerId: myProfile._id, blockedId: targetProfile._id },
        { blockerId: targetProfile._id, blockedId: myProfile._id },
      ],
    }).lean();
    if (blocked) {
      console.warn(
        `[getProfileWithChat] Blocked relationship: blockerId=${blocked.blockerId}, blockedId=${blocked.blockedId} at ${timestamp}`
      );
      return res.status(403).json({
        success: false,
        error: "Cannot fetch chat history: User is blocked",
      });
    }

    // Fetch target user and contact in parallel
    const [targetUser, contact] = await Promise.all([
      User.findOne({ phone: targetPhone }).lean(),
      Contact.findOne({ userId: req.user._id, phone: targetPhone })
        .select("customName")
        .lean(),
    ]);

    console.log(
      `[getProfileWithChat] Target user ${
        targetUser ? "found" : "not found"
      }: phone=${targetPhone}, customName=${
        contact?.customName || null
      } at ${timestamp}`
    );

    // Fetch chats with pagination and filtering out deleted messages
    const chats = await Chat.find({
      $and: [
        {
          $or: [
            { senderId: myProfile._id, receiverId: targetProfile._id },
            { senderId: targetProfile._id, receiverId: myProfile._id },
          ],
        },
        { deletedFor: { $ne: myProfile._id } }, // Exclude messages deleted for the user
      ],
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    console.log(
      `[getProfileWithChat] Found ${chats.length} chats at ${timestamp}`
    );

    // Update status to "read" for unread messages from the target user
    const unreadChatIds = chats
      .filter(
        (chat) =>
          chat.senderId.toString() === targetProfile._id.toString() &&
          ["sent", "delivered"].includes(chat.status)
      )
      .map((chat) => chat._id);

    if (unreadChatIds.length > 0) {
      await Chat.updateMany(
        { _id: { $in: unreadChatIds } },
        { status: "read" }
      );
      console.log(
        `[getProfileWithChat] Marked ${unreadChatIds.length} messages as read at ${timestamp}`
      );
    }

    const response = {
      success: true,
      page,
      limit,
      total: chats.length,
      profile: formatProfile(targetProfile, targetUser, contact?.customName),
      chatHistory: chats.map(formatChat),
    };

    console.log(
      `[getProfileWithChat] Response ready: chats=${response.chatHistory.length} at ${timestamp}`
    );
    return res.json(response);
  } catch (err) {
    console.error(
      `[getProfileWithChat] Error: ${err.message} at ${timestamp}`,
      { errorDetails: err.errors }
    );
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Upsert Contact (Set Custom Name)
 */
export const upsertContacts = async (req, res) => {
  try {
    console.log(
      `[upsertContacts] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user._id}`
    );
    const contacts = req.body.contacts; // Expecting an array of { phone, customName }
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      console.error(
        "[upsertContacts] Invalid input: contacts must be a non-empty array"
      );
      return res
        .status(400)
        .json({ success: false, error: "Contacts must be a non-empty array" });
    }

    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    const invalidContacts = [];
    const validContacts = [];

    // Validate all contacts
    for (const contact of contacts) {
      const { phone, customName } = contact;

      if (!phone || typeof phone !== "string" || !phone.trim()) {
        invalidContacts.push({
          phone,
          error: "Valid phone number is required",
        });
        continue;
      }

      if (!customName || typeof customName !== "string" || !customName.trim()) {
        invalidContacts.push({ phone, error: "Valid custom name is required" });
        continue;
      }

      const normalizedPhone = normalizePhoneNumber(phone);
      if (!phoneRegex.test(normalizedPhone)) {
        invalidContacts.push({ phone, error: "Invalid phone number format" });
        continue;
      }

      validContacts.push({
        phone: normalizedPhone,
        customName: customName.trim(),
      });
    }

    if (invalidContacts.length > 0) {
      console.error(
        `[upsertContacts] Invalid contacts: ${JSON.stringify(invalidContacts)}`
      );
      return res.status(400).json({
        success: false,
        error: "Some contacts have invalid data",
        invalidContacts,
      });
    }

    // Process valid contacts in bulk
    const updatePromises = validContacts.map(({ phone, customName }) =>
      Contact.findOneAndUpdate(
        { userId, phone },
        { customName },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      )
    );

    const updatedContacts = await Promise.all(updatePromises);

    console.log(
      `[upsertContacts] Contacts saved: count=${updatedContacts.length}`
    );

    return res.json({
      success: true,
      message: "Contacts saved successfully",
      contacts: updatedContacts.map((contact) => ({
        phone: contact.phone,
        customName: contact.customName,
      })),
    });
  } catch (err) {
    console.error(`[upsertContacts] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Get Chat List
 */
export const getChatList = async (req, res) => {
  try {
    console.log(
      `[getChatList] Processing request: query=${JSON.stringify(
        req.query
      )}, userId=${req.user._id}, phone=${req.user.phone}`
    );
    const myPhone = normalizePhoneNumber(req.user?.phone);
    const userId = req.user?._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!userId || !myPhone) {
      console.error("[getChatList] Missing userId or phone");
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing user ID or phone",
      });
    }

    if (page < 1 || limit < 1 || limit > 100) {
      console.error(
        `[getChatList] Invalid pagination: page=${page}, limit=${limit}`
      );
      return res.status(400).json({
        success: false,
        error:
          "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }
    const skip = (page - 1) * limit;

    console.log(`[getChatList] Fetching profile: phone=${myPhone}`);
    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(`[getChatList] Profile not found: phone=${myPhone}`);
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }
    console.log(`[getChatList] Profile found: profileId=${myProfile._id}`);

    console.log(`[getChatList] Fetching chats: profileId=${myProfile._id}`);
    const chats = await Chat.find({
      $and: [
        { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
        { receiverId: { $ne: null } },
        { deletedFor: { $ne: myProfile._id } },
      ],
    })
      .sort({ pinned: -1, createdAt: -1 })
      .populate(
        "senderId receiverId",
        "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken"
      );
    console.log(`[getChatList] Found ${chats.length} chats`);

    if (!chats || chats.length === 0) {
      console.log("[getChatList] No chats found");
      return res.json({ success: true, page, limit, total: 0, chats: [] });
    }

    const phoneNumbers = [
      ...new Set([
        ...chats
          .map((chat) => normalizePhoneNumber(chat.senderId?.phone))
          .filter(Boolean),
        ...chats
          .map((chat) => normalizePhoneNumber(chat.receiverId?.phone))
          .filter(Boolean),
      ]),
    ];
    console.log(
      `[getChatList] Extracted ${phoneNumbers.length} unique phone numbers`
    );

    console.log(`[getChatList] Fetching users: phones=${phoneNumbers.length}`);
    const users = await User.find({ phone: { $in: phoneNumbers } }).select(
      "phone online lastSeen fcmToken"
    );
    console.log(`[getChatList] Found ${users.length} users`);
    users.forEach((user) => {
      console.log(
        `[getChatList] User: phone=${user.phone}, fcmToken=${
          user.fcmToken || "null"
        }`
      );
    });
    const userMap = new Map(
      users.map((u) => [normalizePhoneNumber(u.phone), u])
    );

    console.log(
      `[getChatList] Fetching contacts: userId=${userId}, phones=${phoneNumbers.length}`
    );
    const contacts = await Contact.find({
      userId,
      phone: { $in: phoneNumbers },
    }).select("phone customName");
    console.log(`[getChatList] Found ${contacts.length} contacts`);
    const contactMap = new Map();
    contacts.forEach((contact) => {
      const normalizedPhone = normalizePhoneNumber(contact.phone);
      console.log(
        `[getChatList] Mapping contact: phone=${normalizedPhone}, customName=${
          contact.customName || null
        }`
      );
      contactMap.set(normalizedPhone, contact.customName || null);
    });

    const chatMap = new Map();
    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) {
        console.warn(
          `[getChatList] Skipping chat ${chat._id}: missing senderId or receiverId`
        );
        continue;
      }

      const otherProfileId =
        chat.senderId._id.toString() === myProfile._id.toString()
          ? chat.receiverId._id.toString()
          : chat.senderId._id.toString();

      if (!chatMap.has(otherProfileId)) {
        const otherProfile =
          chat.senderId._id.toString() === myProfile._id.toString()
            ? chat.receiverId
            : chat.senderId;
        const otherPhone = normalizePhoneNumber(otherProfile.phone);
        console.log(
          `[getChatList] Other profile fcmToken: ${
            otherProfile.fcmToken || "null"
          }`
        );
        const customName = contactMap.get(otherPhone) || null;
        let displayName;
        if (customName) {
          displayName = customName;
        } else if (otherProfile.isNumberVisible) {
          displayName = otherProfile.phone;
        } else {
          displayName = otherProfile.displayName || "Unknown";
        }
        console.log(
          `[getChatList] Profile: phone=${otherPhone}, displayName=${displayName}, customName=${customName}`
        );
        chatMap.set(otherProfileId, {
          profile: {
            id: otherProfile._id,
            phone: otherProfile.phone,
            displayName,
            customName,
            randomNumber: otherProfile.randomNumber || "",
            avatarUrl: otherProfile.avatarUrl || "",
            online: userMap.get(otherPhone)?.online || false,
            lastSeen: userMap.get(otherPhone)?.lastSeen || null,
            fcmToken:
              otherProfile.fcmToken ||
              userMap.get(otherPhone)?.fcmToken ||
              null,
          },
          latestMessage: chat,
          unreadCount:
            chat.receiverId._id.toString() === myProfile._id.toString() &&
            ["sent", "delivered"].includes(chat.status)
              ? 1
              : 0,
          pinned: chat.pinned || false,
        });
      } else {
        const existing = chatMap.get(otherProfileId);
        if (
          new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)
        ) {
          console.log(
            `[getChatList] Updating latest message: profileId=${otherProfileId}, chatId=${chat._id}`
          );
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
        return (
          new Date(b.latestMessage.createdAt) -
          new Date(a.latestMessage.createdAt)
        );
      })
      .slice(skip, skip + limit);
    console.log(
      `[getChatList] Prepared ${chatList.length} chats: page=${page}, limit=${limit}`
    );

    const formattedChatList = chatList.map((item) => ({
      profile: item.profile,
      latestMessage: formatChat(item.latestMessage),
      unreadCount: item.unreadCount,
      pinned: item.pinned,
    }));

    const response = {
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formattedChatList,
    };
    console.log(
      `[getChatList] Response ready: total=${response.total}, chats=${formattedChatList.length}`
    );
    return res.json(response);
  } catch (err) {
    console.error(`[getChatList] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

/**
 * Delete User Chat
 */
export const deleteUserChat = async (req, res) => {
  try {
    console.log(
      `[deleteUserChat] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user._id}`
    );
    const { targetPhone } = req.body;
    const userId = req.user._id;
    const myPhone = normalizePhoneNumber(req.user.phone);
    const normalizedTargetPhone = normalizePhoneNumber(targetPhone);

    if (!targetPhone) {
      console.error("[deleteUserChat] Target phone number is required");
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }

    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(normalizedTargetPhone)) {
      console.error(
        `[deleteUserChat] Invalid phone number format: ${normalizedTargetPhone}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid phone number format" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(`[deleteUserChat] Profile not found: phone=${myPhone}`);
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    const targetProfile = await Profile.findOne({
      phone: normalizedTargetPhone,
    });
    if (!targetProfile) {
      console.error(
        `[deleteUserChat] Profile not found: phone=${normalizedTargetPhone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Target profile not found" });
    }

    const updateResult = await Chat.updateMany(
      {
        $or: [
          { senderId: myProfile._id, receiverId: targetProfile._id },
          { senderId: targetProfile._id, receiverId: myProfile._id },
        ],
        deletedFor: { $ne: myProfile._id },
      },
      { $addToSet: { deletedFor: myProfile._id } }
    );
    console.log(
      `[deleteUserChat] Soft-deleted ${updateResult.modifiedCount} chats: userId=${userId}, targetPhone=${normalizedTargetPhone}`
    );

    if (updateResult.modifiedCount === 0) {
      console.log(
        `[deleteUserChat] No chats found to delete: userId=${userId}, targetPhone=${normalizedTargetPhone}`
      );
      return res.json({
        success: true,
        message: "No chats found to delete",
        modifiedCount: 0,
      });
    }

    return res.json({
      success: true,
      message: "Chats with target user soft-deleted successfully",
      modifiedCount: updateResult.modifiedCount,
    });
  } catch (err) {
    console.error(`[deleteUserChat] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};
