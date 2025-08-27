import { Server } from "socket.io";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Block from "../models/Block.js";

export const initChatSocket = (server) => {
  const io = new Server(server, { cors: { origin: "*" } });
  const onlineUsers = new Map(); // userId -> socketId

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    /** User joins chat */
    socket.on("join", async (userId) => {
      onlineUsers.set(userId, socket.id);
      await User.findByIdAndUpdate(userId, { online: true, lastSeen: new Date() });
      socket.broadcast.emit("presence_update", { userId, online: true, lastSeen: new Date() });
    });

    /** Typing indicator for text */
    socket.on("typing", async ({ senderId, receiverId, typing }) => {
      const blocked = await Block.findOne({
        $or: [
          { blockerId: receiverId, blockedId: senderId },
          { blockerId: senderId, blockedId: receiverId },
        ],
      });
      if (blocked) return; // Prevent if blocked

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("typing", { senderId, typing });
    });

    /** Recording audio indicator (new: like WhatsApp voice recording status) */
    socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
      const blocked = await Block.findOne({
        $or: [
          { blockerId: receiverId, blockedId: senderId },
          { blockerId: senderId, blockedId: receiverId },
        ],
      });
      if (blocked) return; // Prevent if blocked

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("recording_audio", { senderId, recording });
    });

    /** Send text message (improved with status) */
    socket.on("send_message", async ({ senderId, receiverId, message }) => {
      try {
        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          return socket.emit("message_error", { error: "User is blocked" });
        }

        const chat = await Chat.create({
          senderId,
          receiverId,
          type: "text",
          content: message,
          status: "sent",
          deletedFor: [],
        });

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_message", chat);
          chat.status = "delivered";
          await chat.save();
        }

        socket.emit("message_sent", chat); // Confirm to sender
      } catch (err) {
        console.error("send_message error:", err);
        socket.emit("message_error", { error: "Failed to send message" });
      }
    });

    /** Send voice message (new: supports up to 3 min, with duration) */
    socket.on("send_voice", async ({ senderId, receiverId, voiceUrl, duration }) => {
      try {
        if (duration > 180) { // 3 minutes max (180 seconds)
          return socket.emit("voice_error", { error: "Voice message too long (max 3 minutes)" });
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          return socket.emit("voice_error", { error: "User is blocked" });
        }

        const chat = await Chat.create({
          senderId,
          receiverId,
          type: "voice",
          content: voiceUrl, // URL to audio file (e.g., uploaded via separate endpoint)
          duration, // in seconds, for client UI
          status: "sent",
          deletedFor: [],
        });

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_voice", chat);
          chat.status = "delivered";
          await chat.save();
        }

        socket.emit("voice_sent", chat); // Confirm to sender
      } catch (err) {
        console.error("send_voice error:", err);
        socket.emit("voice_error", { error: "Failed to send voice message" });
      }
    });

    /** Read message (works for text and voice) */
    socket.on("read_message", async ({ chatId, readerId }) => {
      const chat = await Chat.findById(chatId);
      if (chat && !chat.deletedFor.includes(readerId)) {
        chat.status = "read";
        await chat.save();
        const senderSocket = onlineUsers.get(chat.senderId);
        if (senderSocket) io.to(senderSocket).emit("message_read", chatId);
      }
    });

    /** Delete message (improved propagation for text/voice) */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      const chat = await Chat.findById(chatId);
      if (!chat) return socket.emit("delete_error", { error: "Message not found" });

      if (forEveryone && chat.senderId === userId) { // Only sender can delete for everyone
        chat.content = "This message was deleted";
        chat.deletedFor = [chat.senderId, chat.receiverId];
      } else {
        chat.deletedFor.push(userId);
      }
      await chat.save();

      const senderSocket = onlineUsers.get(chat.senderId);
      const receiverSocket = onlineUsers.get(chat.receiverId);
      if (senderSocket) io.to(senderSocket).emit("message_deleted", chat);
      if (receiverSocket) io.to(receiverSocket).emit("message_deleted", chat);

      socket.emit("delete_success", { chatId });
    });

    /** Block user (enhanced notification) */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      await Block.create({ blockerId, blockedId });
      const blockedSocket = onlineUsers.get(blockedId);
      if (blockedSocket) io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
      socket.emit("block_success", { blockedId });
    });

    /** Unblock user (enhanced notification) */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      await Block.deleteOne({ blockerId, blockedId });
      const unblockedSocket = onlineUsers.get(blockedId);
      if (unblockedSocket) io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
      socket.emit("unblock_success", { blockedId });
    });

    /** Disconnect (unchanged, but robust) */
    socket.on("disconnect", async () => {
      for (const [userId, sockId] of onlineUsers.entries()) {
        if (sockId === socket.id) {
          onlineUsers.delete(userId);
          const now = new Date();
          await User.findByIdAndUpdate(userId, { online: false, lastSeen: now });
          socket.broadcast.emit("presence_update", { userId, online: false, lastSeen: now });
        }
      }
      console.log("User disconnected:", socket.id);
    });
  });

  return io;
};