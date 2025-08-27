import mongoose from "mongoose";

const profileSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  randomNumber: { type: String, required: true },
  isVisible: { type: Boolean, default: false },
  isNumberVisible: { type: Boolean, default: false },
  avatarUrl: { type: String, default: "" },  // for controller compatibility
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Profile", profileSchema);
