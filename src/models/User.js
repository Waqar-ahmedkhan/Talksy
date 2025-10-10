import mongoose from "mongoose";
import { normalizePhoneNumber } from "../utils/phone.js";

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
    set: normalizePhoneNumber, // Auto-normalize on save
  },
  displayName: String,
  online: { type: Boolean, default: false },
  lastSeen: Date,
  musicUrl: String,
}, { timestamps: true });

export default mongoose.model("User", userSchema);