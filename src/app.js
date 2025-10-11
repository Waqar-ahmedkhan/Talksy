import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import path from "path";
import { fileURLToPath } from "url";

// Routes
import authRoutes from "./routes/auth.routes.js";
import profileRoutes from "./routes/profiles.routes.js";
import userRoutes from "./routes/user.routes.js";
import uploadRoutes from "./routes/upload.routes.js";

dotenv.config();

const app = express();

// Middleware
// Note: Avoid parsing multipart/form-data with express.json() or express.urlencoded()
// Only apply these for non-multipart routes
app.use((req, res, next) => {
  // Log request details for debugging
  if (req.path.startsWith("/api/upload")) {
    console.log(`Upload request: ${req.method} ${req.path} ${JSON.stringify(req.headers)}`);
  }
  next();
});

app.use(cors({ origin: "*" }));

// Apply JSON and URL-encoded parsing only for non-multipart routes
app.use((req, res, next) => {
  if (req.is("multipart/form-data")) {
    // Skip JSON and URL-encoded parsing for multipart requests
    next();
  } else {
    express.json()(req, res, () => {
      express.urlencoded({ extended: true })(req, res, next);
    });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files (like HTML, CSS, JS) from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Connect to MongoDB
connectDB();

// Mount API routers
app.use("/api/auth", authRoutes);
app.use("/api/profiles", profileRoutes);
app.use("/api/users", userRoutes);
app.use("/api/upload", uploadRoutes);

// Global error handling for uncaught Multer errors
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.log("Global Multer error:", err, "Field names:", Object.keys(req.files || {}));
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        error: "Unexpected field name. Use 'file' for /api/upload or 'files' for /api/upload-multiple.",
      });
    }
    return res.status(400).json({ error: err.message });
  }
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
