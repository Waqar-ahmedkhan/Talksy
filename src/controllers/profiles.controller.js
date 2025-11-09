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
    customName: customName || profile?.customName || null, // fallback to profile
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
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${formatted.customName}, isBlocked=${isBlocked} at ${timestamp}`
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

// export const getProfilesFromContacts = async (req, res) => {
//   try {
//     console.log(
//       `[getProfilesFromContacts] Processing request: body=${JSON.stringify(
//         req.body
//       )}, userId=${req.user._id}`
//     );
//     const { contacts } = req.body;
//     const userId = req.user._id;

//     if (!Array.isArray(contacts) || contacts.length === 0) {
//       console.error(
//         "[getProfilesFromContacts] Invalid or empty contacts array"
//       );
//       return res
//         .status(400)
//         .json({ success: false, error: "Contacts array is required" });
//     }
//     console.log(
//       `[getProfilesFromContacts] Validated contacts: count=${contacts.length}`
//     );

//     let phoneNumbers = [];
//     let contactMap = new Map();

//     if (typeof contacts[0] === "string") {
//       console.log("[getProfilesFromContacts] Processing contacts as strings");
//       phoneNumbers = contacts;
//       const userContacts = await Contact.find({
//         userId,
//         phone: { $in: phoneNumbers },
//       }).select("phone customName");
//       console.log(
//         `[getProfilesFromContacts] Found ${userContacts.length} contacts`
//       );
//       userContacts.forEach((contact) => {
//         const normalizedPhone = normalizePhoneNumber(contact.phone);
//         console.log(
//           `[getProfilesFromContacts] Mapping contact: phone=${normalizedPhone}, customName=${
//             contact.customName || null
//           }`
//         );
//         contactMap.set(normalizedPhone, contact.customName || null);
//       });
//     } else {
//       console.log("[getProfilesFromContacts] Processing contacts as objects");
//       for (const contact of contacts) {
//         if (!contact.phone || typeof contact.phone !== "string") {
//           console.error(
//             `[getProfilesFromContacts] Invalid contact: ${JSON.stringify(
//               contact
//             )}`
//           );
//           return res.status(400).json({
//             success: false,
//             error: "Each contact must have a valid phone number",
//           });
//         }
//         phoneNumbers.push(contact.phone);
//         contactMap.set(
//           normalizePhoneNumber(contact.phone),
//           contact.customName || null
//         );
//       }
//       const userContacts = await Contact.find({
//         userId,
//         phone: { $in: phoneNumbers },
//       }).select("phone customName");
//       console.log(
//         `[getProfilesFromContacts] Found ${userContacts.length} contacts for merging`
//       );
//       userContacts.forEach((contact) => {
//         const normalizedPhone = normalizePhoneNumber(contact.phone);
//         if (!contactMap.has(normalizedPhone)) {
//           console.log(
//             `[getProfilesFromContacts] Merging contact: phone=${normalizedPhone}, customName=${
//               contact.customName || null
//             }`
//           );
//           contactMap.set(normalizedPhone, contact.customName || null);
//         }
//       });
//     }

//     const matchedProfiles = await Profile.find({
//       phone: { $in: phoneNumbers },
//     }).select(
//       "displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone"
//     );
//     console.log(
//       `[getProfilesFromContacts] Found ${matchedProfiles.length} profiles`
//     );

//     const users = await User.find({ phone: { $in: phoneNumbers } }).select(
//       "phone online lastSeen"
//     );
//     console.log(`[getProfilesFromContacts] Found ${users.length} users`);
//     const userMap = new Map(users.map((u) => [u.phone, u]));

//     const response = {
//       success: true,
//       profiles: matchedProfiles.map((profile) =>
//         formatProfile(
//           profile,
//           userMap.get(profile.phone),
//           contactMap.get(profile.phone)
//         )
//       ),
//     };
//     console.log(
//       `[getProfilesFromContacts] Response ready: profiles=${response.profiles.length}`
//     );
//     return res.json(response);
//   } catch (err) {
//     console.error(`[getProfilesFromContacts] Error: ${err.message}`);
//     return res
//       .status(500)
//       .json({ success: false, error: "Server error", details: err.message });
//   }
// };

// export const getProfilesFromContacts = async (req, res) => {
//   const timestamp = logTimestamp();
//   console.log(
//     `[getProfilesFromContacts] START: userId=${req.user._id}, phone=${req.user.phone} at ${timestamp}`
//   );

//   try {
//     const { contacts } = req.body;
//     const userId = req.user._id;

//     if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
//       console.log(
//         `[getProfilesFromContacts] No contacts provided at ${timestamp}`
//       );
//       return res.json({
//         success: true,
//         profiles: [],
//         message: "No contacts provided",
//       });
//     }

//     console.log(
//       `[getProfilesFromContacts] Validated contacts: count=${contacts.length} at ${timestamp}`
//     );

//     // Step 1: Determine if contacts are objects or strings
//     const isObjectArray =
//       contacts.length > 0 &&
//       typeof contacts[0] === "object" &&
//       contacts[0] !== null;

//     if (isObjectArray) {
//       console.log(
//         `[getProfilesFromContacts] Processing contacts as objects at ${timestamp}`
//       );
//     } else {
//       console.log(
//         `[getProfilesFromContacts] Processing contacts as phone strings at ${timestamp}`
//       );
//     }

//     // Step 2: Build contactMap (phone → customName) + normalize phones
//     const contactMap = new Map(); // phone → customName
//     const phoneSet = new Set(); // for deduplication

//     for (let item of contacts) {
//       let rawPhone, customName;

//       if (typeof item === "string") {
//         rawPhone = item;
//         customName = null;
//       } else if (typeof item === "object" && item.phone) {
//         rawPhone = item.phone;
//         customName = item.customName || null;
//       } else {
//         continue;
//       }

//       const phone = normalizePhoneNumber(rawPhone);
//       if (!phone) {
//         console.log(
//           `[normalizePhoneNumber] Invalid phone skipped: ${rawPhone}`
//         );
//         continue;
//       }

//       if (!phoneSet.has(phone)) {
//         phoneSet.add(phone);
//         if (customName && typeof customName === "string" && customName.trim()) {
//           contactMap.set(phone, customName.trim());
//         }
//       }
//     }

//     console.log(
//       `[getProfilesFromContacts] Built contactMap: size=${contactMap.size}, unique phones=${phoneSet.size} at ${timestamp}`
//     );

//     // Step 3: Find users matching these phones
//     const userPhones = Array.from(phoneSet);
//     const users = await User.find({ phone: { $in: userPhones } })
//       .select("phone displayName")
//       .lean();

//     const userMap = new Map();
//     users.forEach((u) => userMap.set(u.phone, u));

//     console.log(
//       `[getProfilesFromContacts] Found ${users.length} users at ${timestamp}`
//     );

//     // Step 4: Find saved contacts (for future merging)
//     const savedContacts = await Contact.find({
//       userId,
//       phone: { $in: userPhones },
//     })
//       .select("phone customName")
//       .lean();

//     const savedContactMap = new Map();
//     savedContacts.forEach((c) => savedContactMap.set(c.phone, c.customName));

//     console.log(
//       `[getProfilesFromContacts] Found ${savedContacts.length} contacts for merging at ${timestamp}`
//     );

//     // Step 5: Find blocked users
//     const blocked = await Block.find({
//       blocker: userId,
//       blocked: { $in: users.map((u) => u._id) },
//     })
//       .select("blocked")
//       .lean();
//     const blockedSet = new Set(blocked.map((b) => b.blocked.toString()));

//     // Step 6: Build final profiles
//     const finalProfiles = [];

//     for (const phone of userPhones) {
//       const user = userMap.get(phone);
//       if (!user) continue;

//       const customName =
//         contactMap.get(phone) || savedContactMap.get(phone) || null;
//       const isBlocked = blockedSet.has(user._id.toString());

//       finalProfiles.push({
//         phone: user.phone,
//         displayName: user.displayName || "Unknown",
//         customName,
//         isBlocked,
//         isRegistered: true,
//       });

//       console.log(
//         `[formatProfile] Formatted profile: phone=${phone}, displayName=${
//           user.displayName
//         }, customName=${
//           customName || null
//         }, isBlocked=${isBlocked} at ${timestamp}`
//       );
//     }

//     // === AUTO-SAVE ALL CUSTOM NAMES TO DB ===
//     console.log(
//       `[getProfilesFromContacts] AUTO-SAVING ${contactMap.size} contacts to DB for future use at ${timestamp}`
//     );

//     const contactsToSave = Array.from(contactMap.entries())
//       .filter(([phone, name]) => name && name.trim())
//       .map(([phone, customName]) => ({
//         userId,
//         phone,
//         customName: validator.escape(customName.trim()),
//       }));

//     if (contactsToSave.length > 0) {
//       const bulkOps = contactsToSave.map((contact) => ({
//         updateOne: {
//           filter: { userId: contact.userId, phone: contact.phone },
//           update: { $set: { customName: contact.customName } },
//           upsert: true,
//         },
//       }));

//       try {
//         const result = await Contact.bulkWrite(bulkOps, { ordered: false });
//         console.log(
//           `[getProfilesFromContacts] AUTO-SAVED: ${result.upsertedCount} new, ${result.modifiedCount} updated, total=${contactsToSave.length} at ${timestamp}`
//         );
//       } catch (err) {
//         console.error(
//           `[getProfilesFromContacts] Auto-save failed: ${err.message} at ${timestamp}`
//         );
//       }
//     } else {
//       console.log(
//         `[getProfilesFromContacts] No custom names to auto-save at ${timestamp}`
//       );
//     }

//     console.log(
//       `[getProfilesFromContacts] Response ready: profiles=${finalProfiles.length} at ${timestamp}`
//     );

//     return res.json({
//       success: true,
//       profiles: finalProfiles,
//       message: `${finalProfiles.length} profiles loaded`,
//     });
//   } catch (err) {
//     console.error(
//       `[getProfilesFromContacts] ERROR: ${err.message} at ${timestamp}`
//     );
//     return res.status(500).json({
//       success: false,
//       error: "Failed to fetch profiles",
//       details: err.message,
//     });
//   }
// };

export const getProfilesFromContacts = async (req, res) => {
  const timestamp = logTimestamp();
  console.log(
    `[getProfilesFromContacts] START: userId=${req.user._id}, phone=${req.user.phone} at ${timestamp}`
  );

  try {
    const { contacts } = req.body;
    const userId = req.user._id;

    // ✅ Validate input
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      console.log(
        `[getProfilesFromContacts] No contacts provided at ${timestamp}`
      );
      return res.json({
        success: true,
        profiles: [],
        message: "No contacts provided",
      });
    }

    console.log(
      `[getProfilesFromContacts] Received ${contacts.length} contacts at ${timestamp}`
    );

    // ✅ Step 1: Build normalized phone list and map request-provided names
    const phoneSet = new Set();
    const requestNameMap = new Map(); // phone -> name from request

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      let rawPhone, nameFromRequest;

      // Handle different contact formats (string or object)
      if (typeof contact === "string") {
        rawPhone = contact;
        nameFromRequest = null;
      } else if (typeof contact === "object" && contact !== null) {
        // Support both 'name' and 'customName' fields from Flutter
        rawPhone = contact.phone;
        nameFromRequest = contact.name || contact.customName || null;
      } else {
        console.warn(
          `[getProfilesFromContacts] Skipping invalid contact at index ${i}: ${typeof contact}`
        );
        continue;
      }

      // Normalize phone number
      const normalizedPhone = normalizePhoneNumber(rawPhone);
      if (!normalizedPhone) {
        console.warn(
          `[getProfilesFromContacts] Skipping invalid phone at index ${i}: ${rawPhone}`
        );
        continue;
      }

      phoneSet.add(normalizedPhone);

      // Store name from request if it exists and is valid
      if (
        nameFromRequest &&
        typeof nameFromRequest === "string" &&
        nameFromRequest.trim()
      ) {
        requestNameMap.set(normalizedPhone, nameFromRequest.trim());
      }
    }

    const phoneNumbers = Array.from(phoneSet);
    console.log(
      `[getProfilesFromContacts] Processed ${phoneNumbers.length} valid phone numbers at ${timestamp}`
    );

    // ✅ Step 2: Fetch FULL Profile and User documents
    const profiles = await Profile.find({ phone: { $in: phoneNumbers } })
      .select(
        "phone displayName randomNumber isVisible isNumberVisible avatarUrl createdAt fcmToken customName"
      )
      .lean();

    const profileMap = new Map(profiles.map((p) => [p.phone, p]));
    console.log(
      `[getProfilesFromContacts] Found ${profiles.length} profiles at ${timestamp}`
    );

    const users = await User.find({ phone: { $in: phoneNumbers } })
      .select("_id phone online lastSeen fcmToken")
      .lean();

    const userMap = new Map(users.map((u) => [u.phone, u]));
    console.log(
      `[getProfilesFromContacts] Found ${users.length} users at ${timestamp}`
    );

    // ✅ Step 3: Get saved contacts from DB for name merging
    const savedContacts = await Contact.find({
      userId,
      phone: { $in: phoneNumbers },
    })
      .select("phone customName")
      .lean();

    const savedContactMap = new Map(
      savedContacts.map((c) => [c.phone, c.customName])
    );
    console.log(
      `[getProfilesFromContacts] Found ${savedContacts.length} saved contacts at ${timestamp}`
    );

    // ✅ Step 4: Get blocked users
    const blocked = await Block.find({
      blocker: userId,
      blocked: { $in: users.map((u) => u._id) },
    })
      .select("blocked")
      .lean();

    const blockedSet = new Set(blocked.map((b) => b.blocked.toString()));
    console.log(
      `[getProfilesFromContacts] Found ${blocked.length} blocked users at ${timestamp}`
    );

    // ✅ Step 5: Build final profiles using formatProfile for registered users
    const finalProfiles = [];

    for (const phone of phoneNumbers) {
      const profile = profileMap.get(phone);
      const user = userMap.get(phone);

      if (profile && user) {
        // Registered user - use formatProfile for full details
        const customName =
          requestNameMap.get(phone) ||
          savedContactMap.get(phone) ||
          profile.customName ||
          null;

        const isBlocked = blockedSet.has(user._id.toString());

        // Use the existing formatProfile helper to ensure consistent response
        const formattedProfile = formatProfile(
          profile,
          user,
          customName,
          isBlocked
        );
        finalProfiles.push(formattedProfile);
      } else {
        // Unregistered user - minimal info
        finalProfiles.push({
          phone,
          displayName: phone,
          customName: requestNameMap.get(phone) || null,
          isBlocked: false,
          isRegistered: false,
          avatarUrl: "", // ✅ Add empty avatarUrl for unregistered
          id: null, // ✅ Add null id for unregistered
          userId: null, // ✅ Add null userId for unregistered
        });
      }
    }

    console.log(
      `[getProfilesFromContacts] Response ready: ${finalProfiles.length} profiles at ${timestamp}`
    );

    return res.json({
      success: true,
      profiles: finalProfiles,
      message: `${finalProfiles.length} profiles loaded`,
    });
  } catch (err) {
    console.error(
      `[getProfilesFromContacts] ERROR: ${err.message} at ${timestamp}`
    );
    return res.status(500).json({
      success: false,
      error: "Failed to fetch profiles",
      details: err.message,
    });
  }
};

export const getProfileWithChat = async (req, res) => {
  try {
    console.log(
      `[getProfileWithChat] Processing request: params=${JSON.stringify(
        req.params
      )}, userId=${req.user._id}`
    );
    const myPhone = normalizePhoneNumber(req.user.phone);
    const targetPhone = req.params.phone;

    if (!targetPhone) {
      console.error("[getProfileWithChat] Target phone number is required");
      return res
        .status(400)
        .json({ success: false, error: "Target phone number is required" });
    }

    const normalizedTargetPhone = normalizePhoneNumber(targetPhone);
    const myProfile = await Profile.findOne({ phone: myPhone });
    const targetProfile = await Profile.findOne({
      phone: normalizedTargetPhone,
    });

    if (!myProfile || !targetProfile) {
      console.error(
        `[getProfileWithChat] Profile not found: myPhone=${myPhone}, targetPhone=${normalizedTargetPhone}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Profile not found" });
    }

    // Check if target user is blocked
    const block = await Block.findOne({
      blockerId: myProfile._id,
      blockedId: targetProfile._id,
    });
    if (block) {
      console.log(
        `[getProfileWithChat] User is blocked: blockerId=${myProfile._id}, blockedId=${targetProfile._id}`
      );
      return res.status(403).json({ success: false, error: "User is blocked" });
    }

    const targetUser = await User.findOne({ phone: normalizedTargetPhone });
    console.log(
      `[getProfileWithChat] Target user ${
        targetUser ? "found" : "not found"
      }: phone=${normalizedTargetPhone}`
    );

    const contact = await Contact.findOne({
      userId: req.user._id,
      phone: normalizedTargetPhone,
    }).select("customName");
    const customName = contact?.customName || null;
    console.log(
      `[getProfileWithChat] Custom name: phone=${normalizedTargetPhone}, customName=${customName}`
    );

    const chats = await Chat.find({
      $or: [
        { senderId: myProfile._id, receiverId: targetProfile._id },
        { senderId: targetProfile._id, receiverId: myProfile._id },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50);
    console.log(`[getProfileWithChat] Found ${chats.length} chats`);

    const response = {
      success: true,
      profile: formatProfile(targetProfile, targetUser, customName, false),
      chatHistory: chats.map(formatChat),
    };
    console.log(
      `[getProfileWithChat] Response ready: chats=${response.chatHistory.length}`
    );
    return res.json(response);
  } catch (err) {
    console.error(`[getProfileWithChat] Error: ${err.message}`);
    return res
      .status(500)
      .json({ success: false, error: "Server error", details: err.message });
  }
};

// export const upsertContacts = async (req, res) => {
//   try {
//     console.log(
//       `[upsertContacts] Processing request: body=${JSON.stringify(
//         req.body
//       )}, userId=${req.user._id}`
//     );
//     const contacts = req.body.contacts; // Expecting an array of { phone, customName }
//     const userId = req.user._id;

//     if (!Array.isArray(contacts) || contacts.length === 0) {
//       console.error(
//         "[upsertContacts] Invalid input: contacts must be a non-empty array"
//       );
//       return res
//         .status(400)
//         .json({ success: false, error: "Contacts must be a non-empty array" });
//     }

//     const phoneRegex = /^\+?[1-9]\d{1,14}$/;
//     const invalidContacts = [];
//     const validContacts = [];

//     // Validate all contacts
//     for (const contact of contacts) {
//       const { phone, customName } = contact;

//       if (!phone || typeof phone !== "string" || !phone.trim()) {
//         invalidContacts.push({
//           phone,
//           error: "Valid phone number is required",
//         });
//         continue;
//       }

//       if (!customName || typeof customName !== "string" || !customName.trim()) {
//         invalidContacts.push({ phone, error: "Valid custom name is required" });
//         continue;
//       }

//       const normalizedPhone = normalizePhoneNumber(phone);
//       if (!phoneRegex.test(normalizedPhone)) {
//         invalidContacts.push({ phone, error: "Invalid phone number format" });
//         continue;
//       }

//       validContacts.push({
//         phone: normalizedPhone,
//         customName: customName.trim(),
//       });
//     }

//     if (invalidContacts.length > 0) {
//       console.error(
//         `[upsertContacts] Invalid contacts: ${JSON.stringify(invalidContacts)}`
//       );
//       return res.status(400).json({
//         success: false,
//         error: "Some contacts have invalid data",
//         invalidContacts,
//       });
//     }

//     // Process valid contacts in bulk
//     const updatePromises = validContacts.map(({ phone, customName }) =>
//       Contact.findOneAndUpdate(
//         { userId, phone },
//         { customName },
//         { new: true, upsert: true, setDefaultsOnInsert: true }
//       )
//     );

//     const updatedContacts = await Promise.all(updatePromises);

//     console.log(
//       `[upsertContacts] Contacts saved: count=${updatedContacts.length}`
//     );

//     return res.json({
//       success: true,
//       message: "Contacts saved successfully",
//       contacts: updatedContacts.map((contact) => ({
//         phone: contact.phone,
//         customName: contact.customName,
//       })),
//     });
//   } catch (err) {
//     console.error(`[upsertContacts] Error: ${err.message}`);
//     return res
//       .status(500)
//       .json({ success: false, error: "Server error", details: err.message });
//   }
// };

// export const getChatList = async (req, res) => {
//   const timestamp = logTimestamp();
//   try {
//     console.log(
//       `[getChatList] Processing request: query=${JSON.stringify(
//         req.query
//       )}, userId=${req.user?._id}, phone=${req.user?.phone} at ${timestamp}`
//     );
//     const myPhone = normalizePhoneNumber(req.user.phone);
//     const userId = req.user._id;
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;

//     if (!userId || !myPhone) {
//       console.error(`❌ [getChatList] Missing userId or phone at ${timestamp}`);
//       return res.status(401).json({
//         success: false,
//         error: "Unauthorized: Missing user ID or phone",
//       });
//     }
//     if (page < 1 || limit < 1 || limit > 100) {
//       console.error(
//         `❌ [getChatList] Invalid pagination: page=${page}, limit=${limit} at ${timestamp}`
//       );
//       return res.status(400).json({
//         success: false,
//         error:
//           "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
//       });
//     }

//     const skip = (page - 1) * limit;
//     const myProfile = await Profile.findOne({ phone: myPhone });
//     if (!myProfile) {
//       console.error(
//         `❌ [getChatList] Profile not found: phone=${myPhone} at ${timestamp}`
//       );
//       return res
//         .status(404)
//         .json({ success: false, error: "Your profile not found" });
//     }

//     const blocked = await Block.find({ blockerId: myProfile._id }).select(
//       "blockedId"
//     );
//     const blockedIds = blocked.map((b) => b.blockedId.toString());
//     console.log(
//       `[getChatList] Found ${blocked.length} blocked users: ${blockedIds.join(
//         ", "
//       )} at ${timestamp}`
//     );

//     const chats = await Chat.find({
//       $and: [
//         { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
//         { receiverId: { $ne: null } },
//         { deletedFor: { $ne: myProfile._id } },
//       ],
//     })
//       .sort({ pinned: -1, createdAt: -1 })
//       .populate(
//         "senderId receiverId",
//         "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt fcmToken"
//       );
//     console.log(`[getChatList] Found ${chats.length} chats at ${timestamp}`);

//     if (!chats || chats.length === 0) {
//       console.log(`[getChatList] No chats found at ${timestamp}`);
//       return res.json({ success: true, page, limit, total: 0, chats: [] });
//     }

//     // const phoneNumbers = [
//     //   ...new Set(
//     //     chats
//     //       .flatMap((c) => [c.senderId?.phone, c.receiverId?.phone])
//     //       .filter(Boolean)
//     //   ),
//     // ];

//     // console.log(
//     //   `[getChatList] Extracted ${phoneNumbers.length} unique phone numbers at ${timestamp}`
//     // );

//     // const [users, contacts] = await Promise.all([
//     //   User.find({ phone: { $in: phoneNumbers } }).select(
//     //     "phone online lastSeen fcmToken"
//     //   ),
//     //   Contact.find({
//     //     userId: req.user._id,
//     //     phone: { $in: phoneNumbers },
//     //   }).select("phone customName"),
//     // ]);
//     // console.log(
//     //   `[getChatList] Found ${users.length} users, ${contacts.length} saved contacts at ${timestamp}`
//     // );

//     // const userMap = new Map(users.map((u) => [u.phone, u]));
//     // const contactMap = new Map(
//     //   contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null])
//     // );

//     // ✅ Normalize all phones before querying and mapping
//     const phoneNumbers = [
//       ...new Set(
//         chats
//           .flatMap((c) => [c.senderId?.phone, c.receiverId?.phone])
//           .filter(Boolean)
//           .map((p) => normalizePhoneNumber(p)) // normalize here
//       ),
//     ];

//     console.log(
//       `[getChatList] Extracted ${phoneNumbers.length} unique (normalized) phone numbers at ${timestamp}`
//     );

//     const [users, contacts] = await Promise.all([
//       User.find({ phone: { $in: phoneNumbers } }).select(
//         "phone online lastSeen fcmToken"
//       ),
//       Contact.find({
//         userId: req.user._id,
//         phone: { $in: phoneNumbers },
//       }).select("phone customName"),
//     ]);

//     console.log(
//       `[getChatList] Found ${users.length} users, ${contacts.length} saved contacts at ${timestamp}`
//     );

//     // ✅ Normalize for safe map lookups
//     const userMap = new Map(
//       users.map((u) => [normalizePhoneNumber(u.phone), u])
//     );

//     const contactMap = new Map(
//       contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null])
//     );

//     const blockedSet = new Set(blockedIds);
//     const chatMap = new Map();

//     for (const chat of chats) {
//       if (!chat.senderId || !chat.receiverId) {
//         console.warn(
//           `[getChatList] Skipping chat ${chat._id}: missing senderId or receiverId at ${timestamp}`
//         );
//         continue;
//       }

//       const otherProfileId =
//         chat.senderId._id.toString() === myProfile._id.toString()
//           ? chat.receiverId._id.toString()
//           : chat.senderId._id.toString();

//       if (!chatMap.has(otherProfileId)) {
//         const otherProfile =
//           chat.senderId._id.toString() === myProfile._id.toString()
//             ? chat.receiverId
//             : chat.senderId;
//         const otherPhone = otherProfile.phone;

//         // Merge customName: first from contacts, then from profile, else null
//         const customName =
//           contactMap.get(otherPhone) || otherProfile.customName || null;

//         const displayName = otherProfile.isNumberVisible
//           ? otherPhone
//           : otherProfile.displayName || "Unknown";

//         console.log(
//           `[getChatList] Profile: phone=${otherPhone}, displayName=${displayName}, customName=${customName} at ${timestamp}`
//         );

//         chatMap.set(otherProfileId, {
//           profile: {
//             id: otherProfile._id.toString(),
//             phone: otherPhone,
//             displayName,
//             customName, // Now merged properly
//             randomNumber: otherProfile.randomNumber || "",
//             avatarUrl: otherProfile.avatarUrl || "",
//             online: userMap.get(otherPhone)?.online || false,
//             lastSeen: userMap.get(otherPhone)?.lastSeen?.toISOString() || null,
//             fcmToken:
//               otherProfile.fcmToken || userMap.get(otherPhone)?.fcmToken || "",
//             isBlocked: blockedSet.has(otherProfile._id.toString()),
//           },
//           latestMessage: chat,
//           unreadCount:
//             chat.receiverId._id.toString() === myProfile._id.toString() &&
//             ["sent", "delivered"].includes(chat.status)
//               ? 1
//               : 0,
//           pinned: chat.pinned || false,
//         });
//       } else {
//         const existing = chatMap.get(otherProfileId);
//         if (
//           new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)
//         ) {
//           console.log(
//             `[getChatList] Updating latest message: profileId=${otherProfileId}, chatId=${chat._id} at ${timestamp}`
//           );
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
//         return (
//           new Date(b.latestMessage.createdAt) -
//           new Date(a.latestMessage.createdAt)
//         );
//       })
//       .slice(skip, skip + limit);

//     const formattedChatList = chatList.map((item) => ({
//       profile: item.profile,
//       latestMessage: formatChat(item.latestMessage),
//       unreadCount: item.unreadCount,
//       pinned: item.pinned,
//     }));

//     console.log(
//       `[getChatList] Response ready: total=${chatMap.size}, chats=${formattedChatList.length} at ${timestamp}`
//     );

//     return res.json({
//       success: true,
//       page,
//       limit,
//       total: chatMap.size,
//       chats: formattedChatList,
//     });
//   } catch (err) {
//     console.error(`❌ [getChatList] Error: ${err.message} at ${timestamp}`);
//     return res
//       .status(500)
//       .json({ success: false, error: "Server error", details: err.message });
//   }
// };
export const upsertContacts = async (req, res) => {
  const timestamp = logTimestamp();
  console.log(`[upsertContacts] START: Processing request at ${timestamp}`);

  try {
    const { contacts } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      console.error(
        `❌ [upsertContacts] Invalid: contacts must be non-empty array at ${timestamp}`
      );
      return res.status(400).json({
        success: false,
        error: "Contacts must be a non-empty array of { phone, customName }",
      });
    }

    const validContacts = [];
    const invalidContacts = [];
    const phoneRegex = /^\+?[0-9]{10,15}$/; // E.164 compatible

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const index = i + 1;

      if (!contact || typeof contact !== "object") {
        invalidContacts.push({ index, error: "Not an object" });
        continue;
      }

      const { phone, customName } = contact;

      if (!phone || typeof phone !== "string") {
        invalidContacts.push({
          index,
          phone,
          error: "Phone is missing or not string",
        });
        continue;
      }

      if (
        !customName ||
        typeof customName !== "string" ||
        customName.trim().length === 0
      ) {
        invalidContacts.push({
          index,
          phone,
          error: "customName is missing or empty",
        });
        continue;
      }

      const normalizedPhone = normalizePhoneNumber(phone.trim());
      if (!normalizedPhone || !phoneRegex.test(normalizedPhone)) {
        invalidContacts.push({
          index,
          phone,
          normalizedPhone,
          error: "Invalid phone format",
        });
        continue;
      }

      validContacts.push({
        originalPhone: phone.trim(),
        phone: normalizedPhone,
        customName: customName.trim(),
      });
    }

    if (invalidContacts.length > 0) {
      console.error(
        `❌ [upsertContacts] ${invalidContacts.length} invalid contacts:`,
        invalidContacts
      );
      return res.status(400).json({
        success: false,
        error: "Some contacts are invalid",
        invalidContacts,
        tip: "Each contact must have valid 'phone' and non-empty 'customName'",
      });
    }

    if (validContacts.length === 0) {
      console.log(`[upsertContacts] No valid contacts to save at ${timestamp}`);
      return res.json({
        success: true,
        message: "No valid contacts to save",
        savedCount: 0,
      });
    }

    // Bulk upsert using findOneAndUpdate
    const savePromises = validContacts.map(async ({ phone, customName }) => {
      try {
        const updated = await Contact.findOneAndUpdate(
          { userId, phone },
          {
            userId,
            phone,
            customName: validator.escape(customName), // Sanitize
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            runValidators: true,
          }
        );

        return {
          phone,
          customName,
          saved: true,
          contactId: updated._id.toString(),
        };
      } catch (err) {
        console.error(
          `❌ [upsertContacts] Failed to save phone=${phone}:`,
          err.message
        );
        return {
          phone,
          customName,
          saved: false,
          error: err.message,
        };
      }
    });

    const results = await Promise.all(savePromises);

    const saved = results.filter((r) => r.saved);
    const failed = results.filter((r) => !r.saved);

    console.log(
      `[upsertContacts] SUCCESS: Saved ${saved.length}/${validContacts.length} contacts at ${timestamp}`
    );
    if (failed.length > 0) {
      console.error(
        `[upsertContacts] FAILED ${failed.length} contacts:`,
        failed
      );
    }

    // Log one example saved contact
    if (saved.length > 0) {
      console.log(
        `[upsertContacts] Example saved → phone: ${saved[0].phone}, customName: "${saved[0].customName}"`
      );
    }

    return res.json({
      success: true,
      message: `Saved ${saved.length} contacts${
        failed.length > 0 ? `, ${failed.length} failed` : ""
      }`,
      savedCount: saved.length,
      failedCount: failed.length,
      savedContacts: saved.map((s) => ({
        phone: s.phone,
        customName: s.customName,
      })),
      failedContacts: failed,
    });
  } catch (err) {
    console.error(
      `❌ [upsertContacts] SERVER ERROR: ${err.message} at ${timestamp}`
    );
    return res.status(500).json({
      success: false,
      error: "Server error while saving contacts",
      details: err.message,
    });
  }
};
export const getChatList = async (req, res) => {
  const timestamp = logTimestamp();
  try {
    console.log(
      `[getChatList] Processing request: query=${JSON.stringify(
        req.query
      )}, userId=$$ {req.user?._id}, phone= $${req.user?.phone} at ${timestamp}`
    );
    const myPhone = normalizePhoneNumber(req.user.phone);
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!userId || !myPhone) {
      console.error(`❌ [getChatList] Missing userId or phone at ${timestamp}`);
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing user ID or phone",
      });
    }
    if (page < 1 || limit < 1 || limit > 100) {
      console.error(
        `❌ [getChatList] Invalid pagination: page=${page}, limit=${limit} at ${timestamp}`
      );
      return res.status(400).json({
        success: false,
        error:
          "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
      });
    }

    const skip = (page - 1) * limit;
    const myProfile = await Profile.findOne({ phone: myPhone });
    if (!myProfile) {
      console.error(
        `❌ [getChatList] Profile not found: phone=${myPhone} at ${timestamp}`
      );
      return res
        .status(404)
        .json({ success: false, error: "Your profile not found" });
    }

    const blocked = await Block.find({ blockerId: myProfile._id }).select(
      "blockedId"
    );
    const blockedIds = blocked.map((b) => b.blockedId.toString());
    console.log(
      `[getChatList] Found ${blocked.length} blocked users at ${timestamp}`
    );

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
    console.log(`[getChatList] Found ${chats.length} chats at ${timestamp}`);

    if (!chats.length) {
      return res.json({ success: true, page, limit, total: 0, chats: [] });
    }

    const phoneNumbers = [
      ...new Set(
        chats
          .flatMap((c) => [c.senderId?.phone, c.receiverId?.phone])
          .filter(Boolean)
          .map(normalizePhoneNumber)
      ),
    ];
    console.log(
      `[getChatList] Extracted ${phoneNumbers.length} unique phones at ${timestamp}`
    );

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
      `[getChatList] Found ${users.length} users, ${contacts.length} contacts at ${timestamp}`
    );

    const userMap = new Map(
      users.map((u) => [normalizePhoneNumber(u.phone), u])
    );
    const contactMap = new Map(
      contacts.map((c) => [normalizePhoneNumber(c.phone), c.customName || null])
    );

    const blockedSet = new Set(blockedIds);
    const chatMap = new Map();

    for (const chat of chats) {
      if (!chat.senderId || !chat.receiverId) continue;

      const otherProfile =
        chat.senderId._id.toString() === myProfile._id.toString()
          ? chat.receiverId
          : chat.senderId;
      const otherProfileId = otherProfile._id.toString();
      const otherPhone = normalizePhoneNumber(otherProfile.phone); // Ensure normalized

      if (blockedSet.has(otherProfileId)) continue; // Skip blocked

      if (!chatMap.has(otherProfileId)) {
        const customName = contactMap.get(otherPhone) || null;
        const displayName = otherProfile.isNumberVisible
          ? otherPhone
          : otherProfile.displayName || "Unknown";

        console.log(
          `[getChatList] Profile: phone=${otherPhone}, displayName=${displayName}, customName=${
            customName || "null"
          } at ${timestamp}`
        );

        chatMap.set(otherProfileId, {
          profile: {
            id: otherProfileId,
            phone: otherPhone,
            displayName,
            customName,
            randomNumber: otherProfile.randomNumber || "",
            avatarUrl: otherProfile.avatarUrl || "",
            online: userMap.get(otherPhone)?.online || false,
            lastSeen: userMap.get(otherPhone)?.lastSeen?.toISOString() || null,
            fcmToken:
              otherProfile.fcmToken || userMap.get(otherPhone)?.fcmToken || "",
            isBlocked: false, // Since we skipped blocked
          },
          latestMessage: chat,
          unreadCount: 0,
          pinned: chat.pinned || false,
        });
      }

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

    const chatList = Array.from(chatMap.values())
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned - a.pinned;
        return (
          new Date(b.latestMessage.createdAt) -
          new Date(a.latestMessage.createdAt)
        );
      })
      .slice(skip, skip + limit);

    const formattedChatList = chatList.map((item) => ({
      profile: item.profile,
      latestMessage: formatChat(item.latestMessage),
      unreadCount: item.unreadCount,
      pinned: item.pinned,
    }));

    console.log(
      `[getChatList] Response ready: total=${chatMap.size}, page=${page}, chats=${formattedChatList.length} at ${timestamp}`
    );

    return res.json({
      success: true,
      page,
      limit,
      total: chatMap.size,
      chats: formattedChatList,
    });
  } catch (err) {
    console.error(`❌ [getChatList] Error: ${err.message} at ${timestamp}`);
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

    const phoneNumbers = blocked.map((b) => b.blockedId?.phone).filter(Boolean);

    const [users, contacts] = await Promise.all([
      User.find({ phone: { $in: phoneNumbers } }).select(
        "phone online lastSeen fcmToken"
      ),
      Contact.find({
        userId: req.user._id,
        phone: { $in: phoneNumbers },
      }).select("phone customName"),
    ]);

    const userMap = new Map(users.map((u) => [u.phone, u]));
    const contactMap = new Map(
      contacts.map((c) => [c.phone, c.customName || null])
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
