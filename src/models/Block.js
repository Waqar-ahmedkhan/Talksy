import mongoose from "mongoose";

const blockSchema = new mongoose.Schema({
  blockerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Profile",
    required: true,
  },
  blockedId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Profile",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
}, {
  indexes: [
    { key: { blockerId: 1, blockedId: 1 }, unique: true }, // Prevent duplicate blocks
  ],
});

export default mongoose.model("Block", blockSchema);