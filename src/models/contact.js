// models/Contact.js
import mongoose from "mongoose";

const contactSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  phone: { 
    type: String, 
    required: true,
    trim: true
  },
  customName: { 
    type: String, 
    trim: true,
    default: null 
  },
}, {
  timestamps: true
});

// Ensure one contact per phone per user
contactSchema.index({ userId: 1, phone: 1 }, { unique: true });

export default mongoose.model("Contact", contactSchema);