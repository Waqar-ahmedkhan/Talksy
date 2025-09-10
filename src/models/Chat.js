import mongoose from "mongoose";

   const chatSchema = new mongoose.Schema({
     senderId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true },
     receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile" }, // For 1-to-1 chats
     channelId: { type: mongoose.Schema.Types.ObjectId, ref: "Channel" }, // For channel messages
     groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group" }, // For group messages
     type: { type: String, enum: ["text", "voice", "video"], default: "text" },
     content: { type: String, required: true },
     duration: { type: Number, default: 0 }, // For voice/video duration
     status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
     deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "Profile" }],
     pinned: { type: Boolean, default: false }, // Support pinned chats
     createdAt: { type: Date, default: Date.now },
   });

   export default mongoose.model("Chat", chatSchema);