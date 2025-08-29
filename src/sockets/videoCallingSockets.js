import { Server } from "socket.io";
import { mongoose } from "../config/db.js"; // Import Mongoose instance
import User from "../models/User.js";
import Block from "../models/Block.js";

/**
 * Initializes the Video Calling Socket with WebRTC signaling support.
 * Features:
 * - Real-time online user tracking with database sync
 * - Call initiation with offer
 * - Incoming call ringing
 * - Accept/Reject call
 * - ICE candidate exchange
 * - Busy/offline/user blocked checks
 * - End call & disconnect cleanup
 * - Room-based signaling for active calls
 */
export const initVideoSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/video-socket",
  });

  const onlineUsers = new Map(); // userId -> socketId
  const busyUsers = new Set();   // userIds currently in any call (audio or video)
  const pendingCalls = new Map(); // calleeId -> { callerId, type ('audio' | 'video'), offer }

  // Broadcast online users list to all clients
  const broadcastOnlineUsers = () => {
    const onlineUsersArray = Array.from(onlineUsers.keys());
    io.emit("online_users", onlineUsersArray);
    console.log("Broadcasted online users at", new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }), ":", onlineUsersArray);
  };

  io.on("connection", (socket) => {
    console.log("User connected to video socket:", socket.id, "at", new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));

    /** User joins video socket (updates presence in database) */
    socket.on("join", async (userId) => {
      if (!userId) {
        console.log("Invalid userId, disconnecting socket:", socket.id);
        return socket.disconnect();
      }

      const userIdStr = userId.toString();
      onlineUsers.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      // Update user online status in database
      await User.findOneAndUpdate({ phone: userIdStr }, { online: true, lastSeen: new Date() }, { upsert: true });
      console.log(`User ${userIdStr} joined video socket and marked online`);
      broadcastOnlineUsers();
    });

    /** Request initial online users list */
    socket.on("request_online_users", () => {
      broadcastOnlineUsers();
    });

    /**
     * Initiate a video call
     * Payload: { callerId, calleeId, offer, callType ('video') }
     */
    socket.on("call_user", async ({ callerId, calleeId, offer, callType = "video" }) => {
      try {
        const caller = callerId.toString();
        const callee = calleeId.toString();

        console.log(`Call attempt: ${caller} → ${callee} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));

        // Prevent self-call
        if (caller === callee) {
          console.log("Self-call attempt detected");
          return socket.emit("call_error", { error: "You cannot call yourself" });
        }

        // Check if callee is online
        if (!onlineUsers.has(callee)) {
          console.log(`Callee ${callee} is offline`);
          return socket.emit("call_error", { error: "User is offline" });
        }

        // Check if users are blocked
        const blocked = await Block.findOne({
          $or: [
            { blockerId: callee, blockedId: caller },
            { blockerId: caller, blockedId: callee },
          ],
        });
        if (blocked) {
          console.log(`Call blocked: ${caller} → ${callee}`);
          return socket.emit("call_error", { error: "Cannot call: User is blocked" });
        }

        // Check if callee is busy
        if (busyUsers.has(callee) || pendingCalls.has(callee)) {
          console.log(`Callee ${callee} is busy or has a pending call`);
          return socket.emit("user_busy", { calleeId: callee });
        }

        // Store pending call
        pendingCalls.set(callee, { callerId: caller, offer, callType });
        console.log(`Pending call stored: ${caller} → ${callee}`);

        const calleeSocket = onlineUsers.get(callee);
        if (calleeSocket) {
          io.to(calleeSocket).emit("incoming_call", {
            callerId: caller,
            offer,
            callType,
          });
          console.log(`Incoming call sent to ${callee} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
        } else {
          console.warn(`Callee socket not found for ${callee}`);
        }

        socket.emit("calling", { calleeId: callee, callType });
        console.log(`Call initiated: ${caller} → ${callee} [${callType}]`);
      } catch (err) {
        console.error("call_user error:", err);
        socket.emit("call_error", { error: "Failed to initiate video call" });
      }
    });

    /**
     * Accept incoming video call
     * Payload: { callerId, calleeId, answer }
     */
    socket.on("accept_call", ({ callerId, calleeId, answer }) => {
      const caller = callerId.toString();
      const callee = calleeId.toString();

      const pending = pendingCalls.get(callee);
      if (!pending || pending.callerId !== caller) {
        console.log(`No valid pending call for ${callee} from ${caller}`);
        return socket.emit("call_error", { error: "No pending call to accept" });
      }

      const { offer, callType } = pending;
      pendingCalls.delete(callee);
      console.log(`Pending call removed: ${caller} → ${callee}`);

      // Mark both users as busy
      busyUsers.add(caller);
      busyUsers.add(callee);
      console.log(`Users marked busy: ${caller}, ${callee}`);

      const callerSocket = onlineUsers.get(caller);
      if (callerSocket) {
        io.to(callerSocket).emit("call_accepted", {
          answer,
          calleeId: callee,
          callType,
        });
        console.log(`Call accepted sent to ${caller} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
      }

      // Create a unique room for this call
      const callRoom = [caller, callee].sort().join("-");
      socket.join(callRoom); // Callee joins room

      if (callerSocket) {
        io.to(callerSocket).emit("join_call_room", { room: callRoom });
        console.log(`Caller ${caller} joined room ${callRoom}`);
      }

      console.log(`Call accepted: ${caller} ↔ ${callee} [${callType}]`);
    });

    /**
     * Reject incoming video call
     * Payload: { callerId, calleeId }
     */
    socket.on("reject_call", ({ callerId, calleeId }) => {
      const caller = callerId.toString();
      const callee = calleeId.toString();

      const pending = pendingCalls.get(callee);
      if (!pending || pending.callerId !== caller) {
        console.log(`No valid pending call to reject for ${callee}`);
        return socket.emit("call_error", { error: "No pending call to reject" });
      }

      pendingCalls.delete(callee);
      console.log(`Pending call rejected: ${caller} → ${callee}`);

      const callerSocket = onlineUsers.get(caller);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", { calleeId, reason: "rejected" });
        console.log(`Rejection sent to ${caller} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
      }
    });

    /**
     * Relay ICE candidates between peers
     * Payload: { candidate, toUserId }
     */
    socket.on("ice_candidate", ({ candidate, toUserId }) => {
      const targetSocket = onlineUsers.get(toUserId);
      if (targetSocket) {
        io.to(targetSocket).emit("ice_candidate", { candidate });
        console.log(`ICE candidate sent to ${toUserId} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
      } else {
        console.warn(`Target socket not found for ${toUserId}`);
      }
    });

    /**
     * End the video call
     * Payload: { userId, peerId }
     */
    socket.on("end_call", ({ userId, peerId }) => {
      const user = userId.toString();
      const peer = peerId.toString();

      busyUsers.delete(user);
      busyUsers.delete(peer);
      console.log(`Users unmarked busy: ${user}, ${peer} at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));

      const peerSocket = onlineUsers.get(peer);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { fromUserId: user });
        console.log(`Call ended notification sent to ${peer}`);
      }

      // Leave call room
      const callRoom = [user, peer].sort().join("-");
      socket.leave(callRoom);
      console.log(`User ${user} left room ${callRoom}`);
    });

    /**
     * Handle user disconnect
     */
    socket.on("disconnect", async () => {
      const disconnectedUserId = Array.from(onlineUsers.entries())
        .find(([_, socketId]) => socketId === socket.id)?.[0];

      if (!disconnectedUserId) {
        console.log("Unknown socket disconnected:", socket.id, "at", new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
        return;
      }

      console.log("User disconnected from video socket:", disconnectedUserId);

      // Clean up presence
      onlineUsers.delete(disconnectedUserId);
      busyUsers.delete(disconnectedUserId);

      // Update user offline status in database
      await User.findOneAndUpdate({ phone: disconnectedUserId }, { online: false, lastSeen: new Date() });

      // Notify if user was receiving a call
      if (pendingCalls.has(disconnectedUserId)) {
        const { callerId } = pendingCalls.get(disconnectedUserId);
        pendingCalls.delete(disconnectedUserId);

        const callerSocket = onlineUsers.get(callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { calleeId: disconnectedUserId, reason: "offline" });
          console.log(`Call ended due to ${disconnectedUserId} going offline at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
        }
      }

      // Notify peers in active calls
      for (const [userId, sockId] of onlineUsers.entries()) {
        if (busyUsers.has(userId)) {
          const callRoom = [disconnectedUserId, userId].sort().join("-");
          if (io.sockets.adapter.rooms.has(callRoom)) {
            io.to(sockId).emit("call_ended", { fromUserId: disconnectedUserId, reason: "disconnected" });
            console.log(`Notified ${userId} of ${disconnectedUserId}'s disconnect at`, new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" }));
          }
        }
      }

      broadcastOnlineUsers();
    });
  });

  return io;
};
