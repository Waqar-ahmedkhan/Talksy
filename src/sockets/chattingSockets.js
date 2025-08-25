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

    /** Typing indicator */
    socket.on("typing", ({ senderId, receiverId, typing }) => {
      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("typing", { senderId, typing });
    });

    /** Send message */
    socket.on("send_message", async ({ senderId, receiverId, message }) => {
      const blocked = await Block.findOne({ blockerId: receiverId, blockedId: senderId });
      if (blocked) return;

      const chat = await Chat.create({ senderId, receiverId, message });
      const receiverSocket = onlineUsers.get(receiverId);

      if (receiverSocket) {
        io.to(receiverSocket).emit("receive_message", chat);
        chat.status = "delivered";
        await chat.save();
      }

      io.to(socket.id).emit("message_sent", chat);
    });

    /** Read message */
    socket.on("read_message", async ({ chatId, readerId }) => {
      const chat = await Chat.findById(chatId);
      if (chat && !chat.deletedFor.includes(readerId)) {
        chat.status = "read";
        await chat.save();
        const senderSocket = onlineUsers.get(chat.senderId);
        if (senderSocket) io.to(senderSocket).emit("message_read", chatId);
      }
    });

    /** Delete message */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      const chat = await Chat.findById(chatId);
      if (!chat) return;

      if (forEveryone) {
        // Mark message as deleted for all participants
        chat.message = "This message was deleted";
        chat.deletedFor = [chat.senderId, chat.receiverId];
      } else {
        // Mark message as deleted for this user only
        chat.deletedFor.push(userId);
      }
      await chat.save();

      const senderSocket = onlineUsers.get(chat.senderId);
      const receiverSocket = onlineUsers.get(chat.receiverId);
      if (senderSocket) io.to(senderSocket).emit("message_deleted", chat);
      if (receiverSocket) io.to(receiverSocket).emit("message_deleted", chat);
    });

    /** Block user */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      await Block.create({ blockerId, blockedId });
      const blockedSocket = onlineUsers.get(blockedId);
      if (blockedSocket) io.to(blockedSocket).emit("blocked", { blockerId });
    });

    /** Unblock user */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      await Block.deleteOne({ blockerId, blockedId });
    });

    /** Disconnect */
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
