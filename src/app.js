// src/app.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import path from 'path';
import { fileURLToPath } from 'url';

// Routes
import authRoutes from "./routes/auth.routes.js";
import profileRoutes from "./routes/profiles.routes.js";
import userRoutes from "./routes/user.routes.js";

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*" }));

// --- Static File Serving Configuration ---
// Get the directory name of the current module (app.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Serve static files (like HTML, CSS, JS) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// --- End Static File Serving ---

// Routes
// Serve the main HTML file (e.g., chat-test.html or index.html) when accessing the root URL
// Express's static middleware will automatically look for index.html inside the 'public' folder
// when you hit the root route '/'. So this GET handler might be redundant if you name your
// HTML file index.html. If you name it something else, like chat-test.html, you might need
// a specific route or rename the file.
// Example: If your file is chat-test.html, visiting http://localhost:5000/chat-test.html will work.
// If it's index.html, visiting http://localhost:5000/ will work automatically.
app.get("/", (req, res) => {
  // Option 1: Let express.static handle it if you have index.html
  // res.sendFile(path.join(__dirname, 'public', 'index.html')); // Use if NOT named index.html
  // Option 2: Redirect to the specific file if it's not index.html
  // res.redirect('/chat-test.html'); // Use if your file is named chat-test.html
  // Option 3: Simple message (like your original, but fixed syntax)
  // res.send("Welcome! Check /chat-test.html"); // Basic message

  // Let's use Option 1 and explicitly send index.html if that's what you'll use:
  // Make sure you have a file named index.html inside the 'public' folder.
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Connect to MongoDB
connectDB();

// Mount API routers
app.use("/api/auth", authRoutes);
app.use("/api/profiles", profileRoutes);
app.use("/api/users", userRoutes);

export default app;
