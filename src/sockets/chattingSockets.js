import { Server } from "socket.io";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Block from "../models/Block.js";
import Group from "../models/Group.js";
import Channel from "../models/Channel.js";

export const initChatSocket = (server) => {
  const io = new Server(server, { cors: { origin: "*" } });
  const onlineUsers = new Map(); // userId -> socketId

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    /** User joins chat */
    socket.on("join", async (userId) => {
      console.log("User joined:", { userId, socketId: socket.id });
      onlineUsers.set(userId, socket.id);
      await User.findByIdAndUpdate(userId, { online: true, lastSeen: new Date() });
      socket.broadcast.emit("presence_update", { userId, online: true, lastSeen: new Date() });
    });

    /** Typing indicator for text */
    socket.on("typing", async ({ senderId, receiverId, typing }) => {
      console.log("Typing event received:", { senderId, receiverId, typing });
      const blocked = await Block.findOne({
        $or: [
          { blockerId: receiverId, blockedId: senderId },
          { blockerId: senderId, blockedId: receiverId },
        ],
      });
      if (blocked) return;

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("typing", { senderId, typing });
    });

    /** Recording audio indicator */
    socket.on("recording_audio", async ({ senderId, receiverId, recording }) => {
      console.log("Recording audio event received:", { senderId, receiverId, recording });
      const blocked = await Block.findOne({
        $or: [
          { blockerId: receiverId, blockedId: senderId },
          { blockerId: senderId, blockedId: receiverId },
        ],
      });
      if (blocked) return;

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("recording_audio", { senderId, recording });
    });

    /** Uploading media indicator */
    socket.on("uploading_media", async ({ senderId, receiverId, groupId, channelId, uploading }) => {
      console.log("Uploading media event received:", { senderId, receiverId, groupId, channelId, uploading });
      try {
        if (receiverId) {
          const blocked = await Block.findOne({
            $or: [
              { blockerId: receiverId, blockedId: senderId },
              { blockerId: senderId, blockedId: receiverId },
            ],
          });
          if (blocked) return;

          const receiverSocket = onlineUsers.get(receiverId);
          if (receiverSocket) io.to(receiverSocket).emit("uploading_media", { senderId, uploading });
        } else if (groupId) {
          const group = await Group.findById(groupId);
          if (!group) return;
          const memberIds = group.members.map(id => id.toString());
          memberIds.forEach(memberId => {
            if (memberId !== senderId) {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, groupId, uploading });
            }
          });
        } else if (channelId) {
          const channel = await Channel.findById(channelId);
          if (!channel) return;
          const memberIds = channel.members.map(id => id.toString());
          memberIds.forEach(memberId => {
            if (memberId !== senderId) {
              const memberSocket = onlineUsers.get(memberId);
              if (memberSocket) io.to(memberSocket).emit("uploading_media", { senderId, channelId, uploading });
            }
          });
        }
      } catch (err) {
        console.error("uploading_media error:", err);
      }
    });

    /** Send text message */
    socket.on("send_message", async ({ senderId, receiverId, content }) => {
      console.log("Received send_message:", { senderId, receiverId, content });
      try {
        if (!content || typeof content !== "string" || content.trim() === "") {
          return socket.emit("message_error", { error: "Message content is required" });
        }

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
          content,
          status: "sent",
          deletedFor: [],
          createdAt: new Date(),
        });

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_message", {
            id: chat._id.toString(),
            senderId: chat.senderId.toString(),
            receiverId: chat.receiverId.toString(),
            content: chat.content,
            type: chat.type,
            timestamp: chat.createdAt,
            status: chat.status,
            duration: chat.duration,
          });
          chat.status = "delivered";
          await chat.save();
        }

        socket.emit("message_sent", {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId.toString(),
          content: chat.content,
          type: chat.type,
          timestamp: chat.createdAt,
          status: chat.status,
          duration: chat.duration,
        });
      } catch (err) {
        console.error("send_message error:", err);
        socket.emit("message_error", { error: "Failed to send message" });
      }
    });

    /** Send voice message */
    socket.on("send_voice", async ({ senderId, receiverId, content, duration }) => {
      console.log("Received send_voice:", { senderId, receiverId, content, duration });
      try {
        if (!content || typeof content !== "string" || content.trim() === "") {
          return socket.emit("voice_error", { error: "Voice content URL is required" });
        }
        if (typeof duration !== "number" || duration <= 0 || duration > 180) {
          return socket.emit("voice_error", { error: "Voice message duration invalid (max 3 minutes)" });
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
          content,
          duration,
          status: "sent",
          deletedFor: [],
          createdAt: new Date(),
        });

        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit("receive_voice", {
            id: chat._id.toString(),
            senderId: chat.senderId.toString(),
            receiverId: chat.receiverId.toString(),
            content: chat.content,
            type: chat.type,
            timestamp: chat.createdAt,
            status: chat.status,
            duration: chat.duration,
          });
          chat.status = "delivered";
          await chat.save();
        }

        socket.emit("voice_sent", {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId.toString(),
          content: chat.content,
          type: chat.type,
          timestamp: chat.createdAt,
          status: chat.status,
          duration: chat.duration,
        });
      } catch (err) {
        console.error("send_voice error:", err);
        socket.emit("voice_error", { error: "Failed to send voice message" });
      }
    });

    /** Send media (images, videos, documents) - supports multiple files */
    socket.on("send_media", async ({ senderId, receiverId, groupId, channelId, files }) => {
      console.log("Received send_media:", { senderId, receiverId, groupId, channelId, files });
      try {
        if (!files || !Array.isArray(files) || files.length === 0 || files.length > 10) {
          return socket.emit("media_error", { error: "Files must be a non-empty array (max 10)" });
        }
        if (!receiverId && !groupId && !channelId) {
          return socket.emit("media_error", { error: "Must specify receiverId, groupId, or channelId" });
        }

        // Validate files
        for (const file of files) {
          const { type, url, fileType, duration, fileName } = file;
          if (!["image", "video", "file"].includes(type)) {
            return socket.emit("media_error", { error: `Invalid media type: ${type}` });
          }
          if (!url || typeof url !== "string" || url.trim() === "") {
            return socket.emit("media_error", { error: "Each file must have a valid URL" });
          }
          if (!fileType || typeof fileType !== "string") {
            return socket.emit("media_error", { error: "Each file must have a valid MIME type" });
          }
          if (type === "image" && !fileType.startsWith("image/")) {
            return socket.emit("media_error", { error: `Invalid MIME type for image: ${fileType}` });
          }
          if (type === "video" && !fileType.startsWith("video/")) {
            return socket.emit("media_error", { error: `Invalid MIME type for video: ${fileType}` });
          }
          if (type === "video" && (typeof duration !== "number" || duration <= 0 || duration > 300)) {
            return socket.emit("media_error", { error: "Video duration invalid (max 5 minutes)" });
          }
          if (type === "file" && (!fileName || typeof fileName !== "string")) {
            return socket.emit("media_error", { error: "Documents must have a file name" });
          }
        }

        // Check for blocking in 1-to-1 chats
        if (receiverId) {
          const blocked = await Block.findOne({
            $or: [
              { blockerId: receiverId, blockedId: senderId },
              { blockerId: senderId, blockedId: receiverId },
            ],
          });
          if (blocked) {
            return socket.emit("media_error", { error: "User is blocked" });
          }
        }

        // Create a Chat document for each file
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

        // Prepare payload for emission
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
          duration: chat.duration,
          timestamp: chat.createdAt,
          status: chat.status,
        }));

        // Emit to recipients
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
            const memberIds = group.members.map(id => id.toString());
            memberIds.forEach(memberId => {
              if (memberId !== senderId) {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  payload.forEach(item => io.to(memberSocket).emit("receive_media", item));
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
                }
              }
            });
            chats.forEach(async chat => {
              chat.status = "delivered";
              await chat.save();
            });
          }
        }

        // Emit to sender
        payload.forEach(item => socket.emit("media_sent", item));
      } catch (err) {
        console.error("send_media error:", err);
        socket.emit("media_error", { error: "Failed to send media" });
      }
    });

    /** Read message */
    socket.on("read_message", async ({ chatId, readerId }) => {
      console.log("Received read_message:", { chatId, readerId });
      try {
        const chat = await Chat.findById(chatId);
        if (chat && !chat.deletedFor.includes(readerId)) {
          chat.status = "read";
          await chat.save();
          const senderSocket = onlineUsers.get(chat.senderId.toString());
          if (senderSocket) io.to(senderSocket).emit("message_read", { id: chatId });
        }
      } catch (err) {
        console.error("read_message error:", err);
      }
    });

    /** Delete message */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      console.log("Received delete_message:", { chatId, userId, forEveryone });
      try {
        const chat = await Chat.findById(chatId);
        if (!chat) return socket.emit("delete_error", { error: "Message not found" });

        if (forEveryone && chat.senderId.toString() === userId) {
          chat.content = "This message was deleted";
          chat.deletedFor = [
            chat.senderId,
            chat.receiverId,
            ...(chat.groupId ? (await Group.findById(chat.groupId))?.members : []),
            ...(chat.channelId ? (await Channel.findById(chat.channelId))?.members : []),
          ].filter(id => id);
        } else {
          chat.deletedFor.push(userId);
        }
        await chat.save();

        const recipients = [];
        if (chat.receiverId) {
          const receiverSocket = onlineUsers.get(chat.receiverId.toString());
          if (receiverSocket) recipients.push(receiverSocket);
        } else if (chat.groupId) {
          const group = await Group.findById(chat.groupId);
          if (group) {
            group.members.forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId.toString());
              if (memberSocket && memberId.toString() !== userId) recipients.push(memberSocket);
            });
          }
        } else if (chat.channelId) {
          const channel = await Channel.findById(chat.channelId);
          if (channel) {
            channel.members.forEach(memberId => {
              const memberSocket = onlineUsers.get(memberId.toString());
              if (memberSocket && memberId.toString() !== userId) recipients.push(memberSocket);
            });
          }
        }

        const senderSocket = onlineUsers.get(chat.senderId.toString());
        if (senderSocket) recipients.push(senderSocket);

        recipients.forEach(socketId => {
          io.to(socketId).emit("message_deleted", {
            id: chat._id.toString(),
            senderId: chat.senderId.toString(),
            receiverId: chat.receiverId?.toString(),
            groupId: chat.groupId?.toString(),
            channelId: chat.channelId?.toString(),
            content: chat.content,
            type: chat.type,
            fileType: chat.fileType,
            fileName: chat.fileName,
            duration: chat.duration,
            timestamp: chat.createdAt,
            status: chat.status,
          });
        });

        socket.emit("delete_success", { chatId });
      } catch (err) {
        console.error("delete_message error:", err);
        socket.emit("delete_error", { error: "Failed to delete message" });
      }
    });

    /** Block user */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      console.log("Received block_user:", { blockerId, blockedId });
      try {
        await Block.create({ blockerId, blockedId });
        const blockedSocket = onlineUsers.get(blockedId);
        if (blockedSocket) io.to(blockedSocket).emit("blocked_update", { blockerId, blocked: true });
        socket.emit("block_success", { blockedId });
      } catch (err) {
        console.error("block_user error:", err);
        socket.emit("block_error", { error: "Failed to block user" });
      }
    });

    /** Unblock user */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      console.log("Received unblock_user:", { blockerId, blockedId });
      try {
        await Block.deleteOne({ blockerId, blockedId });
        const unblockedSocket = onlineUsers.get(blockedId);
        if (unblockedSocket) io.to(unblockedSocket).emit("blocked_update", { blockerId, blocked: false });
        socket.emit("unblock_success", { blockedId });
      } catch (err) {
        console.error("unblock_user error:", err);
        socket.emit("unblock_error", { error: "Failed to unblock user" });
      }
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