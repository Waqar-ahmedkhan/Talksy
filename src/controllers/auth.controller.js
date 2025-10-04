// controllers/auth.controller.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Otp from "../models/Otp.js";
import { generateOtp } from "../utils/otp.js";

dotenv.config();

/**
 * Request OTP
 * Generates a fixed OTP ("123456") for production/testing and saves it to DB.
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

    // Always use fixed OTP for production/testing
    const otp = "123456";
    const expiry = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry, matching schema default

    // Save or update OTP in DB (upsert)
    await Otp.findOneAndUpdate(
      { phone },
      { otp, expiry, attempts: 0 }, // Reset attempts on new request
      { upsert: true, new: true }
    );

    // Optional: Hide OTP in production response
    const responseOtp = process.env.NODE_ENV === "production" ? "******" : otp;

    return res.json({
      success: true,
      message: "OTP generated successfully",
      phone,
      otp: responseOtp,
    });
  } catch (err) {
    console.error("requestOtp error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/**
 * Verify OTP & Issue JWT Token
 * Fetches from DB, validates, checks expiry/attempts, and generates token on success.
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

    // Fetch OTP from DB
    const storedOtp = await Otp.findOne({ phone });
    if (!storedOtp) {
      return res.status(400).json({ success: false, message: "No OTP found. Please request a new one." });
    }

    // Check if expired
    if (storedOtp.isExpired()) {
      // Optional: Delete expired OTP
      await Otp.findOneAndDelete({ phone });
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }

    // Normalize input OTP (handles number vs string + whitespace)
    const normalizedOtp = String(otp).trim();

    // Check match (storedOtp.otp is already a string from schema)
    if (normalizedOtp !== storedOtp.otp) {
      // Increment attempts on failure
      storedOtp.attempts += 1;
      await storedOtp.save();

      // Optional: Lock after 3 attempts
      if (storedOtp.attempts >= 3) {
        await Otp.findOneAndDelete({ phone });
        return res.status(400).json({ success: false, message: "Too many attempts. Please request a new OTP." });
      }

      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Success: Generate JWT
    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET not defined!");
      return res
        .status(500)
        .json({ success: false, error: "Server configuration error" });
    }

    const token = jwt.sign({ phone }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    // Optional: Delete OTP after successful verification (prevents reuse)
    // await Otp.findOneAndDelete({ phone });

    return res.json({
      success: true,
      message: "OTP verified successfully",
      token,
      phone, // Optional: Echo back for client
    });
  } catch (err) {
    console.error("verifyOtp error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};






























// // controllers/auth.controller.js
// import jwt from "jsonwebtoken";
// import dotenv from "dotenv";
// import Otp from "../models/Otp.js";
// import { generateOtp } from "../utils/otp.js";

// dotenv.config();



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

//     // ✅ Always return fixed OTP without saving in DB
//     return res.json({
//       success: true,
//       message: "OTP generated successfully",
//       phone,
//       otp: "123456",
//     });
//   } catch (err) {
//     console.error("requestOtp error:", err);
//     return res.status(500).json({ success: false, error: "Server error" });
//   }
// };

// // export const requestOtp = async (req, res) => {
// //   try {
// //     const { phone } = req.body;

// //     // Strict validation for Pakistan phone numbers
// //     const phoneRegex = /^\+92[0-9]{10}$/;
// //     if (!phone || !phoneRegex.test(phone)) {
// //       return res.status(400).json({
// //         success: false,
// //         error: "Valid Pakistan phone number is required (e.g., +923001234567)",
// //       });
// //     }

// //     // ✅ Always use fixed OTP
// //     const otp = "123456";

// //     // Expiry: 2 minutes (optional)
// //     const expiry = new Date(Date.now() + 2 * 60 * 1000);

// //     // Save or update OTP in DB
// //     await Otp.findOneAndUpdate(
// //       { phone },
// //       { otp, expiry },
// //       { upsert: true, new: true }
// //     );

// //     return res.json({
// //       success: true,
// //       message: "OTP generated successfully",
// //       phone,
// //       otp, // ✅ always return 123456
// //     });
// //   } catch (err) {
// //     console.error("requestOtp error:", err);
// //     return res.status(500).json({ success: false, error: "Server error" });
// //   }
// // };

// /**
//  * Request OTP
//  * 
//  * 
//  * 
//  */
// // export const requestOtp = async (req, res) => {
// //   try {
// //     const { phone } = req.body;

// //     // Strict validation for Pakistan phone numbers
// //     const phoneRegex = /^\+92[0-9]{10}$/;
// //     if (!phone || !phoneRegex.test(phone)) {
// //       return res.status(400).json({
// //         success: false,
// //         error: "Valid Pakistan phone number is required (e.g., +923001234567)",
// //       });
// //     }

// //     // Check if OTP was requested too frequently (rate limiting)
// //     const existingOtp = await Otp.findOne({ phone });
// //     if (
// //       existingOtp &&
// //       new Date() - new Date(existingOtp.updatedAt) < 60 * 1000
// //     ) {
// //       return res.status(429).json({
// //         success: false,
// //         message:
// //           "OTP already sent recently. Please wait a minute before retrying.",
// //       });
// //     }

// //     // Generate OTP
// //     const env = process.env.NODE_ENV || "development";
// //     const otp = env === "development" ? "123456" : generateOtp();
// //     const expiry = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000);
// //     // ≈ 3 months (90 days from now)
// //     // 2 minutes expiry

// //     // Save or update OTP
// //     await Otp.findOneAndUpdate(
// //       { phone },
// //       { otp, expiry },
// //       { upsert: true, new: true }
// //     );

// //     return res.json({
// //       success: true,
// //       message: "OTP generated successfully",
// //       phone,
// //       otp: env === "development" ? otp : "******", // hide in production
// //     });
// //   } catch (err) {
// //     console.error("requestOtp error:", err);
// //     return res.status(500).json({ success: false, error: "Server error" });
// //   }
// // };

// /**
//  * Verify OTP & Issue JWT Token
//  */
// export const verifyOtp = async (req, res) => {
//   try {
//     const { phone, otp } = req.body;

//     // Strict validation
//     const phoneRegex = /^\+92[0-9]{10}$/;
//     if (!phone || !phoneRegex.test(phone)) {
//       return res.status(400).json({
//         success: false,
//         error: "Valid Pakistan phone number is required (e.g., +923001234567)",
//       });
//     }
//     if (!otp) {
//       return res.status(400).json({ success: false, error: "OTP is required" });
//     }

//     // ✅ Always accept 123456
//     if (otp !== "123456") {
//       return res.status(400).json({ success: false, message: "Invalid OTP" });
//     }

//     // Check JWT_SECRET
//     if (!process.env.JWT_SECRET) {
//       console.error("JWT_SECRET not defined!");
//       return res
//         .status(500)
//         .json({ success: false, error: "Server configuration error" });
//     }

//     // Generate JWT token
//     const token = jwt.sign({ phone }, process.env.JWT_SECRET, {
//       expiresIn: "1h",
//     });

//     return res.json({
//       success: true,
//       message: "OTP verified successfully",
//       token,
//     });
//   } catch (err) {
//     console.error("verifyOtp error:", err);
//     return res.status(500).json({ success: false, error: "Server error" });
//   }
// };