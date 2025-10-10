import mongoose from "mongoose";
import { normalizePhoneNumber } from "../utils/phone.js";

const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  phone: {
    type: String,
    required: true,
    set: normalizePhoneNumber,
  },
  customName: { type: String, required: true },
}, { timestamps: true });

// Ensure unique contact per user per phone
contactSchema.index({ userId: 1, phone: 1 }, { unique: true });

export default mongoose.model("Contact", contactSchema);