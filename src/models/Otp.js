// models/Otp.js
import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true, // removes extra spaces
    },
    otp: {
      type: String,
      required: true,
    },
    expiry: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 5 * 60 * 1000), // default 5 minutes expiry
    },
    attempts: {
      type: Number,
      default: 0, // optional: track number of verification attempts
    },
  },
  {
    timestamps: true, // createdAt & updatedAt
  }
);

// Optional: check if OTP is expired
otpSchema.methods.isExpired = function () {
  return new Date() > this.expiry;
};

export default mongoose.model("Otp", otpSchema);
