// sockets/videoCallingSockets.js

import { Server } from "socket.io";
import User from "../models/User.js";
import Block from "../models/Block.js";

/**
 * Initializes the Video Calling Socket with WebRTC signaling support.
 * Features:
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
  const busyUsers = new Set(); // userIds currently in any call (audio or video)
  const pendingCalls = new Map(); // calleeId -> { callerId, type ('audio' | 'video'), offer }

  io.on("connection", (socket) => {
    console.log("User connected to video socket:", socket.id);

    /** User joins video socket (for presence in video calling system) */
    socket.on("join", async (userId) => {
      onlineUsers.set(userId, socket.id);
      console.log(`User ${userId} joined video socket`);
    });

    /**
     * Initiate a video call
     * Payload: { callerId, calleeId, offer, callType ('video') }
     */
    socket.on("call_user", async ({ callerId, calleeId, offer, callType = "video" }) => {
      try {
        // Prevent self-call
        if (callerId === calleeId) {
          return socket.emit("call_error", { error: "You cannot call yourself" });
        }

        // Check if users are blocked
        const blocked = await Block.findOne({
          $or: [
            { blockerId: calleeId, blockedId: callerId },
            { blockerId: callerId, blockedId: calleeId },
          ],
        });
        if (blocked) {
          return socket.emit("call_error", { error: "Cannot call: User is blocked" });
        }

        // Check if callee is online
        if (!onlineUsers.has(calleeId)) {
          return socket.emit("call_error", { error: "User is offline" });
        }

        // Check if callee is already in a call
        if (busyUsers.has(calleeId)) {
          return socket.emit("user_busy", { calleeId });
        }

        // Prevent multiple incoming calls
        if (pendingCalls.has(calleeId)) {
          return socket.emit("user_busy", { calleeId });
        }

        // Store pending call
        pendingCalls.set(calleeId, { callerId, offer, callType });

        const calleeSocket = onlineUsers.get(calleeId);
        if (calleeSocket) {
          io.to(calleeSocket).emit("incoming_call", {
            callerId,
            offer,
            callType, // Tells client it's a video call
          });
        }

        socket.emit("calling", { calleeId, callType }); // Notify caller
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
      const pending = pendingCalls.get(calleeId);
      if (!pending || pending.callerId !== callerId) {
        return socket.emit("call_error", { error: "No pending call to accept" });
      }

      const { offer, callType } = pending;
      pendingCalls.delete(calleeId);

      // Mark both users as busy
      busyUsers.add(callerId);
      busyUsers.add(calleeId);

      const callerSocket = onlineUsers.get(callerId);
      if (callerSocket) {
        io.to(callerSocket).emit("call_accepted", {
          answer,
          calleeId,
          callType,
        });
      }

      // Create a unique room for this call (caller + callee sorted)
      const callRoom = [callerId, calleeId].sort().join("-");
      socket.join(callRoom); // Callee joins room

      if (callerSocket) {
        io.to(callerSocket).emit("join_call_room", { room: callRoom });
      }

      console.log(`Call accepted: ${callerId} ↔ ${calleeId} [${callType}]`);
    });

    /**
     * Reject incoming video call
     * Payload: { callerId, calleeId }
     */
    socket.on("reject_call", ({ callerId, calleeId }) => {
      const pending = pendingCalls.get(calleeId);
      if (!pending || pending.callerId !== callerId) {
        return socket.emit("call_error", { error: "No pending call to reject" });
      }

      pendingCalls.delete(calleeId);

      const callerSocket = onlineUsers.get(callerId);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", { calleeId, reason: "rejected" });
      }

      console.log(`Call rejected: ${callerId} → ${calleeId}`);
    });

    /**
     * Send busy response (optional if user manually taps "busy")
     */
    socket.on("send_busy", ({ callerId, calleeId }) => {
      const callerSocket = onlineUsers.get(callerId);
      if (callerSocket) {
        io.to(callerSocket).emit("user_busy", { calleeId });
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
      }
    });

    /**
     * End the video call
     * Payload: { userId, peerId }
     */
    socket.on("end_call", ({ userId, peerId }) => {
      // Remove from busy set
      busyUsers.delete(userId);
      busyUsers.delete(peerId);

      const peerSocket = onlineUsers.get(peerId);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { fromUserId: userId });
      }

      // Leave call room
      const callRoom = [userId, peerId].sort().join("-");
      socket.leave(callRoom);

      console.log(`Call ended: ${userId} ↔ ${peerId}`);
    });

    /**
     * Handle user disconnect
     */
    socket.on("disconnect", () => {
      let disconnectedUserId = null;

      // Find user by socket ID
      for (const [userId, socketId] of onlineUsers.entries()) {
        if (socketId === socket.id) {
          disconnectedUserId = userId;
          break;
        }
      }

      if (!disconnectedUserId) {
        console.log("Unknown socket disconnected:", socket.id);
        return;
      }

      console.log("User disconnected from video socket:", disconnectedUserId);

      // Clean up presence
      onlineUsers.delete(disconnectedUserId);
      busyUsers.delete(disconnectedUserId);

      // If user was receiving a call, notify caller
      if (pendingCalls.has(disconnectedUserId)) {
        const { callerId } = pendingCalls.get(disconnectedUserId);
        pendingCalls.delete(disconnectedUserId);

        const callerSocket = onlineUsers.get(callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { calleeId: disconnectedUserId, reason: "offline" });
        }
      }

      // If user was in an active call, notify peer
      // (We assume peer will detect disconnection via WebRTC, but send signal)
      for (const [userId, sockId] of onlineUsers.entries()) {
        if (busyUsers.has(userId)) {
          const callRoom = [disconnectedUserId, userId].sort().join("-");
          if (socket.rooms.has(callRoom)) {
            io.to(sockId).emit("call_ended", { fromUserId: disconnectedUserId, reason: "disconnected" });
          }
        }
      }
    });
  });

  return io;
};