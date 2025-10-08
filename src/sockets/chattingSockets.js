import { Server } from "socket.io";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Block from "../models/Block.js";
import Group from "../models/Group.js";
import Channel from "../models/Channel.js";
import Profile from "../models/Profile.js";
import jwt from "jsonwebtoken";
import moment from "moment-timezone";

export const initChatSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/chat-socket",
    pingTimeout: 60000,
    pingInterval: 25000,
  });
  const onlineUsers = new Map(); // userId -> socketId

  // Middleware to verify JWT token
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.query.userId;
    const logTimestamp = () => moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

    if (!token || !userId) {
      console.error(`❌ Auth error: Missing token or userId at ${logTimestamp()}`, { userId });
      return next(new Error("Authentication error: Token and userId required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const profile = await Profile.findById(userId);
      if (!profile || decoded.phone !== profile.phone) {
        console.error(`❌ Auth error: Invalid userId=${userId} or token at ${logTimestamp()}`, { decoded });
        return next(new Error("Authentication error: Invalid user or token"));
      }
      socket.userId = userId;
      socket.phone = profile.phone; // Store for User lookup
      next();
    } catch (err) {
      console.error(`❌ Auth error: ${err.message} at ${logTimestamp()}`, { userId });
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const logTimestamp = () => moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

    // Handle connection errors
    socket.on("connect_error", (err) => {
      console.error(`❌ Connection error: ${err.message} at ${logTimestamp()}`, { socketId: socket.id });
    });

    /** User joins chat */
    socket.on("join", async (userId) => {
      try {
        if (userId !== socket.userId) {
          socket.emit("join_error", { error: "Invalid user ID" });
          return;
        }

        const user = await User.findOne({ phone: socket.phone });
        if (!user) {
          socket.emit("join_error", { error: "User not found" });
          return;
        }

        onlineUsers.set(userId, socket.id);
        socket.join(userId);
        await User.findByIdAndUpdate(user._id, { online: true, lastSeen: new Date() });
        io.emit("presence_update", {
          userId,
          online: true,
          lastSeen: new Date().toISOString(),
        });
      } catch (err) {
        socket.emit("join_error", { error: "Server error during join" });
      }
    });

    /** Typing indicator */
    socket.on("typing", async ({ senderId, receiverId, typing }) => {
      try {
        if (!senderId || !receiverId || typeof typing !== "boolean" || senderId !== socket.userId) {
          socket.emit("typing_error", { error: "Invalid typing data" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          socket.emit("typing_error", { error: "User is blocked" });
          return;
        }

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("typing", { senderId, receiverId, typing });
        }
      } catch (err) {
        socket.emit("typing_error", { error: "Server error during typing" });
      }
    });

    /** Recording audio indicator */
    socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
      try {
        if (!senderId || !receiverId || typeof recording !== "boolean" || senderId !== socket.userId) {
          socket.emit("recording_audio_error", { error: "Invalid recording data" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          socket.emit("recording_audio_error", { error: "User is blocked" });
          return;
        }

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("recording_audio", { senderId, receiverId, recording });
        }
      } catch (err) {
        socket.emit("recording_audio_error", { error: "Server error during recording" });
      }
    });

    /** Uploading media indicator */
    socket.on("uploading_media", async ({ senderId, receiverId, groupId, channelId, uploading }) => {
      try {
        if (!senderId || (!receiverId && !groupId && !channelId) || typeof uploading !== "boolean" || senderId !== socket.userId) {
          socket.emit("uploading_media_error", { error: "Invalid uploading data" });
          return;
        }

        if (receiverId) {
          const blocked = await Block.findOne({
            $or: [
              { blockerId: receiverId, blockedId: senderId },
              { blockerId: senderId, blockedId: receiverId },
            ],
          });
          if (blocked) {
            socket.emit("uploading_media_error", { error: "User is blocked" });
            return;
          }

          const receiverSocket = onlineUsers.get(receiverId);
          if (receiverSocket) {
            io.to(receiverSocket).emit("uploading_media", { senderId, receiverId, uploading });
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (!group || !group.members.includes(senderId)) {
            socket.emit("uploading_media_error", { error: group ? "Sender not in group" : "Group not found" });
            return;
          }
          group.members
            .map(id => id.toString())
            .filter(id => id !== senderId)
            .forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, groupId, uploading });
            });
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (!channel || !channel.members.includes(senderId)) {
            socket.emit("uploading_media_error", { error: channel ? "Sender not in channel" : "Channel not found" });
            return;
          }
          channel.members
            .map(id => id.toString())
            .filter(id => id !== senderId)
            .forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, channelId, uploading });
            });
        }
      } catch (err) {
        socket.emit("uploading_media_error", { error: "Server error during uploading" });
      }
    });

    /** Send text message */
    socket.on("send_message", async (data, callback) => {
      const timestamp = moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (!data.senderId || !data.receiverId || !data.content || data.senderId !== socket.userId) {
          socket.emit("message_error", { error: "Invalid message data" });
          if (callback) callback({ error: "Invalid message data" });
          return;
        }

        // Validate sender profile
        const senderProfile = await Profile.findById(data.senderId);
        if (!senderProfile) {
          socket.emit("message_error", { error: "Sender profile not found" });
          if (callback) callback({ error: "Sender profile not found" });
          return;
        }

        // Validate receiver profile, with fallback to create if User exists
        let receiverProfile = await Profile.findById(data.receiverId);
        if (!receiverProfile) {
          const user = await User.findById(data.receiverId); // Check if client sent User._id by mistake
          if (user) {
            // Create minimal Profile if User exists (fallback)
            receiverProfile = await Profile.create({
              phone: user.phone,
              displayName: user.displayName,
              randomNumber: Math.random().toString(36).substring(2, 10), // Generate random
              isVisible: false,
              isNumberVisible: false,
              avatarUrl: "",
            });
            data.receiverId = receiverProfile._id.toString(); // Update to Profile._id
          } else {
            console.error(`❌ Receiver profile/user not found: receiverId=${data.receiverId} at ${timestamp}`);
            socket.emit("message_error", { error: "Receiver profile not found" });
            if (callback) callback({ error: "Receiver profile not found" });
            return;
          }
        }

        const isBlocked = await Block.findOne({
          $or: [
            { blockerId: data.senderId, blockedId: data.receiverId },
            { blockerId: data.receiverId, blockedId: data.senderId },
          ],
        });
        if (isBlocked) {
          socket.emit("message_error", { error: "User is blocked" });
          if (callback) callback({ error: "User is blocked" });
          return;
        }

        const chat = new Chat({
          senderId: data.senderId,
          receiverId: data.receiverId,
          content: data.content,
          type: "text",
          status: "sent",
        });

        await chat.save();

        const messageData = {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId.toString(),
          content: chat.content,
          type: chat.type,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          duration: chat.duration || 0,
        };

        socket.emit("message_sent", messageData);
        const receiverSocket = onlineUsers.get(data.receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_message", messageData);
          chat.status = "delivered";
          await chat.save();
          messageData.status = "delivered";
        }

        if (callback) callback({ status: "success", id: chat._id.toString() });
      } catch (err) {
        console.error(`❌ Send message error: ${err.message} at ${timestamp}`, { senderId: data.senderId, receiverId: data.receiverId });
        socket.emit("message_error", { error: "Failed to send message" });
        if (callback) callback({ error: "Failed to send message" });
      }
    });

    /** Send voice message */
    socket.on("send_voice", async ({ senderId, receiverId, content, duration }, callback) => {
      try {
        if (!senderId || !receiverId || !content || typeof content !== "string" || content.trim() === "" || senderId !== socket.userId || typeof duration !== "number" || duration <= 0 || duration > 180) {
          socket.emit("voice_error", { error: "Invalid voice data or duration (max 3 minutes)" });
          if (callback) callback({ error: "Invalid voice data or duration" });
          return;
        }

        const senderProfile = await Profile.findById(senderId);
        let receiverProfile = await Profile.findById(receiverId);
        if (!senderProfile || !receiverProfile) {
          if (!receiverProfile) {
            const user = await User.findById(receiverId);
            if (user) {
              receiverProfile = await Profile.create({
                phone: user.phone,
                displayName: user.displayName,
                randomNumber: Math.random().toString(36).substring(2, 10),
                isVisible: false,
                isNumberVisible: false,
                avatarUrl: "",
              });
              receiverId = receiverProfile._id.toString();
            } else {
              socket.emit("voice_error", { error: "User profile not found" });
              if (callback) callback({ error: "User profile not found" });
              return;
            }
          } else {
            socket.emit("voice_error", { error: "Sender profile not found" });
            if (callback) callback({ error: "Sender profile not found" });
            return;
          }
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          socket.emit("voice_error", { error: "User is blocked" });
          if (callback) callback({ error: "User is blocked" });
          return;
        }

        const chat = await Chat.create({
          senderId,
          receiverId,
          type: "voice",
          content,
          duration,
          status: "sent",
          deletedFor: [],
        });

        const voiceData = {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId.toString(),
          content: chat.content,
          type: chat.type,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          duration: chat.duration || 0,
        };

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_voice", voiceData);
          chat.status = "delivered";
          await chat.save();
          voiceData.status = "delivered";
        }

        socket.emit("voice_sent", voiceData);
        if (callback) callback({ status: "success", id: chat._id.toString() });
      } catch (err) {
        socket.emit("voice_error", { error: "Failed to send voice message" });
        if (callback) callback({ error: "Server error" });
      }
    });

    /** Send media (images, videos, documents) */
    socket.on("send_media", async ({ senderId, receiverId, groupId, channelId, files }, callback) => {
      try {
        if (!senderId || (!receiverId && !groupId && !channelId) || !files || !Array.isArray(files) || files.length === 0 || files.length > 10 || senderId !== socket.userId) {
          socket.emit("media_error", { error: "Invalid media data (1-10 files required)" });
          if (callback) callback({ error: "Invalid media data" });
          return;
        }

        const senderProfile = await Profile.findById(senderId);
        if (!senderProfile) {
          socket.emit("media_error", { error: "Sender profile not found" });
          if (callback) callback({ error: "Sender profile not found" });
          return;
        }

        // Validate files
        for (const file of files) {
          const { type, url, fileType, duration, fileName } = file;
          if (!["image", "video", "file"].includes(type) || !url || typeof url !== "string" || url.trim() === "" || !fileType || typeof fileType !== "string") {
            socket.emit("media_error", { error: `Invalid file data: ${type}` });
            if (callback) callback({ error: `Invalid file data: ${type}` });
            return;
          }
          if (type === "image" && !fileType.startsWith("image/")) {
            socket.emit("media_error", { error: `Invalid MIME type for image: ${fileType}` });
            if (callback) callback({ error: `Invalid MIME type for image: ${fileType}` });
            return;
          }
          if (type === "video" && (!fileType.startsWith("video/") || typeof duration !== "number" || duration <= 0 || duration > 300)) {
            socket.emit("media_error", { error: "Invalid video MIME type or duration (max 5 minutes)" });
            if (callback) callback({ error: "Invalid video MIME type or duration" });
            return;
          }
          if (type === "file" && (!fileName || typeof fileName !== "string")) {
            socket.emit("media_error", { error: "Documents must have a file name" });
            if (callback) callback({ error: "Documents must have a file name" });
            return;
          }
        }

        if (receiverId) {
          let receiverProfile = await Profile.findById(receiverId);
          if (!receiverProfile) {
            const user = await User.findById(receiverId);
            if (user) {
              receiverProfile = await Profile.create({
                phone: user.phone,
                displayName: user.displayName,
                randomNumber: Math.random().toString(36).substring(2, 10),
                isVisible: false,
                isNumberVisible: false,
                avatarUrl: "",
              });
              receiverId = receiverProfile._id.toString();
            } else {
              socket.emit("media_error", { error: "Receiver profile not found" });
              if (callback) callback({ error: "Receiver profile not found" });
              return;
            }
          }

          const blocked = await Block.findOne({
            $or: [
              { blockerId: receiverId, blockedId: senderId },
              { blockerId: senderId, blockedId: receiverId },
            ],
          });
          if (blocked) {
            socket.emit("media_error", { error: "User is blocked" });
            if (callback) callback({ error: "User is blocked" });
            return;
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (!group || !group.members.includes(senderId)) {
            socket.emit("media_error", { error: group ? "Sender not in group" : "Group not found" });
            if (callback) callback({ error: group ? "Sender not in group" : "Group not found" });
            return;
          }
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (!channel || !channel.members.includes(senderId)) {
            socket.emit("media_error", { error: channel ? "Sender not in channel" : "Channel not found" });
            if (callback) callback({ error: channel ? "Sender not in channel" : "Channel not found" });
            return;
          }
        }

        const chats = await Promise.all(
          files.map(file =>
            Chat.create({
              senderId,
              receiverId: receiverId || undefined,
              groupId: groupId || undefined,
              channelId: channelId || undefined,
              type: file.type,
              content: file.url,
              fileType: file.fileType,
              fileName: file.type === "file" ? file.fileName : undefined,
              duration: file.type === "video" ? file.duration : 0,
              status: "sent",
              deletedFor: [],
            })
          )
        );

        const payload = chats.map(chat => ({
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId?.toString(),
          groupId: chat.groupId?.toString(),
          channelId: chat.channelId?.toString(),
          content: chat.content,
          type: chat.type,
          fileType: chat.fileType,
          fileName: chat.fileName,
          duration: chat.duration || 0,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
        }));

        if (receiverId) {
          const receiverSocket = onlineUsers.get(receiverId);
          if (receiverSocket) {
            payload.forEach(item => io.to(receiverSocket).emit("receive_media", item));
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (group) {
            group.members
              .map(id => id.toString())
              .filter(id => id !== senderId)
              .forEach(memberId => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
              });
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (channel) {
            channel.members
              .map(id => id.toString())
              .filter(id => id !== senderId)
              .forEach(memberId => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
              });
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        }

        payload.forEach(item => socket.emit("media_sent", item));
        if (callback) callback({ status: "success", ids: chats.map(c => c._id.toString()) });
      } catch (err) {
        socket.emit("media_error", { error: "Failed to send media" });
        if (callback) callback({ error: "Server error" });
      }
    });

    /** Read message */
    socket.on("read_message", async ({ chatId, readerId }) => {
      try {
        if (!chatId || !readerId || readerId !== socket.userId) {
          socket.emit("message_error", { error: "Invalid chat or reader ID" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat || chat.deletedFor.includes(readerId)) {
          socket.emit("message_error", { error: chat ? "Message deleted" : "Message not found" });
          return;
        }

        chat.status = "read";
        await chat.save();

        const senderSocket = onlineUsers.get(chat.senderId.toString());
        if (senderSocket) {
          io.to(senderSocket).emit("message_read", { id: chatId });
        }
      } catch (err) {
        socket.emit("message_error", { error: "Failed to mark message as read" });
      }
    });

    /** Delete message */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      try {
        if (!chatId || !userId || userId !== socket.userId) {
          socket.emit("delete_error", { error: "Invalid chat or user ID" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit("delete_error", { error: "Message not found" });
          return;
        }

        if (forEveryone && chat.senderId.toString() !== userId) {
          socket.emit("delete_error", { error: "Only sender can delete for everyone" });
          return;
        }

        if (forEveryone) {
          chat.content = "This message was deleted";
          chat.deletedFor = [
            chat.senderId,
            chat.receiverId,
            ...(chat.groupId ? (await Group.findById(chat.groupId))?.members || [] : []),
            ...(chat.channelId ? (await Channel.findById(chat.channelId))?.members || [] : []),
          ].filter(id => id);
        } else {
          chat.deletedFor.push(userId);
        }
        await chat.save();

        const recipients = new Set();
        if (chat.receiverId) {
          const receiverSocket = onlineUsers.get(chat.receiverId.toString());
          if (receiverSocket) recipients.add(receiverSocket);
        }
        if (chat.groupId) {
          const group = await Group.findById(chat.groupId);
          if (group) {
            group.members
              .map(id => id.toString())
              .filter(id => id !== userId)
              .forEach(memberId => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) recipients.add(memberSocket);
              });
          }
        }
        if (chat.channelId) {
          const channel = await Channel.findById(chat.channelId);
          if (channel) {
            channel.members
              .map(id => id.toString())
              .filter(id => id !== userId)
              .forEach(memberId => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) recipients.add(memberSocket);
              });
          }
        }

        const senderSocket = onlineUsers.get(chat.senderId.toString());
        if (senderSocket) recipients.add(senderSocket);

        const deletedMessage = {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId?.toString(),
          groupId: chat.groupId?.toString(),
          channelId: chat.channelId?.toString(),
          content: chat.content,
          type: chat.type,
          fileType: chat.fileType,
          fileName: chat.fileName,
          duration: chat.duration || 0,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
        };

        recipients.forEach(socketId => io.to(socketId).emit("message_deleted", deletedMessage));
        socket.emit("delete_success", { chatId });
      } catch (err) {
        socket.emit("delete_error", { error: "Failed to delete message" });
      }
    });

    /** Block user */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      try {
        if (!blockerId || !blockedId || blockerId === blockedId || blockerId !== socket.userId) {
          socket.emit("block_error", { error: "Invalid blocker or blocked ID" });
          return;
        }

        const existingBlock = await Block.findOne({ blockerId, blockedId });
        if (existingBlock) {
          socket.emit("block_error", { error: "User already blocked" });
          return;
        }

        await Block.create({ blockerId, blockedId });

        const blockedSocket = onlineUsers.get(blockedId);
        if (blockedSocket) {
          io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
        }

        socket.emit("block_success", { blockedId });
      } catch (err) {
        socket.emit("block_error", { error: "Failed to block user" });
      }
    });

    /** Unblock user */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      try {
        if (!blockerId || !blockedId || blockerId !== socket.userId) {
          socket.emit("unblock_error", { error: "Invalid blocker or blocked ID" });
          return;
        }

        const result = await Block.deleteOne({ blockerId, blockedId });
        if (result.deletedCount === 0) {
          socket.emit("unblock_error", { error: "Block not found" });
          return;
        }

        const unblockedSocket = onlineUsers.get(blockedId);
        if (unblockedSocket) {
          io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
        }

        socket.emit("unblock_success", { blockedId });
      } catch (err) {
        socket.emit("unblock_error", { error: "Failed to unblock user" });
      }
    });

    /** Disconnect */
    socket.on("disconnect", async () => {
      try {
        if (socket.userId && onlineUsers.get(socket.userId) === socket.id) {
          onlineUsers.delete(socket.userId);
          const user = await User.findOne({ phone: socket.phone });
          if (user) {
            const now = new Date();
            await User.findByIdAndUpdate(user._id, { online: false, lastSeen: now });
            io.emit("presence_update", {
              userId: socket.userId,
              online: false,
              lastSeen: now.toISOString(),
            });
          }
        }
      } catch (err) {
        console.error(`❌ Disconnect error: ${err.message} at ${logTimestamp()}`, { socketId: socket.id, userId: socket.userId });
      }
    });
  });

  return io;
};








// import { Server } from "socket.io";
// import User from "../models/User.js";
// import Chat from "../models/Chat.js";
// import Block from "../models/Block.js";
// import Group from "../models/Group.js";
// import Channel from "../models/Channel.js";

// export const initChatSocket = (server) => {
//   const io = new Server(server, { cors: { origin: "*" } });
//   const onlineUsers = new Map(); // userId -> socketId

//   io.on("connection", (socket) => {
//     console.log("User connected:", socket.id);

//     /** User joins chat */
//     socket.on("join", async (userId) => {
//       console.log("User joined:", { userId, socketId: socket.id });
//       onlineUsers.set(userId, socket.id);
//       await User.findByIdAndUpdate(userId, { online: true, lastSeen: new Date() });
//       socket.broadcast.emit("presence_update", { userId, online: true, lastSeen: new Date() });
//     });

//     /** Typing indicator for text */
//     socket.on("typing", async ({ senderId, receiverId, typing }) => {
//       console.log("Typing event received:", { senderId, receiverId, typing });
//       const blocked = await Block.findOne({
//         $or: [
//           { blockerId: receiverId, blockedId: senderId },
//           { blockerId: senderId, blockedId: receiverId },
//         ],
//       });
//       if (blocked) return;

//       const receiverSocket = onlineUsers.get(receiverId);
//       if (receiverSocket) io.to(receiverSocket).emit("typing", { senderId, typing });
//     });

//     /** Recording audio indicator */
//     socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
//       console.log("Recording audio event received:", { senderId, receiverId, recording });
//       const blocked = await Block.findOne({
//         $or: [
//           { blockerId: receiverId, blockedId: senderId },
//           { blockerId: senderId, blockedId: receiverId },
//         ],
//       });
//       if (blocked) return;

//       const receiverSocket = onlineUsers.get(receiverId);
//       if (receiverSocket) io.to(receiverSocket).emit("recording_audio", { senderId, recording });
//     });

//     /** Uploading media indicator */
//     socket.on("uploading_media", async ({ senderId, receiverId, groupId, channelId, uploading }) => {
//       console.log("Uploading media event received:", { senderId, receiverId, groupId, channelId, uploading });
//       try {
//         if (receiverId) {
//           const blocked = await Block.findOne({
//             $or: [
//               { blockerId: receiverId, blockedId: senderId },
//               { blockerId: senderId, blockedId: receiverId },
//             ],
//           });
//           if (blocked) return;

//           const receiverSocket = onlineUsers.get(receiverId);
//           if (receiverSocket) io.to(receiverSocket).emit("uploading_media", { senderId, uploading });
//         } else if (groupId) {
//           const group = await Group.findById(groupId);
//           if (!group) return;
//           const memberIds = group.members.map(id => id.toString());
//           memberIds.forEach(memberId => {
//             if (memberId !== senderId) {
//               const memberSocket = onlineUsers.get(memberId);
//               if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, groupId, uploading });
//             }
//           });
//         } else if (channelId) {
//           const channel = await Channel.findById(channelId);
//           if (!channel) return;
//           const memberIds = channel.members.map(id => id.toString());
//           memberIds.forEach(memberId => {
//             if (memberId !== senderId) {
//               const memberSocket = onlineUsers.get(memberId);
//               if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, channelId, uploading });
//             }
//           });
//         }
//       } catch (err) {
//         console.error("uploading_media error:", err);
//       }
//     });

//     /** Send text message */
//     socket.on("send_message", async ({ senderId, receiverId, content }) => {
//       console.log("Received send_message:", { senderId, receiverId, content });
//       try {
//         if (!content || typeof content !== "string" || content.trim() === "") {
//           return socket.emit("message_error", { error: "Message content is required" });
//         }

//         const blocked = await Block.findOne({
//           $or: [
//             { blockerId: receiverId, blockedId: senderId },
//             { blockerId: senderId, blockedId: receiverId },
//           ],
//         });
//         if (blocked) {
//           return socket.emit("message_error", { error: "User is blocked" });
//         }

//         const chat = await Chat.create({
//           senderId,
//           receiverId,
//           type: "text",
//           content,
//           status: "sent",
//           deletedFor: [],
//           createdAt: new Date(),
//         });

//         const receiverSocket = onlineUsers.get(receiverId);
//         if (receiverSocket) {
//           io.to(receiverSocket).emit("receive_message", {
//             id: chat._id.toString(),
//             senderId: chat.senderId.toString(),
//             receiverId: chat.receiverId.toString(),
//             content: chat.content,
//             type: chat.type,
//             timestamp: chat.createdAt,
//             status: chat.status,
//             duration: chat.duration,
//           });
//           chat.status = "delivered";
//           await chat.save();
//         }

//         socket.emit("message_sent", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });
//       } catch (err) {
//         console.error("send_message error:", err);
//         socket.emit("message_error", { error: "Failed to send message" });
//       }
//     });

//     /** Send voice message */
//     socket.on("send_voice", async ({ senderId, receiverId, content, duration }) => {
//       console.log("Received send_voice:", { senderId, receiverId, content, duration });
//       try {
//         if (!content || typeof content !== "string" || content.trim() === "") {
//           return socket.emit("voice_error", { error: "Voice content URL is required" });
//         }
//         if (typeof duration !== "number" || duration <= 0 || duration > 180) {
//           return socket.emit("voice_error", { error: "Voice message duration invalid (max 3 minutes)" });
//         }

//         const blocked = await Block.findOne({
//           $or: [
//             { blockerId: receiverId, blockedId: senderId },
//             { blockerId: senderId, blockedId: receiverId },
//           ],
//         });
//         if (blocked) {
//           return socket.emit("voice_error", { error: "User is blocked" });
//         }

//         const chat = await Chat.create({
//           senderId,
//           receiverId,
//           type: "voice",
//           content,
//           duration,
//           status: "sent",
//           deletedFor: [],
//           createdAt: new Date(),
//         });

//         const receiverSocket = onlineUsers.get(receiverId);
//         if (receiverSocket) {
//           io.to(receiverSocket).emit("receive_voice", {
//             id: chat._id.toString(),
//             senderId: chat.senderId.toString(),
//             receiverId: chat.receiverId.toString(),
//             content: chat.content,
//             type: chat.type,
//             timestamp: chat.createdAt,
//             status: chat.status,
//             duration: chat.duration,
//           });
//           chat.status = "delivered";
//           await chat.save();
//         }

//         socket.emit("voice_sent", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });
//       } catch (err) {
//         console.error("send_voice error:", err);
//         socket.emit("voice_error", { error: "Failed to send voice message" });
//       }
//     });

//     /** Send media (images, videos, documents) - supports multiple files */
//     socket.on("send_media", async ({ senderId, receiverId, groupId, channelId, files }) => {
//       console.log("Received send_media:", { senderId, receiverId, groupId, channelId, files });
//       try {
//         if (!files || !Array.isArray(files) || files.length === 0 || files.length > 10) {
//           return socket.emit("media_error", { error: "Files must be a non-empty array (max 10)" });
//         }
//         if (!receiverId && !groupId && !channelId) {
//           return socket.emit("media_error", { error: "Must specify receiverId, groupId, or channelId" });
//         }

//         // Validate files
//         for (const file of files) {
//           const { type, url, fileType, duration, fileName } = file;
//           if (!["image", "video", "file"].includes(type)) {
//             return socket.emit("media_error", { error: `Invalid media type: ${type}` });
//           }
//           if (!url || typeof url !== "string" || url.trim() === "") {
//             return socket.emit("media_error", { error: "Each file must have a valid URL" });
//           }
//           if (!fileType || typeof fileType !== "string") {
//             return socket.emit("media_error", { error: "Each file must have a valid MIME type" });
//           }
//           if (type === "image" && !fileType.startsWith("image/")) {
//             return socket.emit("media_error", { error: `Invalid MIME type for image: ${fileType}` });
//           }
//           if (type === "video" && !fileType.startsWith("video/")) {
//             return socket.emit("media_error", { error: `Invalid MIME type for video: ${fileType}` });
//           }
//           if (type === "video" && (typeof duration !== "number" || duration <= 0 || duration > 300)) {
//             return socket.emit("media_error", { error: "Video duration invalid (max 5 minutes)" });
//           }
//           if (type === "file" && (!fileName || typeof fileName !== "string")) {
//             return socket.emit("media_error", { error: "Documents must have a file name" });
//           }
//         }

//         // Check for blocking in 1-to-1 chats
//         if (receiverId) {
//           const blocked = await Block.findOne({
//             $or: [
//               { blockerId: receiverId, blockedId: senderId },
//               { blockerId: senderId, blockedId: receiverId },
//             ],
//           });
//           if (blocked) {
//             return socket.emit("media_error", { error: "User is blocked" });
//           }
//         }

//         // Create a Chat document for each file
//         const chats = [];
//         for (const file of files) {
//           const { type, url, fileType, duration, fileName } = file;
//           const chat = await Chat.create({
//             senderId,
//             receiverId: receiverId || undefined,
//             groupId: groupId || undefined,
//             channelId: channelId || undefined,
//             type,
//             content: url,
//             fileType,
//             fileName: type === "file" ? fileName : undefined,
//             duration: type === "video" ? duration : 0,
//             status: "sent",
//             deletedFor: [],
//             createdAt: new Date(),
//           });
//           chats.push(chat);
//         }

//         // Prepare payload for emission
//         const payload = chats.map(chat => ({
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId?.toString(),
//           groupId: chat.groupId?.toString(),
//           channelId: chat.channelId?.toString(),
//           content: chat.content,
//           type: chat.type,
//           fileType: chat.fileType,
//           fileName: chat.fileName,
//           duration: chat.duration,
//           timestamp: chat.createdAt,
//           status: chat.status,
//         }));

//         // Emit to recipients
//         if (receiverId) {
//           const receiverSocket = onlineUsers.get(receiverId);
//           if (receiverSocket) {
//             payload.forEach(item => io.to(receiverSocket).emit("receive_media", item));
//             chats.forEach(async chat => {
//               chat.status = "delivered";
//               await chat.save();
//             });
//           }
//         } else if (groupId) {
//           const group = await Group.findById(groupId);
//           if (group) {
//             const memberIds = group.members.map(id => id.toString());
//             memberIds.forEach(memberId => {
//               if (memberId !== senderId) {
//                 const memberSocket = onlineUsers.get(memberId);
//                 if (memberSocket) {
//                   payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
//                 }
//               }
//             });
//             chats.forEach(async chat => {
//               chat.status = "delivered";
//               await chat.save();
//             });
//           }
//         } else if (channelId) {
//           const channel = await Channel.findById(channelId);
//           if (channel) {
//             const memberIds = channel.members.map(id => id.toString());
//             memberIds.forEach(memberId => {
//               if (memberId !== senderId) {
//                 const memberSocket = onlineUsers.get(memberId);
//                 if (memberSocket) {
//                   payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
//                 }
//               }
//             });
//             chats.forEach(async chat => {
//               chat.status = "delivered";
//               await chat.save();
//             });
//           }
//         }

//         // Emit to sender
//         payload.forEach(item => socket.emit("media_sent", item));
//       } catch (err) {
//         console.error("send_media error:", err);
//         socket.emit("media_error", { error: "Failed to send media" });
//       }
//     });

//     /** Read message */
//     socket.on("read_message", async ({ chatId, readerId }) => {
//       console.log("Received read_message:", { chatId, readerId });
//       try {
//         const chat = await Chat.findById(chatId);
//         if (chat && !chat.deletedFor.includes(readerId)) {
//           chat.status = "read";
//           await chat.save();
//           const senderSocket = onlineUsers.get(chat.senderId.toString());
//           if (senderSocket) io.to(senderSocket).emit("message_read", { id: chatId });
//         }
//       } catch (err) {
//         console.error("read_message error:", err);
//       }
//     });

//     /** Delete message */
//     socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
//       console.log("Received delete_message:", { chatId, userId, forEveryone });
//       try {
//         const chat = await Chat.findById(chatId);
//         if (!chat) return socket.emit("delete_error", { error: "Message not found" });

//         if (forEveryone && chat.senderId.toString() === userId) {
//           chat.content = "This message was deleted";
//           chat.deletedFor = [
//             chat.senderId,
//             chat.receiverId,
//             ...(chat.groupId ? (await Group.findById(chat.groupId))?.members : []),
//             ...(chat.channelId ? (await Channel.findById(chat.channelId))?.members : []),
//           ].filter(id => id);
//         } else {
//           chat.deletedFor.push(userId);
//         }
//         await chat.save();

//         const recipients = [];
//         if (chat.receiverId) {
//           const receiverSocket = onlineUsers.get(chat.receiverId.toString());
//           if (receiverSocket) recipients.push(receiverSocket);
//         } else if (chat.groupId) {
//           const group = await Group.findById(chat.groupId);
//           if (group) {
//             group.members.forEach(memberId => {
//               const memberSocket = onlineUsers.get(memberId.toString());
//               if (memberSocket && memberId.toString() !== userId) recipients.push(memberSocket);
//             });
//           }
//         } else if (chat.channelId) {
//           const channel = await Channel.findById(chat.channelId);
//           if (channel) {
//             channel.members.forEach(memberId => {
//               const memberSocket = onlineUsers.get(memberId.toString());
//               if (memberSocket && memberId.toString() !== userId) recipients.push(memberSocket);
//             });
//           }
//         }

//         const senderSocket = onlineUsers.get(chat.senderId.toString());
//         if (senderSocket) recipients.push(senderSocket);

//         recipients.forEach(socketId => {
//           io.to(socketId).emit("message_deleted", {
//             id: chat._id.toString(),
//             senderId: chat.senderId.toString(),
//             receiverId: chat.receiverId?.toString(),
//             groupId: chat.groupId?.toString(),
//             channelId: chat.channelId?.toString(),
//             content: chat.content,
//             type: chat.type,
//             fileType: chat.fileType,
//             fileName: chat.fileName,
//             duration: chat.duration,
//             timestamp: chat.createdAt,
//             status: chat.status,
//           });
//         });

//         socket.emit("delete_success", { chatId });
//       } catch (err) {
//         console.error("delete_message error:", err);
//         socket.emit("delete_error", { error: "Failed to delete message" });
//       }
//     });

//     /** Block user */
//     socket.on("block_user", async ({ blockerId, blockedId }) => {
//       console.log("Received block_user:", { blockerId, blockedId });
//       try {
//         await Block.create({ blockerId, blockedId });
//         const blockedSocket = onlineUsers.get(blockedId);
//         if (blockedSocket) io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
//         socket.emit("block_success", { blockedId });
//       } catch (err) {
//         console.error("block_user error:", err);
//         socket.emit("block_error", { error: "Failed to block user" });
//       }
//     });

//     /** Unblock user */
//     socket.on("unblock_user", async ({ blockerId, blockedId }) => {
//       console.log("Received unblock_user:", { blockerId, blockedId });
//       try {
//         await Block.deleteOne({ blockerId, blockedId });
//         const unblockedSocket = onlineUsers.get(blockedId);
//         if (unblockedSocket) io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
//         socket.emit("unblock_success", { blockedId });
//       } catch (err) {
//         console.error("unblock_user error:", err);
//         socket.emit("unblock_error", { error: "Failed to unblock user" });
//       }
//     });

//     /** Disconnect */
//     socket.on("disconnect", async () => {
//       for (const [userId, sockId] of onlineUsers.entries()) {
//         if (sockId === socket.id) {
//           onlineUsers.delete(userId);
//           const now = new Date();
//           await User.findByIdAndUpdate(userId, { online: false, lastSeen: now });
//           socket.broadcast.emit("presence_update", { userId, online: false, lastSeen: now });
//         }
//       }
//       console.log("User disconnected:", socket.id);
//     });
//   });

//   return io;
// };





































// import { Server } from "socket.io";
// import User from "../models/User.js";
// import Chat from "../models/Chat.js";
// import Block from "../models/Block.js";

// export const initChatSocket = (server) => {
//   const io = new Server(server, { cors: { origin: "*" } });
//   const onlineUsers = new Map(); // userId -> socketId

//   io.on("connection", (socket) => {
//     console.log("User connected:", socket.id);

//     /** User joins chat */
//     socket.on("join", async (userId) => {
//       console.log("User joined:", { userId, socketId: socket.id });
//       onlineUsers.set(userId, socket.id);
//       await User.findByIdAndUpdate(userId, { online: true, lastSeen: new Date() });
//       socket.broadcast.emit("presence_update", { userId, online: true, lastSeen: new Date() });
//     });

//     /** Typing indicator for text */
//     socket.on("typing", async ({ senderId, receiverId, typing }) => {
//       console.log("Typing event received:", { senderId, receiverId, typing });
//       const blocked = await Block.findOne({
//         $or: [
//           { blockerId: receiverId, blockedId: senderId },
//           { blockerId: senderId, blockedId: receiverId },
//         ],
//       });
//       if (blocked) return;

//       const receiverSocket = onlineUsers.get(receiverId);
//       if (receiverSocket) io.to(receiverSocket).emit("typing", { senderId, typing });
//     });

//     /** Recording audio indicator */
//     socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
//       console.log("Recording audio event received:", { senderId, receiverId, recording });
//       const blocked = await Block.findOne({
//         $or: [
//           { blockerId: receiverId, blockedId: senderId },
//           { blockerId: senderId, blockedId: receiverId },
//         ],
//       });
//       if (blocked) return;

//       const receiverSocket = onlineUsers.get(receiverId);
//       if (receiverSocket) io.to(receiverSocket).emit("recording_audio", { senderId, recording });
//     });

//     /** Send text message */
//     socket.on("send_message", async ({ senderId, receiverId, content }) => {
//       console.log("Received send_message:", { senderId, receiverId, content });
//       try {
//         if (!content || typeof content !== "string" || content.trim() === "") {
//           return socket.emit("message_error", { error: "Message content is required" });
//         }

//         const blocked = await Block.findOne({
//           $or: [
//             { blockerId: receiverId, blockedId: senderId },
//             { blockerId: senderId, blockedId: receiverId },
//           ],
//         });
//         if (blocked) {
//           return socket.emit("message_error", { error: "User is blocked" });
//         }

//         const chat = await Chat.create({
//           senderId,
//           receiverId,
//           type: "text",
//           content,
//           status: "sent",
//           deletedFor: [],
//           createdAt: new Date(),
//         });

//         const receiverSocket = onlineUsers.get(receiverId);
//         if (receiverSocket) {
//           io.to(receiverSocket).emit("receive_message", {
//             id: chat._id.toString(),
//             senderId: chat.senderId.toString(),
//             receiverId: chat.receiverId.toString(),
//             content: chat.content,
//             type: chat.type,
//             timestamp: chat.createdAt,
//             status: chat.status,
//             duration: chat.duration,
//           });
//           chat.status = "delivered";
//           await chat.save();
//         }

//         socket.emit("message_sent", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });
//       } catch (err) {
//         console.error("send_message error:", err);
//         socket.emit("message_error", { error: "Failed to send message" });
//       }
//     });

//     /** Send voice message */
//     socket.on("send_voice", async ({ senderId, receiverId, content, duration }) => {
//       console.log("Received send_voice:", { senderId, receiverId, content, duration });
//       try {
//         if (!content || typeof content !== "string" || content.trim() === "") {
//           return socket.emit("voice_error", { error: "Voice content URL is required" });
//         }
//         if (duration > 180) {
//           return socket.emit("voice_error", { error: "Voice message too long (max 3 minutes)" });
//         }

//         const blocked = await Block.findOne({
//           $or: [
//             { blockerId: receiverId, blockedId: senderId },
//             { blockerId: senderId, blockedId: receiverId },
//           ],
//         });
//         if (blocked) {
//           return socket.emit("voice_error", { error: "User is blocked" });
//         }

//         const chat = await Chat.create({
//           senderId,
//           receiverId,
//           type: "voice",
//           content,
//           duration,
//           status: "sent",
//           deletedFor: [],
//           createdAt: new Date(),
//         });

//         const receiverSocket = onlineUsers.get(receiverId);
//         if (receiverSocket) {
//           io.to(receiverSocket).emit("receive_voice", {
//             id: chat._id.toString(),
//             senderId: chat.senderId.toString(),
//             receiverId: chat.receiverId.toString(),
//             content: chat.content,
//             type: chat.type,
//             timestamp: chat.createdAt,
//             status: chat.status,
//             duration: chat.duration,
//           });
//           chat.status = "delivered";
//           await chat.save();
//         }

//         socket.emit("voice_sent", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });
//       } catch (err) {
//         console.error("send_voice error:", err);
//         socket.emit("voice_error", { error: "Failed to send voice message" });
//       }
//     });

//     /** Read message */
//     socket.on("read_message", async ({ chatId, readerId }) => {
//       console.log("Received read_message:", { chatId, readerId });
//       try {
//         const chat = await Chat.findById(chatId);
//         if (chat && !chat.deletedFor.includes(readerId)) {
//           chat.status = "read";
//           await chat.save();
//           const senderSocket = onlineUsers.get(chat.senderId.toString());
//           if (senderSocket) io.to(senderSocket).emit("message_read", { id: chatId });
//         }
//       } catch (err) {
//         console.error("read_message error:", err);
//       }
//     });

//     /** Delete message */
//     socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
//       console.log("Received delete_message:", { chatId, userId, forEveryone });
//       try {
//         const chat = await Chat.findById(chatId);
//         if (!chat) return socket.emit("delete_error", { error: "Message not found" });

//         if (forEveryone && chat.senderId.toString() === userId) {
//           chat.content = "This message was deleted";
//           chat.deletedFor = [chat.senderId, chat.receiverId].filter(id => id);
//         } else {
//           chat.deletedFor.push(userId);
//         }
//         await chat.save();

//         const senderSocket = onlineUsers.get(chat.senderId.toString());
//         const receiverSocket = onlineUsers.get(chat.receiverId?.toString());
//         if (senderSocket) io.to(senderSocket).emit("message_deleted", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId?.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });
//         if (receiverSocket) io.to(receiverSocket).emit("message_deleted", {
//           id: chat._id.toString(),
//           senderId: chat.senderId.toString(),
//           receiverId: chat.receiverId?.toString(),
//           content: chat.content,
//           type: chat.type,
//           timestamp: chat.createdAt,
//           status: chat.status,
//           duration: chat.duration,
//         });

//         socket.emit("delete_success", { chatId });
//       } catch (err) {
//         console.error("delete_message error:", err);
//         socket.emit("delete_error", { error: "Failed to delete message" });
//       }
//     });

//     /** Block user */
//     socket.on("block_user", async ({ blockerId, blockedId }) => {
//       console.log("Received block_user:", { blockerId, blockedId });
//       try {
//         await Block.create({ blockerId, blockedId });
//         const blockedSocket = onlineUsers.get(blockedId);
//         if (blockedSocket) io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
//         socket.emit("block_success", { blockedId });
//       } catch (err) {
//         console.error("block_user error:", err);
//         socket.emit("block_error", { error: "Failed to block user" });
//       }
//     });

//     /** Unblock user */
//     socket.on("unblock_user", async ({ blockerId, blockedId }) => {
//       console.log("Received unblock_user:", { blockerId, blockedId });
//       try {
//         await Block.deleteOne({ blockerId, blockedId });
//         const unblockedSocket = onlineUsers.get(blockedId);
//         if (unblockedSocket) io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
//         socket.emit("unblock_success", { blockedId });
//       } catch (err) {
//         console.error("unblock_user error:", err);
//         socket.emit("unblock_error", { error: "Failed to unblock user" });
//       }
//     });

//     /** Disconnect */
//     socket.on("disconnect", async () => {
//       for (const [userId, sockId] of onlineUsers.entries()) {
//         if (sockId === socket.id) {
//           onlineUsers.delete(userId);
//           const now = new Date();
//           await User.findByIdAndUpdate(userId, { online: false, lastSeen: now });
//           socket.broadcast.emit("presence_update", { userId, online: false, lastSeen: now });
//         }
//       }
//       console.log("User disconnected:", socket.id);
//     });
//   });

//   return io;
// };