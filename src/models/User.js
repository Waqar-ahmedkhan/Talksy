import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  musicUrl: { type: String, default: null } // URL to profile music
});

export default mongoose.model("User", userSchema);
