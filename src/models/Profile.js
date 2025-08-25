// models/Profile.js
import mongoose from "mongoose";

const profileSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true, // remove leading/trailing spaces
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    randomNumber: {
      type: Number,
      required: true,
      unique: true, // ensures no duplicates
    },
    isVisible: {
      type: Boolean,
      default: false, // false = private, true = public
    },
    bio: {
      type: String,
      default: "", // optional user bio
      trim: true,
    },
    avatarUrl: {
      type: String,
      default: "", // optional profile picture URL
    },
  },
  {
    timestamps: true, // adds createdAt & updatedAt
  }
);

// Optional: add a virtual field for full info
profileSchema.virtual("info").get(function () {
  return {
    displayName: this.displayName,
    phone: this.phone,
    isVisible: this.isVisible,
    bio: this.bio,
    avatarUrl: this.avatarUrl,
  };
});

// Optional: customize JSON output
profileSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    delete ret._id; // remove MongoDB _id if you want
  },
});

export default mongoose.model("Profile", profileSchema);
