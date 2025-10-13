import mongoose from "mongoose";

const chatSchema = new mongoose.Schema({
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Profile",
    required: true,
  },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile" }, // For 1-to-1 chats
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: "Channel" }, // For channel messages
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group" }, // For group messages
  type: {
    type: String,
    enum: ["text", "voice", "video", "file", "image", "location"],
    default: "text",
  },
  content: { type: String, required: true }, // Text, URL, or JSON string for location
  fileType: { type: String }, // MIME type (e.g., "image/jpeg", "video/mp4", "application/pdf")
  fileName: { type: String }, // For document names (e.g., "report.pdf")
  location: {
    latitude: { type: Number },
    longitude: { type: Number },
    name: { type: String }, // Optional place name
  },
  duration: { type: Number, default: 0 }, // For voice/video duration
  status: {
    type: String,
    enum: ["sent", "delivered", "read"],
    default: "sent",
  },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "Profile" }],
  pinned: { type: Boolean, default: false },
  forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "Chat" }, // Reference to original message
  createdAt: { type: Date, default: Date.now },
});

// Add indexes for performance
chatSchema.index({ senderId: 1 });
chatSchema.index({ receiverId: 1 });
chatSchema.index({ channelId: 1 });
chatSchema.index({ groupId: 1 });
chatSchema.index({ createdAt: 1 });

export default mongoose.model("Chat", chatSchema);