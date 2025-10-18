import { Server } from "socket.io";
import User from "../models/User.js";
import Chat from "../models/Chat.js";
import Block from "../models/Block.js";
import Group from "../models/Group.js";
import Channel from "../models/Channel.js";
import Profile from "../models/Profile.js";
import Contact from "../model/Contact.js";
import jwt from "jsonwebtoken";
import moment from "moment-timezone";

const logTimestamp = () =>
  moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

// Normalize phone number function (consistent with Express routes)
export const normalizePhoneNumber = (phone) => {
  const timestamp = logTimestamp();
  if (!phone || typeof phone !== "string") {
    console.warn(
      `[normalizePhoneNumber] Invalid or missing phone number: ${phone} at ${timestamp}`
    );
    return null;
  }
  let normalized = phone.trim().replace(/[\s-]/g, "");
  if (!normalized.startsWith("+") && /^\d{10}$/.test(normalized)) {
    normalized = `+92${normalized}`; // Default to Pakistan country code
  }
  console.log(
    `[normalizePhoneNumber] Normalized: ${phone} -> ${normalized} at ${timestamp}`
  );
  return normalized;
};

// Format profile for response (consistent with get_blocked_users)
export const formatProfile = (
  profile,
  user,
  customName = null,
  isBlocked = false
) => {
  const timestamp = logTimestamp();
  const phone = profile?.phone || "";
  const name = customName || profile?.displayName || "Unknown";
  const displayName = name && phone ? name : name || phone || "Unknown";

  const formatted = {
    id: profile?._id?.toString() || null,
    userId: user?._id?.toString() || null,
    phone,
    displayName,
    randomNumber: profile?.randomNumber || "",
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: validator.escape(profile?.avatarUrl || ""),
    fcmToken: profile?.fcmToken || user?.fcmToken || "",
    createdAt: profile?.createdAt?.toISOString() || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen?.toISOString() || null,
    customName: customName || null,
    isBlocked,
  };

  console.log(
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${customName}, isBlocked=${isBlocked} at ${timestamp}`
  );
  return formatted;
};

export const initChatSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/chat-socket",
    pingTimeout: 60000,
    pingInterval: 25000,
  });
  const onlineUsers = new Map();

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.query.userId;
    const logTimestamp = () =>
      moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

    if (!token || !userId) {
      console.error(
        `❌ Auth error: Missing token or userId at ${logTimestamp()}`,
        { userId }
      );
      return next(new Error("Authentication error: Token and userId required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const profile = await Profile.findById(userId);
      if (!profile || decoded.phone !== profile.phone) {
        console.error(
          `❌ Auth error: Invalid userId=${userId} or token at ${logTimestamp()}`,
          { decoded }
        );
        return next(new Error("Authentication error: Invalid user or token"));
      }
      socket.userId = userId;
      socket.phone = profile.phone; // Store for User lookup
      next();
    } catch (err) {
      console.error(`❌ Auth error: ${err.message} at ${logTimestamp()}`, {
        userId,
      });
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const logTimestamp = () =>
      moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

    // Handle connection errors
    socket.on("connect_error", (err) => {
      console.error(
        `❌ Connection error: ${err.message} at ${logTimestamp()}`,
        { socketId: socket.id }
      );
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
        await User.findByIdAndUpdate(user._id, {
          online: true,
          lastSeen: new Date(),
        });
        io.emit("presence_update", {
          userId,
          online: true,
          lastSeen: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`❌ Join error: ${err.message} at ${logTimestamp()}`, {
          userId,
        });
        socket.emit("join_error", { error: "Server error during join" });
      }
    });

    /** Typing indicator */
    socket.on("typing", async ({ senderId, receiverId, typing }) => {
      try {
        if (
          !senderId ||
          !receiverId ||
          typeof typing !== "boolean" ||
          senderId !== socket.userId
        ) {
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
          io.to(receiverSocket).emit("typing", {
            senderId,
            receiverId,
            typing,
          });
        }
      } catch (err) {
        console.error(`❌ Typing error: ${err.message} at ${logTimestamp()}`, {
          senderId,
          receiverId,
        });
        socket.emit("typing_error", { error: "Server error during typing" });
      }
    });

    /** Recording audio indicator */
    socket.on(
      "recording_audio",
      async ({ senderId, receiverId, recording }) => {
        try {
          if (
            !senderId ||
            !receiverId ||
            typeof recording !== "boolean" ||
            senderId !== socket.userId
          ) {
            socket.emit("recording_audio_error", {
              error: "Invalid recording data",
            });
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
            io.to(receiverSocket).emit("recording_audio", {
              senderId,
              receiverId,
              recording,
            });
          }
        } catch (err) {
          console.error(
            `❌ Recording audio error: ${err.message} at ${logTimestamp()}`,
            {
              senderId,
              receiverId,
            }
          );
          socket.emit("recording_audio_error", {
            error: "Server error during recording",
          });
        }
      }
    );

    /** Uploading media indicator */
    socket.on(
      "uploading_media",
      async ({ senderId, receiverId, groupId, channelId, uploading }) => {
        try {
          if (
            !senderId ||
            (!receiverId && !groupId && !channelId) ||
            typeof uploading !== "boolean" ||
            senderId !== socket.userId
          ) {
            socket.emit("uploading_media_error", {
              error: "Invalid uploading data",
            });
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
              socket.emit("uploading_media_error", {
                error: "User is blocked",
              });
              return;
            }

            const receiverSocket = onlineUsers.get(receiverId);
            if (receiverSocket) {
              io.to(receiverSocket).emit("uploading_media", {
                senderId,
                receiverId,
                uploading,
              });
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (!group || !group.members.includes(senderId)) {
              socket.emit("uploading_media_error", {
                error: group ? "Sender not in group" : "Group not found",
              });
              return;
            }
            group.members
              .map((id) => id.toString())
              .filter((id) => id !== senderId)
              .forEach((memberId) => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  io.to(memberSocket).emit("uploading_media", {
                    senderId,
                    groupId,
                    uploading,
                  });
                }
              });
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (!channel || !channel.members.includes(senderId)) {
              socket.emit("uploading_media_error", {
                error: channel ? "Sender not in channel" : "Channel not found",
              });
              return;
            }
            channel.members
              .map((id) => id.toString())
              .filter((id) => id !== senderId)
              .forEach((memberId) => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  io.to(memberSocket).emit("uploading_media", {
                    senderId,
                    channelId,
                    uploading,
                  });
                }
              });
          }
        } catch (err) {
          console.error(
            `❌ Uploading media error: ${err.message} at ${logTimestamp()}`,
            {
              senderId,
              receiverId,
              groupId,
              channelId,
            }
          );
          socket.emit("uploading_media_error", {
            error: "Server error during uploading",
          });
        }
      }
    );

    /** Send text message */
    socket.on("send_message", async (data, callback) => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (
          !data.senderId ||
          (!data.receiverId && !data.groupId && !data.channelId) ||
          !data.content ||
          data.senderId !== socket.userId
        ) {
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

        // Validate receiver profile, group, or channel
        if (data.receiverId) {
          let receiverProfile = await Profile.findById(data.receiverId);
          if (!receiverProfile) {
            const user = await User.findById(data.receiverId);
            if (user) {
              receiverProfile = await Profile.findOne({ phone: user.phone });
              if (!receiverProfile) {
                receiverProfile = await Profile.create({
                  phone: user.phone,
                  displayName: user.displayName,
                  randomNumber: Math.random().toString(36).substring(2, 10),
                  isVisible: false,
                  isNumberVisible: false,
                  avatarUrl: "",
                });
              }
              data.receiverId = receiverProfile._id.toString();
            } else {
              socket.emit("message_error", {
                error: "Receiver profile not found",
              });
              if (callback) callback({ error: "Receiver profile not found" });
              return;
            }
          }

          const blocked = await Block.findOne({
            $or: [
              { blockerId: data.receiverId, blockedId: data.senderId },
              { blockerId: data.senderId, blockedId: data.receiverId },
            ],
          });
          if (blocked) {
            socket.emit("message_error", { error: "User is blocked" });
            if (callback) callback({ error: "User is blocked" });
            return;
          }
        } else if (data.groupId) {
          const group = await Group.findById(data.groupId);
          if (!group || !group.members.includes(data.senderId)) {
            socket.emit("message_error", {
              error: group ? "Sender not in group" : "Group not found",
            });
            if (callback)
              callback({
                error: group ? "Sender not in group" : "Group not found",
              });
            return;
          }
        } else if (data.channelId) {
          const channel = await Channel.findById(data.channelId);
          if (!channel || !channel.members.includes(data.senderId)) {
            socket.emit("message_error", {
              error: channel ? "Sender not in channel" : "Channel not found",
            });
            if (callback)
              callback({
                error: channel ? "Sender not in channel" : "Channel not found",
              });
            return;
          }
        }

        const chat = new Chat({
          senderId: data.senderId,
          receiverId: data.receiverId || undefined,
          groupId: data.groupId || undefined,
          channelId: data.channelId || undefined,
          content: data.content,
          type: "text",
          status: "sent",
          deletedFor: [],
        });

        await chat.save();

        const messageData = {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          receiverId: chat.receiverId?.toString(),
          groupId: chat.groupId?.toString(),
          channelId: chat.channelId?.toString(),
          content: chat.content,
          type: chat.type,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          duration: chat.duration || 0,
        };

        socket.emit("message_sent", messageData);

        if (data.receiverId) {
          const receiverSocket = onlineUsers.get(data.receiverId);
          if (receiverSocket) {
            io.to(receiverSocket).emit("receive_message", messageData);
            chat.status = "delivered";
            await chat.save();
            messageData.status = "delivered";
          }
        } else if (data.groupId) {
          const group = await Group.findById(data.groupId);
          if (group) {
            group.members
              .map((id) => id.toString())
              .filter((id) => id !== data.senderId)
              .forEach((memberId) => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  io.to(memberSocket).emit("receive_message", messageData);
                }
              });
            chat.status = "delivered";
            await chat.save();
            messageData.status = "delivered";
          }
        } else if (data.channelId) {
          const channel = await Channel.findById(data.channelId);
          if (channel) {
            channel.members
              .map((id) => id.toString())
              .filter((id) => id !== data.senderId)
              .forEach((memberId) => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) {
                  io.to(memberSocket).emit("receive_message", messageData);
                }
              });
            chat.status = "delivered";
            await chat.save();
            messageData.status = "delivered";
          }
        }

        if (callback) callback({ status: "success", id: chat._id.toString() });
      } catch (err) {
        console.error(`❌ Send message error: ${err.message} at ${timestamp}`, {
          senderId: data.senderId,
          receiverId: data.receiverId,
          groupId: data.groupId,
          channelId: data.channelId,
        });
        socket.emit("message_error", { error: "Failed to send message" });
        if (callback) callback({ error: "Failed to send message" });
      }
    });

    /** Send voice message */
    socket.on(
      "send_voice",
      async ({ senderId, receiverId, content, duration }, callback) => {
        const timestamp = moment()
          .tz("Asia/Karachi")
          .format("DD/MM/YYYY, hh:mm:ss a");
        try {
          if (
            !senderId ||
            !receiverId ||
            !content ||
            typeof content !== "string" ||
            content.trim() === "" ||
            senderId !== socket.userId ||
            typeof duration !== "number" ||
            duration <= 0 ||
            duration > 180
          ) {
            socket.emit("voice_error", {
              error: "Invalid voice data or duration (max 3 minutes)",
            });
            if (callback) callback({ error: "Invalid voice data or duration" });
            return;
          }

          const senderProfile = await Profile.findById(senderId);
          let receiverProfile = await Profile.findById(receiverId);
          if (!senderProfile || !receiverProfile) {
            if (!receiverProfile) {
              const user = await User.findById(receiverId);
              if (user) {
                receiverProfile = await Profile.findOne({ phone: user.phone });
                if (!receiverProfile) {
                  receiverProfile = await Profile.create({
                    phone: user.phone,
                    displayName: user.displayName,
                    randomNumber: Math.random().toString(36).substring(2, 10),
                    isVisible: false,
                    isNumberVisible: false,
                    avatarUrl: "",
                  });
                }
                receiverId = receiverProfile._id.toString();
              } else {
                socket.emit("voice_error", {
                  error: "Receiver profile not found",
                });
                if (callback) callback({ error: "Receiver profile not found" });
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

          socket.emit("voice_sent", voiceData);
          const receiverSocket = onlineUsers.get(receiverId);
          if (receiverSocket) {
            io.to(receiverSocket).emit("receive_voice", voiceData);
            chat.status = "delivered";
            await chat.save();
            voiceData.status = "delivered";
          }

          if (callback)
            callback({ status: "success", id: chat._id.toString() });
        } catch (err) {
          console.error(`❌ Send voice error: ${err.message} at ${timestamp}`, {
            senderId,
            receiverId,
          });
          socket.emit("voice_error", { error: "Failed to send voice message" });
          if (callback) callback({ error: "Failed to send voice message" });
        }
      }
    );

    /** Send media (images, videos, documents) */
    socket.on(
      "send_media",
      async ({ senderId, receiverId, groupId, channelId, files }, callback) => {
        const timestamp = moment()
          .tz("Asia/Karachi")
          .format("DD/MM/YYYY, hh:mm:ss a");
        try {
          if (
            !senderId ||
            (!receiverId && !groupId && !channelId) ||
            !files ||
            !Array.isArray(files) ||
            files.length === 0 ||
            files.length > 10 ||
            senderId !== socket.userId
          ) {
            socket.emit("media_error", {
              error: "Invalid media data (1-10 files required)",
            });
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
            if (
              !["image", "video", "file"].includes(type) ||
              !url ||
              typeof url !== "string" ||
              url.trim() === "" ||
              !fileType ||
              typeof fileType !== "string"
            ) {
              socket.emit("media_error", {
                error: `Invalid file data: ${type}`,
              });
              if (callback) callback({ error: `Invalid file data: ${type}` });
              return;
            }
            if (type === "image" && !fileType.startsWith("image/")) {
              socket.emit("media_error", {
                error: `Invalid MIME type for image: ${fileType}`,
              });
              if (callback)
                callback({ error: `Invalid MIME type for image: ${fileType}` });
              return;
            }
            if (
              type === "video" &&
              !fileType.startsWith("video/") &&
              fileType !== "application/octet-stream"
            ) {
              socket.emit("media_error", {
                error: `Invalid MIME type for video: ${fileType}`,
              });
              if (callback) callback({ error: `Invalid video MIME type` });
              return;
            }
            if (
              type === "file" &&
              (!fileName || typeof fileName !== "string")
            ) {
              socket.emit("media_error", {
                error: "Documents must have a file name",
              });
              if (callback)
                callback({ error: "Documents must have a file name" });
              return;
            }
            if (
              type === "video" &&
              duration != null &&
              (typeof duration !== "number" || duration <= 0 || duration > 300)
            ) {
              console.warn(
                `Invalid video duration for ${fileName}: ${duration}, proceeding without duration`
              );
            }
          }

          if (receiverId) {
            let receiverProfile = await Profile.findById(receiverId);
            if (!receiverProfile) {
              const user = await User.findById(receiverId);
              if (user) {
                receiverProfile = await Profile.findOne({ phone: user.phone });
                if (!receiverProfile) {
                  receiverProfile = await Profile.create({
                    phone: user.phone,
                    displayName: user.displayName,
                    randomNumber: Math.random().toString(36).substring(2, 10),
                    isVisible: false,
                    isNumberVisible: false,
                    avatarUrl: "",
                  });
                }
                receiverId = receiverProfile._id.toString();
              } else {
                socket.emit("media_error", {
                  error: "Receiver profile not found",
                });
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
              socket.emit("media_error", {
                error: group ? "Sender not in group" : "Group not found",
              });
              if (callback)
                callback({
                  error: group ? "Sender not in group" : "Group not found",
                });
              return;
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (!channel || !channel.members.includes(senderId)) {
              socket.emit("media_error", {
                error: channel ? "Sender not in channel" : "Channel not found",
              });
              if (callback)
                callback({
                  error: channel
                    ? "Sender not in channel"
                    : "Channel not found",
                });
              return;
            }
          }

          const chats = await Promise.all(
            files.map((file) =>
              Chat.create({
                senderId,
                receiverId: receiverId || undefined,
                groupId: groupId || undefined,
                channelId: channelId || undefined,
                type: file.type,
                content: file.url,
                fileType: file.fileType,
                fileName: file.type === "file" ? file.fileName : undefined,
                duration: file.type === "video" ? file.duration || 0 : 0,
                status: "sent",
                deletedFor: [],
              })
            )
          );

          const payload = chats.map((chat) => ({
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
              payload.forEach((item) =>
                io.to(receiverSocket).emit("receive_media", item)
              );
              await Promise.all(
                chats.map(async (chat) => {
                  chat.status = "delivered";
                  await chat.save();
                })
              );
              payload.forEach((item) => (item.status = "delivered"));
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (group) {
              group.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    payload.forEach((item) =>
                      io.to(memberSocket).emit("receive_media", item)
                    );
                  }
                });
              await Promise.all(
                chats.map(async (chat) => {
                  chat.status = "delivered";
                  await chat.save();
                })
              );
              payload.forEach((item) => (item.status = "delivered"));
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (channel) {
              channel.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    payload.forEach((item) =>
                      io.to(memberSocket).emit("receive_media", item)
                    );
                  }
                });
              await Promise.all(
                chats.map(async (chat) => {
                  chat.status = "delivered";
                  await chat.save();
                })
              );
              payload.forEach((item) => (item.status = "delivered"));
            }
          }

          payload.forEach((item) => socket.emit("media_sent", item));
          if (callback)
            callback({
              status: "success",
              ids: chats.map((c) => c._id.toString()),
            });
        } catch (err) {
          console.error(`❌ Send media error: ${err.message} at ${timestamp}`, {
            senderId,
            receiverId,
            groupId,
            channelId,
          });
          socket.emit("media_error", { error: "Failed to send media" });
          if (callback) callback({ error: "Failed to send media" });
        }
      }
    );

    /** Send location */
    socket.on(
      "send_location",
      async (
        { senderId, receiverId, groupId, channelId, latitude, longitude, name },
        callback
      ) => {
        const timestamp = moment()
          .tz("Asia/Karachi")
          .format("DD/MM/YYYY, hh:mm:ss a");
        try {
          if (
            !senderId ||
            (!receiverId && !groupId && !channelId) ||
            senderId !== socket.userId ||
            typeof latitude !== "number" ||
            typeof longitude !== "number" ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180 ||
            (name && typeof name !== "string")
          ) {
            socket.emit("location_error", {
              error: "Invalid location or recipient data",
            });
            if (callback)
              callback({ error: "Invalid location or recipient data" });
            return;
          }

          const senderProfile = await Profile.findById(senderId);
          if (!senderProfile) {
            socket.emit("location_error", {
              error: "Sender profile not found",
            });
            if (callback) callback({ error: "Sender profile not found" });
            return;
          }

          if (receiverId) {
            let receiverProfile = await Profile.findById(receiverId);
            if (!receiverProfile) {
              const user = await User.findById(receiverId);
              if (user) {
                receiverProfile = await Profile.findOne({ phone: user.phone });
                if (!receiverProfile) {
                  receiverProfile = await Profile.create({
                    phone: user.phone,
                    displayName: user.displayName,
                    randomNumber: Math.random().toString(36).substring(2, 10),
                    isVisible: false,
                    isNumberVisible: false,
                    avatarUrl: "",
                  });
                }
                receiverId = receiverProfile._id.toString();
              } else {
                socket.emit("location_error", {
                  error: "Receiver profile not found",
                });
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
              socket.emit("location_error", { error: "User is blocked" });
              if (callback) callback({ error: "User is blocked" });
              return;
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (!group || !group.members.includes(senderId)) {
              socket.emit("location_error", {
                error: group ? "Sender not in group" : "Group not found",
              });
              if (callback)
                callback({
                  error: group ? "Sender not in group" : "Group not found",
                });
              return;
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (!channel || !channel.members.includes(senderId)) {
              socket.emit("location_error", {
                error: channel ? "Sender not in channel" : "Channel not found",
              });
              if (callback)
                callback({
                  error: channel
                    ? "Sender not in channel"
                    : "Channel not found",
                });
              return;
            }
          }

          const chat = new Chat({
            senderId,
            receiverId: receiverId || undefined,
            groupId: groupId || undefined,
            channelId: channelId || undefined,
            content: JSON.stringify({
              latitude,
              longitude,
              name: name || undefined,
            }),
            type: "location",
            location: { latitude, longitude, name: name || undefined },
            status: "sent",
            deletedFor: [],
          });

          await chat.save();

          const locationData = {
            id: chat._id.toString(),
            senderId: chat.senderId.toString(),
            receiverId: chat.receiverId?.toString(),
            groupId: chat.groupId?.toString(),
            channelId: chat.channelId?.toString(),
            content: chat.content,
            type: chat.type,
            location: chat.location,
            timestamp: chat.createdAt.toISOString(),
            status: chat.status,
          };

          socket.emit("location_sent", locationData);

          if (receiverId) {
            const receiverSocket = onlineUsers.get(receiverId);
            if (receiverSocket) {
              io.to(receiverSocket).emit("receive_location", locationData);
              chat.status = "delivered";
              await chat.save();
              locationData.status = "delivered";
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (group) {
              group.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    io.to(memberSocket).emit("receive_location", locationData);
                  }
                });
              chat.status = "delivered";
              await chat.save();
              locationData.status = "delivered";
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (channel) {
              channel.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    io.to(memberSocket).emit("receive_location", locationData);
                  }
                });
              chat.status = "delivered";
              await chat.save();
              locationData.status = "delivered";
            }
          }

          if (callback)
            callback({ status: "success", id: chat._id.toString() });
        } catch (err) {
          console.error(
            `❌ Send location error: ${err.message} at ${timestamp}`,
            {
              senderId,
              receiverId,
              groupId,
              channelId,
            }
          );
          socket.emit("location_error", { error: "Failed to send location" });
          if (callback) callback({ error: "Failed to send location" });
        }
      }
    );

    /** Forward message */
    socket.on(
      "forward_message",
      async (
        { chatId, senderId, receiverId, groupId, channelId },
        callback
      ) => {
        const timestamp = moment()
          .tz("Asia/Karachi")
          .format("DD/MM/YYYY, hh:mm:ss a");
        try {
          // Validate input
          if (
            !chatId ||
            !senderId ||
            (!receiverId && !groupId && !channelId) ||
            senderId !== socket.userId
          ) {
            socket.emit("forward_error", {
              error: "Invalid message or recipient data",
            });
            if (callback)
              callback({ error: "Invalid message or recipient data" });
            return;
          }

          // Validate sender profile
          const senderProfile = await Profile.findById(senderId);
          if (!senderProfile) {
            socket.emit("forward_error", { error: "Sender profile not found" });
            if (callback) callback({ error: "Sender profile not found" });
            return;
          }

          // Validate original message
          const originalChat = await Chat.findById(chatId);
          if (!originalChat || originalChat.deletedFor.includes(senderId)) {
            socket.emit("forward_error", {
              error: originalChat ? "Message deleted" : "Message not found",
            });
            if (callback)
              callback({
                error: originalChat ? "Message deleted" : "Message not found",
              });
            return;
          }

          // Validate recipient
          if (receiverId) {
            let receiverProfile = await Profile.findById(receiverId);
            if (!receiverProfile) {
              const user = await User.findById(receiverId);
              if (user) {
                receiverProfile = await Profile.findOne({ phone: user.phone });
                if (!receiverProfile) {
                  receiverProfile = await Profile.create({
                    phone: user.phone,
                    displayName: user.displayName,
                    randomNumber: Math.random().toString(36).substring(2, 10),
                    isVisible: false,
                    isNumberVisible: false,
                    avatarUrl: "",
                  });
                }
                receiverId = receiverProfile._id.toString();
              } else {
                socket.emit("forward_error", {
                  error: "Receiver profile not found",
                });
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
              socket.emit("forward_error", { error: "User is blocked" });
              if (callback) callback({ error: "User is blocked" });
              return;
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (!group || !group.members.includes(senderId)) {
              socket.emit("forward_error", {
                error: group ? "Sender not in group" : "Group not found",
              });
              if (callback)
                callback({
                  error: group ? "Sender not in group" : "Group not found",
                });
              return;
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (!channel || !channel.members.includes(senderId)) {
              socket.emit("forward_error", {
                error: channel ? "Sender not in channel" : "Channel not found",
              });
              if (callback)
                callback({
                  error: channel
                    ? "Sender not in channel"
                    : "Channel not found",
                });
              return;
            }
          }

          // Create forwarded message
          const chat = new Chat({
            senderId,
            receiverId: receiverId || undefined,
            groupId: groupId || undefined,
            channelId: channelId || undefined,
            content: originalChat.content,
            type: originalChat.type,
            fileType: originalChat.fileType,
            fileName: originalChat.fileName,
            location: originalChat.location,
            duration: originalChat.duration || 0,
            status: "sent",
            deletedFor: [],
            forwardedFrom: originalChat._id,
          });

          await chat.save();

          const messageData = {
            id: chat._id.toString(),
            senderId: chat.senderId.toString(),
            receiverId: chat.receiverId?.toString(),
            groupId: chat.groupId?.toString(),
            channelId: chat.channelId?.toString(),
            content: chat.content,
            type: chat.type,
            fileType: chat.fileType,
            fileName: chat.fileName,
            location: chat.location,
            duration: chat.duration || 0,
            timestamp: chat.createdAt.toISOString(),
            status: chat.status,
            forwardedFrom: originalChat._id.toString(),
          };

          // Emit to sender
          socket.emit("message_forwarded", messageData);

          // Emit to recipients based on message type
          if (receiverId) {
            const receiverSocket = onlineUsers.get(receiverId);
            if (receiverSocket) {
              if (messageData.type === "location") {
                io.to(receiverSocket).emit("receive_location", messageData);
              } else if (messageData.type === "voice") {
                io.to(receiverSocket).emit("receive_voice", messageData);
              } else if (
                ["image", "video", "file"].includes(messageData.type)
              ) {
                io.to(receiverSocket).emit("receive_media", messageData);
              } else {
                io.to(receiverSocket).emit("receive_message", messageData);
              }
              chat.status = "delivered";
              await chat.save();
              messageData.status = "delivered";
            }
          } else if (groupId) {
            const group = await Group.findById(groupId);
            if (group) {
              group.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    if (messageData.type === "location") {
                      io.to(memberSocket).emit("receive_location", messageData);
                    } else if (messageData.type === "voice") {
                      io.to(memberSocket).emit("receive_voice", messageData);
                    } else if (
                      ["image", "video", "file"].includes(messageData.type)
                    ) {
                      io.to(memberSocket).emit("receive_media", messageData);
                    } else {
                      io.to(memberSocket).emit("receive_message", messageData);
                    }
                  }
                });
              chat.status = "delivered";
              await chat.save();
              messageData.status = "delivered";
            }
          } else if (channelId) {
            const channel = await Channel.findById(channelId);
            if (channel) {
              channel.members
                .map((id) => id.toString())
                .filter((id) => id !== senderId)
                .forEach((memberId) => {
                  const memberSocket = onlineUsers.get(memberId);
                  if (memberSocket) {
                    if (messageData.type === "location") {
                      io.to(memberSocket).emit("receive_location", messageData);
                    } else if (messageData.type === "voice") {
                      io.to(memberSocket).emit("receive_voice", messageData);
                    } else if (
                      ["image", "video", "file"].includes(messageData.type)
                    ) {
                      io.to(memberSocket).emit("receive_media", messageData);
                    } else {
                      io.to(memberSocket).emit("receive_message", messageData);
                    }
                  }
                });
              chat.status = "delivered";
              await chat.save();
              messageData.status = "delivered";
            }
          }

          if (callback)
            callback({ status: "success", id: chat._id.toString() });
        } catch (err) {
          console.error(
            `❌ Forward message error: ${err.message} at ${timestamp}`,
            {
              senderId,
              chatId,
              receiverId,
              groupId,
              channelId,
            }
          );
          socket.emit("forward_error", { error: "Failed to forward message" });
          if (callback) callback({ error: "Failed to forward message" });
        }
      }
    );

    /** Read message */
    socket.on("read_message", async ({ chatId, readerId }) => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (!chatId || !readerId || readerId !== socket.userId) {
          socket.emit("message_error", { error: "Invalid chat or reader ID" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat || chat.deletedFor.includes(readerId)) {
          socket.emit("message_error", {
            error: chat ? "Message deleted" : "Message not found",
          });
          return;
        }

        chat.status = "read";
        await chat.save();

        const senderSocket = onlineUsers.get(chat.senderId.toString());
        if (senderSocket) {
          io.to(senderSocket).emit("message_read", { id: chatId });
        }
      } catch (err) {
        console.error(`❌ Read message error: ${err.message} at ${timestamp}`, {
          chatId,
          readerId,
        });
        socket.emit("message_error", {
          error: "Failed to mark message as read",
        });
      }
    });

    /** Delete message */
    socket.on("delete_message", async ({ chatId, userId, forEveryone }) => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
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
          socket.emit("delete_error", {
            error: "Only sender can delete for everyone",
          });
          return;
        }

        if (forEveryone) {
          chat.content = "This message was deleted";
          chat.deletedFor = [
            chat.senderId,
            chat.receiverId,
            ...(chat.groupId
              ? (await Group.findById(chat.groupId))?.members || []
              : []),
            ...(chat.channelId
              ? (await Channel.findById(chat.channelId))?.members || []
              : []),
          ].filter((id) => id);
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
              .map((id) => id.toString())
              .filter((id) => id !== userId)
              .forEach((memberId) => {
                const memberSocket = onlineUsers.get(memberId);
                if (memberSocket) recipients.add(memberSocket);
              });
          }
        }
        if (chat.channelId) {
          const channel = await Channel.findById(chat.channelId);
          if (channel) {
            channel.members
              .map((id) => id.toString())
              .filter((id) => id !== userId)
              .forEach((memberId) => {
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
          location: chat.location,
          duration: chat.duration || 0,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          forwardedFrom: chat.forwardedFrom?.toString(),
        };

        recipients.forEach((socketId) =>
          io.to(socketId).emit("message_deleted", deletedMessage)
        );
        socket.emit("delete_success", { chatId });
      } catch (err) {
        console.error(
          `❌ Delete message error: ${err.message} at ${timestamp}`,
          { chatId, userId }
        );
        socket.emit("delete_error", { error: "Failed to delete message" });
      }
    });

    /** Block user */
    socket.on("block_user", async ({ blockerId, blockedId }) => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (
          !blockerId ||
          !blockedId ||
          blockerId === blockedId ||
          blockerId !== socket.userId
        ) {
          socket.emit("block_error", {
            error: "Invalid blocker or blocked ID",
          });
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
          io.to(blockedSocket).emit("blocked_update", {
            blockerId,
            blocked: true,
          });
        }

        socket.emit("block_success", { blockedId });
      } catch (err) {
        console.error(`❌ Block user error: ${err.message} at ${timestamp}`, {
          blockerId,
          blockedId,
        });
        socket.emit("block_error", { error: "Failed to block user" });
      }
    });

    /** Unblock user */
    socket.on("unblock_user", async ({ blockerId, blockedId }) => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (!blockerId || !blockedId || blockerId !== socket.userId) {
          socket.emit("unblock_error", {
            error: "Invalid blocker or blocked ID",
          });
          return;
        }

        const result = await Block.deleteOne({ blockerId, blockedId });
        if (result.deletedCount === 0) {
          socket.emit("unblock_error", { error: "Block not found" });
          return;
        }

        const unblockedSocket = onlineUsers.get(blockedId);
        if (unblockedSocket) {
          io.to(unblockedSocket).emit("blocked_update", {
            blockerId,
            blocked: false,
          });
        }

        socket.emit("unblock_success", { blockedId });
      } catch (err) {
        console.error(`❌ Unblock user error: ${err.message} at ${timestamp}`, {
          blockerId,
          blockedId,
        });
        socket.emit("unblock_error", { error: "Failed to unblock user" });
      }
    });

    /** Get blocked users */
    socket.on(
      "get_blocked_users",
      async ({ userPhone, page = 1, limit = 20 }, callback) => {
        const timestamp = moment()
          .tz("Asia/Karachi")
          .format("DD/MM/YYYY, hh:mm:ss a");
        try {
          if (
            !userPhone ||
            normalizePhoneNumber(userPhone) !==
              normalizePhoneNumber(socket.phone) ||
            page < 1 ||
            limit < 1 ||
            limit > 100
          ) {
            console.error(
              `[get_blocked_users] Invalid user phone or pagination parameters at ${timestamp}`,
              { userPhone, page, limit, socketPhone: socket.phone }
            );
            socket.emit("blocked_users_error", {
              error: "Invalid user phone or pagination parameters",
            });
            if (callback)
              callback({
                error: "Invalid user phone or pagination parameters",
              });
            return;
          }

          const normalizedPhone = normalizePhoneNumber(userPhone);
          const skip = (page - 1) * limit;

          const myProfile = await Profile.findOne({ phone: normalizedPhone });
          if (!myProfile) {
            console.error(
              `[get_blocked_users] Profile not found: phone=${normalizedPhone} at ${timestamp}`
            );
            socket.emit("blocked_users_error", {
              error: "Your profile not found",
            });
            if (callback) callback({ error: "Your profile not found" });
            return;
          }

          const blocked = await Block.find({ blockerId: myProfile._id })
            .populate(
              "blockedId",
              "phone displayName isVisible isNumberVisible avatarUrl randomNumber createdAt"
            )
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

          console.log(
            `[get_blocked_users] Found ${blocked.length} blocked users at ${timestamp}`
          );

          const phoneNumbers = blocked.map((b) => b.blockedId.phone);
          const users = await User.find({
            phone: { $in: phoneNumbers },
          }).select("phone online lastSeen");
          const userMap = new Map(users.map((u) => [u.phone, u]));

          const contacts = await Contact.find({
            userId: myProfile._id,
            phone: { $in: phoneNumbers },
          }).select("phone customName");
          const contactMap = new Map(
            contacts.map((c) => [c.phone, c.customName || null])
          );

          const blockedProfiles = blocked.map((block) => {
            const profile = block.blockedId;
            const user = userMap.get(profile.phone);
            const customName = contactMap.get(profile.phone);
            return {
              id: profile._id.toString(),
              userId: user?._id.toString() || null,
              phone: profile.phone,
              displayName:
                customName || profile.displayName || profile.phone || "Unknown",
              randomNumber: profile.randomNumber || "",
              isVisible: profile.isVisible ?? false,
              isNumberVisible: profile.isNumberVisible ?? false,
              avatarUrl: profile.avatarUrl || "",
              fcmToken: profile.fcmToken || "",
              createdAt: profile.createdAt?.toISOString() || null,
              online: user?.online ?? false,
              lastSeen: user?.lastSeen?.toISOString() || null,
              customName: customName || null,
              isBlocked: true, // Always true for blocked users
            };
          });

          console.log(
            `[get_blocked_users] Response ready: total=${blocked.length}, profiles=${blockedProfiles.length} at ${timestamp}`
          );
          socket.emit("blocked_users_success", {
            success: true,
            page,
            limit,
            total: blocked.length,
            blockedUsers: blockedProfiles,
          });
          if (callback)
            callback({
              success: true,
              page,
              limit,
              total: blocked.length,
              blockedUsers: blockedProfiles,
            });
        } catch (err) {
          console.error(
            `❌ Get blocked users error: ${err.message} at ${timestamp}`,
            {
              userPhone,
              page,
              limit,
            }
          );
          socket.emit("blocked_users_error", {
            error: "Failed to retrieve blocked users",
          });
          if (callback) callback({ error: "Failed to retrieve blocked users" });
        }
      }
    );

    /** Disconnect */
    socket.on("disconnect", async () => {
      const timestamp = moment()
        .tz("Asia/Karachi")
        .format("DD/MM/YYYY, hh:mm:ss a");
      try {
        if (socket.userId && onlineUsers.get(socket.userId) === socket.id) {
          onlineUsers.delete(socket.userId);
          const user = await User.findOne({ phone: socket.phone });
          if (user) {
            const now = new Date();
            await User.findByIdAndUpdate(user._id, {
              online: false,
              lastSeen: now,
            });
            io.emit("presence_update", {
              userId: socket.userId,
              online: false,
              lastSeen: now.toISOString(),
            });
          }
        }
      } catch (err) {
        console.error(`❌ Disconnect error: ${err.message} at ${timestamp}`, {
          socketId: socket.id,
          userId: socket.userId,
        });
      }
    });
  });

  return io;
};
