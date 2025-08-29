// db.js
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: process.env.DB_NAME || "otpAuth",
    });
    console.log("✅ MongoDB Connected...");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

export { mongoose };       // ✅ Export mongoose
export default connectDB;  // ✅ Export connection function
