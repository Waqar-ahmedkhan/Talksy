import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import profileRoutes from "./routes/profile.routes.js";

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // parses form data
app.use(cors());

// Connect to MongoDB
connectDB();

// Routes
app.use("/api", profileRoutes);

export default app;
