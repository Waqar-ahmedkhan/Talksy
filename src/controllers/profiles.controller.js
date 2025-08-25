// controllers/profiles.controller.js
import jwt from "jsonwebtoken";
import { randomInt } from "crypto";
import Profile from "../models/Profile.js";

/**
 * Middleware to verify JWT token
 */
export const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader?.split(" ")[1];

    if (!token) return res.status(401).json({ error: "Access token is required" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { phone, iat, exp }
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};

/**
 * Helper: Format profile for response
 */
const formatProfile = (profile) => ({
  id: profile._id,
  displayName: profile.displayName,
  randomNumber: profile.randomNumber,
  isVisible: profile.isVisible,
  bio: profile.bio || "",
  avatarUrl: profile.avatarUrl || "",
  createdAt: profile.createdAt,
});

/**
 * Create Profile
 */
export const createProfile = [
  authenticateToken,
  async (req, res) => {
    try {
      const { displayName, isVisible = false, bio = "", avatarUrl = "" } = req.body;
      const phone = req.user.phone;

      if (!displayName?.trim()) {
        return res.status(400).json({ error: "Display name is required" });
      }

      const existing = await Profile.findOne({ phone });
      if (existing) return res.status(400).json({ error: "Profile already exists" });

      const profile = new Profile({
        phone,
        displayName: displayName.trim(),
        randomNumber: randomInt(1000, 10000),
        isVisible,
        bio: bio.trim(),
        avatarUrl: avatarUrl.trim(),
      });

      await profile.save();

      return res.status(201).json({
        success: true,
        message: "Profile created successfully",
        profile: formatProfile(profile),
      });
    } catch (err) {
      console.error("createProfile error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
];

/**
 * Get My Profile
 */
export const getMyProfile = [
  authenticateToken,
  async (req, res) => {
    try {
      const profile = await Profile.findOne({ phone: req.user.phone });
      if (!profile) return res.status(404).json({ error: "Profile not found" });

      return res.json({ success: true, profile: formatProfile(profile) });
    } catch (err) {
      console.error("getMyProfile error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
];

/**
 * Get Public Profiles with optional pagination
 */
export const getPublicProfiles = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const publicProfiles = await Profile.find({ isVisible: true })
      .select("displayName randomNumber isVisible bio avatarUrl createdAt")
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
export const getProfilesFromContacts = [
  authenticateToken,
  async (req, res) => {
    try {
      const { contacts } = req.body;
      if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: "Contacts array is required" });
      }

      const matchedProfiles = await Profile.find({ phone: { $in: contacts } }).select(
        "displayName randomNumber isVisible bio avatarUrl createdAt phone"
      );

      return res.json({
        success: true,
        profiles: matchedProfiles.map(formatProfile),
      });
    } catch (err) {
      console.error("getProfilesFromContacts error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
];
