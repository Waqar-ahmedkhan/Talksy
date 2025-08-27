import http from "http";
import app from "./app.js";
import { initChatSocket } from "./sockets/chattingSockets.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 5000;

// Create HTTP server using Express app
const server = http.createServer(app);

// Initialize Socket.IO (real-time chat)
const io = initChatSocket(server);

// Log socket events for debugging
io.on("connection", (socket) => {
  console.log(`⚡ New client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
