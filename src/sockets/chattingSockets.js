import { Server } from "socket.io";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Block from "../models/Block.js";
import Group from "../models/Group.js";
import Channel from "../models/Channel.js";
import Profile from "../models/Profile.js";
import jwt from "jsonwebtoken";

export const initChatSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/chat-socket",
    pingTimeout: 60000, // Increase timeout to 60s to reduce disconnections
    pingInterval: 25000, // Default heartbeat interval
  });
  const onlineUsers = new Map(); // userId -> socketId

  // Middleware to verify JWT token
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.query.userId;
    const logTimestamp = () => new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

    console.log(`🔐 Auth middleware: userId=${userId}, token=${token ? "provided" : "missing"} at ${logTimestamp()}`);
    if (!token || !userId) {
      console.error(`❌ Auth error: Missing token or userId`, { userId, token });
      return next(new Error("Authentication error: Token and userId required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const profile = await Profile.findById(userId);
      if (!profile || decoded.phone !== profile.phone) {
        console.error(`❌ Auth error: Invalid userId=${userId} or token`, { decoded });
        return next(new Error("Authentication error: Invalid user or token"));
      }
      socket.userId = userId;
      console.log(`✅ Auth success: userId=${userId}`);
      next();
    } catch (err) {
      console.error(`❌ Auth error: ${err.message}`, { userId, stack: err.stack });
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const logTimestamp = () => new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
    console.log(`⚡ Chat client connected: socketId=${socket.id}, userId=${socket.userId} at ${logTimestamp()}`);

    // Handle connection errors
    socket.on("connect_error", (err) => {
      console.error(`❌ Connection error: ${err.message}`, { socketId: socket.id, stack: err.stack });
    });

    /** User joins chat */
    socket.on("join", async (userId) => {
      console.log(`📥 Join event received: userId=${userId}, socketId=${socket.id} at ${logTimestamp()}`);
      try {
        if (!userId || userId !== socket.userId) {
          console.error(`❌ Join error: Invalid or mismatched userId=${userId}, expected=${socket.userId}`);
          socket.emit("join_error", { error: "Invalid or mismatched user ID" });
          return;
        }

        const profile = await Profile.findById(userId);
        if (!profile) {
          console.error(`❌ Join error: Profile not found for userId=${userId}`);
          socket.emit("join_error", { error: "User profile not found" });
          return;
        }

        const user = await User.findOne({ phone: profile.phone });
        if (!user) {
          console.error(`❌ Join error: User not found for phone=${profile.phone}`);
          socket.emit("join_error", { error: "User not found" });
          return;
        }

        onlineUsers.set(userId, socket.id);
        socket.join(userId); // Join user-specific room
        await User.findByIdAndUpdate(user._id, { online: true, lastSeen: new Date() });
        console.log(`✅ User joined: userId=${userId}, socketId=${socket.id}`);

        io.emit("presence_update", {
          userId,
          online: true,
          lastSeen: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`❌ Join error: ${err.message}`, { userId, stack: err.stack });
        socket.emit("join_error", { error: "Server error during join" });
      }
    });

    /** Typing indicator for text */
    socket.on("typing", async ({ senderId, receiverId, typing }) => {
      console.log(`📥 Typing event received: senderId=${senderId}, receiverId=${receiverId}, typing=${typing} at ${logTimestamp()}`);
      try {
        if (!senderId || !receiverId || typeof typing !== "boolean" || senderId !== socket.userId) {
          console.error(`❌ Typing error: Invalid data`, { senderId, receiverId, typing, socketUserId: socket.userId });
          socket.emit("typing_error", { error: "Invalid typing data or unauthorized sender" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          console.log(`🚫 Typing blocked: senderId=${senderId}, receiverId=${receiverId}`);
          socket.emit("typing_error", { error: "User is blocked" });
          return;
        }

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("typing", { senderId, receiverId, typing });
          console.log(`✅ Typing event emitted to receiverId=${receiverId}`);
        } else {
          console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
        }
      } catch (err) {
        console.error(`❌ Typing error: ${err.message}`, { senderId, receiverId, stack: err.stack });
        socket.emit("typing_error", { error: "Server error during typing" });
      }
    });

    /** Recording audio indicator */
    socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
      console.log(`📥 Recording audio event received: senderId=${senderId}, receiverId=${receiverId}, recording=${recording} at ${logTimestamp()}`);
      try {
        if (!senderId || !receiverId || typeof recording !== "boolean" || senderId !== socket.userId) {
          console.error(`❌ Recording audio error: Invalid data`, { senderId, receiverId, recording, socketUserId: socket.userId });
          socket.emit("recording_audio_error", { error: "Invalid recording data or unauthorized sender" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          console.log(`🚫 Recording audio blocked: senderId=${senderId}, receiverId=${receiverId}`);
          socket.emit("recording_audio_error", { error: "User is blocked" });
          return;
        }

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("recording_audio", { senderId, receiverId, recording });
          console.log(`✅ Recording audio event emitted to receiverId=${receiverId}`);
        } else {
          console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
        }
      } catch (err) {
        console.error(`❌ Recording audio error: ${err.message}`, { senderId, receiverId, stack: err.stack });
        socket.emit("recording_audio_error", { error: "Server error during recording" });
      }
    });

    /** Uploading media indicator */
    socket.on("uploading_media", async ({ senderId, receiverId, groupId, channelId, uploading }) => {
      console.log(`📥 Uploading media event received: senderId=${senderId}, receiverId=${receiverId}, groupId=${groupId}, channelId=${channelId}, uploading=${uploading} at ${logTimestamp()}`);
      try {
        if (!senderId || (!receiverId && !groupId && !channelId) || typeof uploading !== "boolean" || senderId !== socket.userId) {
          console.error(`❌ Uploading media error: Invalid data`, { senderId, receiverId, groupId, channelId, uploading, socketUserId: socket.userId });
          socket.emit("uploading_media_error", { error: "Invalid uploading data or unauthorized sender" });
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
            console.log(`🚫 Uploading media blocked: senderId=${senderId}, receiverId=${receiverId}`);
            socket.emit("uploading_media_error", { error: "User is blocked" });
            return;
          }

          const receiverSocket = onlineUsers.get(receiverId);
          if (receiverSocket) {
            io.to(receiverSocket).emit("uploading_media", { senderId, receiverId, uploading });
            console.log(`✅ Uploading media event emitted to receiverId=${receiverId}`);
          } else {
            console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (!group) {
            console.error(`❌ Uploading media error: Group not found, groupId=${groupId}`);
            socket.emit("uploading_media_error", { error: "Group not found" });
            return;
          }
          if (!group.members.includes(senderId)) {
            console.error(`❌ Uploading media error: Sender not in group, senderId=${senderId}, groupId=${groupId}`);
            socket.emit("uploading_media_error", { error: "Sender not in group" });
            return;
          }
          const memberIds = group.members.map(id => id.toString());
          memberIds.forEach(memberId => {
            if (memberId !== senderId) {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) {
                io.to(memberSocket).emit("uploading_media", { senderId, groupId, uploading });
                console.log(`✅ Uploading media event emitted to group memberId=${memberId}`);
              }
            }
          });
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (!channel) {
            console.error(`❌ Uploading media error: Channel not found, channelId=${channelId}`);
            socket.emit("uploading_media_error", { error: "Channel not found" });
            return;
          }
          if (!channel.members.includes(senderId)) {
            console.error(`❌ Uploading media error: Sender not in channel, senderId=${senderId}, channelId=${channelId}`);
            socket.emit("uploading_media_error", { error: "Sender not in channel" });
            return;
          }
          const memberIds = channel.members.map(id => id.toString());
          memberIds.forEach(memberId => {
            if (memberId !== senderId) {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) {
                io.to(memberSocket).emit("uploading_media", { senderId, channelId, uploading });
                console.log(`✅ Uploading media event emitted to channel memberId=${memberId}`);
              }
            }
          });
        }
      } catch (err) {
        console.error(`❌ Uploading media error: ${err.message}`, { senderId, receiverId, groupId, channelId, stack: err.stack });
        socket.emit("uploading_media_error", { error: "Server error during uploading" });
      }
    });

    /** Send text message */
    socket.on("send_message", async ({ senderId, receiverId, content }, callback) => {
      console.log(`📥 Send message received: senderId=${senderId}, receiverId=${receiverId}, content="${content}" at ${logTimestamp()}`);
      try {
        if (!senderId || !receiverId || !content || typeof content !== "string" || content.trim() === "" || senderId !== socket.userId) {
          console.error(`❌ Send message error: Invalid data`, { senderId, receiverId, content, socketUserId: socket.userId });
          socket.emit("message_error", { error: "Invalid message data or unauthorized sender" });
          if (callback) callback({ error: "Invalid message data" });
          return;
        }

        const senderProfile = await Profile.findById(senderId);
        const receiverProfile = await Profile.findById(receiverId);
        if (!senderProfile || !receiverProfile) {
          console.error(`❌ Send message error: Profile not found`, { senderId, receiverId });
          socket.emit("message_error", { error: "User profile not found" });
          if (callback) callback({ error: "User profile not found" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          console.log(`🚫 Send message blocked: senderId=${senderId}, receiverId=${receiverId}`);
          socket.emit("message_error", { error: "User is blocked" });
          if (callback) callback({ error: "User is blocked" });
          return;
        }

        const chat = await Chat.create({
          senderId,
          receiverId,
          type: "text",
          content,
          status: "sent",
          deletedFor: [],
          createdAt: new Date(),
        });

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

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_message", messageData);
          chat.status = "delivered";
          await chat.save();
          messageData.status = "delivered";
          console.log(`✅ Message delivered to receiverId=${receiverId}: id=${chat._id}`);
        } else {
          console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
        }

        socket.emit("message_sent", messageData);
        if (callback) callback({ status: "success", id: chat._id.toString() });
        console.log(`✅ Message sent: id=${chat._id}, senderId=${senderId}, receiverId=${receiverId}`);
      } catch (err) {
        console.error(`❌ Send message error: ${err.message}`, { senderId, receiverId, content, stack: err.stack });
        socket.emit("message_error", { error: "Failed to send message" });
        if (callback) callback({ error: "Server error" });
      }
    });

    /** Send voice message */
    socket.on("send_voice", async ({ senderId, receiverId, content, duration }, callback) => {
      console.log(`📥 Send voice received: senderId=${senderId}, receiverId=${receiverId}, content="${content}", duration=${duration} at ${logTimestamp()}`);
      try {
        if (!senderId || !receiverId || !content || typeof content !== "string" || content.trim() === "" || senderId !== socket.userId) {
          console.error(`❌ Send voice error: Invalid content`, { senderId, receiverId, content, duration, socketUserId: socket.userId });
          socket.emit("voice_error", { error: "Voice content URL is required or unauthorized sender" });
          if (callback) callback({ error: "Voice content URL is required" });
          return;
        }
        if (typeof duration !== "number" || duration <= 0 || duration > 180) {
          console.error(`❌ Send voice error: Invalid duration=${duration}`);
          socket.emit("voice_error", { error: "Voice duration invalid (max 3 minutes)" });
          if (callback) callback({ error: "Voice duration invalid (max 3 minutes)" });
          return;
        }

        const senderProfile = await Profile.findById(senderId);
        const receiverProfile = await Profile.findById(receiverId);
        if (!senderProfile || !receiverProfile) {
          console.error(`❌ Send voice error: Profile not found`, { senderId, receiverId });
          socket.emit("voice_error", { error: "User profile not found" });
          if (callback) callback({ error: "User profile not found" });
          return;
        }

        const blocked = await Block.findOne({
          $or: [
            { blockerId: receiverId, blockedId: senderId },
            { blockerId: senderId, blockedId: receiverId },
          ],
        });
        if (blocked) {
          console.log(`🚫 Send voice blocked: senderId=${senderId}, receiverId=${receiverId}`);
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
          createdAt: new Date(),
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
          console.log(`✅ Voice delivered to receiverId=${receiverId}: id=${chat._id}`);
        } else {
          console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
        }

        socket.emit("voice_sent", voiceData);
        if (callback) callback({ status: "success", id: chat._id.toString() });
        console.log(`✅ Voice sent: id=${chat._id}, senderId=${senderId}, receiverId=${receiverId}`);
      } catch (err) {
        console.error(`❌ Send voice error: ${err.message}`, { senderId, receiverId, content, duration, stack: err.stack });
        socket.emit("voice_error", { error: "Failed to send voice message" });
        if (callback) callback({ error: "Server error" });
      }
    });

    /** Send media (images, videos, documents) */
    socket.on("send_media", async ({ senderId, receiverId, groupId, channelId, files }, callback) => {
      console.log(`📥 Send media received: senderId=${senderId}, receiverId=${receiverId}, groupId=${groupId}, channelId=${channelId}, files=${JSON.stringify(files)} at ${logTimestamp()}`);
      try {
        if (!senderId || (!receiverId && !groupId && !channelId) || !files || !Array.isArray(files) || files.length === 0 || files.length > 10 || senderId !== socket.userId) {
          console.error(`❌ Send media error: Invalid data`, { senderId, receiverId, groupId, channelId, files, socketUserId: socket.userId });
          socket.emit("media_error", { error: "Invalid media data (1-10 files required) or unauthorized sender" });
          if (callback) callback({ error: "Invalid media data" });
          return;
        }

        const senderProfile = await Profile.findById(senderId);
        if (!senderProfile) {
          console.error(`❌ Send media error: Sender profile not found, senderId=${senderId}`);
          socket.emit("media_error", { error: "Sender profile not found" });
          if (callback) callback({ error: "Sender profile not found" });
          return;
        }

        // Validate files
        for (const file of files) {
          const { type, url, fileType, duration, fileName } = file;
          if (!["image", "video", "file"].includes(type)) {
            console.error(`❌ Send media error: Invalid type=${type}`);
            socket.emit("media_error", { error: `Invalid media type: ${type}` });
            if (callback) callback({ error: `Invalid media type: ${type}` });
            return;
          }
          if (!url || typeof url !== "string" || url.trim() === "") {
            console.error(`❌ Send media error: Invalid URL`, { file });
            socket.emit("media_error", { error: "Each file must have a valid URL" });
            if (callback) callback({ error: "Each file must have a valid URL" });
            return;
          }
          if (!fileType || typeof fileType !== "string") {
            console.error(`❌ Send media error: Invalid fileType`, { file });
            socket.emit("media_error", { error: "Each file must have a valid MIME type" });
            if (callback) callback({ error: "Each file must have a valid MIME type" });
            return;
          }
          if (type === "image" && !fileType.startsWith("image/")) {
            console.error(`❌ Send media error: Invalid image MIME type=${fileType}`);
            socket.emit("media_error", { error: `Invalid MIME type for image: ${fileType}` });
            if (callback) callback({ error: `Invalid MIME type for image: ${fileType}` });
            return;
          }
          if (type === "video" && !fileType.startsWith("video/")) {
            console.error(`❌ Send media error: Invalid video MIME type=${fileType}`);
            socket.emit("media_error", { error: `Invalid MIME type for video: ${fileType}` });
            if (callback) callback({ error: `Invalid MIME type for video: ${fileType}` });
            return;
          }
          if (type === "video" && (typeof duration !== "number" || duration <= 0 || duration > 300)) {
            console.error(`❌ Send media error: Invalid video duration=${duration}`);
            socket.emit("media_error", { error: "Video duration invalid (max 5 minutes)" });
            if (callback) callback({ error: "Video duration invalid (max 5 minutes)" });
            return;
          }
          if (type === "file" && (!fileName || typeof fileName !== "string")) {
            console.error(`❌ Send media error: Missing fileName for document`, { file });
            socket.emit("media_error", { error: "Documents must have a file name" });
            if (callback) callback({ error: "Documents must have a file name" });
            return;
          }
        }

        if (receiverId) {
          const receiverProfile = await Profile.findById(receiverId);
          if (!receiverProfile) {
            console.error(`❌ Send media error: Receiver profile not found, receiverId=${receiverId}`);
            socket.emit("media_error", { error: "Receiver profile not found" });
            if (callback) callback({ error: "Receiver profile not found" });
            return;
          }

          const blocked = await Block.findOne({
            $or: [
              { blockerId: receiverId, blockedId: senderId },
              { blockerId: senderId, blockedId: receiverId },
            ],
          });
          if (blocked) {
            console.log(`🚫 Send media blocked: senderId=${senderId}, receiverId=${receiverId}`);
            socket.emit("media_error", { error: "User is blocked" });
            if (callback) callback({ error: "User is blocked" });
            return;
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (!group) {
            console.error(`❌ Send media error: Group not found, groupId=${groupId}`);
            socket.emit("media_error", { error: "Group not found" });
            if (callback) callback({ error: "Group not found" });
            return;
          }
          if (!group.members.includes(senderId)) {
            console.error(`❌ Send media error: Sender not in group, senderId=${senderId}, groupId=${groupId}`);
            socket.emit("media_error", { error: "Sender not in group" });
            if (callback) callback({ error: "Sender not in group" });
            return;
          }
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (!channel) {
            console.error(`❌ Send media error: Channel not found, channelId=${channelId}`);
            socket.emit("media_error", { error: "Channel not found" });
            if (callback) callback({ error: "Channel not found" });
            return;
          }
          if (!channel.members.includes(senderId)) {
            console.error(`❌ Send media error: Sender not in channel, senderId=${senderId}, channelId=${channelId}`);
            socket.emit("media_error", { error: "Sender not in channel" });
            if (callback) callback({ error: "Sender not in channel" });
            return;
          }
        }

        const chats = [];
        for (const file of files) {
          const { type, url, fileType, duration, fileName } = file;
          const chat = await Chat.create({
            senderId,
            receiverId: receiverId || undefined,
            groupId: groupId || undefined,
            channelId: channelId || undefined,
            type,
            content: url,
            fileType,
            fileName: type === "file" ? fileName : undefined,
            duration: type === "video" ? duration : 0,
            status: "sent",
            deletedFor: [],
            createdAt: new Date(),
          });
          chats.push(chat);
        }

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
            console.log(`✅ Media delivered to receiverId=${receiverId}: ids=${chats.map(c => c._id).join(",")}`);
          } else {
            console.log(`⚠️ Receiver not online: receiverId=${receiverId}`);
          }
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (group) {
            const memberIds = group.members.map(id => id.toString());
            memberIds.forEach(memberId => {
              if (memberId !== senderId) {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
                  console.log(`✅ Media delivered to group memberId=${memberId}: ids=${chats.map(c => c._id).join(",")}`);
                }
              }
            });
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (channel) {
            const memberIds = channel.members.map(id => id.toString());
            memberIds.forEach(memberId => {
              if (memberId !== senderId) {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
                  console.log(`✅ Media delivered to channel memberId=${memberId}: ids=${chats.map(c => c._id).join(",")}`);
                }
              }
            });
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        }

        payload.forEach(item => socket.emit("media_sent", item));
        if (callback) callback({ status: "success", ids: chats.map(c => c._id.toString()) });
        console.log(`✅ Media sent: senderId=${senderId}, ids=${chats.map(c => c._id).join(",")}`);
      } catch (err) {
        console.error(`❌ Send media error: ${err.message}`, { senderId, receiverId, groupId, channelId, files, stack: err.stack });
        socket.emit("media_error", { error: "Failed to send media" });
        if (callback) callback({ error: "Server error" });
      }
    });

    /** Read message */
    socket.on("read_message", async ({ chatId, readerId }) => {
      console.log(`📥 Read message received: chatId=${chatId}, readerId=${readerId} at ${logTimestamp()}`);
      try {
        if (!chatId || !readerId || readerId !== socket.userId) {
          console.error(`❌ Read message error: Invalid data`, { chatId, readerId, socketUserId: socket.userId });
          socket.emit("message_error", { error: "Invalid chat or reader ID or unauthorized reader" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat) {
          console.error(`❌ Read message error: Chat not found, chatId=${chatId}`);
          socket.emit("message_error", { error: "Message not found" });
          return;
        }
        if (chat.deletedFor.includes(readerId)) {
          console.log(`🚫 Read message ignored: Message deleted for readerId=${readerId}, chatId=${chatId}`);
          return;
        }

        chat.status = "read";
        await chat.save();
        console.log(`✅ Message marked as read: chatId=${chatId}, readerId=${readerId}`);

        const senderSocket = onlineUsers.get(chat.senderId.toString());
        if (senderSocket) {
          io.to(senderSocket).emit("message_read", { id: chatId });
          console.log(`✅ Read event emitted to senderId=${chat.senderId}`);
        }
      } catch (err) {
        console.error(`❌ Read message error: ${err.message}`, { chatId, readerId, stack: err.stack });
        socket.emit("message_error", { error: "Failed to mark message as read" });
      }
    });

    /** Delete message */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      console.log(`📥 Delete message received: chatId=${chatId}, userId=${userId}, forEveryone=${forEveryone} at ${logTimestamp()}`);
      try {
        if (!chatId || !userId || userId !== socket.userId) {
          console.error(`❌ Delete message error: Invalid data`, { chatId, userId, forEveryone, socketUserId: socket.userId });
          socket.emit("delete_error", { error: "Invalid chat or user ID or unauthorized user" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat) {
          console.error(`❌ Delete message error: Chat not found, chatId=${chatId}`);
          socket.emit("delete_error", { error: "Message not found" });
          return;
        }

        if (forEveryone && chat.senderId.toString() !== userId) {
          console.error(`❌ Delete message error: Only sender can delete for everyone`, { chatId, userId });
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
        console.log(`✅ Message deleted: chatId=${chatId}, userId=${userId}, forEveryone=${forEveryone}`);

        const recipients = new Set();
        if (chat.receiverId) {
          const receiverSocket = onlineUsers.get(chat.receiverId.toString());
          if (receiverSocket) recipients.add(receiverSocket);
        }
        if (chat.groupId) {
          const group = await Group.findById(chat.groupId);
          if (group) {
            group.members.forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId.toString());
              if (memberSocket && memberId.toString() !== userId) recipients.add(memberSocket);
            });
          }
        }
        if (chat.channelId) {
          const channel = await Channel.findById(chat.channelId);
          if (channel) {
            channel.members.forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId.toString());
              if (memberSocket && memberId.toString() !== userId) recipients.add(memberSocket);
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

        recipients.forEach(socketId => {
          io.to(socketId).emit("message_deleted", deletedMessage);
          console.log(`✅ Delete event emitted to socketId=${socketId}: chatId=${chatId}`);
        });

        socket.emit("delete_success", { chatId });
        console.log(`✅ Delete success emitted: chatId=${chatId}, userId=${userId}`);
      } catch (err) {
        console.error(`❌ Delete message error: ${err.message}`, { chatId, userId, forEveryone, stack: err.stack });
        socket.emit("delete_error", { error: "Failed to delete message" });
      }
    });

    /** Block user */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      console.log(`📥 Block user received: blockerId=${blockerId}, blockedId=${blockedId} at ${logTimestamp()}`);
      try {
        if (!blockerId || !blockedId || blockerId === blockedId || blockerId !== socket.userId) {
          console.error(`❌ Block user error: Invalid data`, { blockerId, blockedId, socketUserId: socket.userId });
          socket.emit("block_error", { error: "Invalid blocker or blocked ID or unauthorized blocker" });
          return;
        }

        const existingBlock = await Block.findOne({ blockerId, blockedId });
        if (existingBlock) {
          console.log(`⚠️ Block user ignored: Already blocked`, { blockerId, blockedId });
          socket.emit("block_error", { error: "User already blocked" });
          return;
        }

        await Block.create({ blockerId, blockedId });
        console.log(`✅ User blocked: blockerId=${blockerId}, blockedId=${blockedId}`);

        const blockedSocket = onlineUsers.get(blockedId);
        if (blockedSocket) {
          io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
          console.log(`✅ Blocked update emitted to blockedId=${blockedId}`);
        }

        socket.emit("block_success", { blockedId });
        console.log(`✅ Block success emitted: blockerId=${blockerId}, blockedId=${blockedId}`);
      } catch (err) {
        console.error(`❌ Block user error: ${err.message}`, { blockerId, blockedId, stack: err.stack });
        socket.emit("block_error", { error: "Failed to block user" });
      }
    });

    /** Unblock user */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      console.log(`📥 Unblock user received: blockerId=${blockerId}, blockedId=${blockedId} at ${logTimestamp()}`);
      try {
        if (!blockerId || !blockedId || blockerId !== socket.userId) {
          console.error(`❌ Unblock user error: Invalid data`, { blockerId, blockedId, socketUserId: socket.userId });
          socket.emit("unblock_error", { error: "Invalid blocker or blocked ID or unauthorized blocker" });
          return;
        }

        const result = await Block.deleteOne({ blockerId, blockedId });
        if (result.deletedCount === 0) {
          console.error(`❌ Unblock user error: Block not found`, { blockerId, blockedId });
          socket.emit("unblock_error", { error: "Block not found" });
          return;
        }

        console.log(`✅ User unblocked: blockerId=${blockerId}, blockedId=${blockedId}`);

        const unblockedSocket = onlineUsers.get(blockedId);
        if (unblockedSocket) {
          io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
          console.log(`✅ Unblocked update emitted to blockedId=${blockedId}`);
        }

        socket.emit("unblock_success", { blockedId });
        console.log(`✅ Unblock success emitted: blockerId=${blockerId}, blockedId=${blockedId}`);
      } catch (err) {
        console.error(`❌ Unblock user error: ${err.message}`, { blockerId, blockedId, stack: err.stack });
        socket.emit("unblock_error", { error: "Failed to unblock user" });
      }
    });

    /** Disconnect */
    socket.on("disconnect", async () => {
      console.log(`❌ Chat client disconnected: socketId=${socket.id}, userId=${socket.userId} at ${logTimestamp()}`);
      try {
        if (socket.userId && onlineUsers.get(socket.userId) === socket.id) {
          onlineUsers.delete(socket.userId);
          const user = await User.findById(socket.userId);
          if (user) {
            const now = new Date();
            await User.findByIdAndUpdate(socket.userId, { online: false, lastSeen: now });
            io.emit("presence_update", {
              userId: socket.userId,
              online: false,
              lastSeen: now.toISOString(),
            });
            console.log(`✅ User disconnected: userId=${socket.userId}, lastSeen=${now.toISOString()}`);
          }
        }
      } catch (err) {
        console.error(`❌ Disconnect error: ${err.message}`, { socketId: socket.id, userId: socket.userId, stack: err.stack });
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