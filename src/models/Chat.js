import mongoose from "mongoose";

const chatSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: "Channel" }, // For channel messages
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group" },     // For group messages
  type: { type: String, enum: ["text", "voice", "video"], default: "text" },
  content: { type: String, required: true }, 
  duration: { type: Number, default: 0 }, // for voice/video
  status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], 
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Chat", chatSchema);
