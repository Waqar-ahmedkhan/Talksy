import mongoose from "mongoose";

const blockSchema = new mongoose.Schema({
  blockerId: String,
  blockedId: String
}, { timestamps: true });

export default mongoose.model("Block", blockSchema);
