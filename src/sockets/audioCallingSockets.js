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
 * - Supports both MongoDB ObjectIDs and phone numbers
 */
export const initAudioSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/audio-socket",
  });

  const onlineUsers = new Map(); // userId -> socketId (stores MongoDB ObjectIDs as primary keys)
  const busyUsers = new Set();   // userIds currently in a call (MongoDB ObjectIDs)
  const pendingCalls = new Map(); // calleeId -> { callerId, offer, timestamp } (MongoDB ObjectIDs)
  const phoneToUserIdMap = new Map(); // phone -> MongoDB ObjectID for quick lookup
  const iceBuffer = new Map(); // userId -> [candidates] for buffering ICE candidates

  // Helper for PKT timestamp
  const getPKTTimestamp = () => new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

  // Helper function to resolve any identifier to MongoDB ObjectID
  const resolveToUserId = async (identifier) => {
    if (!identifier) return null;
    
    const idStr = identifier.toString().trim();
    
    // Invalid identifier check
    if (!idStr || idStr === 'undefined' || idStr === '[object Object]') {
      console.log(`[AUDIO_RESOLVE_ERROR] Invalid identifier: ${JSON.stringify(identifier)} at ${getPKTTimestamp()}`);
      return null;
    }
    
    // If it's already a valid MongoDB ObjectID (24 hex chars), return as-is
    if (/^[0-9a-fA-F]{24}$/.test(idStr)) {
      console.log(`[AUDIO_RESOLVE_DEBUG] Valid ObjectID detected: ${idStr} at ${getPKTTimestamp()}`);
      return idStr;
    }
    
    // If it's a phone number, look up the MongoDB ID
    if (idStr.startsWith('+') && /^\+\d{10,15}$/.test(idStr)) {
      try {
        const user = await User.findOne({ phone: idStr });
        if (user && user._id) {
          const userId = user._id.toString();
          // Cache the mapping for future use
          phoneToUserIdMap.set(idStr, userId);
          console.log(`[AUDIO_RESOLVE_DEBUG] Resolved phone ${idStr} to userId ${userId} at ${getPKTTimestamp()}`);
          return userId;
        }
      } catch (err) {
        console.error(`[AUDIO_RESOLVE_ERROR] Could not resolve phone ${idStr} to user ID: ${err.message} at ${getPKTTimestamp()}`);
      }
    }
    
    // If it's neither, try to find by phone field (fallback)
    try {
      const user = await User.findOne({ 
        $or: [
          { phone: idStr },
          { _id: idStr }
        ]
      });
      if (user && user._id) {
        console.log(`[AUDIO_RESOLVE_DEBUG] Fallback resolve: ${idStr} to ${user._id.toString()} at ${getPKTTimestamp()}`);
        return user._id.toString();
      }
    } catch (err) {
      console.error(`[AUDIO_RESOLVE_ERROR] Could not resolve identifier ${idStr} to user ID: ${err.message} at ${getPKTTimestamp()}`);
    }
    
    console.warn(`[AUDIO_RESOLVE_WARN] Unresolved identifier: ${idStr} at ${getPKTTimestamp()}`);
    return null; // Changed to null for stricter error handling
  };

  // Helper function to get phone number from user ID
  const getPhoneFromUserId = async (userId) => {
    if (!userId) return null;
    
    const idStr = userId.toString().trim();
    
    // Check cache first
    for (const [phone, uid] of phoneToUserIdMap.entries()) {
      if (uid === idStr) {
        console.log(`[AUDIO_PHONE_DEBUG] Cache hit for userId ${idStr}: phone ${phone} at ${getPKTTimestamp()}`);
        return phone;
      }
    }
    
    // Query database
    try {
      const user = await User.findById(idStr);
      if (user && user.phone) {
        phoneToUserIdMap.set(user.phone, idStr);
        console.log(`[AUDIO_PHONE_DEBUG] DB lookup for userId ${idStr}: phone ${user.phone} at ${getPKTTimestamp()}`);
        return user.phone;
      }
    } catch (err) {
      console.error(`[AUDIO_PHONE_ERROR] Could not get phone for user ${idStr}: ${err.message} at ${getPKTTimestamp()}`);
    }
    
    console.warn(`[AUDIO_PHONE_WARN] No phone found for userId ${idStr} at ${getPKTTimestamp()}`);
    return null;
  };

  // Broadcast online users list to all clients
  const broadcastOnlineUsers = () => {
    const onlineUsersArray = Array.from(onlineUsers.keys());
    io.emit("online_users", onlineUsersArray);
    console.log(`[AUDIO_BROADCAST_INFO] Online users updated at ${getPKTTimestamp()}: ${onlineUsersArray.length} users online`);
  };

  // Cleanup stale pending calls (e.g., if not accepted within 60 seconds)
  setInterval(() => {
    const now = Date.now();
    for (const [calleeId, pending] of pendingCalls.entries()) {
      if (now - pending.timestamp > 60000) { // 60 seconds timeout
        pendingCalls.delete(calleeId);
        const callerSocket = onlineUsers.get(pending.callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { calleeId, reason: "timeout" });
          console.log(`[AUDIO_CLEANUP_INFO] Removed stale pending call ${pending.callerId} → ${calleeId} due to 60s timeout at ${getPKTTimestamp()}`);
        }
      }
    }
  }, 10000); // Check every 10 seconds

  io.on("connection", (socket) => {
    console.log(`[AUDIO_CONNECTION_INFO] New socket connected: ${socket.id} at ${getPKTTimestamp()}`);

    /** User joins audio socket (updates presence) */
    socket.on("join", async (userId) => {
      console.log(`[AUDIO_JOIN_INFO] Join event received for userId: ${JSON.stringify(userId)} (type: ${typeof userId}) at ${getPKTTimestamp()}`);
      
      if (!userId) {
        console.error(`[AUDIO_JOIN_ERROR] Invalid userId (null/empty), disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      // Handle if userId is object (common Flutter issue: send stringified _id, phone, or nested {userId: '...'})
      let userIdStr = '';
      if (typeof userId === 'object' && userId !== null) {
        // Try nested 'userId' first (as seen in logs: { userId: '+923120110916' })
        userIdStr = userId.userId || userId._id || userId.phone || userId.id || JSON.stringify(userId);
        console.log(`[AUDIO_JOIN_DEBUG] Converted object userId to string: ${userIdStr} (raw object keys: ${Object.keys(userId)}) at ${getPKTTimestamp()}`);
      } else {
        userIdStr = userId.toString();
      }

      // Final validation
      if (!userIdStr || userIdStr === '[object Object]' || userIdStr === 'undefined') {
        console.error(`[AUDIO_JOIN_ERROR] Failed to extract valid userIdStr from: ${JSON.stringify(userId)} — disconnecting socket: ${socket.id} at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      console.log(`[AUDIO_JOIN_DEBUG] Final userIdStr extracted: ${userIdStr} at ${getPKTTimestamp()}`);

      // Resolve to MongoDB ObjectID for consistent tracking
      const resolvedUserId = await resolveToUserId(userIdStr);
      console.log(`[AUDIO_JOIN_DEBUG] Resolved userId ${userIdStr} to MongoDB ID: ${resolvedUserId} at ${getPKTTimestamp()}`);

      if (!resolvedUserId) {
        console.error(`[AUDIO_JOIN_ERROR] Could not resolve userId ${userIdStr} to valid user at ${getPKTTimestamp()}`);
        return socket.disconnect(true);
      }

      // Force disconnect old socket if already online
      if (onlineUsers.has(resolvedUserId)) {
        const oldSocketId = onlineUsers.get(resolvedUserId);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.disconnect(true);
          console.warn(`[AUDIO_JOIN_WARN] Disconnected old socket ${oldSocketId} for user ${resolvedUserId} at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[AUDIO_JOIN_WARN] Old socket ${oldSocketId} not found for user ${resolvedUserId} at ${getPKTTimestamp()}`);
        }
      } else {
        console.log(`[AUDIO_JOIN_INFO] Added new online user ${resolvedUserId} with socket ${socket.id} at ${getPKTTimestamp()}`);
      }
      onlineUsers.set(resolvedUserId, socket.id);
      
      socket.userId = resolvedUserId;

      // Update user online status in database
      try {
        const dbUpdate = await User.findByIdAndUpdate(resolvedUserId, { online: true, lastSeen: new Date() });
        console.log(`[AUDIO_JOIN_SUCCESS] User ${resolvedUserId} marked online in DB (updated: ${!!dbUpdate}) at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[AUDIO_JOIN_ERROR] DB update failed for ${resolvedUserId}: ${dbErr.message} at ${getPKTTimestamp()}`);
        // Don't disconnect on DB error—keep socket alive
      }
      
      broadcastOnlineUsers();
    });

    /** Request initial online users list */
    socket.on("request_online_users", () => {
      console.log(`[AUDIO_REQUEST_INFO] Online users list requested by socket ${socket.id} (user: ${socket.userId || 'unknown'}) at ${getPKTTimestamp()}`);
      broadcastOnlineUsers();
    });

    /** Initiate audio call (with WebRTC offer) */
    socket.on("call_user", async ({ callerId, calleeId, offer }) => {
      try {
        console.log(`[AUDIO_CALL_INIT_INFO] Call_user event received: callerId=${callerId}, calleeId=${calleeId}, offer keys=${Object.keys(offer || {})} at ${getPKTTimestamp()}`);
        
        if (!callerId || !calleeId) {
          console.error(`[AUDIO_CALL_ERROR] Missing callerId or calleeId in payload at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Missing call participants" });
        }

        // Resolve both caller and callee to MongoDB ObjectIDs
        const resolvedCaller = await resolveToUserId(callerId);
        const resolvedCallee = await resolveToUserId(calleeId);
        
        if (!resolvedCaller || !resolvedCallee) {
          console.error(`[AUDIO_CALL_ERROR] Could not resolve caller or callee IDs (caller: ${resolvedCaller}, callee: ${resolvedCallee}) at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid user identifiers" });
        }

        console.log(`[AUDIO_CALL_DEBUG] Processing call attempt: ${resolvedCaller} → ${resolvedCallee} at ${getPKTTimestamp()}`);

        // Prevent self-call
        if (resolvedCaller === resolvedCallee) {
          console.error(`[AUDIO_CALL_ERROR] Self-call attempt detected for ${resolvedCaller} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "You cannot call yourself" });
        }

        // Check if caller is online (basic sanity)
        if (!onlineUsers.has(resolvedCaller)) {
          console.error(`[AUDIO_CALL_ERROR] Caller ${resolvedCaller} not online at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "You must be online to call" });
        }

        // Check if callee is online
        if (!onlineUsers.has(resolvedCallee)) {
          console.error(`[AUDIO_CALL_ERROR] Callee ${resolvedCallee} is offline at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "User is offline" });
        }

        // Check if users are blocked
        console.log(`[AUDIO_CALL_DEBUG] Checking blocks between ${resolvedCaller} and ${resolvedCallee} at ${getPKTTimestamp()}`);
        const blocked = await Block.findOne({
          $or: [
            { blockerId: resolvedCallee, blockedId: resolvedCaller },
            { blockerId: resolvedCaller, blockedId: resolvedCallee },
          ],
        });
        if (blocked) {
          console.error(`[AUDIO_CALL_ERROR] Call blocked: ${resolvedCaller} → ${resolvedCallee} (block doc: ${JSON.stringify(blocked)}) at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Cannot call: User is blocked" });
        }
        console.log(`[AUDIO_CALL_DEBUG] No blocks found between ${resolvedCaller} and ${resolvedCallee} at ${getPKTTimestamp()}`);

        // Check if callee is busy
        if (busyUsers.has(resolvedCallee) || pendingCalls.has(resolvedCallee)) {
          console.error(`[AUDIO_CALL_ERROR] Callee ${resolvedCallee} is busy (busy: ${busyUsers.has(resolvedCallee)}, pending: ${pendingCalls.has(resolvedCallee)}) at ${getPKTTimestamp()}`);
          return socket.emit("user_busy", { calleeId: resolvedCallee });
        }

        // Validate offer structure
        if (!offer || !offer.type || !offer.sdp || typeof offer.sdp !== 'string' || !offer.sdp.trim()) {
          console.error(`[AUDIO_CALL_ERROR] Invalid offer structure from ${resolvedCaller}: type=${offer?.type}, sdp length=${offer?.sdp?.length || 0} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call offer structure" });
        }
        console.log(`[AUDIO_CALL_DEBUG] Offer validated: type=${offer.type}, sdp length=${offer.sdp.length} at ${getPKTTimestamp()}`);

        // Store pending call with resolved MongoDB IDs and timestamp for timeout
        pendingCalls.set(resolvedCallee, { callerId: resolvedCaller, offer, timestamp: Date.now() });
        console.log(`[AUDIO_CALL_PENDING_INFO] Stored pending call: ${resolvedCaller} → ${resolvedCallee} (offer type: ${offer.type}) at ${getPKTTimestamp()}`);

        const calleeSocket = onlineUsers.get(resolvedCallee);
        if (calleeSocket) {
          // Get phone numbers for display purposes
          const callerPhone = await getPhoneFromUserId(resolvedCaller);
          const calleePhone = await getPhoneFromUserId(resolvedCallee);
          
          io.to(calleeSocket).emit("incoming_call", {
            callerId: callerPhone || resolvedCaller, // Send phone for display, fallback to ID
            offer,
            callerUserId: resolvedCaller, // Send MongoDB ID for internal use
            calleeUserId: resolvedCallee,
          });
          console.log(`[AUDIO_CALL_INCOMING_INFO] Sent incoming_call to ${resolvedCallee} (socket: ${calleeSocket}, callerPhone: ${callerPhone}) at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[AUDIO_CALL_WARN] Callee socket not found for ${resolvedCallee} despite online status at ${getPKTTimestamp()}`);
          pendingCalls.delete(resolvedCallee); // Cleanup
          return socket.emit("call_error", { error: "Callee unavailable" });
        }

        socket.emit("calling", { calleeId: calleeId }); // Send original calleeId back for display
        console.log(`[AUDIO_CALL_SUCCESS] Call initiated and ringing: ${resolvedCaller} → ${resolvedCallee} at ${getPKTTimestamp()}`);
      } catch (err) {
        console.error(`[AUDIO_CALL_ERROR] Unexpected error in call_user: ${err.message} at ${getPKTTimestamp()}`, err.stack);
        socket.emit("call_error", { error: "Failed to initiate call" });
      }
    });

    /** Accept call (with WebRTC answer) */
    socket.on("accept_call", async ({ callerId, calleeId, answer }) => {
      try {
        console.log(`[AUDIO_ACCEPT_INFO] Accept_call event received: callerId=${callerId}, calleeId=${calleeId}, answer keys=${Object.keys(answer || {})} at ${getPKTTimestamp()}`);
        
        // Resolve to MongoDB ObjectIDs
        const resolvedCaller = await resolveToUserId(callerId);
        const resolvedCallee = await resolveToUserId(calleeId);
        
        if (!resolvedCaller || !resolvedCallee) {
          console.error(`[AUDIO_ACCEPT_ERROR] Could not resolve caller or callee IDs (caller: ${resolvedCaller}, callee: ${resolvedCallee}) at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid user identifiers" });
        }

        const pending = pendingCalls.get(resolvedCallee);
        if (!pending || pending.callerId !== resolvedCaller) {
          console.error(`[AUDIO_ACCEPT_ERROR] No valid pending call for ${resolvedCallee} from ${resolvedCaller} (pending: ${!!pending}) at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "No pending call to accept" });
        }

        // Validate answer structure
        if (!answer || !answer.type || !answer.sdp || typeof answer.sdp !== 'string' || !answer.sdp.trim()) {
          console.error(`[AUDIO_ACCEPT_ERROR] Invalid answer structure from ${resolvedCallee}: type=${answer?.type}, sdp length=${answer?.sdp?.length || 0} at ${getPKTTimestamp()}`);
          return socket.emit("call_error", { error: "Invalid call answer structure" });
        }
        console.log(`[AUDIO_ACCEPT_DEBUG] Answer validated: type=${answer.type}, sdp length=${answer.sdp.length} at ${getPKTTimestamp()}`);

        const { offer } = pending;
        pendingCalls.delete(resolvedCallee);
        console.log(`[AUDIO_ACCEPT_INFO] Removed pending call: ${resolvedCaller} → ${resolvedCallee} at ${getPKTTimestamp()}`);

        // Mark both as busy
        busyUsers.add(resolvedCaller);
        busyUsers.add(resolvedCallee);
        console.log(`[AUDIO_BUSY_INFO] Marked users busy: ${resolvedCaller}, ${resolvedCallee} at ${getPKTTimestamp()}`);

        const callerSocket = onlineUsers.get(resolvedCaller);
        if (callerSocket) {
          io.to(callerSocket).emit("call_accepted", {
            calleeId: calleeId, // Send original for display
            answer,
            callerUserId: resolvedCaller,
            calleeUserId: resolvedCallee,
          });
          console.log(`[AUDIO_ACCEPT_SENT_INFO] Sent call_accepted to ${resolvedCaller} (socket: ${callerSocket}) at ${getPKTTimestamp()}`);
        } else {
          console.warn(`[AUDIO_ACCEPT_WARN] Caller socket not found for ${resolvedCaller} at ${getPKTTimestamp()}`);
        }

        // Create a unique room for this call
        const callRoom = [resolvedCaller, resolvedCallee].sort().join("-");
        socket.join(callRoom); // Callee joins room
        console.log(`[AUDIO_ROOM_INFO] Callee ${resolvedCallee} joined room ${callRoom} at ${getPKTTimestamp()}`);

        if (callerSocket) {
          const callerSocketObj = io.sockets.sockets.get(callerSocket);
          if (callerSocketObj) {
            callerSocketObj.join(callRoom);
            console.log(`[AUDIO_ROOM_INFO] Caller ${resolvedCaller} joined room ${callRoom} at ${getPKTTimestamp()}`);
          }
          io.to(callerSocket).emit("join_call_room", { room: callRoom });
          console.log(`[AUDIO_ROOM_NOTIFY_INFO] Notified caller to join room ${callRoom} at ${getPKTTimestamp()}`);
        }

        // Send buffered ICE candidates if any
        if (iceBuffer.has(resolvedCaller)) {
          const bufferedCandidates = iceBuffer.get(resolvedCaller);
          io.to(callerSocket).emit("ice_candidate", bufferedCandidates);
          iceBuffer.delete(resolvedCaller);
          console.log(`[AUDIO_ICE_BUFFER_INFO] Sent ${bufferedCandidates.length} buffered ICE candidates to caller ${resolvedCaller} at ${getPKTTimestamp()}`);
        }
        if (iceBuffer.has(resolvedCallee)) {
          const bufferedCandidates = iceBuffer.get(resolvedCallee);
          io.to(calleeSocket).emit("ice_candidate", bufferedCandidates);
          iceBuffer.delete(resolvedCallee);
          console.log(`[AUDIO_ICE_BUFFER_INFO] Sent ${bufferedCandidates.length} buffered ICE candidates to callee ${resolvedCallee} at ${getPKTTimestamp()}`);
        }

        console.log(`[AUDIO_ACCEPT_SUCCESS] Call accepted and connected: ${resolvedCaller} ↔ ${resolvedCallee} in room ${callRoom} at ${getPKTTimestamp()}`);
      } catch (err) {
        console.error(`[AUDIO_ACCEPT_ERROR] Unexpected error in accept_call: ${err.message} at ${getPKTTimestamp()}`, err.stack);
        socket.emit("call_error", { error: "Failed to accept call" });
      }
    });

    /** Reject call */
    socket.on("reject_call", async ({ callerId, calleeId }) => {
      console.log(`[AUDIO_REJECT_INFO] Reject_call event received: callerId=${callerId}, calleeId=${calleeId} at ${getPKTTimestamp()}`);
      
      // Resolve to MongoDB ObjectIDs
      const resolvedCaller = await resolveToUserId(callerId);
      const resolvedCallee = await resolveToUserId(calleeId);
      
      if (!resolvedCaller || !resolvedCallee) {
        console.error(`[AUDIO_REJECT_ERROR] Could not resolve caller or callee IDs at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "Invalid user identifiers" });
      }

      const pending = pendingCalls.get(resolvedCallee);
      if (!pending || pending.callerId !== resolvedCaller) {
        console.error(`[AUDIO_REJECT_ERROR] No valid pending call to reject for ${resolvedCallee} at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "No pending call to reject" });
      }

      pendingCalls.delete(resolvedCallee);
      console.log(`[AUDIO_REJECT_INFO] Pending call rejected: ${resolvedCaller} → ${resolvedCallee} at ${getPKTTimestamp()}`);

      const callerSocket = onlineUsers.get(resolvedCaller);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", { calleeId: calleeId });
        console.log(`[AUDIO_REJECT_SENT_INFO] Sent call_rejected to ${resolvedCaller} (socket: ${callerSocket}) at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[AUDIO_REJECT_WARN] Caller socket not found for rejection to ${resolvedCaller} at ${getPKTTimestamp()}`);
      }
    });

    /** Relay ICE candidate (with buffering) */
    socket.on("ice_candidate", async ({ candidate, toUserId }) => {
      console.log(`[AUDIO_ICE_INFO] ICE_candidate event received: toUserId=${toUserId}, candidate keys=${Object.keys(candidate || {})} at ${getPKTTimestamp()}`);
      
      if (!candidate || !candidate.candidate) {
        console.error(`[AUDIO_ICE_ERROR] Invalid ICE candidate (missing candidate field, keys: ${Object.keys(candidate || {})}) at ${getPKTTimestamp()}`);
        return socket.emit("call_error", { error: "Invalid ICE candidate" });
      }
      console.log(`[AUDIO_ICE_DEBUG] Valid ICE candidate: candidate=${candidate.candidate.substring(0, 50)}... (sdpMLineIndex: ${candidate.sdpMLineIndex}) at ${getPKTTimestamp()}`);

      // Resolve toUserId to MongoDB ObjectID
      const resolvedToUserId = await resolveToUserId(toUserId);
      
      if (!resolvedToUserId) {
        console.warn(`[AUDIO_ICE_WARN] Could not resolve toUserId ${toUserId} at ${getPKTTimestamp()}`);
        return;
      }

      const targetSocket = onlineUsers.get(resolvedToUserId);
      if (targetSocket) {
        io.to(targetSocket).emit("ice_candidate", { candidate });
        console.log(`[AUDIO_ICE_SENT_INFO] ICE candidate relayed to ${resolvedToUserId} (socket: ${targetSocket}) at ${getPKTTimestamp()}`);
      } else {
        if (!iceBuffer.has(resolvedToUserId)) iceBuffer.set(resolvedToUserId, []);
        iceBuffer.get(resolvedToUserId).push({ candidate });
        console.log(`[AUDIO_ICE_BUFFER_INFO] Buffered ICE candidate for ${resolvedToUserId} (buffer size: ${iceBuffer.get(resolvedToUserId).length}) at ${getPKTTimestamp()}`);
      }
    });

    /** End call */
    socket.on("end_call", async ({ userId, peerId }) => {
      console.log(`[AUDIO_END_INFO] End_call event received: userId=${userId}, peerId=${peerId} at ${getPKTTimestamp()}`);
      
      // Resolve to MongoDB ObjectIDs
      const resolvedUser = await resolveToUserId(userId);
      const resolvedPeer = await resolveToUserId(peerId);
      
      if (!resolvedUser || !resolvedPeer) {
        console.error(`[AUDIO_END_ERROR] Could not resolve user or peer IDs at ${getPKTTimestamp()}`);
        return;
      }

      const wasBusyUser = busyUsers.has(resolvedUser);
      const wasBusyPeer = busyUsers.has(resolvedPeer);
      busyUsers.delete(resolvedUser);
      busyUsers.delete(resolvedPeer);
      if (wasBusyUser || wasBusyPeer) {
        console.log(`[AUDIO_END_BUSY_INFO] Unmarked busy users: ${resolvedUser}, ${resolvedPeer} (was busy: user=${wasBusyUser}, peer=${wasBusyPeer}) at ${getPKTTimestamp()}`);
      } else {
        console.log(`[AUDIO_END_BUSY_DEBUG] No busy status to unmark for ${resolvedUser}/${resolvedPeer} at ${getPKTTimestamp()}`);
      }

      const peerSocket = onlineUsers.get(resolvedPeer);
      if (peerSocket) {
        io.to(peerSocket).emit("call_ended", { fromUserId: userId }); // Send original for display
        console.log(`[AUDIO_END_SENT_INFO] Call_ended notification sent to ${resolvedPeer} (socket: ${peerSocket}) at ${getPKTTimestamp()}`);
      } else {
        console.warn(`[AUDIO_END_WARN] Peer socket not found for ${resolvedPeer} at ${getPKTTimestamp()}`);
      }

      const callRoom = [resolvedUser, resolvedPeer].sort().join("-");
      const wasInRoom = socket.rooms.has(callRoom);
      socket.leave(callRoom);
      if (wasInRoom) {
        console.log(`[AUDIO_END_ROOM_INFO] User ${resolvedUser} left room ${callRoom} at ${getPKTTimestamp()}`);
      } else {
        console.log(`[AUDIO_END_ROOM_DEBUG] User ${resolvedUser} not in room ${callRoom} (no-op leave) at ${getPKTTimestamp()}`);
      }

      if (peerSocket) {
        const peerSocketObj = io.sockets.sockets.get(peerSocket);
        if (peerSocketObj) {
          const peerWasInRoom = peerSocketObj.rooms.has(callRoom);
          peerSocketObj.leave(callRoom);
          if (peerWasInRoom) {
            console.log(`[AUDIO_END_ROOM_INFO] Peer ${resolvedPeer} left room ${callRoom} at ${getPKTTimestamp()}`);
          }
        }
      }
    });

    socket.on("disconnect", async () => {
      console.log(`[AUDIO_DISCONNECT_INFO] Socket disconnect event: ${socket.id} (user: ${socket.userId || 'unknown'}) at ${getPKTTimestamp()}`);
      
      const disconnectedUserId = Array.from(onlineUsers.entries())
        .find(([_, socketId]) => socketId === socket.id)?.[0];

      if (!disconnectedUserId) {
        console.warn(`[AUDIO_DISCONNECT_WARN] Unknown socket disconnected: ${socket.id} at ${getPKTTimestamp()}`);
        return;
      }

      console.log(`[AUDIO_DISCONNECT_DEBUG] Handling disconnect for user: ${disconnectedUserId} at ${getPKTTimestamp()}`);

      const wasBusy = busyUsers.has(disconnectedUserId);

      onlineUsers.delete(disconnectedUserId);
      if (wasBusy) busyUsers.delete(disconnectedUserId); // Only if was busy
      console.log(`[AUDIO_DISCONNECT_CLEANUP_INFO] Removed ${disconnectedUserId} from online/busy maps (was busy: ${wasBusy}) at ${getPKTTimestamp()}`);

      try {
        const dbUpdate = await User.findByIdAndUpdate(disconnectedUserId, { online: false, lastSeen: new Date() });
        console.log(`[AUDIO_DISCONNECT_DB_INFO] User ${disconnectedUserId} marked offline in DB (updated: ${!!dbUpdate}) at ${getPKTTimestamp()}`);
      } catch (dbErr) {
        console.error(`[AUDIO_DISCONNECT_ERROR] DB update failed for ${disconnectedUserId}: ${dbErr.message} at ${getPKTTimestamp()}`);
      }

      if (pendingCalls.has(disconnectedUserId)) {
        const { callerId } = pendingCalls.get(disconnectedUserId);
        pendingCalls.delete(disconnectedUserId);
        console.log(`[AUDIO_DISCONNECT_PENDING_INFO] Cleaned pending call for ${disconnectedUserId} (caller: ${callerId}) at ${getPKTTimestamp()}`);

        const callerSocket = onlineUsers.get(callerId);
        if (callerSocket) {
          io.to(callerSocket).emit("call_ended", { calleeId: disconnectedUserId, reason: "offline" });
          console.log(`[AUDIO_DISCONNECT_NOTIFY_INFO] Sent call_ended (offline) to caller ${callerId} (socket: ${callerSocket}) at ${getPKTTimestamp()}`);
        }
      }

      if (wasBusy) {
        console.log(`[AUDIO_DISCONNECT_BUSY_INFO] Notifying peers of busy user disconnect: ${disconnectedUserId} at ${getPKTTimestamp()}`);
        let notifiedCount = 0;
        for (const [userId, sockId] of onlineUsers.entries()) {
          if (busyUsers.has(userId)) { // Check current busy (post-delete)
            const callRoom = [disconnectedUserId, userId].sort().join("-");
            if (io.sockets.adapter.rooms.has(callRoom)) {
              io.to(sockId).emit("call_ended", { fromUserId: disconnectedUserId, reason: "disconnected" });
              console.log(`[AUDIO_DISCONNECT_NOTIFY_INFO] Sent call_ended (disconnected) to peer ${userId} in room ${callRoom} (socket: ${sockId}) at ${getPKTTimestamp()}`);
              notifiedCount++;
            }
          }
        }
        console.log(`[AUDIO_DISCONNECT_NOTIFY_DEBUG] Total peers notified: ${notifiedCount} at ${getPKTTimestamp()}`);
      }

      broadcastOnlineUsers();
      console.log(`[AUDIO_DISCONNECT_COMPLETE] Cleanup finished for ${disconnectedUserId} at ${getPKTTimestamp()}`);
    });
  });

  console.log(`[AUDIO_INIT_INFO] Audio Socket initialized on path /audio-socket at ${getPKTTimestamp()}`);
  return io;
};