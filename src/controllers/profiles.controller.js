import jwt from "jsonwebtoken";
import Profile from "../models/Profile.js";

/**
 * Middleware to verify JWT token
 */
export const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token is required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { phone, iat, exp }
    next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};

/**
 * Helper: Format profile for response
 */
const formatProfile = (profile) => ({
  id: profile._id,
  phone: profile.phone,
  displayName: profile.displayName,
  randomNumber: profile.randomNumber,
  isVisible: profile.isVisible,
  isNumberVisible: profile.isNumberVisible,
  avatarUrl: profile.avatarUrl || "",
  createdAt: profile.createdAt,
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
    console.log("Request headers:", req.headers); // Debug
    console.log("Request body:", req.body); // Debug
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
        randomNumber: generateRandom11DigitNumber(), // Use helper function
        isVisible,
        isNumberVisible,
        avatarUrl: avatarUrl.trim(),
      });
    }

    await profile.save();

    return res.status(201).json({
      success: true,
      message: "Profile saved successfully",
      profile: formatProfile(profile), // Use formatProfile helper
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

    return res.json({ success: true, profile: formatProfile(profile) });
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
      .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      page,
      limit,
      profiles: publicProfiles.map(formatProfile),
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

    const matchedProfiles = await Profile.find({ phone: { $in: contacts } })
      .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

    return res.json({
      success: true,
      profiles: matchedProfiles.map(formatProfile),
    });
  } catch (err) {
    console.error("getProfilesFromContacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
