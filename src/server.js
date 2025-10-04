import http from "http";
import app from "./app.js";
import { initChatSocket } from "./sockets/chattingSockets.js";
import { initVideoSocket } from "./sockets/videoCallingSockets.js";
import { initAudioSocket } from "./sockets/audioCallingSockets.js";
import { initGroupSocket } from "./sockets/initGroupSocket.js"; // ✅ ADDED
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

const chatIo = initChatSocket(server, { path: "/chat-socket" });
const videoIo = initVideoSocket(server);
const audioIo = initAudioSocket(server);
const groupIo = initGroupSocket(server); // ✅ Your group socket uses internal path "/group-socket"

groupIo.on("connection", (socket) => {
  console.log(`👥 New group client connected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  socket.on("disconnect", () => {
    console.log(`❌ Group client disconnected: ${socket.id} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
  });
});

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

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
});
