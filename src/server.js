import http from "http";
import app from "./app.js";
import { initChatSocket } from "./sockets/chattingSockets.js"; // Socket.IO chat module

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO for chat
const io = initChatSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
