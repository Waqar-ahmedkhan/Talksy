// File: sockets/audioCallingSockets.js

import { Server } from "socket.io";
import User from "../models/User.js";
import Block from "../models/Block.js";

export const initAudioSocket = (server) => {
  const io = new Server(server, { cors: { origin: "*" }, path: "/audio-socket" });
  const onlineUsers = new Map(); // userId -> socketId
  const busyUsers = new Set(); // userIds currently in a call
  const pendingCalls = new Map(); // calleeId -> { callerId, offer }

  io.on("connection", (socket) => {
    console.log("User connected to audio socket:", socket.id);

    /** User joins audio socket (for presence in calling system) */
    socket.on("join", async (userId) => {
      onlineUsers.set(userId, socket.id);
      // Note: We don't update User model here to avoid conflicts with chat socket; assume chat handles primary presence.
    });

    /** Initiate audio call (with WebRTC offer) */
    socket.on("call_user", async ({ callerId, calleeId, offer }) => {
      try {
        const blocked = await Block.findOne({
          $or: [
            { blockerId: calleeId, blockedId: callerId },
            { blockerId: callerId, blockedId: calleeId },
          ],
        });
        if (blocked) {
          return socket.emit("call_error", { error: "User is blocked" });
        }

        if (!onlineUsers.has(calleeId)) {
          return socket.emit("call_error", { error: "User is offline" });
        }

        if (busyUsers.has(calleeId)) {
          return socket.emit("user_busy", { calleeId });
        }

        if (pendingCalls.has(calleeId)) {
          return socket.emit("user_busy", { calleeId }); // Treat as busy if already receiving a call
        }

        // Set pending call
        pendingCalls.set(calleeId, { callerId, offer });

        const calleeSocket = onlineUsers.get(calleeId);
        if (calleeSocket) {
          io.to(calleeSocket).emit("incoming_call", { callerId, offer }); // Show ringing to callee
        }

        socket.emit("calling", { calleeId }); // Show "calling" to caller
      } catch (err) {
        console.error("call_user error:", err);
        socket.emit("call_error", { error: "Failed to initiate call" });
      }
    });

    /** Accept call (with WebRTC answer) */
    socket.on("accept_call", ({ calleeId, callerId, answer }) => {
      if (!pendingCalls.has(calleeId) || pendingCalls.get(calleeId).callerId !== callerId) {
        return socket.emit("call_error", { error: "No pending call" });
      }

      const { offer } = pendingCalls.get(calleeId);
      pendingCalls.delete(calleeId);

      // Mark both as busy
      busyUsers.add(callerId);
      busyUsers.add(calleeId);

      const callerSocket = onlineUsers.get(callerId);
      if (callerSocket) {
        io.to(callerSocket).emit("call_accepted", { calleeId, answer });
      }

      // Optional: Create a symmetric room for ICE candidates or further signaling
      const callRoom = [callerId, calleeId].sort().join("-");
      socket.join(callRoom); // Callee joins
      if (callerSocket) {
        io.to(callerSocket).emit("join_call_room", { room: callRoom }); // Tell caller to join
      }
    });

    /** Reject call */
    socket.on("reject_call", ({ calleeId, callerId }) => {
      if (pendingCalls.has(calleeId) && pendingCalls.get(calleeId).callerId === callerId) {
        pendingCalls.delete(calleeId);
        const callerSocket = onlineUsers.get(callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_rejected", { calleeId });
        }
      }
    });

    /** Relay ICE candidate */
    socket.on("ice_candidate", ({ candidate, toUserId }) => {
      const toSocket = onlineUsers.get(toUserId);
      if (toSocket) {
        io.to(toSocket).emit("ice_candidate", { candidate });
      }
    });

    /** End call */
    socket.on("end_call", ({ userId, peerId }) => {
      busyUsers.delete(userId);
      busyUsers.delete(peerId);

      const peerSocket = onlineUsers.get(peerId);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { fromUserId: userId });
      }

      // Optional: Leave room
      const callRoom = [userId, peerId].sort().join("-");
      socket.leave(callRoom);
    });

    /** Disconnect handling */
    socket.on("disconnect", () => {
      for (const [userId, sockId] of onlineUsers.entries()) {
        if (sockId === socket.id) {
          onlineUsers.delete(userId);
          busyUsers.delete(userId);

          // Clean up pending call if callee disconnects
          if (pendingCalls.has(userId)) {
            const { callerId } = pendingCalls.get(userId);
            pendingCalls.delete(userId);
            const callerSocket = onlineUsers.get(callerId);
            if (callerSocket) {
              io.to(callerSocket).emit("call_ended", { calleeId: userId });
            }
          }

          // Notify peers if in call (client should handle, but basic cleanup)
          // To fully handle, we'd need a map of active calls, but keeping simple.
          console.log("User disconnected from audio:", socket.id);
        }
      }
    });
  });

  return io;
};