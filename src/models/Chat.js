import mongoose from "mongoose";

const chatSchema = new mongoose.Schema({
  senderId: String,
  receiverId: String,
  message: String,
  status: { type: String, enum: ["sent","delivered","read"], default: "sent" },
  deletedFor: { type: [String], default: [] } // userIds who deleted this message
}, { timestamps: true });

export default mongoose.model("Chat", chatSchema);
