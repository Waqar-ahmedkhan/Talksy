import mongoose from "mongoose";

const profileSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  randomNumber: { type: String, required: true },
  isVisible: { type: Boolean, default: false },
  isNumberVisible: { type: Boolean, default: false },
  avatar: { type: Buffer, default: null }, // store image as binary
  avatarContentType: { type: String, default: null }, // MIME type (image/png, image/jpeg)
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Profile", profileSchema);
