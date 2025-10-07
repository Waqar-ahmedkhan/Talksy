import { Server } from "socket.io";
import { mongoose } from "../config/db.js"; // Import Mongoose instance
import User from "../models/User.js";
import Block from "../models/Block.js";

/**
 * Initializes the Audio Calling Socket with WebRTC signaling support.
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
export const initAudioSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/audio-socket",
  });

  const onlineUsers = new Map(); // userId -> socketId
  const busyUsers = new Set();   // userIds currently in a call
  const pendingCalls = new Map(); // calleeId -> { callerId, offer }

  // Helper for PKT timestamp
  const getPKTTimestamp = () => new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

  // Broadcast online users list to all clients
  const broadcastOnlineUsers = () => {
    const onlineUsersArray = Array.from(onlineUsers.keys());
    io.emit("online_users", onlineUsersArray);
    console.log(`[AUDIO_BROADCAST] Online users updated at ${getPKTTimestamp()}:`, onlineUsersArray);
  };

  io.on("connection", (socket) => {
    console.log(`[AUDIO_CONNECTION] New socket connected: ${socket.id} at ${getPKTTimestamp()}`);

    /** User joins audio socket (updates presence) */
    socket.on("join", async (userId) => {
      console.log(`[AUDIO_JOIN] Join event received for userId:`, userId, `(type: ${typeof userId}) at ${getPKTTimestamp()}`);
      
      if (!userId) {
        console.log(`[AUDIO_JOIN_ERROR] Invalid userId (null/empty), disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect();
      }

      // Handle if userId is object (common Flutter issue: send stringified _id or phone)
      let userIdStr = userId;
      if (typeof userId === 'object') {
        userIdStr = userId._id || userId.phone || userId.toString(); // Fallback to string rep
        console.log(`[AUDIO_JOIN] Converted object userId to string: ${userIdStr} at ${getPKTTimestamp()}`);
      } else {
        userIdStr = userId.toString();
      }

      // Check for duplicates
      if (onlineUsers.has(userIdStr)) {
        console.log(`[AUDIO_JOIN_WARN] User ${userIdStr} already online, updating socket from ${onlineUsers.get(userIdStr)} to ${socket.id} at ${getPKTTimestamp()}`);
        onlineUsers.set(userIdStr, socket.id);
      } else {
        onlineUsers.set(userIdStr, socket.id);
      }
      
      socket.userId = userIdStr;

      // Update user online status in database
      try {
        await User.findOneAndUpdate({ phone: userIdStr }, { online: true, lastSeen: new Date() }, { upsert: true });
        console.log(`[AUDIO_JOIN_SUCCESS] User ${userIdStr} marked online in DB at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[AUDIO_JOIN_ERROR] DB update failed for ${userIdStr}:`, dbErr, `at ${getPKTTimestamp()}`);
      }
      
      broadcastOnlineUsers();
    });

    /** Request initial online users list */
    socket.on("request_online_users", () => {
      console.log(`[AUDIO_REQUEST] Online users list requested by socket ${socket.id} at ${getPKTTimestamp()}`);
      broadcastOnlineUsers();
    });

    /** Initiate audio call (with WebRTC offer) */
    socket.on("call_user", async ({ callerId, calleeId, offer }) => {
      try {
        console.log(`[AUDIO_CALL_INIT] Call_user event received: callerId=${callerId}, calleeId=${calleeId}, offer keys=${Object.keys(offer || {})} at ${getPKTTimestamp()}`);
        
        const caller = callerId.toString();
        const callee = calleeId.toString();

        console.log(`[AUDIO_CALL] Processing call attempt: ${caller} → ${callee} at ${getPKTTimestamp()}`);

        // Prevent self-call
        if (caller === callee) {
          console.log(`[AUDIO_CALL_ERROR] Self-call attempt detected for ${caller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "You cannot call yourself" });
        }

        // Check if caller is online (basic sanity)
        if (!onlineUsers.has(caller)) {
          console.log(`[AUDIO_CALL_ERROR] Caller ${caller} not online at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "You must be online to call" });
        }

        // Check if callee is online
        if (!onlineUsers.has(callee)) {
          console.log(`[AUDIO_CALL_ERROR] Callee ${callee} is offline at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "User is offline" });
        }

        // Check if users are blocked
        console.log(`[AUDIO_CALL] Checking blocks between ${caller} and ${callee} at ${getPKTTimestamp()}`);
        const blocked = await Block.findOne({
          $or: [
            { blockerId: callee, blockedId: caller },
            { blockerId: caller, blockedId: callee },
          ],
        });
        if (blocked) {
          console.log(`[AUDIO_CALL_ERROR] Call blocked: ${caller} → ${callee} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Cannot call: User is blocked" });
        }
        console.log(`[AUDIO_CALL] No blocks found between ${caller} and ${callee} at ${getPKTTimestamp()}`);

        // Check if callee is busy
        if (busyUsers.has(callee) || pendingCalls.has(callee)) {
          console.log(`[AUDIO_CALL_ERROR] Callee ${callee} is busy or has pending call at ${getPKTTimestamp()}`);
          return socket.emit("user_busy", { calleeId: callee });
        }

        // Validate offer (basic check)
        if (!offer || !offer.type || !offer.sdp) {
          console.log(`[AUDIO_CALL_ERROR] Invalid offer from ${caller}: missing type/sdp at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call offer" });
        }

        // Store pending call
        pendingCalls.set(callee, { callerId: caller, offer });
        console.log(`[AUDIO_CALL_PENDING] Stored pending call: ${caller} → ${callee} at ${getPKTTimestamp()}`);

        const calleeSocket = onlineUsers.get(callee);
        if (calleeSocket) {
          io.to(calleeSocket).emit("incoming_call", {
            callerId: caller,
            offer,
          });
          console.log(`[AUDIO_CALL_INCOMING] Sent incoming_call to ${callee} (socket: ${calleeSocket}) at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[AUDIO_CALL_WARN] Callee socket not found for ${callee} despite online status at ${getPKTTimestamp()}`);
          pendingCalls.delete(callee); // Cleanup
          return socket.emit("call_error", { error: "Callee unavailable" });
        }

        socket.emit("calling", { calleeId });
        console.log(`[AUDIO_CALL_SUCCESS] Call initiated and ringing: ${caller} → ${callee} at ${getPKTTimestamp()}`);
      } catch (err) {
        console.error(`[AUDIO_CALL_ERROR] Unexpected error in call_user:`, err, `at ${getPKTTimestamp()}`);
        socket.emit("call_error", { error: "Failed to initiate call" });
      }
    });

    /** Accept call (with WebRTC answer) */
    socket.on("accept_call", ({ callerId, calleeId, answer }) => {
      try {
        console.log(`[AUDIO_ACCEPT] Accept_call event received: callerId=${callerId}, calleeId=${calleeId}, answer keys=${Object.keys(answer || {})} at ${getPKTTimestamp()}`);
        
        const caller = callerId.toString();
        const callee = calleeId.toString();

        const pending = pendingCalls.get(callee);
        if (!pending || pending.callerId !== caller) {
          console.log(`[AUDIO_ACCEPT_ERROR] No valid pending call for ${callee} from ${caller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "No pending call to accept" });
        }

        // Validate answer
        if (!answer || !answer.type || !answer.sdp) {
          console.log(`[AUDIO_ACCEPT_ERROR] Invalid answer from ${callee}: missing type/sdp at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call answer" });
        }

        const { offer } = pending;
        pendingCalls.delete(callee);
        console.log(`[AUDIO_ACCEPT] Removed pending call: ${caller} → ${callee} at ${getPKTTimestamp()}`);

        // Mark both as busy
        busyUsers.add(caller);
        busyUsers.add(callee);
        console.log(`[AUDIO_BUSY] Marked users busy: ${caller}, ${callee} at ${getPKTTimestamp()}`);

        const callerSocket = onlineUsers.get(caller);
        if (callerSocket) {
          io.to(callerSocket).emit("call_accepted", {
            calleeId: callee,
            answer,
          });
          console.log(`[AUDIO_ACCEPT_SENT] Sent call_accepted to ${caller} (socket: ${callerSocket}) at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[AUDIO_ACCEPT_WARN] Caller socket not found for ${caller} at ${getPKTTimestamp()}`);
        }

        // Create a unique room for this call
        const callRoom = [caller, callee].sort().join("-");
        socket.join(callRoom); // Callee joins room
        console.log(`[AUDIO_ROOM] Callee ${callee} joined room ${callRoom} at ${getPKTTimestamp()}`);

        if (callerSocket) {
          // Actually join caller to room
          const callerSocketObj = io.sockets.sockets.get(callerSocket);
          if (callerSocketObj) {
            callerSocketObj.join(callRoom);
            console.log(`[AUDIO_ROOM] Caller ${caller} joined room ${callRoom} at ${getPKTTimestamp()}`);
          }
          io.to(callerSocket).emit("join_call_room", { room: callRoom });
          console.log(`[AUDIO_ROOM_NOTIFY] Notified caller to join room ${callRoom} at ${getPKTTimestamp()}`);
        }

        console.log(`[AUDIO_ACCEPT_SUCCESS] Call accepted and connected: ${caller} ↔ ${callee} in room ${callRoom} at ${getPKTTimestamp()}`);
      } catch (err) {
        console.error(`[AUDIO_ACCEPT_ERROR] Unexpected error in accept_call:`, err, `at ${getPKTTimestamp()}`);
        socket.emit("call_error", { error: "Failed to accept call" });
      }
    });

    /** Reject call */
    socket.on("reject_call", ({ callerId, calleeId }) => {
      console.log(`[AUDIO_REJECT] Reject_call event received: callerId=${callerId}, calleeId=${calleeId} at ${getPKTTimestamp()}`);
      
      const caller = callerId.toString();
      const callee = calleeId.toString();

      const pending = pendingCalls.get(callee);
      if (!pending || pending.callerId !== caller) {
        console.log(`[AUDIO_REJECT_ERROR] No valid pending call to reject for ${callee} at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "No pending call to reject" });
      }

      pendingCalls.delete(callee);
      console.log(`[AUDIO_REJECT] Pending call rejected: ${caller} → ${callee} at ${getPKTTimestamp()}`);

      const callerSocket = onlineUsers.get(caller);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", { calleeId });
        console.log(`[AUDIO_REJECT_SENT] Sent call_rejected to ${caller} (socket: ${callerSocket}) at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[AUDIO_REJECT_WARN] Caller socket not found for rejection to ${caller} at ${getPKTTimestamp()}`);
      }
    });

    /** Relay ICE candidate */
    socket.on("ice_candidate", ({ candidate, toUserId }) => {
      console.log(`[AUDIO_ICE] ICE_candidate event received: toUserId=${toUserId}, candidate keys=${Object.keys(candidate || {})} at ${getPKTTimestamp()}`);
      
      if (!candidate || !candidate.candidate) {
        console.log(`[AUDIO_ICE_ERROR] Invalid ICE candidate (missing candidate field) at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "Invalid ICE candidate" });
      }

      const targetSocket = onlineUsers.get(toUserId);
      if (targetSocket) {
        io.to(targetSocket).emit("ice_candidate", { candidate });
        console.log(`[AUDIO_ICE_SENT] ICE candidate relayed to ${toUserId} (socket: ${targetSocket}) at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[AUDIO_ICE_WARN] Target socket not found for ${toUserId} at ${getPKTTimestamp()}`);
        // Don't emit error to avoid spam, but log
      }
    });

    /** End call */
    socket.on("end_call", ({ userId, peerId }) => {
      console.log(`[AUDIO_END] End_call event received: userId=${userId}, peerId=${peerId} at ${getPKTTimestamp()}`);
      
      const user = userId.toString();
      const peer = peerId.toString();

      // Unmark busy (idempotent: safe to call multiple times)
      const wasBusyUser = busyUsers.has(user);
      const wasBusyPeer = busyUsers.has(peer);
      busyUsers.delete(user);
      busyUsers.delete(peer);
      if (wasBusyUser || wasBusyPeer) {
        console.log(`[AUDIO_END_BUSY] Unmarked busy users: ${user}, ${peer} (was busy: user=${wasBusyUser}, peer=${wasBusyPeer}) at ${getPKTTimestamp()}`);
      }

      const peerSocket = onlineUsers.get(peer);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { fromUserId: user });
        console.log(`[AUDIO_END_SENT] Call_ended notification sent to ${peer} (socket: ${peerSocket}) at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[AUDIO_END_WARN] Peer socket not found for ${peer} at ${getPKTTimestamp()}`);
      }

      // Leave call room
      const callRoom = [user, peer].sort().join("-");
      const wasInRoom = socket.rooms.has(callRoom);
      socket.leave(callRoom);
      if (wasInRoom) {
        console.log(`[AUDIO_END_ROOM] User ${user} left room ${callRoom} at ${getPKTTimestamp()}`);
      } else {
        console.log(`[AUDIO_END_ROOM_WARN] User ${user} not in room ${callRoom} (no-op leave) at ${getPKTTimestamp()}`);
      }

      // Also leave peer if possible
      if (peerSocket) {
        const peerSocketObj = io.sockets.sockets.get(peerSocket);
        if (peerSocketObj) {
          peerSocketObj.leave(callRoom);
          console.log(`[AUDIO_END_ROOM] Peer ${peer} left room ${callRoom} at ${getPKTTimestamp()}`);
        }
      }
    });

    /** Disconnect handling */
    socket.on("disconnect", async () => {
      console.log(`[AUDIO_DISCONNECT] Socket disconnect event: ${socket.id} at ${getPKTTimestamp()}`);
      
      const disconnectedUserId = Array.from(onlineUsers.entries())
        .find(([_, socketId]) => socketId === socket.id)?.[0];

      if (!disconnectedUserId) {
        console.log(`[AUDIO_DISCONNECT_WARN] Unknown socket disconnected: ${socket.id} at ${getPKTTimestamp()}`);
        return;
      }

      console.log(`[AUDIO_DISCONNECT] Handling disconnect for user: ${disconnectedUserId} at ${getPKTTimestamp()}`);

      const wasBusy = busyUsers.has(disconnectedUserId);

      // Clean up presence
      onlineUsers.delete(disconnectedUserId);
      if (wasBusy) busyUsers.delete(disconnectedUserId); // Only if was busy

      // Update user offline status
      try {
        await User.findOneAndUpdate({ phone: disconnectedUserId }, { online: false, lastSeen: new Date() });
        console.log(`[AUDIO_DISCONNECT_DB] User ${disconnectedUserId} marked offline in DB at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[AUDIO_DISCONNECT_ERROR] DB update failed for ${disconnectedUserId}:`, dbErr, `at ${getPKTTimestamp()}`);
      }

      // Notify if user was receiving a call
      if (pendingCalls.has(disconnectedUserId)) {
        const { callerId } = pendingCalls.get(disconnectedUserId);
        pendingCalls.delete(disconnectedUserId);
        console.log(`[AUDIO_DISCONNECT_PENDING] Cleaned pending call for ${disconnectedUserId} (caller: ${callerId}) at ${getPKTTimestamp()}`);

        const callerSocket = onlineUsers.get(callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { calleeId: disconnectedUserId, reason: "offline" });
          console.log(`[AUDIO_DISCONNECT_NOTIFY] Sent call_ended (offline) to caller ${callerId} at ${getPKTTimestamp()}`);
        }
      }

      // Notify peers in active calls (only if was busy)
      if (wasBusy) {
        console.log(`[AUDIO_DISCONNECT_BUSY] Notifying peers of busy user disconnect: ${disconnectedUserId} at ${getPKTTimestamp()}`);
        for (const [userId, sockId] of onlineUsers.entries()) {
          if (busyUsers.has(userId)) { // Check current busy (post-delete)
            const callRoom = [disconnectedUserId, userId].sort().join("-");
            if (io.sockets.adapter.rooms.has(callRoom)) {
              io.to(sockId).emit("call_ended", { fromUserId: disconnectedUserId, reason: "disconnected" });
              console.log(`[AUDIO_DISCONNECT_NOTIFY] Sent call_ended (disconnected) to peer ${userId} in room ${callRoom} at ${getPKTTimestamp()}`);
            }
          }
        }
      }

      broadcastOnlineUsers();
      console.log(`[AUDIO_DISCONNECT_COMPLETE] Cleanup finished for ${disconnectedUserId} at ${getPKTTimestamp()}`);
    });
  });

  console.log(`[AUDIO_INIT] Audio Socket initialized on path /audio-socket at ${getPKTTimestamp()}`);
  return io;
};