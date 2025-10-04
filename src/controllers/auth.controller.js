// controllers/auth.controller.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Otp from "../models/Otp.js";
import { generateOtp } from "../utils/otp.js";

dotenv.config();



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

    // ✅ Always return fixed OTP without saving in DB
    return res.json({
      success: true,
      message: "OTP generated successfully",
      phone,
      otp: "123456",
    });
  } catch (err) {
    console.error("requestOtp error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// export const requestOtp = async (req, res) => {
//   try {
//     const { phone } = req.body;

//     // Strict validation for Pakistan phone numbers
//     const phoneRegex = /^\+92[0-9]{10}$/;
//     if (!phone || !phoneRegex.test(phone)) {
//       return res.status(400).json({
//         success: false,
//         error: "Valid Pakistan phone number is required (e.g., +923001234567)",
//       });
//     }

//     // ✅ Always use fixed OTP
//     const otp = "123456";

//     // Expiry: 2 minutes (optional)
//     const expiry = new Date(Date.now() + 2 * 60 * 1000);

//     // Save or update OTP in DB
//     await Otp.findOneAndUpdate(
//       { phone },
//       { otp, expiry },
//       { upsert: true, new: true }
//     );

//     return res.json({
//       success: true,
//       message: "OTP generated successfully",
//       phone,
//       otp, // ✅ always return 123456
//     });
//   } catch (err) {
//     console.error("requestOtp error:", err);
//     return res.status(500).json({ success: false, error: "Server error" });
//   }
// };

/**
 * Request OTP
 * 
 * 
 * 
 */
// export const requestOtp = async (req, res) => {
//   try {
//     const { phone } = req.body;

//     // Strict validation for Pakistan phone numbers
//     const phoneRegex = /^\+92[0-9]{10}$/;
//     if (!phone || !phoneRegex.test(phone)) {
//       return res.status(400).json({
//         success: false,
//         error: "Valid Pakistan phone number is required (e.g., +923001234567)",
//       });
//     }

//     // Check if OTP was requested too frequently (rate limiting)
//     const existingOtp = await Otp.findOne({ phone });
//     if (
//       existingOtp &&
//       new Date() - new Date(existingOtp.updatedAt) < 60 * 1000
//     ) {
//       return res.status(429).json({
//         success: false,
//         message:
//           "OTP already sent recently. Please wait a minute before retrying.",
//       });
//     }

//     // Generate OTP
//     const env = process.env.NODE_ENV || "development";
//     const otp = env === "development" ? "123456" : generateOtp();
//     const expiry = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000);
//     // ≈ 3 months (90 days from now)
//     // 2 minutes expiry

//     // Save or update OTP
//     await Otp.findOneAndUpdate(
//       { phone },
//       { otp, expiry },
//       { upsert: true, new: true }
//     );

//     return res.json({
//       success: true,
//       message: "OTP generated successfully",
//       phone,
//       otp: env === "development" ? otp : "******", // hide in production
//     });
//   } catch (err) {
//     console.error("requestOtp error:", err);
//     return res.status(500).json({ success: false, error: "Server error" });
//   }
// };

/**
 * Verify OTP & Issue JWT Token
 */
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    // Strict validation
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

    // ✅ Always accept 123456
    if (otp !== "123456") {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Check JWT_SECRET
    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET not defined!");
      return res
        .status(500)
        .json({ success: false, error: "Server configuration error" });
    }

    // Generate JWT token
    const token = jwt.sign({ phone }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    return res.json({
      success: true,
      message: "OTP verified successfully",
      token,
    });
  } catch (err) {
    console.error("verifyOtp error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};