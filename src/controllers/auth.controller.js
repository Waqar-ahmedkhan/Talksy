// controllers/auth.controller.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Otp from "../models/Otp.js";
import { generateOtp } from "../utils/otp.js";

dotenv.config();

/**
 * Request OTP
 */
export const requestOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    // Strict validation for Pakistan phone numbers
    const phoneRegex = /^\+92[0-9]{10}$/;
    if (!phone || !phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: "Valid Pakistan phone number is required (e.g., +923001234567)",
      });
    }

    // Check if OTP was requested too frequently (rate limiting)
    const existingOtp = await Otp.findOne({ phone });
    if (
      existingOtp &&
      new Date() - new Date(existingOtp.updatedAt) < 60 * 1000
    ) {
      return res.status(429).json({
        success: false,
        message:
          "OTP already sent recently. Please wait a minute before retrying.",
      });
    }

    // Generate OTP
    const env = process.env.NODE_ENV || "development";
    const otp = env === "development" ? "123456" : generateOtp();
    const expiry = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000);
    // ≈ 3 months (90 days from now)
    // 2 minutes expiry

    // Save or update OTP
    await Otp.findOneAndUpdate(
      { phone },
      { otp, expiry },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      message: "OTP generated successfully",
      phone,
      otp: env === "development" ? otp : "******", // hide in production
    });
  } catch (err) {
    console.error("requestOtp error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/**
 * Verify OTP & Issue JWT Token
 */
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    const phoneRegex = /^\+92[0-9]{10}$/;
    if (!phone || !phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: "Valid Pakistan phone number is required (e.g., +923001234567)",
      });
    }
    if (!otp) {
      return res.status(400).json({ success: false, error: "OTP is required" });
    }

    const record = await Otp.findOne({ phone });
    if (!record) {
      return res.status(404).json({ success: false, message: "No OTP found" });
    }

    const { otp: storedOtp, expiry } = record;
    if (Date.now() > new Date(expiry).getTime()) {
      await Otp.deleteOne({ phone });
      return res.status(400).json({ success: false, message: "OTP expired" });
    }

    const env = process.env.NODE_ENV || "development";
    const isValidOtp =
      env === "development"
        ? otp === "123456" || otp === storedOtp
        : otp === storedOtp;

    if (!isValidOtp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // ✅ THIS IS THE FIX: Create user if not exists
    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone }); // displayName is optional → safe
      await user.save();
    }

    await Otp.deleteOne({ phone });

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET not defined!");
      return res.status(500).json({ success: false, error: "Server configuration error" });
    }

    const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: "30d" });

    return res.json({
      success: true,
      message: "OTP verified successfully",
      token,
    });
  } catch (err) {
    console.error("🔥 verifyOtp error:", err);
    // Log validation errors
    if (err.name === "ValidationError") {
      console.error("Validation failed:", err.errors);
    }
    return res.status(500).json({ success: false, error: "Server error" });
  }
};