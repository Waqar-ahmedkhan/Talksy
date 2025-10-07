// lib/sockets/video_socket.js
import { Server } from "socket.io";
import { mongoose } from "../config/db.js";
import User from "../models/User.js";
import Block from "../models/Block.js";

/**
 * PRODUCTION-GRADE Video Calling Socket with WebRTC signaling
 * ✅ ICE Candidate Buffering (fixes early candidate routing)
 * ✅ Single socket per user enforcement
 * ✅ Robust user ID resolution with cache invalidation
 * ✅ Comprehensive call state management
 * ✅ Graceful disconnect handling with peer notification
 * ✅ Detailed logging with PKT timestamps
 * ✅ Memory leak prevention with cleanup
 */
export const initVideoSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/video-socket",
  });

  // Core data structures
  const onlineUsers = new Map(); // userId (MongoDB ID) -> socketId
  const busyUsers = new Set();   // userIds currently in any call
  const pendingCalls = new Map(); // calleeId -> { callerId, type, offer, timestamp }
  const phoneToUserIdMap = new Map(); // phone -> MongoDB ObjectID
  const pendingIceCandidates = new Map(); // socketId -> Array of {candidate, targetUserId}

  // Helper for PKT timestamp
  const getPKTTimestamp = () => new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

  // Enhanced user ID resolution with cache validation
  const resolveToUserId = async (identifier) => {
    if (!identifier) return null;
    
    const idStr = identifier.toString().trim();
    
    // Already a valid MongoDB ObjectID - validate existence
    if (/^[0-9a-fA-F]{24}$/.test(idStr)) {
      try {
        const userExists = await User.findById(idStr);
        return userExists ? idStr : null;
      } catch (err) {
        console.log(`[VIDEO_RESOLVE_WARN] MongoDB ID validation failed for ${idStr}: ${err.message} at ${getPKTTimestamp()}`);
        return null;
      }
    }
    
    // Phone number lookup with caching and validation
    if (idStr.startsWith('+') && /^\+\d{10,15}$/.test(idStr)) {
      if (phoneToUserIdMap.has(idStr)) {
        const cachedId = phoneToUserIdMap.get(idStr);
        try {
          const user = await User.findById(cachedId);
          if (user && user.phone === idStr) {
            return cachedId;
          } else {
            phoneToUserIdMap.delete(idStr); // Invalidate stale cache
          }
        } catch (err) {
          phoneToUserIdMap.delete(idStr);
        }
      }
      
      try {
        const user = await User.findOne({ phone: idStr });
        if (user && user._id) {
          const userId = user._id.toString();
          phoneToUserIdMap.set(idStr, userId);
          return userId;
        }
      } catch (err) {
        console.log(`[VIDEO_RESOLVE_WARN] Phone lookup failed for ${idStr}: ${err.message} at ${getPKTTimestamp()}`);
      }
    }
    
    // Fallback database lookup with validation
    try {
      const user = await User.findOne({ 
        $or: [
          { phone: idStr },
          { _id: idStr }
        ]
      });
      if (user && user._id) {
        const userId = user._id.toString();
        if (user.phone) {
          phoneToUserIdMap.set(user.phone, userId);
        }
        return userId;
      }
    } catch (err) {
      console.log(`[VIDEO_RESOLVE_WARN] Fallback lookup failed for ${idStr}: ${err.message} at ${getPKTTimestamp()}`);
    }
    
    return null;
  };

  // Get phone from user ID with caching
  const getPhoneFromUserId = async (userId) => {
    if (!userId) return null;
    
    const idStr = userId.toString().trim();
    
    // Check cache first
    for (const [phone, uid] of phoneToUserIdMap.entries()) {
      if (uid === idStr) {
        return phone;
      }
    }
    
    try {
      const user = await User.findById(idStr);
      if (user && user.phone) {
        phoneToUserIdMap.set(user.phone, idStr);
        return user.phone;
      }
    } catch (err) {
      console.log(`[VIDEO_PHONE_WARN] Phone lookup failed for ${idStr}: ${err.message} at ${getPKTTimestamp()}`);
    }
    
    return null;
  };

  // Broadcast online users safely
  const broadcastOnlineUsers = () => {
    try {
      const onlineUsersArray = Array.from(onlineUsers.keys());
      io.emit("online_users", onlineUsersArray);
      console.log(`[VIDEO_BROADCAST] Online users updated at ${getPKTTimestamp()}: [${onlineUsersArray.join(', ')}]`);
    } catch (err) {
      console.error(`[VIDEO_BROADCAST_ERROR] Failed to broadcast online users: ${err.message} at ${getPKTTimestamp()}`);
    }
  };

  // Flush buffered ICE candidates for a socket
  const flushBufferedIceCandidates = (socketId, targetUserId) => {
    if (!pendingIceCandidates.has(socketId)) return;
    
    const bufferedCandidates = pendingIceCandidates.get(socketId);
    pendingIceCandidates.delete(socketId);
    
    const targetSocket = onlineUsers.get(targetUserId);
    if (targetSocket) {
      bufferedCandidates.forEach(({ candidate, fromUserId }) => {
        io.to(targetSocket).emit("ice_candidate", { 
          candidate,
          fromUserId: fromUserId || null
        });
      });
      console.log(`[VIDEO_ICE_FLUSH] Flushed ${bufferedCandidates.length} buffered ICE candidates to ${targetUserId} at ${getPKTTimestamp()}`);
    }
  };

  // Clean up user resources on disconnect
  const cleanupUserResources = async (userId, socketId, reason = "disconnect") => {
    try {
      console.log(`[VIDEO_CLEANUP] Starting cleanup for user ${userId} (socket: ${socketId}, reason: ${reason}) at ${getPKTTimestamp()}`);
      
      // Clean up pending ICE candidates
      if (pendingIceCandidates.has(socketId)) {
        pendingIceCandidates.delete(socketId);
        console.log(`[VIDEO_CLEANUP] Cleared pending ICE candidates for socket ${socketId} at ${getPKTTimestamp()}`);
      }
      
      // Remove from online users
      onlineUsers.delete(userId);
      
      // Handle pending calls where this user is the callee
      if (pendingCalls.has(userId)) {
        const pending = pendingCalls.get(userId);
        pendingCalls.delete(userId);
        console.log(`[VIDEO_CLEANUP] Removed pending call: ${pending.callerId} → ${userId} at ${getPKTTimestamp()}`);
        
        const callerSocket = onlineUsers.get(pending.callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { 
            calleeId: userId, 
            reason: reason === "reconnect" ? "user_reconnected" : "callee_offline" 
          });
          console.log(`[VIDEO_CLEANUP] Notified caller ${pending.callerId} about ended call at ${getPKTTimestamp()}`);
        }
      }
      
      // Handle pending calls where this user is the caller
      for (const [calleeId, pending] of pendingCalls.entries()) {
        if (pending.callerId === userId) {
          pendingCalls.delete(calleeId);
          console.log(`[VIDEO_CLEANUP] Removed outgoing pending call: ${userId} → ${calleeId} at ${getPKTTimestamp()}`);
          
          const calleeSocket = onlineUsers.get(calleeId);
          if (calleeSocket) {
            io.to(calleeSocket).emit("call_ended", { 
              callerId: userId, 
              reason: reason === "reconnect" ? "caller_reconnected" : "caller_offline" 
            });
            console.log(`[VIDEO_CLEANUP] Notified callee ${calleeId} about ended call at ${getPKTTimestamp()}`);
          }
        }
      }
      
      // Remove from busy users
      const wasBusy = busyUsers.has(userId);
      if (wasBusy) {
        busyUsers.delete(userId);
        console.log(`[VIDEO_CLEANUP] Removed ${userId} from busy users at ${getPKTTimestamp()}`);
      }
      
      // Update database
      try {
        await User.findByIdAndUpdate(userId, { online: false, lastSeen: new Date() });
        console.log(`[VIDEO_CLEANUP_DB] User ${userId} marked offline in DB at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[VIDEO_CLEANUP_DB_ERROR] Failed to update user ${userId}: ${dbErr.message} at ${getPKTTimestamp()}`);
      }
      
      console.log(`[VIDEO_CLEANUP_COMPLETE] Cleanup finished for user ${userId} at ${getPKTTimestamp()}`);
    } catch (err) {
      console.error(`[VIDEO_CLEANUP_ERROR] Unexpected error during cleanup for ${userId}: ${err.message} at ${getPKTTimestamp()}`);
    }
  };

  io.on("connection", (socket) => {
    console.log(`[VIDEO_CONNECTION] New socket connected: ${socket.id} at ${getPKTTimestamp()}`);

    // USER JOIN HANDLER - ENFORCES SINGLE SOCKET PER USER
    socket.on("join", async (userId) => {
      console.log(`[VIDEO_JOIN] Join request received: userId=${userId} (type: ${typeof userId}) from socket ${socket.id} at ${getPKTTimestamp()}`);
      
      if (!userId) {
        console.log(`[VIDEO_JOIN_ERROR] Invalid userId (null/empty), disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      let userIdStr = '';
      if (typeof userId === 'object' && userId !== null) {
        userIdStr = userId.userId || userId._id || userId.phone || userId.id || userId.toString();
      } else {
        userIdStr = userId.toString();
      }

      if (!userIdStr || userIdStr === '[object Object]' || userIdStr === 'undefined') {
        console.log(`[VIDEO_JOIN_ERROR] Invalid userIdStr extracted: "${userIdStr}", disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      const resolvedUserId = await resolveToUserId(userIdStr);
      if (!resolvedUserId) {
        console.log(`[VIDEO_JOIN_ERROR] Could not resolve userId "${userIdStr}" to valid user, disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      console.log(`[VIDEO_JOIN] Resolved "${userIdStr}" to MongoDB ID: ${resolvedUserId} at ${getPKTTimestamp()}`);

      // ENFORCE SINGLE SOCKET PER USER
      if (onlineUsers.has(resolvedUserId)) {
        const oldSocketId = onlineUsers.get(resolvedUserId);
        console.log(`[VIDEO_JOIN_REPLACE] User ${resolvedUserId} already online on socket ${oldSocketId}, replacing with ${socket.id} at ${getPKTTimestamp()}`);
        
        await cleanupUserResources(resolvedUserId, oldSocketId, "reconnect");
        
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.disconnect(true);
          console.log(`[VIDEO_JOIN_REPLACE] Old socket ${oldSocketId} forcibly disconnected at ${getPKTTimestamp()}`);
        }
      }

      onlineUsers.set(resolvedUserId, socket.id);
      socket.userId = resolvedUserId;
      
      try {
        await User.findByIdAndUpdate(resolvedUserId, { online: true, lastSeen: new Date() });
        console.log(`[VIDEO_JOIN_SUCCESS] User ${resolvedUserId} marked online (socket: ${socket.id}) at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[VIDEO_JOIN_DB_ERROR] Failed to update user ${resolvedUserId}: ${dbErr.message} at ${getPKTTimestamp()}`);
      }
      
      broadcastOnlineUsers();
    });

    // REQUEST ONLINE USERS
    socket.on("request_online_users", () => {
      console.log(`[VIDEO_REQUEST] Online users requested by socket ${socket.id} (user: ${socket.userId || 'unknown'}) at ${getPKTTimestamp()}`);
      broadcastOnlineUsers();
    });

    // CALL INITIATION
    socket.on("call_user", async ({ callerId, calleeId, offer, callType = "video" }) => {
      try {
        console.log(`[VIDEO_CALL_INIT] Call request: ${callerId} → ${calleeId} [${callType}] from socket ${socket.id} at ${getPKTTimestamp()}`);
        
        if (!callerId || !calleeId || !offer) {
          console.log(`[VIDEO_CALL_ERROR] Missing required fields in call_user payload at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Missing required fields" });
        }

        const resolvedCaller = await resolveToUserId(callerId);
        const resolvedCallee = await resolveToUserId(calleeId);
        
        if (!resolvedCaller || !resolvedCallee) {
          console.log(`[VIDEO_CALL_ERROR] Invalid user identifiers: caller=${callerId}, callee=${calleeId} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid user identifiers" });
        }

        if (resolvedCaller === resolvedCallee) {
          console.log(`[VIDEO_CALL_ERROR] Self-call attempt by ${resolvedCaller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Cannot call yourself" });
        }

        if (!onlineUsers.has(resolvedCaller)) {
          console.log(`[VIDEO_CALL_ERROR] Caller ${resolvedCaller} not online at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "You are not online" });
        }

        if (!onlineUsers.has(resolvedCallee)) {
          console.log(`[VIDEO_CALL_ERROR] Callee ${resolvedCallee} is offline at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "User is offline" });
        }

        // Check blocks
        const blocked = await Block.findOne({
          $or: [
            { blockerId: resolvedCallee, blockedId: resolvedCaller },
            { blockerId: resolvedCaller, blockedId: resolvedCallee },
          ],
        });
        if (blocked) {
          console.log(`[VIDEO_CALL_ERROR] Call blocked between ${resolvedCaller} and ${resolvedCallee} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "User is blocked" });
        }

        // Check if callee is busy
        if (busyUsers.has(resolvedCallee) || pendingCalls.has(resolvedCallee)) {
          console.log(`[VIDEO_CALL_ERROR] Callee ${resolvedCallee} is busy at ${getPKTTimestamp()}`);
          return socket.emit("user_busy", { calleeId: resolvedCallee });
        }

        // Validate offer
        if (!offer.type || !offer.sdp || offer.type !== "offer") {
          console.log(`[VIDEO_CALL_ERROR] Invalid offer from ${resolvedCaller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call offer" });
        }

        // Store pending call
        pendingCalls.set(resolvedCallee, { 
          callerId: resolvedCaller, 
          offer, 
          callType,
          timestamp: Date.now()
        });
        console.log(`[VIDEO_CALL_PENDING] Stored pending call: ${resolvedCaller} → ${resolvedCallee} [${callType}] at ${getPKTTimestamp()}`);

        // Notify callee
        const calleeSocket = onlineUsers.get(resolvedCallee);
        if (calleeSocket) {
          const callerPhone = await getPhoneFromUserId(resolvedCaller);
          
          io.to(calleeSocket).emit("incoming_call", {
            callerId: callerPhone || resolvedCaller,
            callerUserId: resolvedCaller,
            calleeUserId: resolvedCallee,
            offer,
            callType
          });
          console.log(`[VIDEO_CALL_INCOMING] Sent incoming_call to ${resolvedCallee} (socket: ${calleeSocket}) at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[VIDEO_CALL_WARN] Callee socket not found despite online status for ${resolvedCallee} at ${getPKTTimestamp()}`);
          pendingCalls.delete(resolvedCallee);
          return socket.emit("call_error", { error: "Callee unavailable" });
        }

        socket.emit("calling", { 
          calleeId: resolvedCallee,
          callType 
        });
        console.log(`[VIDEO_CALL_SUCCESS] Call initiated: ${resolvedCaller} → ${resolvedCallee} [${callType}] at ${getPKTTimestamp()}`);
        
      } catch (err) {
        console.error(`[VIDEO_CALL_UNEXPECTED_ERROR] ${err.message} at ${getPKTTimestamp()}`, err);
        socket.emit("call_error", { error: "Failed to initiate call" });
      }
    });

    // ACCEPT CALL
    socket.on("accept_call", async ({ callerId, calleeId, answer }) => {
      try {
        console.log(`[VIDEO_ACCEPT] Accept call: ${callerId} ← ${calleeId} at ${getPKTTimestamp()}`);
        
        const resolvedCaller = await resolveToUserId(callerId);
        const resolvedCallee = await resolveToUserId(calleeId);
        
        if (!resolvedCaller || !resolvedCallee) {
          console.log(`[VIDEO_ACCEPT_ERROR] Invalid user IDs at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid user identifiers" });
        }

        const pending = pendingCalls.get(resolvedCallee);
        if (!pending || pending.callerId !== resolvedCaller) {
          console.log(`[VIDEO_ACCEPT_ERROR] No valid pending call for ${resolvedCallee} from ${resolvedCaller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "No pending call to accept" });
        }

        if (!answer?.type || !answer?.sdp || answer.type !== "answer") {
          console.log(`[VIDEO_ACCEPT_ERROR] Invalid answer from ${resolvedCallee} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call answer" });
        }

        pendingCalls.delete(resolvedCallee);
        busyUsers.add(resolvedCaller);
        busyUsers.add(resolvedCallee);
        console.log(`[VIDEO_ACCEPT] Call accepted: ${resolvedCaller} ↔ ${resolvedCallee} at ${getPKTTimestamp()}`);

        // Notify caller and flush ICE candidates
        const callerSocket = onlineUsers.get(resolvedCaller);
        if (callerSocket) {
          io.to(callerSocket).emit("call_accepted", {
            answer,
            callerUserId: resolvedCaller,
            calleeUserId: resolvedCallee,
            callType: pending.callType
          });
          console.log(`[VIDEO_ACCEPT_SENT] Sent call_accepted to ${resolvedCaller} at ${getPKTTimestamp()}`);
          
          // FLUSH BUFFERED ICE CANDIDATES FOR CALLER
          flushBufferedIceCandidates(callerSocket, resolvedCallee);
        }

        // Create room
        const callRoom = [resolvedCaller, resolvedCallee].sort().join("-");
        socket.join(callRoom);
        console.log(`[VIDEO_ROOM] Callee ${resolvedCallee} joined room ${callRoom} at ${getPKTTimestamp()}`);

        if (callerSocket) {
          const callerSocketObj = io.sockets.sockets.get(callerSocket);
          if (callerSocketObj) {
            callerSocketObj.join(callRoom);
            console.log(`[VIDEO_ROOM] Caller ${resolvedCaller} joined room ${callRoom} at ${getPKTTimestamp()}`);
            
            // FLUSH BUFFERED ICE CANDIDATES FOR CALLEE
            flushBufferedIceCandidates(socket.id, resolvedCaller);
          }
        }

        console.log(`[VIDEO_ACCEPT_SUCCESS] Call connected in room ${callRoom} at ${getPKTTimestamp()}`);
        
      } catch (err) {
        console.error(`[VIDEO_ACCEPT_UNEXPECTED_ERROR] ${err.message} at ${getPKTTimestamp()}`, err);
        socket.emit("call_error", { error: "Failed to accept call" });
      }
    });

    // REJECT CALL
    socket.on("reject_call", async ({ callerId, calleeId }) => {
      console.log(`[VIDEO_REJECT] Reject call: ${callerId} ← ${calleeId} at ${getPKTTimestamp()}`);
      
      const resolvedCaller = await resolveToUserId(callerId);
      const resolvedCallee = await resolveToUserId(calleeId);
      
      if (!resolvedCaller || !resolvedCallee) {
        console.log(`[VIDEO_REJECT_ERROR] Invalid user IDs at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "Invalid user identifiers" });
      }

      const pending = pendingCalls.get(resolvedCallee);
      if (!pending || pending.callerId !== resolvedCaller) {
        console.log(`[VIDEO_REJECT_ERROR] No pending call to reject at ${getPKTTimestamp()}`);
        return;
      }

      pendingCalls.delete(resolvedCallee);
      console.log(`[VIDEO_REJECT] Call rejected: ${resolvedCaller} → ${resolvedCallee} at ${getPKTTimestamp()}`);

      const callerSocket = onlineUsers.get(resolvedCaller);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", { 
          calleeId: resolvedCallee,
          reason: "rejected"
        });
        console.log(`[VIDEO_REJECT_SENT] Rejection sent to ${resolvedCaller} at ${getPKTTimestamp()}`);
      }
    });

    // ICE CANDIDATE HANDLING WITH BUFFERING
    socket.on("ice_candidate", async ({ candidate, toUserId }) => {
      console.log(`[VIDEO_ICE] ICE candidate received for ${toUserId} from socket ${socket.id} at ${getPKTTimestamp()}`);
      
      if (!candidate || !candidate.candidate) {
        console.log(`[VIDEO_ICE_ERROR] Invalid ICE candidate structure at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "Invalid ICE candidate" });
      }

      // If no toUserId provided, buffer the candidate
      if (!toUserId || toUserId === 'undefined' || toUserId === 'null' || toUserId === null) {
        if (!pendingIceCandidates.has(socket.id)) {
          pendingIceCandidates.set(socket.id, []);
        }
        pendingIceCandidates.get(socket.id).push({ candidate, fromUserId: socket.userId });
        console.log(`[VIDEO_ICE_BUFFER] Buffered ICE candidate (no target) for socket ${socket.id} at ${getPKTTimestamp()}`);
        return;
      }

      const resolvedToUserId = await resolveToUserId(toUserId);
      if (!resolvedToUserId) {
        console.warn(`[VIDEO_ICE_DROP] Dropping ICE candidate - invalid toUserId: ${toUserId} at ${getPKTTimestamp()}`);
        return;
      }

      // If target is not online, buffer the candidate
      if (!onlineUsers.has(resolvedToUserId)) {
        if (!pendingIceCandidates.has(socket.id)) {
          pendingIceCandidates.set(socket.id, []);
        }
        pendingIceCandidates.get(socket.id).push({ candidate, fromUserId: socket.userId });
        console.log(`[VIDEO_ICE_BUFFER] Buffered ICE candidate (target offline) for socket ${socket.id} at ${getPKTTimestamp()}`);
        return;
      }

      // If not in active call, buffer the candidate
      if (!socket.userId || !busyUsers.has(socket.userId) || !busyUsers.has(resolvedToUserId)) {
        if (!pendingIceCandidates.has(socket.id)) {
          pendingIceCandidates.set(socket.id, []);
        }
        pendingIceCandidates.get(socket.id).push({ candidate, fromUserId: socket.userId, targetUserId: resolvedToUserId });
        console.log(`[VIDEO_ICE_BUFFER] Buffered ICE candidate (not in call) for socket ${socket.id} at ${getPKTTimestamp()}`);
        return;
      }

      // Relay candidate immediately
      const targetSocket = onlineUsers.get(resolvedToUserId);
      if (targetSocket) {
        io.to(targetSocket).emit("ice_candidate", { 
          candidate,
          fromUserId: socket.userId
        });
        console.log(`[VIDEO_ICE_SENT] ICE candidate relayed to ${resolvedToUserId} at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[VIDEO_ICE_DROP] Target socket not found for ${resolvedToUserId} at ${getPKTTimestamp()}`);
      }
    });

    // END CALL
    socket.on("end_call", async ({ userId, peerId }) => {
      console.log(`[VIDEO_END] End call request: ${userId} ↔ ${peerId} from socket ${socket.id} at ${getPKTTimestamp()}`);
      
      const resolvedUser = await resolveToUserId(userId);
      const resolvedPeer = await resolveToUserId(peerId);
      
      if (!resolvedUser || !resolvedPeer) {
        console.log(`[VIDEO_END_ERROR] Invalid user IDs at ${getPKTTimestamp()}`);
        return;
      }

      busyUsers.delete(resolvedUser);
      busyUsers.delete(resolvedPeer);
      console.log(`[VIDEO_END] Removed ${resolvedUser} and ${resolvedPeer} from busy users at ${getPKTTimestamp()}`);

      const peerSocket = onlineUsers.get(resolvedPeer);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { 
          fromUserId: resolvedUser,
          reason: "ended_by_user"
        });
        console.log(`[VIDEO_END_SENT] Call ended notification sent to ${resolvedPeer} at ${getPKTTimestamp()}`);
      }

      const callRoom = [resolvedUser, resolvedPeer].sort().join("-");
      socket.leave(callRoom);
      console.log(`[VIDEO_END_ROOM] User ${resolvedUser} left room ${callRoom} at ${getPKTTimestamp()}`);

      if (peerSocket) {
        const peerSocketObj = io.sockets.sockets.get(peerSocket);
        if (peerSocketObj) {
          peerSocketObj.leave(callRoom);
          console.log(`[VIDEO_END_ROOM] Peer ${resolvedPeer} left room ${callRoom} at ${getPKTTimestamp()}`);
        }
      }
    });

    // DISCONNECT HANDLER
    socket.on("disconnect", async (reason) => {
      console.log(`[VIDEO_DISCONNECT] Socket ${socket.id} disconnected (user: ${socket.userId || 'unknown'}, reason: ${reason}) at ${getPKTTimestamp()}`);
      
      if (socket.userId) {
        await cleanupUserResources(socket.userId, socket.id, reason);
        broadcastOnlineUsers();
      } else {
        // Clean up pending ICE candidates for unknown sockets
        if (pendingIceCandidates.has(socket.id)) {
          pendingIceCandidates.delete(socket.id);
          console.log(`[VIDEO_DISCONNECT] Cleaned pending ICE candidates for unknown socket ${socket.id} at ${getPKTTimestamp()}`);
        }
        console.log(`[VIDEO_DISCONNECT] Unknown socket disconnected: ${socket.id} at ${getPKTTimestamp()}`);
      }
    });
  });

  console.log(`[VIDEO_INIT] ✅ Video Socket server initialized on path /video-socket at ${getPKTTimestamp()}`);
  return io;
};