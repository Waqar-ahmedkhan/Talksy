import { Server } from "socket.io";
import Channel from "../models/Channel.js";
import User from "../models/User.js";
import Block from "../models/Block.js";

export const initChannelSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/channel-socket",
  });

  const onlineUsers = new Map(); // userId -> socketId

  io.on("connection", (socket) => {
    console.log("User connected to channel socket:", socket.id);

    /** User joins channel management system */
    socket.on("join_channels", async (userId) => {
      if (!userId) return socket.disconnect();

      const userIdStr = userId.toString();
      onlineUsers.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      // Update user online status
      await User.findByIdAndUpdate(userIdStr, { 
        online: true, 
        lastSeen: new Date() 
      });

      // Get user's channels and join their rooms
      const userChannels = await Channel.find({ members: userIdStr });
      const channelRooms = userChannels.map(ch => `channel_${ch._id}`);
      if (channelRooms.length > 0) {
        socket.join(channelRooms);
      }

      console.log(`User ${userIdStr} joined channel system`);
    });

    /** Create a new channel */
    socket.on("create_channel", async (data, callback) => {
      try {
        const { name, description, isPrivate, members = [] } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = new Channel({
          name,
          description,
          createdBy: userId,
          members: [...new Set([userId, ...members])],
          isPrivate,
        });

        await channel.save();

        // Join creator to channel room
        const channelRoom = `channel_${channel._id}`;
        socket.join(channelRoom);

        // Notify all members
        channel.members.forEach(memberId => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          if (memberSocketId) {
            io.to(memberSocketId).emit("channel_created", { channel });
          }
        });

        callback({ success: true, channel });
      } catch (error) {
        console.error("Create channel error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Add members to channel */
    socket.on("add_channel_members", async (data, callback) => {
      try {
        const { channelId, memberIds } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = await Channel.findById(channelId);
        if (!channel) {
          return callback({ success: false, message: "Channel not found" });
        }

        // Only creator can add members
        if (channel.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        const existingMembers = channel.members.map(id => id.toString());
        const newMembers = memberIds.filter(id => !existingMembers.includes(id));

        if (newMembers.length > 0) {
          channel.members.push(...newMembers);
          channel.updatedAt = Date.now();
          await channel.save();

          // Notify new members
          const channelRoom = `channel_${channelId}`;
          newMembers.forEach(memberId => {
            const memberSocketId = onlineUsers.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit("added_to_channel", { channel });
              // Auto-join the channel room
              io.to(memberSocketId).emit("auto_join_channel", { channelId });
            }
          });

          // Notify existing members
          channel.members.forEach(memberId => {
            const memberSocketId = onlineUsers.get(memberId.toString());
            if (memberSocketId && memberId.toString() !== userId) {
              io.to(memberSocketId).emit("channel_members_added", { 
                channelId,
                newMembers 
              });
            }
          });
        }

        callback({ success: true, channel });
      } catch (error) {
        console.error("Add channel members error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Remove member from channel */
    socket.on("remove_channel_member", async (data, callback) => {
      try {
        const { channelId, memberId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = await Channel.findById(channelId);
        if (!channel) {
          return callback({ success: false, message: "Channel not found" });
        }

        // Only creator can remove members
        if (channel.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        // Cannot remove creator
        if (memberId === channel.createdBy.toString()) {
          return callback({ success: false, message: "Cannot remove channel creator" });
        }

        channel.members = channel.members.filter(id => id.toString() !== memberId);
        channel.updatedAt = Date.now();
        await channel.save();

        // Notify removed member
        const removedSocketId = onlineUsers.get(memberId);
        if (removedSocketId) {
          io.to(removedSocketId).emit("removed_from_channel", { channelId });
          // Leave channel room
          io.sockets.sockets.get(removedSocketId)?.leave(`channel_${channelId}`);
        }

        // Notify remaining members
        channel.members.forEach(memberId => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          if (memberSocketId) {
            io.to(memberSocketId).emit("channel_member_removed", { 
              channelId,
              removedMember: memberId
            });
          }
        });

        callback({ success: true, channel });
      } catch (error) {
        console.error("Remove channel member error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Update channel info */
    socket.on("update_channel", async (data, callback) => {
      try {
        const { channelId, name, description, isPrivate } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = await Channel.findById(channelId);
        if (!channel) {
          return callback({ success: false, message: "Channel not found" });
        }

        // Only creator can update
        if (channel.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        if (name) channel.name = name;
        if (description !== undefined) channel.description = description;
        if (isPrivate !== undefined) channel.isPrivate = isPrivate;
        channel.updatedAt = Date.now();

        await channel.save();

        // Notify all members
        const channelRoom = `channel_${channelId}`;
        io.to(channelRoom).emit("channel_updated", { channel });

        callback({ success: true, channel });
      } catch (error) {
        console.error("Update channel error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Delete channel */
    socket.on("delete_channel", async (data, callback) => {
      try {
        const { channelId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = await Channel.findById(channelId);
        if (!channel) {
          return callback({ success: false, message: "Channel not found" });
        }

        // Only creator can delete
        if (channel.createdBy.toString() !== userId) {
          return callback({ success: false, message: "Not authorized" });
        }

        await Channel.findByIdAndDelete(channelId);

        // Notify all members
        const channelRoom = `channel_${channelId}`;
        io.to(channelRoom).emit("channel_deleted", { channelId });

        // Make all members leave the room
        const socketsInRoom = await io.in(channelRoom).fetchSockets();
        socketsInRoom.forEach(sock => {
          sock.leave(channelRoom);
        });

        callback({ success: true, message: "Channel deleted" });
      } catch (error) {
        console.error("Delete channel error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Get user's channels */
    socket.on("get_my_channels", async (callback) => {
      try {
        const userId = socket.userId;
        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channels = await Channel.find({ members: userId })
          .populate("createdBy", "username email")
          .populate("members", "username email online lastSeen");

        callback({ success: true, channels });
      } catch (error) {
        console.error("Get channels error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Get channel details */
    socket.on("get_channel_details", async (data, callback) => {
      try {
        const { channelId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }

        const channel = await Channel.findById(channelId)
          .populate("createdBy", "username email")
          .populate("members", "username email online lastSeen");

        // Check if user is member
        const isMember = channel.members.some(member => 
          member._id.toString() === userId
        );

        if (!isMember) {
          return callback({ success: false, message: "Not authorized" });
        }

        callback({ success: true, channel });
      } catch (error) {
        console.error("Get channel details error:", error);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Join channel room (for real-time updates) */
    socket.on("join_channel_room", ({ channelId }) => {
      const roomName = `channel_${channelId}`;
      socket.join(roomName);
      socket.emit("channel_room_joined", { channelId });
    });

    /** Leave channel room */
    socket.on("leave_channel_room", ({ channelId }) => {
      const roomName = `channel_${channelId}`;
      socket.leave(roomName);
      socket.emit("channel_room_left", { channelId });
    });

    /** Disconnect handling */
    socket.on("disconnect", async () => {
      const disconnectedUserId = socket.userId;
      if (!disconnectedUserId) return;

      onlineUsers.delete(disconnectedUserId);

      // Update user offline status
      await User.findByIdAndUpdate(disconnectedUserId, { 
        online: false, 
        lastSeen: new Date() 
      });

      console.log("User disconnected from channel socket:", disconnectedUserId);
    });
  });

  return io;
};