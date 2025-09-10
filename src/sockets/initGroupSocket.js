import { Server } from "socket.io";
import Channel from "../models/Channel.js";
import Group from "../models/Group.js";
import Chat from "../models/Chat.js";
import User from "../models/User.js";
import { isValidObjectId } from "mongoose";

export const initGroupSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/group-socket",
  });

  const onlineUsers = new Map(); // userId -> socketId
  const typingUsers = new Map(); // groupId -> Set of typing userIds

  io.on("connection", (socket) => {
    console.log("User connected to group socket:", socket.id);

    /** User joins group chatting system */
    socket.on("join_groups", async (userId) => {
      if (!userId || !isValidObjectId(userId)) {
        socket.emit("error", { message: "Invalid user ID" });
        return socket.disconnect();
      }

      const userIdStr = userId.toString();
      onlineUsers.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      try {
        // Update user online status
        await User.findByIdAndUpdate(userIdStr, {
          online: true,
          lastSeen: new Date(),
        });

        // Get user's groups and join their rooms
        const userGroups = await Group.find({ members: userIdStr });
        const groupRooms = userGroups.map((gr) => `group_${gr._id}`);
        if (groupRooms.length > 0) {
          socket.join(groupRooms);
          // Emit group music for each group
          userGroups.forEach((group) => {
            if (group.musicUrl) {
              socket.emit("play_group_music", { groupId: group._id, musicUrl: group.musicUrl });
            }
          });
        }

        console.log(`User ${userIdStr} joined group chatting system`);
      } catch (error) {
        console.error("Join groups error:", error);
        socket.emit("error", { message: "Failed to join groups" });
        socket.disconnect();
      }
    });

    /** Create a new group with music */
    socket.on("create_group", async (data, callback) => {
      try {
        const { name, channelId, members = [], musicUrl } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!name || name.trim().length < 3) {
          return callback({ success: false, message: "Group name must be at least 3 characters" });
        }
        if (!isValidObjectId(channelId)) {
          return callback({ success: false, message: "Invalid channel ID" });
        }
        if (musicUrl && !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(musicUrl)) {
          return callback({ success: false, message: "Invalid music URL format" });
        }
        if (!members.every(isValidObjectId)) {
          return callback({ success: false, message: "Invalid member IDs" });
        }

        const channel = await Channel.findById(channelId);
        if (!channel) {
          return callback({ success: false, message: "Channel not found" });
        }

        // Verify all members exist
        const validMembers = await User.find({ _id: { $in: members } });
        if (validMembers.length !== members.length) {
          return callback({ success: false, message: "One or more members not found" });
        }

        const group = new Group({
          name,
          channelId,
          createdBy: userId,
          members: [...new Set([userId, ...members])],
          musicUrl: musicUrl || null,
        });

        await group.save();

        // Join creator to group room
        const groupRoom = `group_${group._id}`;
        socket.join(groupRoom);

        // Notify all members
        group.members.forEach((memberId) => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          if (memberSocketId) {
            io.to(memberSocketId).emit("group_created", { group });
            if (group.musicUrl) {
              io.to(memberSocketId).emit("play_group_music", { groupId: group._id, musicUrl: group.musicUrl });
            }
          }
        });

        callback({ success: true, group });
      } catch (error) {
        console.error("Create group error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Add members to group */
    socket.on("add_group_members", async (data, callback) => {
      try {
        const { groupId, memberIds } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid group ID" });
        }
        if (!memberIds.every(isValidObjectId)) {
          return callback({ success: false, message: "Invalid member IDs" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        if (group.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        // Verify all members exist
        const validMembers = await User.find({ _id: { $in: memberIds } });
        if (validMembers.length !== memberIds.length) {
          return callback({ success: false, message: "One or more members not found" });
        }

        const existingMembers = group.members.map((id) => id.toString());
        const newMembers = memberIds.filter((id) => !existingMembers.includes(id));

        if (newMembers.length > 0) {
          group.members.push(...newMembers);
          group.updatedAt = Date.now();
          await group.save();

          const groupRoom = `group_${groupId}`;
          newMembers.forEach((memberId) => {
            const memberSocketId = onlineUsers.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit("added_to_group", { group });
              io.to(memberSocketId).emit("auto_join_group", { groupId });
              if (group.musicUrl) {
                io.to(memberSocketId).emit("play_group_music", { groupId, musicUrl: group.musicUrl });
              }
            }
          });

          group.members.forEach((memberId) => {
            const memberSocketId = onlineUsers.get(memberId.toString());
            if (memberSocketId && memberId.toString() !== userId) {
              io.to(memberSocketId).emit("group_members_added", {
                groupId,
                newMembers,
              });
            }
          });
        }

        callback({ success: true, group });
      } catch (error) {
        console.error("Add group members error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Remove member from group */
    socket.on("remove_group_member", async (data, callback) => {
      try {
        const { groupId, memberId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
          return callback({ success: false, message: "Invalid group or member ID" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        if (group.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        if (memberId === group.createdBy.toString()) {
          return callback({ success: false, message: "Cannot remove group creator" });
        }

        group.members = group.members.filter((id) => id.toString() !== memberId);
        group.updatedAt = Date.now();
        await group.save();

        const removedSocketId = onlineUsers.get(memberId);
        if (removedSocketId) {
          io.to(removedSocketId).emit("removed_from_group", { groupId });
          io.to(removedSocketId).emit("stop_group_music", { groupId });
          io.sockets.sockets.get(removedSocketId)?.leave(`group_${groupId}`);
        }

        group.members.forEach((memberId) => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          if (memberSocketId) {
            io.to(memberSocketId).emit("group_member_removed", {
              groupId,
              removedMember: memberId,
            });
          }
        });

        callback({ success: true, group });
      } catch (error) {
        console.error("Remove group member error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Send text message */
    socket.on("send_text_message", async (data, callback) => {
      try {
        const { groupId, content } = data;
        const senderId = socket.userId;

        if (!senderId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid group ID" });
        }
        if (!content || content.trim() === "") {
          return callback({ success: false, message: "Message content cannot be empty" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        const isMember = group.members.some((id) => id.toString() === senderId);
        if (!isMember) {
          return callback({ success: false, message: "Not authorized to send message" });
        }

        const chat = new Chat({
          senderId,
          groupId,
          type: "text",
          content,
          status: "sent",
        });

        await chat.save();
        await chat.populate("senderId", "displayName");

        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("new_text_message", { message: chat });

        setTimeout(async () => {
          const updatedChat = await Chat.findByIdAndUpdate(
            chat._id,
            { status: "delivered" },
            { new: true }
          );
          io.to(groupRoom).emit("message_status_update", {
            messageId: chat._id,
            status: "delivered",
          });
        }, 100);

        callback({ success: true, message: chat });
      } catch (error) {
        console.error("Send text message error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Send voice message */
    socket.on("send_voice_message", async (data, callback) => {
      try {
        const { groupId, voiceUrl, duration } = data;
        const senderId = socket.userId;

        if (!senderId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid group ID" });
        }
        if (!voiceUrl || !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(voiceUrl)) {
          return callback({ success: false, message: "Invalid voice URL" });
        }
        if (duration > 180) {
          return callback({ success: false, message: "Voice message too long (max 3 minutes)" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        const isMember = group.members.some((id) => id.toString() === senderId);
        if (!isMember) {
          return callback({ success: false, message: "Not authorized to send message" });
        }

        const chat = new Chat({
          senderId,
          groupId,
          type: "voice",
          content: voiceUrl,
          duration,
          status: "sent",
        });

        await chat.save();
        await chat.populate("senderId", "displayName");

        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("new_voice_message", { message: chat });

        setTimeout(async () => {
          const updatedChat = await Chat.findByIdAndUpdate(
            chat._id,
            { status: "delivered" },
            { new: true }
          );
          io.to(groupRoom).emit("message_status_update", {
            messageId: chat._id,
            status: "delivered",
          });
        }, 100);

        callback({ success: true, message: chat });
      } catch (error) {
        console.error("Send voice message error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Typing indicator */
    socket.on("typing", ({ groupId, typing }) => {
      const userId = socket.userId;
      if (!userId || !groupId || !isValidObjectId(groupId)) return;

      const groupRoom = `group_${groupId}`;

      if (typing) {
        if (!typingUsers.has(groupId)) {
          typingUsers.set(groupId, new Set());
        }
        typingUsers.get(groupId).add(userId);

        socket.to(groupRoom).emit("user_typing", {
          userId,
          groupId,
          typing: true,
        });
      } else {
        if (typingUsers.has(groupId)) {
          typingUsers.get(groupId).delete(userId);
          if (typingUsers.get(groupId).size === 0) {
            typingUsers.delete(groupId);
          }
        }

        socket.to(groupRoom).emit("user_typing", {
          userId,
          groupId,
          typing: false,
        });
      }
    });

    /** Mark message as read */
    socket.on("mark_message_read", async (data, callback) => {
      try {
        const { messageId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(messageId)) {
          return callback({ success: false, message: "Invalid message ID" });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          return callback({ success: false, message: "Message not found" });
        }

        message.status = "read";
        await message.save();

        const groupRoom = `group_${message.groupId}`;
        io.to(groupRoom).emit("message_status_update", {
          messageId,
          status: "read",
          readBy: userId,
        });

        const senderSocketId = onlineUsers.get(message.senderId.toString());
        if (senderSocketId) {
          io.to(senderSocketId).emit("message_read", {
            messageId,
            readBy: userId,
          });
        }

        callback({ success: true, message });
      } catch (error) {
        console.error("Mark message read error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Get group messages with pagination */
    socket.on("get_group_messages", async (data, callback) => {
      try {
        const { groupId, page = 1, limit = 50 } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid group ID" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        const isMember = group.members.some((id) => id.toString() === userId);
        if (!isMember) {
          return callback({ success: false, message: "Not authorized" });
        }

        const skip = (page - 1) * limit;
        const messages = await Chat.find({ groupId })
          .populate("senderId", "displayName")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        const unreadMessages = messages.filter(
          (msg) => msg.senderId.toString() !== userId && msg.status === "sent"
        );

        if (unreadMessages.length > 0) {
          const unreadIds = unreadMessages.map((msg) => msg._id);
          await Chat.updateMany({ _id: { $in: unreadIds } }, { status: "delivered" });
        }

        callback({
          success: true,
          messages: messages.reverse(),
          hasMore: messages.length === limit,
        });
      } catch (error) {
        console.error("Get group messages error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Delete message */
    socket.on("delete_message", async (data, callback) => {
      try {
        const { messageId, forEveryone = false } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(messageId)) {
          return callback({ success: false, message: "Invalid message ID" });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          return callback({ success: false, message: "Message not found" });
        }

        if (forEveryone && message.senderId.toString() === userId) {
          message.content = "This message was deleted";
          message.deletedFor = [];
        } else {
          if (!message.deletedFor.includes(userId)) {
            message.deletedFor.push(userId);
          }
        }

        await message.save();

        const groupRoom = `group_${message.groupId}`;
        io.to(groupRoom).emit("message_deleted", { message });

        callback({ success: true, message });
      } catch (error) {
        console.error("Delete message error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Join group room for real-time messaging */
    socket.on("join_group_room", async ({ groupId }) => {
      if (!isValidObjectId(groupId)) {
        socket.emit("error", { message: "Invalid group ID" });
        return;
      }

      const group = await Group.findById(groupId);
      if (!group) {
        socket.emit("error", { message: "Group not found" });
        return;
      }

      const roomName = `group_${groupId}`;
      socket.join(roomName);
      if (group.musicUrl) {
        socket.emit("play_group_music", { groupId, musicUrl: group.musicUrl });
      }
      socket.emit("group_room_joined", { groupId });
    });

    /** Leave group room */
    socket.on("leave_group_room", ({ groupId }) => {
      if (!isValidObjectId(groupId)) return;

      const roomName = `group_${groupId}`;
      socket.leave(roomName);
      socket.emit("stop_group_music", { groupId });
      socket.emit("group_room_left", { groupId });
    });

    /** Get typing users in group */
    socket.on("get_typing_users", ({ groupId }) => {
      if (!isValidObjectId(groupId)) return;

      const typingSet = typingUsers.get(groupId) || new Set();
      const typingArray = Array.from(typingSet);
      socket.emit("typing_users", { groupId, users: typingArray });
    });

    /** Disconnect handling */
    socket.on("disconnect", async () => {
      const disconnectedUserId = socket.userId;
      if (!disconnectedUserId) return;

      onlineUsers.delete(disconnectedUserId);

      try {
        await User.findByIdAndUpdate(disconnectedUserId, {
          online: false,
          lastSeen: new Date(),
        });

        typingUsers.forEach((userSet, groupId) => {
          if (userSet.has(disconnectedUserId)) {
            userSet.delete(disconnectedUserId);
            const groupRoom = `group_${groupId}`;
            socket.to(groupRoom).emit("user_typing", {
              userId: disconnectedUserId,
              groupId,
              typing: false,
            });
          }
        });

        console.log("User disconnected from group socket:", disconnectedUserId);
      } catch (error) {
        console.error("Disconnect error:", error);
      }
    });
  });

  return io;
};