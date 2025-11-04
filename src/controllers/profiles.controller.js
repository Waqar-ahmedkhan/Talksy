import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Contact from "../models/Contact.js";
import Block from "../models/Block.js";
import moment from "moment-timezone";
import validator from "validator";

const logTimestamp = () =>
  moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

export const authenticateToken = async (req, res, next) => {
  const timestamp = logTimestamp();
  try {
    console.log(
      `[authenticateToken] Starting token verification at ${timestamp}`
    );
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];

    if (!token) {
      console.error(`❌ [authenticateToken] No token provided at ${timestamp}`);
      return res
        .status(401)
        .json({ success: false, error: "Access token is required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(
      `[authenticateToken] Token decoded: phone=${decoded.phone}, iat=${decoded.iat}, exp=${decoded.exp} at ${timestamp}`
    );

    if (!decoded.phone) {
      console.error(
        `❌ [authenticateToken] Phone number missing in token payload at ${timestamp}`
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
        `❌ [authenticateToken] No user found for phone: ${decoded.phone} at ${timestamp}`
      );
      return res.status(404).json({ success: false, error: "User not found" });
    }

    req.user = {
      _id: user._id.toString(),
      phone: decoded.phone,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    console.log(
      `[authenticateToken] User attached: userId=${req.user._id}, phone=${req.user.phone} at ${timestamp}`
    );
    next();
  } catch (err) {
    console.error(
      `❌ [authenticateToken] JWT verification failed: ${err.message} at ${timestamp}`
    );
    return res
      .status(403)
      .json({ success: false, error: "Invalid or expired token" });
  }
};

export const checkBlockStatus = async (req, res, next) => {
  const timestamp = logTimestamp();
  try {
    const { targetPhone } = req.body || req.params;
    const myPhone = normalizePhoneNumber(req.user.phone);

    if (!targetPhone) {
      console.log(
        `[checkBlockStatus] No targetPhone provided, skipping check at ${timestamp}`
      );
      return next();
    }

    const normalizedTargetPhone = normalizePhoneNumber(targetPhone);
    if (!normalizedTargetPhone) {
      console.error(
        `❌ [checkBlockStatus] Invalid target phone number: ${targetPhone} at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid target phone number" });
    }

    const [myProfile, targetProfile] = await Promise.all([
      Profile.findOne({ phone: myPhone }),
      Profile.findOne({ phone: normalizedTargetPhone }),
    ]);

    if (!myProfile || !targetProfile) {
      console.error(
        `❌ [checkBlockStatus] Profile not found: myPhone=${myPhone}, targetPhone=${normalizedTargetPhone} at ${timestamp}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    const block = await Block.findOne({
      $or: [
        { blockerId: myProfile._id, blockedId: targetProfile._id },
        { blockerId: targetProfile._id, blockedId: myProfile._id },
      ],
    });

    if (block) {
      console.log(
        `[checkBlockStatus] User is blocked: blockerId=${block.blockerId}, blockedId=${block.blockedId} at ${timestamp}`
      );
      return res.status(403).json({ success: false, error: "User is blocked" });
    }

    console.log(
      `[checkBlockStatus] No block found for myPhone=${myPhone}, targetPhone=${normalizedTargetPhone} at ${timestamp}`
    );
    next();
  } catch (err) {
    console.error(
      `❌ [checkBlockStatus] Error: ${err.message} at ${timestamp}`
    );
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

export const normalizePhoneNumber = (phone) => {
  const timestamp = logTimestamp();
  if (!phone || typeof phone !== "string") {
    console.warn(
      `[normalizePhoneNumber] Invalid input: ${phone} at ${timestamp}`
    );
    return null;
  }

  // 1. Remove EVERYTHING except digits and a leading +
  let cleaned = phone.replace(/[^\d+]/g, "");

  // 2. Pakistani 10-digit numbers → +92
  if (/^\d{10}$/.test(cleaned)) {
    cleaned = `+92${cleaned}`;
  }

  // 3. Numbers that start with 0 (03xxxxxxxxx) → +923xxxxxxxxx
  if (/^0\d{9}$/.test(cleaned)) {
    cleaned = `+92${cleaned.slice(1)}`;
  }

  // 4. Force leading +
  if (!cleaned.startsWith("+")) cleaned = `+${cleaned}`;

  // 5. Remove any extra + after the first one
  cleaned = cleaned.replace(/\+/g, (m, i) => (i === 0 ? m : ""));

  console.log(`[normalizePhoneNumber] ${phone} → ${cleaned} at ${timestamp}`);
  return cleaned;
};
const generateRandom11DigitNumber = () => {
  const randomNumber = Array.from({ length: 11 }, () =>
    Math.floor(Math.random() * 10)
  ).join("");
  console.log(
    `[generateRandom11DigitNumber] Generated: ${randomNumber} at ${logTimestamp()}`
  );
  return randomNumber;
};

export const formatProfile = (
  profile,
  user,
  customName = null,
  isBlocked = false
) => {
  const timestamp = logTimestamp();
  const phone = profile?.phone || "";
  const displayName = profile?.isNumberVisible
    ? phone
    : profile?.displayName || "Unknown";

  const formatted = {
    id: profile?._id?.toString() || null,
    userId: user?._id?.toString() || null,
    phone,
    displayName,
    customName: customName || null, // Exact customName from contacts
    randomNumber: profile?.randomNumber || "",
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: profile?.avatarUrl || "",
    fcmToken: profile?.fcmToken || user?.fcmToken || "",
    createdAt: profile?.createdAt?.toISOString() || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen?.toISOString() || null,
    isBlocked,
  };

  console.log(
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${customName}, isBlocked=${isBlocked} at ${timestamp}`
  );
  return formatted;
};

const formatChat = (chat) => {
  const timestamp = moment()
    .tz("Asia/Karachi")
    .format("DD/MM/YYYY, hh:mm:ss a");
  try {
    const isAudio =
      chat.content.includes(".m4a") ||
      (chat.fileType && chat.fileType.startsWith("audio/"));
    const chatType = isAudio ? "voice" : chat.type;

    console.log(
      `[formatChat] Formatting chat: id=${chat._id}, originalType=${chat.type}, newType=${chatType}, content=${chat.content} at ${timestamp}`
    );

    return {
      id: chat._id.toString(),
      senderId: chat.senderId?._id?.toString() || null,
      receiverId: chat.receiverId?._id?.toString() || null,
      groupId: chat.groupId?.toString() || null,
      channelId: chat.channelId?.toString() || null,
      type: chatType,
      content: chat.content,
      displayContent:
        chat.type === "text" && chat.content.length > 50
          ? `${chat.content.slice(0, 50)}...`
          : chat.content,
      fileType: chat.fileType || (isAudio ? "audio/mp4" : null),
      fileName: chat.fileName || "",
      duration: chat.duration || null,
      status: chat.status || "sent",
      createdAt: chat.createdAt?.toISOString() || null,
      pinned: chat.pinned || false,
    };
  } catch (err) {
    console.error(`❌ [formatChat] Error: ${err.message} at ${timestamp}`);
    return null;
  }
};

export const createProfile = async (req, res) => {
  const timestamp = logTimestamp();
  try {
    console.log(
      `[createProfile] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user?._id} at ${timestamp}`
    );

    // Validate request body
    if (!req.body || typeof req.body !== "object") {
      console.error(
        `❌ [createProfile] Missing or invalid request body at ${timestamp}`
      );
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
    const phone = normalizePhoneNumber(req.user?.phone);

    // Validate inputs
    if (!phone) {
      console.error(
        `❌ [createProfile] Phone number not found in token at ${timestamp}`
      );
      return res
        .status(401)
        .json({ success: false, error: "Phone number not found in token" });
    }
    if (
      !displayName ||
      typeof displayName !== "string" ||
      !displayName.trim()
    ) {
      console.error(
        `❌ [createProfile] Display name is required and must be a non-empty string at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Display name is required" });
    }
    if (
      typeof isVisible !== "boolean" ||
      typeof isNumberVisible !== "boolean"
    ) {
      console.error(
        `❌ [createProfile] Invalid visibility flags at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Visibility flags must be booleans" });
    }
    if (fcmToken && typeof fcmToken !== "string") {
      console.error(
        `❌ [createProfile] Invalid FCM token format at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "FCM token must be a string" });
    }
    if (
      fcmToken &&
      (fcmToken.trim().length < 50 || fcmToken.trim().length > 500)
    ) {
      console.error(
        `❌ [createProfile] Invalid FCM token length at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid FCM token length" });
    }
    if (avatarUrl && typeof avatarUrl !== "string") {
      console.error(
        `❌ [createProfile] Invalid avatar URL format at ${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Avatar URL must be a string" });
    }

    // Sanitize inputs
    const sanitizedDisplayName = validator.escape(displayName.trim());
    const sanitizedAvatarUrl = validator.isURL(avatarUrl.trim())
      ? avatarUrl.trim()
      : "";

    const sanitizedFcmToken = fcmToken ? validator.escape(fcmToken.trim()) : "";

    // Check for existing profile
    let profile = await Profile.findOne({ phone });
    const isNewProfile = !profile;
    console.log(
      `[createProfile] Profile ${
        isNewProfile ? "not found" : "found"
      } for phone=${phone} at ${timestamp}`
    );

    if (isNewProfile) {
      profile = new Profile({
        phone,
        displayName: sanitizedDisplayName,
        randomNumber: generateRandom11DigitNumber(),
        isVisible,
        isNumberVisible,
        avatarUrl: sanitizedAvatarUrl,
        fcmToken: sanitizedFcmToken,
      });
      console.log(
        `[createProfile] Creating new profile: phone=${phone}, fcmToken=${
          sanitizedFcmToken ? "provided" : "empty"
        } at ${timestamp}`
      );
    } else {
      profile.displayName = sanitizedDisplayName;
      profile.isVisible = isVisible;
      profile.isNumberVisible = isNumberVisible;
      profile.avatarUrl = sanitizedAvatarUrl;
      if (sanitizedFcmToken) profile.fcmToken = sanitizedFcmToken;
      console.log(
        `[createProfile] Updating profile: phone=${phone}, fcmToken=${
          sanitizedFcmToken ? "provided" : "empty"
        } at ${timestamp}`
      );
    }

    // Save profile and update/create user concurrently
    const [savedProfile, user] = await Promise.all([
      profile.save(),
      User.findOneAndUpdate(
        { phone },
        {
          displayName: sanitizedDisplayName,
          fcmToken: sanitizedFcmToken || undefined,
          online: false,
          lastSeen: new Date(),
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ),
    ]);

    console.log(
      `[createProfile] Profile saved: phone=${phone}, profileId=${savedProfile._id} at ${timestamp}`
    );
    console.log(
      `[createProfile] User ${
        user.isNew ? "created" : "updated"
      }: phone=${phone}, userId=${user._id} at ${timestamp}`
    );

    // Fetch contact for custom name
    const contact = await Contact.findOne({
      userId: req.user._id,
      phone,
    }).select("customName");
    const customName = contact?.customName
      ? validator.escape(contact.customName)
      : null;
    console.log(
      `[createProfile] Custom name for phone=${phone}: ${customName} at ${timestamp}`
    );

    return res.status(isNewProfile ? 201 : 200).json({
      success: true,
      message: `Profile ${isNewProfile ? "created" : "updated"} successfully`,
      profile: formatProfile(savedProfile, user, customName),
    });
  } catch (err) {
    console.error(`❌ [createProfile] Error: ${err.message} at ${timestamp}`);
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

    const myProfile = await Profile.findOne({
      phone: normalizePhoneNumber(req.user.phone),
    });
    if (!myProfile) {
      console.error(
        `[getPublicProfiles] Profile not found: phone=${req.user.phone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    // Get blocked user IDs
    const blocked = await Block.find({ blockerId: myProfile._id }).select(
      "blockedId"
    );
    const blockedIds = blocked.map((b) => b.blockedId);

    const publicProfiles = await Profile.find({
      isVisible: true,
      _id: { $nin: blockedIds }, // Exclude blocked users
    })
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

    // Fetch blocked phones for the current user to set isBlocked flag
    const blockedSet = new Set(blocked.map((b) => b.blockedId.toString()));

    const response = {
      success: true,
      page,
      limit,
      profiles: publicProfiles.map((profile) =>
        formatProfile(
          profile,
          userMap.get(profile.phone),
          contactMap.get(profile.phone),
          blockedSet.has(profile._id.toString()) // Set isBlocked
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
// ─────────────────────────────────────────────────────────────────────────────
// 1. getProfilesFromContacts – AUTO-CREATE missing contacts
// ─────────────────────────────────────────────────────────────────────────────
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
      return res
        .status(400)
        .json({ success: false, error: "Contacts array is required" });
    }

    // ----------------------------------------------------------------------
    // Normalise incoming phones and build a map of {phone → clientCustomName}
    // ----------------------------------------------------------------------
    const incomingMap = new Map(); // phone → customName from client
    const phoneNumbers = []; // phones to query DB for
    for (const c of contacts) {
      const phone = typeof c === "string" ? c : c.phone;
      const custom = typeof c === "object" ? c.customName : null;

      if (!phone || typeof phone !== "string") {
        return res
          .status(400)
          .json({ success: false, error: "Each contact must have a phone" });
      }
      const norm = normalizePhoneNumber(phone);
      if (!norm) continue; // skip malformed numbers
      phoneNumbers.push(norm);
      if (custom) incomingMap.set(norm, custom.trim());
    }

    // ----------------------------------------------------------------------
    // 1. Find already-saved contacts
    // 2. Find matching Profiles
    // ----------------------------------------------------------------------
    const [savedContacts, matchedProfiles] = await Promise.all([
      Contact.find({ userId, phone: { $in: phoneNumbers } }).select(
        "phone customName"
      ),
      Profile.find({ phone: { $in: phoneNumbers } }).select(
        "displayName phone isNumberVisible"
      ),
    ]);

    // ----------------------------------------------------------------------
    // Build final contactMap:
    //   • saved contact   → use saved customName
    //   • client sent     → use client customName
    //   • none of the above → create a contact with displayName
    // ----------------------------------------------------------------------
    const contactMap = new Map(); // phone → final customName
    const toCreate = [];

    for (const profile of matchedProfiles) {
      const norm = profile.phone; // already normalised
      const saved = savedContacts.find(
        (c) => normalizePhoneNumber(c.phone) === norm
      );
      const clientName = incomingMap.get(norm);

      let finalName = saved?.customName ?? clientName;
      if (!finalName) {
        // No saved contact & client didn’t give a name → create one
        finalName = profile.isNumberVisible
          ? norm
          : profile.displayName || "Unknown";
        toCreate.push({ userId, phone: norm, customName: finalName });
      }
      contactMap.set(norm, finalName);
    }

    // ----------------------------------------------------------------------
    // Bulk-insert missing contacts (fire-and-forget, no await needed)
    // ----------------------------------------------------------------------
    if (toCreate.length) {
      Contact.insertMany(toCreate).catch((e) =>
        console.error("[getProfilesFromContacts] insertMany error:", e)
      );
    }

    // ----------------------------------------------------------------------
    // Users for online/lastSeen
    // ----------------------------------------------------------------------
    const users = await User.find({ phone: { $in: phoneNumbers } }).select(
      "phone online lastSeen"
    );
    const userMap = new Map(users.map((u) => [u.phone, u]));

    // ----------------------------------------------------------------------
    // Build response
    // ----------------------------------------------------------------------
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. getProfileWithChat – AUTO-CREATE missing contact for the target
// ─────────────────────────────────────────────────────────────────────────────
export const getProfileWithChat = async (req, res) => {
  try {
    const myPhone = normalizePhoneNumber(req.user.phone);
    const targetPhone = req.params.phone;
    if (!targetPhone) {
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }
    const normalizedTarget = normalizePhoneNumber(targetPhone);

    const [myProfile, targetProfile] = await Promise.all([
      Profile.findOne({ phone: myPhone }),
      Profile.findOne({ phone: normalizedTarget }),
    ]);
    if (!myProfile || !targetProfile) {
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    // ---- block check (unchanged) ----
    const block = await Block.findOne({
      blockerId: myProfile._id,
      blockedId: targetProfile._id,
    });
    if (block) {
      return res.status(403).json({ success: false, error: "User is blocked" });
    }

    // ---- ensure contact exists (auto-create) ----
    const existing = await Contact.findOne({
      userId: req.user._id,
      phone: normalizedTarget,
    });
    let customName = existing?.customName;
    if (!existing) {
      const fallback = targetProfile.isNumberVisible
        ? normalizedTarget
        : targetProfile.displayName || "Unknown";
      await Contact.create({
        userId: req.user._id,
        phone: normalizedTarget,
        customName: fallback,
      });
      customName = fallback;
    }

    const targetUser = await User.findOne({ phone: normalizedTarget });
    const chats = await Chat.find({
      $or: [
        { senderId: myProfile._id, receiverId: targetProfile._id },
        { senderId: targetProfile._id, receiverId: myProfile._id },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50);

    const response = {
      success: true,
      profile: formatProfile(targetProfile, targetUser, customName, false),
      chatHistory: chats.map(formatChat),
    };
    return res.json(response);
  } catch (err) {
    console.error(`[getProfileWithChat] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. upsertContacts – unchanged (already works)
// ─────────────────────────────────────────────────────────────────────────────
export const upsertContacts = async (req, res) => {
  try {
    const contacts = req.body.contacts;
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Contacts must be a non-empty array" });
    }

    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    const invalidContacts = [];
    const validContacts = [];

    for (const c of contacts) {
      const { phone, customName } = c;
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
      const norm = normalizePhoneNumber(phone);
      if (!phoneRegex.test(norm)) {
        invalidContacts.push({ phone, error: "Invalid phone number format" });
        continue;
      }
      validContacts.push({ phone: norm, customName: customName.trim() });
    }

    if (invalidContacts.length) {
      return res.status(400).json({
        success: false,
        error: "Some contacts have invalid data",
        invalidContacts,
      });
    }

    const updatePromises = validContacts.map(({ phone, customName }) =>
      Contact.findOneAndUpdate(
        { userId, phone },
        { customName },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      )
    );
    const updated = await Promise.all(updatePromises);

    return res.json({
      success: true,
      message: "Contacts saved successfully",
      contacts: updated.map((c) => ({
        phone: c.phone,
        customName: c.customName,
      })),
    });
  } catch (err) {
    console.error(`[upsertContacts] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

export const getChatList = async (req, res) => {
  const timestamp = logTimestamp();
  try {
    console.log(
      `[getChatList] Processing request: query=${JSON.stringify(
        req.query
      )}, userId=${req.user?._id}, phone=${req.user?.phone} at ${timestamp}`
    );

    const myPhone = normalizePhoneNumber(req.user.phone);
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!userId || !myPhone) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing user ID or phone",
      });
    }
    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters: page >=1, limit 1-100",
      });
    }

    const skip = (page - 1) * limit;
    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    // --- Blocked users ---
    const blocked = await Block.find({ blockerId: myProfile._id }).select(
      "blockedId"
    );
    const blockedIds = blocked.map((b) => b.blockedId.toString());

    // --- All chats involving me ---
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

    if (!chats.length) {
      return res.json({ success: true, page, limit, total: 0, chats: [] });
    }

    // --- Extract unique phone numbers ---
    const phoneNumbers = [
      ...new Set([
        ...chats
          .map((c) => normalizePhoneNumber(c.senderId?.phone))
          .filter(Boolean),
        ...chats
          .map((c) => normalizePhoneNumber(c.receiverId?.phone))
          .filter(Boolean),
      ]),
    ];

    // --- Load users & saved contacts ---
    const [users, savedContacts] = await Promise.all([
      User.find({ phone: { $in: phoneNumbers } }).select(
        "phone online lastSeen fcmToken"
      ),
      Contact.find({ userId, phone: { $in: phoneNumbers } }).select(
        "phone customName"
      ),
    ]);

    const userMap = new Map(
      users.map((u) => [normalizePhoneNumber(u.phone), u])
    );
    const savedContactMap = new Map(
      savedContacts.map((c) => [normalizePhoneNumber(c.phone), c.customName])
    );

    const blockedSet = new Set(blockedIds);
    const chatMap = new Map();

    // --- Helper: ensure contact exists & return final customName ---
    const ensureCustomName = async (profile) => {
      const normPhone = normalizePhoneNumber(profile.phone);
      const saved = savedContactMap.get(normPhone);

      if (saved) return saved; // already saved

      const fallback = profile.isNumberVisible
        ? normPhone
        : profile.displayName || "Unknown";

      // Fire-and-forget insert – will be available on next request
      Contact.create({ userId, phone: normPhone, customName: fallback }).catch(
        (err) => console.error("[getChatList] auto-create contact error:", err)
      );

      return fallback;
    };

    // --- Build chat list ---
    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) continue;

      const otherProfile =
        chat.senderId._id.toString() === myProfile._id.toString()
          ? chat.receiverId
          : chat.senderId;

      const otherProfileId = otherProfile._id.toString();
      const otherPhone = normalizePhoneNumber(otherProfile.phone);

      if (!chatMap.has(otherProfileId)) {
        const finalCustomName = await ensureCustomName(otherProfile);
        const displayName = otherProfile.isNumberVisible
          ? otherPhone
          : otherProfile.displayName || "Unknown";

        chatMap.set(otherProfileId, {
          profile: {
            id: otherProfile._id.toString(),
            phone: otherProfile.phone,
            displayName,
            customName: finalCustomName, // ALWAYS a string
            randomNumber: otherProfile.randomNumber || "",
            avatarUrl: otherProfile.avatarUrl || "",
            online: userMap.get(otherPhone)?.online || false,
            lastSeen: userMap.get(otherPhone)?.lastSeen?.toISOString() || null,
            fcmToken:
              otherProfile.fcmToken || userMap.get(otherPhone)?.fcmToken || "",
            isBlocked: blockedSet.has(otherProfile._id.toString()),
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

    // --- Sort & paginate ---
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

    const formatted = chatList.map((item) => ({
      profile: item.profile,
      latestMessage: formatChat(item.latestMessage),
      unreadCount: item.unreadCount,
      pinned: item.pinned,
    }));

    return res.json({
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formatted,
    });
  } catch (err) {
    console.error(`[getChatList] Error: ${err.message} at ${timestamp}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};
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

export const blockUser = async (req, res) => {
  try {
    console.log(
      `[blockUser] Processing request: body=${JSON.stringify(
        req.body
      )}, userId=${req.user._id}`
    );
    const { targetPhone } = req.body;
    const myPhone = normalizePhoneNumber(req.user.phone);

    if (!targetPhone) {
      console.error("[blockUser] Target phone number is required");
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }

    const normalizedTargetPhone = normalizePhoneNumber(targetPhone);
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(normalizedTargetPhone)) {
      console.error(
        `[blockUser] Invalid phone number format: ${normalizedTargetPhone}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid phone number format" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    const targetProfile = await Profile.findOne({
      phone: normalizedTargetPhone,
    });

    if (!myProfile || !targetProfile) {
      console.error(
        `[blockUser] Profile not found: myPhone=${myPhone}, targetPhone=${normalizedTargetPhone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    if (myProfile._id.toString() === targetProfile._id.toString()) {
      console.error("[blockUser] Cannot block self");
      return res
        .status(400)
        .json({ success: false, error: "Cannot block yourself" });
    }

    const existingBlock = await Block.findOne({
      blockerId: myProfile._id,
      blockedId: targetProfile._id,
    });
    if (existingBlock) {
      console.log(
        `[blockUser] User already blocked: blockerId=${myProfile._id}, blockedId=${targetProfile._id}`
      );
      return res
        .status(400)
        .json({ success: false, error: "User is already blocked" });
    }

    const block = new Block({
      blockerId: myProfile._id,
      blockedId: targetProfile._id,
    });
    await block.save();
    console.log(
      `[blockUser] User blocked: blockerId=${myProfile._id}, blockedId=${targetProfile._id}`
    );

    return res.status(201).json({
      success: true,
      message: "User blocked successfully",
    });
  } catch (err) {
    console.error(`[blockUser] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

export const getBlockedUsers = async (req, res) => {
  const timestamp = logTimestamp();
  try {
    console.log(
      `[getBlockedUsers] Processing request: userId=${req.user._id} at ${timestamp}`
    );
    const myPhone = normalizePhoneNumber(req.user.phone);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    if (!myPhone) {
      console.error(
        `❌ [getBlockedUsers] Invalid user phone number at ${timestamp}`
      );
      return res
        .status(401)
        .json({ success: false, error: "Invalid user phone number" });
    }

    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(
        `❌ [getBlockedUsers] Profile not found: phone=${myPhone} at ${timestamp}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    const blocked = await Block.find({ blockerId: myProfile._id })
      .populate(
        "blockedId",
        "phone displayName isVisible isNumberVisible avatarUrl randomNumber createdAt fcmToken"
      )
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    console.log(
      `[getBlockedUsers] Found ${
        blocked.length
      } blocked users, blockedIds=${blocked
        .map((b) => b.blockedId?._id)
        .filter(Boolean)
        .join(",")} at ${timestamp}`
    );

    if (!blocked.length) {
      console.log(
        `[getBlockedUsers] No blocked users found for blockerId=${myProfile._id} at ${timestamp}`
      );
      return res.json({
        success: true,
        page,
        limit,
        total: 0,
        blockedUsers: [],
      });
    }

    const phoneNumbers = blocked
      .map((b) => normalizePhoneNumber(b.blockedId?.phone))
      .filter(Boolean);
    const [users, contacts] = await Promise.all([
      User.find({ phone: { $in: phoneNumbers } }).select(
        "phone online lastSeen fcmToken"
      ),
      Contact.find({
        userId: req.user._id,
        phone: { $in: phoneNumbers },
      }).select("phone customName"),
    ]);

    console.log(
      `[getBlockedUsers] Found ${users.length} users, ${contacts.length} contacts at ${timestamp}`
    );

    const userMap = new Map(
      users.map((u) => [normalizePhoneNumber(u.phone), u])
    );
    const contactMap = new Map(
      contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null])
    );

    const blockedProfiles = blocked
      .filter((block) => block.blockedId)
      .map((block) => {
        const profile = block.blockedId;
        const user = userMap.get(normalizePhoneNumber(profile.phone));
        const customName = contactMap.get(normalizePhoneNumber(profile.phone));
        return formatProfile(profile, user, customName, true); // isBlocked set to true
      });

    return res.json({
      success: true,
      page,
      limit,
      total: blocked.length,
      blockedUsers: blockedProfiles,
    });
  } catch (err) {
    console.error(`❌ [getBlockedUsers] Error: ${err.message} at ${timestamp}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};
