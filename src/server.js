// src/server.js
import http from "http";
import app from "./app.js";
import { initChatSocket } from "./sockets/chattingSockets.js";
import { initVideoSocket } from "./sockets/videoCallingSockets.js";
import { initAudioSocket } from "./sockets/audioCallingSockets.js";
import { initGroupSocket } from "./sockets/initGroupSocket.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// ✅ Initialize all Socket.IO instances
const chatIo = initChatSocket(server);
const videoIo = initVideoSocket(server);
const audioIo = initAudioSocket(server);
const groupIo = initGroupSocket(server); // ✅ Do NOT pass options here — path is set inside


// ✅ Optional: Log connections for OTHER sockets (chat, video, audio)
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

// ✅ Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
});