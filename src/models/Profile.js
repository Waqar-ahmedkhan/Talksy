import mongoose from "mongoose";
import { normalizePhoneNumber } from "../utils/phone.js";

const profileSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
    set: normalizePhoneNumber,
  },
  displayName: { type: String, required: true },
  randomNumber: String,
  isVisible: { type: Boolean, default: false },
  isNumberVisible: { type: Boolean, default: false },
  avatarUrl: String,
}, { timestamps: true });

export default mongoose.model("Profile", profileSchema);