import http from "http";
import app from "./app.js";
import { initChatSocket } from "./sockets/chattingSockets.js";
import { initVideoSocket } from "./sockets/videoCallingSockets.js";
import { initAudioSocket } from "./sockets/audioCallingSockets.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// Initialize Socket.IO services with their respective paths
const io = new http.Server(); // Create a base HTTP server for Socket.IO
const chatIo = initChatSocket(server, { path: "/chat-socket" });
const videoIo = initVideoSocket(server, { path: "/video-socket" });
const audioIo = initAudioSocket(server, { path: "/audio-socket" });

// Log socket events for debugging
chatIo.on("connection", (socket) => {
  console.log(`⚡ New chat client connected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  socket.on("disconnect", () => {
    console.log(`❌ Chat client disconnected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  });
});

videoIo.on("connection", (socket) => {
  console.log(`🎥 New video client connected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  socket.on("disconnect", () => {
    console.log(`❌ Video client disconnected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  });
});

audioIo.on("connection", (socket) => {
  console.log(`🎙️ New audio client connected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  socket.on("disconnect", () => {
    console.log(`❌ Audio client disconnected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
});
