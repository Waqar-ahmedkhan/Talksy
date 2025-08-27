import mongoose from "mongoose";

const chatSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["text", "voice"], default: "text" },
  content: { type: String, required: true }, // Text message or voice URL
  duration: { type: Number, default: 0 }, // For voice, in seconds
  status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // Array of userIds who deleted it
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Chat", chatSchema);