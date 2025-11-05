// models/Contact.js
import mongoose from "mongoose";
import { normalizePhoneNumber } from "../controllers/profile.controller.js"; // <-- add this import

const contactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    customName: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ---- NEW: normalize phone before every save ----
contactSchema.pre("save", function (next) {
  if (this.isModified("phone")) {
    const normalized = normalizePhoneNumber(this.phone);
    if (!normalized) {
      return next(new Error("Invalid phone number"));
    }
    this.phone = normalized;
  }
  next();
});

// Ensure one contact per phone per user
contactSchema.index({ userId: 1, phone: 1 }, { unique: true });

export default mongoose.model("Contact", contactSchema);
