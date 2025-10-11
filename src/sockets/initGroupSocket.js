import { Server } from "socket.io";
import Channel from "../models/Channel.js";
import Group from "../models/Group.js";
import Chat from "../models/Chat.js";
import User from "../models/User.js";
import Profile from "../models/Profile.js";
import { isValidObjectId } from "mongoose";
import mongoose from "mongoose";

export const initGroupSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/group-socket",
  });

  const onlineUsers = new Map();
  const typingUsers = new Map();

  io.on("connection", (socket) => {
    console.log(
      `[GROUP_SOCKET] User connected: socketId=${
        socket.id
      }, time=${new Date().toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
      })}`
    );

    /** User joins group chatting system */
    socket.on("join_groups", async (userId) => {
      console.log(
        `[JOIN_GROUPS] Attempting to join: userId=${userId}, socketId=${socket.id}`
      );

      if (!userId || !isValidObjectId(userId)) {
        console.error(`[JOIN_GROUPS_ERROR] Invalid userId: ${userId}`);
        socket.emit("error", { message: "Invalid user ID" });
        socket.disconnect();
        return;
      }

      const userIdStr = userId.toString();
      onlineUsers.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      try {
        const user = await User.findByIdAndUpdate(
          userIdStr,
          { online: true, lastSeen: new Date() },
          { new: true }
        );
        if (!user) {
          console.error(
            `[JOIN_GROUPS_ERROR] User not found: userId=${userIdStr}`
          );
          socket.emit("error", { message: "User not found" });
          socket.disconnect();
          return;
        }
        console.log(
          `[JOIN_GROUPS] User updated: userId=${userIdStr}, online=true`
        );

        const userGroups = await Group.find({ members: userIdStr }).lean();
        console.log(
          `[JOIN_GROUPS] Found ${userGroups.length} groups for userId=${userIdStr}`
        );

        const groupRooms = userGroups.map((gr) => `group_${gr._id}`);
        if (groupRooms.length > 0) {
          socket.join(groupRooms);
          console.log(
            `[JOIN_GROUPS] User joined rooms: ${groupRooms.join(", ")}`
          );

          userGroups.forEach((group) => {
            if (group.musicUrl) {
              socket.emit("play_group_music", {
                groupId: group._id,
                musicUrl: group.musicUrl,
              });
              console.log(
                `[JOIN_GROUPS] Emitted play_group_music: groupId=${group._id}, musicUrl=${group.musicUrl}`
              );
            }
          });
        }

        console.log(
          `[JOIN_GROUPS_SUCCESS] User ${userIdStr} joined group chatting system`
        );
      } catch (error) {
        console.error(
          `[JOIN_GROUPS_ERROR] Failed for userId=${userIdStr}: ${error.message}`
        );
        socket.emit("error", {
          message: "Failed to join groups",
          error: error.message,
        });
        socket.disconnect();
      }
    });
    // socket.on("create_group", async (data, callback) => {
    //   console.log(
    //     `[CREATE_GROUP] Attempting to create group (NO AUTH): data=${JSON.stringify(
    //       data
    //     )}`
    //   );

    //   try {
    //     const { name, channelId, members = [], musicUrl, pictureUrl } = data;

    //     // 🔥 Hardcoded creator ID for testing — no auth, no socket.userId
    //     const userId = "68e12bcbdee26bec7660c64c"; // any valid ObjectId string

    //     if (!name || name.trim().length < 3) {
    //       return callback({
    //         success: false,
    //         message: "Group name must be at least 3 characters",
    //       });
    //     }

    //     if (channelId && !isValidObjectId(channelId)) {
    //       return callback({ success: false, message: "Invalid channel ID" });
    //     }

    //     if (channelId) {
    //       const channel = await Channel.findById(channelId);
    //       if (!channel) {
    //         return callback({ success: false, message: "Channel not found" });
    //       }
    //     }

    //     if (musicUrl && !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(musicUrl)) {
    //       return callback({
    //         success: false,
    //         message: "Invalid music URL format",
    //       });
    //     }
    //     if (
    //       pictureUrl &&
    //       !/^https?:\/\/.*\.(jpg|jpeg|png|gif)$/.test(pictureUrl)
    //     ) {
    //       return callback({
    //         success: false,
    //         message: "Invalid picture URL format",
    //       });
    //     }
    //     if (!members.every(isValidObjectId)) {
    //       return callback({ success: false, message: "Invalid member IDs" });
    //     }

    //     // 🔥 Skip member existence check — allow any ObjectId
    //     const group = new Group({
    //       name,
    //       channelId: channelId || null,
    //       createdBy: userId,
    //       members: [...new Set([userId, ...members])],
    //       musicUrl: musicUrl || null,
    //       pictureUrl: pictureUrl || null,
    //     });

    //     await group.save();
    //     console.log(`[CREATE_GROUP] Group created: ${group._id}`);

    //     // Optional: join room (won't notify others without onlineUsers map)
    //     const groupRoom = `group_${group._id}`;
    //     socket.join(groupRoom);

    //     callback({ success: true, group: group.toObject() });
    //     console.log(`[CREATE_GROUP_SUCCESS] Group created successfully`);
    //   } catch (error) {
    //     console.error(`[CREATE_GROUP_ERROR] ${error.message}`);
    //     callback({ success: false, message: "Server error" });
    //   }
    // });
    /** Create a new group with optional channel, music, and picture */
    socket.on("create_group", async (data, callback) => {
      console.log(
        `[CREATE_GROUP] Attempting to create group: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { name, channelId, members = [], musicUrl, pictureUrl } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(
            `[CREATE_GROUP_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!name || name.trim().length < 3) {
          console.error(`[CREATE_GROUP_ERROR] Invalid name: ${name}`);
          return callback({
            success: false,
            message: "Group name must be at least 3 characters",
          });
        }
        if (channelId) {
          if (!isValidObjectId(channelId)) {
            console.error(
              `[CREATE_GROUP_ERROR] Invalid channelId: ${channelId}`
            );
            return callback({ success: false, message: "Invalid channel ID" });
          }
          const channel = await Channel.findById(channelId);
          if (!channel) {
            console.error(
              `[CREATE_GROUP_ERROR] Channel not found: channelId=${channelId}`
            );
            return callback({ success: false, message: "Channel not found" });
          }
          console.log(
            `[CREATE_GROUP] Valid channel provided: channelId=${channelId}`
          );
        } else {
          console.log(
            `[CREATE_GROUP] No channel provided, creating standalone group`
          );
        }
        if (musicUrl && !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(musicUrl)) {
          console.error(`[CREATE_GROUP_ERROR] Invalid musicUrl: ${musicUrl}`);
          return callback({
            success: false,
            message: "Invalid music URL format",
          });
        }
        if (
          pictureUrl &&
          !/^https?:\/\/.*\.(jpg|jpeg|png|gif)$/.test(pictureUrl)
        ) {
          console.error(
            `[CREATE_GROUP_ERROR] Invalid pictureUrl: ${pictureUrl}`
          );
          return callback({
            success: false,
            message: "Invalid picture URL format",
          });
        }
        if (!members.every(isValidObjectId)) {
          console.error(`[CREATE_GROUP_ERROR] Invalid member IDs: ${members}`);
          return callback({ success: false, message: "Invalid member IDs" });
        }

        const validMembers = await User.find({ _id: { $in: members } });
        if (validMembers.length !== members.length) {
          console.error(
            `[CREATE_GROUP_ERROR] One or more members not found: members=${members}`
          );
          return callback({
            success: false,
            message: "One or more members not found",
          });
        }

        // Inside socket.on("create_group", ...)
        const group = new Group({
          name,
          channelId: channelId || null,
          createdBy: userId,
          members: [...new Set([userId, ...members])],
          admins: [userId], // 👈 Auto-add creator as admin
          musicUrl: musicUrl || null,
          pictureUrl: pictureUrl || null,
        });

        // const group = new Group({
        //   name,
        //   channelId: channelId || null, // Optional: Set to null if not provided
        //   createdBy: userId,
        //   members: [...new Set([userId, ...members])],
        //   musicUrl: musicUrl || null,
        //   pictureUrl: pictureUrl || null,
        // });

        await group.save();
        console.log(
          `[CREATE_GROUP] Group created: groupId=${group._id}, name=${
            group.name
          }, channelId=${group.channelId || "none"}`
        );

        const groupRoom = `group_${group._id}`;
        socket.join(groupRoom);
        console.log(
          `[CREATE_GROUP] Creator joined room: groupId=${group._id}, socketId=${socket.id}`
        );

        group.members.forEach((memberId) => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          if (memberSocketId) {
            io.to(memberSocketId).emit("group_created", { group });
            console.log(
              `[CREATE_GROUP] Notified member: memberId=${memberId}, groupId=${group._id}`
            );
            if (group.musicUrl) {
              io.to(memberSocketId).emit("play_group_music", {
                groupId: group._id,
                musicUrl: group.musicUrl,
              });
              console.log(
                `[CREATE_GROUP] Emitted play_group_music to memberId=${memberId}`
              );
            }
          }
        });

        callback({ success: true, group });
        console.log(
          `[CREATE_GROUP_SUCCESS] Group creation successful: groupId=${group._id}`
        );
      } catch (error) {
        console.error(
          `[CREATE_GROUP_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    /** Update group picture */
    /** Update group name or picture */

    /** Add members to group */
    socket.on("add_group_members", async (data, callback) => {
      console.log(
        `[ADD_GROUP_MEMBERS] Attempting to add members: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { groupId, memberIds } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] Invalid groupId: ${groupId}`
          );
          return callback({ success: false, message: "Invalid group ID" });
        }
        if (!memberIds.every(isValidObjectId)) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] Invalid memberIds: ${memberIds}`
          );
          return callback({ success: false, message: "Invalid member IDs" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] Group not found: groupId=${groupId}`
          );
          return callback({ success: false, message: "Group not found" });
        }

        if (group.createdBy.toString() !== userId) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] Not authorized: userId=${userId}, groupCreator=${group.createdBy}`
          );
          return callback({ success: false, message: "Not authorized" });
        }

        const validMembers = await User.find({ _id: { $in: memberIds } });
        if (validMembers.length !== memberIds.length) {
          console.error(
            `[ADD_GROUP_MEMBERS_ERROR] One or more members not found: memberIds=${memberIds}`
          );
          return callback({
            success: false,
            message: "One or more members not found",
          });
        }

        const existingMembers = group.members.map((id) => id.toString());
        const newMembers = memberIds.filter(
          (id) => !existingMembers.includes(id)
        );

        if (newMembers.length > 0) {
          group.members.push(...newMembers);
          group.updatedAt = Date.now();
          await group.save();
          console.log(
            `[ADD_GROUP_MEMBERS] Added ${newMembers.length} members to groupId=${groupId}`
          );

          const groupRoom = `group_${groupId}`;
          newMembers.forEach((memberId) => {
            const memberSocketId = onlineUsers.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit("added_to_group", { group });
              io.to(memberSocketId).emit("auto_join_group", { groupId });
              console.log(
                `[ADD_GROUP_MEMBERS] Notified new member: memberId=${memberId}, groupId=${groupId}`
              );
              if (group.musicUrl) {
                io.to(memberSocketId).emit("play_group_music", {
                  groupId,
                  musicUrl: group.musicUrl,
                });
                console.log(
                  `[ADD_GROUP_MEMBERS] Emitted play_group_music to memberId=${memberId}`
                );
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
              console.log(
                `[ADD_GROUP_MEMBERS] Notified existing member: memberId=${memberId}, groupId=${groupId}`
              );
            }
          });
        } else {
          console.log(
            `[ADD_GROUP_MEMBERS] No new members to add: groupId=${groupId}`
          );
        }

        callback({ success: true, group });
        console.log(
          `[ADD_GROUP_MEMBERS_SUCCESS] Members added to groupId=${groupId}`
        );
      } catch (error) {
        console.error(
          `[ADD_GROUP_MEMBERS_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    socket.on("update_group", async (data, callback) => {
      console.log(
        `[UPDATE_GROUP] Attempting to update: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );
      try {
        const { groupId, name, pictureUrl } = data;
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

        // Check if user is creator or admin
        const isCreator = group.createdBy.toString() === userId;
        const isAdmin = group.admins
          ?.map((id) => id.toString())
          .includes(userId);
        if (!isCreator && !isAdmin) {
          return callback({
            success: false,
            message: "Only admins can update group",
          });
        }

        // Validate updates
        if (name !== undefined) {
          if (!name || name.trim().length < 3) {
            return callback({
              success: false,
              message: "Group name must be at least 3 characters",
            });
          }
          group.name = name.trim();
        }

        if (pictureUrl !== undefined) {
          if (
            pictureUrl &&
            !/^https?:\/\/.*\.(jpg|jpeg|png|gif)$/.test(pictureUrl)
          ) {
            return callback({
              success: false,
              message: "Invalid picture URL format",
            });
          }
          group.pictureUrl = pictureUrl || null;
        }

        group.updatedAt = Date.now();
        await group.save();

        // Notify all members
        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("group_updated", { group });

        callback({ success: true, group });
        console.log(`[UPDATE_GROUP_SUCCESS] Group updated: groupId=${groupId}`);
      } catch (error) {
        console.error(`[UPDATE_GROUP_ERROR] ${error.message}`);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Get full group details with members and admins */
    socket.on("get_group_details", async (data, callback) => {
      console.log(
        `[GET_GROUP_DETAILS] Fetching: userId=${socket.userId}, groupId=${data.groupId}`
      );
      try {
        const { groupId } = data;
        const userId = socket.userId;

        if (!userId || !isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid input" });
        }

        const group = await Group.findById(groupId)
          .populate("createdBy", "displayName phone")
          .populate("admins", "displayName phone")
          .populate("members", "displayName phone");

        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        // Check membership
        if (!group.members.map((m) => m._id.toString()).includes(userId)) {
          return callback({ success: false, message: "Not a group member" });
        }

        // Fetch online status & lastSeen for all members
        const phoneNumbers = group.members.map((m) => m.phone);
        const users = await User.find({ phone: { $in: phoneNumbers } }).select(
          "phone online lastSeen"
        );
        const userMap = new Map(users.map((u) => [u.phone, u]));

        const membersWithStatus = group.members.map((member) => ({
          ...member.toObject(),
          online: userMap.get(member.phone)?.online || false,
          lastSeen: userMap.get(member.phone)?.lastSeen || null,
          isAdmin: group.admins
            .map((a) => a._id.toString())
            .includes(member._id.toString()),
          isCreator: member._id.toString() === group.createdBy._id.toString(),
        }));

        callback({
          success: true,
          group: {
            ...group.toObject(),
            members: membersWithStatus,
          },
        });
      } catch (error) {
        console.error(`[GET_GROUP_DETAILS_ERROR] ${error.message}`);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Delete group (creator only) */
    socket.on("delete_group", async (data, callback) => {
      console.log(
        `[DELETE_GROUP] Attempting: userId=${socket.userId}, groupId=${data.groupId}`
      );
      try {
        const { groupId } = data;
        const userId = socket.userId;

        if (!userId || !isValidObjectId(groupId)) {
          return callback({ success: false, message: "Invalid input" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        if (group.createdBy.toString() !== userId) {
          return callback({
            success: false,
            message: "Only creator can delete group",
          });
        }

        // Delete group and all messages
        await Group.deleteOne({ _id: groupId });
        await Chat.deleteMany({ groupId });

        // Notify all members
        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("group_deleted", { groupId });

        callback({ success: true, message: "Group deleted" });
        console.log(`[DELETE_GROUP_SUCCESS] Group deleted: ${groupId}`);
      } catch (error) {
        console.error(`[DELETE_GROUP_ERROR] ${error.message}`);
        callback({ success: false, message: "Server error" });
      }
    });

    /** Remove member from group (self-leave or admin/creator removal) */
    socket.on("remove_group_member", async (data, callback) => {
      console.log(
        `[REMOVE_GROUP_MEMBER] Attempting to remove member: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );
      try {
        const { groupId, memberId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
          return callback({
            success: false,
            message: "Invalid group or member ID",
          });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: "Group not found" });
        }

        // Check if user is a member
        const isMember = group.members
          .map((id) => id.toString())
          .includes(userId);
        if (!isMember) {
          return callback({
            success: false,
            message: "You are not a member of this group",
          });
        }

        // Case 1: User is trying to leave themselves
        if (memberId === userId) {
          // Creator cannot leave
          if (memberId === group.createdBy.toString()) {
            return callback({
              success: false,
              message: "Group creator cannot leave. Delete the group instead.",
            });
          }

          // Admin can leave only if not the last admin
          const isAdmin = group.admins
            ?.map((id) => id.toString())
            .includes(userId);
          if (isAdmin) {
            const activeAdmins = group.admins.filter(
              (adminId) =>
                adminId.toString() !== userId &&
                group.members
                  .map((m) => m.toString())
                  .includes(adminId.toString())
            );
            if (activeAdmins.length === 0) {
              return callback({
                success: false,
                message:
                  "You are the last admin. Promote another admin before leaving.",
              });
            }
          }
        }
        // Case 2: User is trying to remove someone else → must be creator or admin
        else {
          const isCreator = group.createdBy.toString() === userId;
          const isAdmin = group.admins
            ?.map((id) => id.toString())
            .includes(userId);
          if (!isCreator && !isAdmin) {
            return callback({
              success: false,
              message: "Only admins or creator can remove members",
            });
          }

          // Cannot remove the creator
          if (memberId === group.createdBy.toString()) {
            return callback({
              success: false,
              message: "Cannot remove group creator",
            });
          }

          // Admins cannot remove other admins (optional — you can allow this if needed)
          if (isAdmin && !isCreator) {
            const targetIsAdmin = group.admins
              ?.map((id) => id.toString())
              .includes(memberId);
            if (targetIsAdmin) {
              return callback({
                success: false,
                message: "Admins cannot remove other admins",
              });
            }
          }
        }

        // Perform removal
        group.members = group.members.filter(
          (id) => id.toString() !== memberId
        );
        group.updatedAt = Date.now();
        await group.save();

        // Notify removed user
        const removedSocketId = onlineUsers.get(memberId);
        if (removedSocketId) {
          io.to(removedSocketId).emit("removed_from_group", { groupId });
          io.to(removedSocketId).emit("stop_group_music", { groupId });
          io.sockets.sockets.get(removedSocketId)?.leave(`group_${groupId}`);
        }

        // Notify remaining members
        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("group_member_removed", {
          groupId,
          removedMember: memberId,
        });

        callback({ success: true, group });
        console.log(
          `[REMOVE_GROUP_MEMBER_SUCCESS] Member removed: ${memberId} from group ${groupId}`
        );
      } catch (error) {
        console.error(`[REMOVE_GROUP_MEMBER_ERROR] ${error.message}`);
        callback({ success: false, message: "Server error" });
      }
    });


socket.on("send_text_message", async (data, callback) => {
  console.log(
    `[SEND_TEXT_MESSAGE] Attempting to send message: socketId=${
      socket.id
    }, userId="${socket.userId}" (type: ${typeof socket.userId}), data=${JSON.stringify(
      data,
      null,
      2
    )}`
  );

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { groupId, content } = data;
    let senderIdStr = socket.userId;

    // Step 1: Validate socket.userId and check onlineUsers
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 1: Validating socket.userId: "${senderIdStr}"`);
    if (!senderIdStr || typeof senderIdStr !== "string") {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] Invalid or missing senderId: "${senderIdStr}" (socketId=${socket.id})`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Not authenticated - please join groups first",
      });
    }

    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Checking if user in onlineUsers: has=${onlineUsers.has(senderIdStr)}`);
    if (!onlineUsers.has(senderIdStr)) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] User not in onlineUsers: senderId=${senderIdStr}, socketId=${socket.id}`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "User not connected - please join groups first",
      });
    }

    // Step 2: Validate and cast senderId
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 2: Validating ObjectId: isValid=${isValidObjectId(senderIdStr)}`);
    if (!isValidObjectId(senderIdStr)) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] senderId is not a valid ObjectId: "${senderIdStr}" (socketId=${socket.id})`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Invalid user ID format",
      });
    }
    const senderId = new mongoose.Types.ObjectId(senderIdStr);
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Casted senderId: ${senderId.toString()}`);

    // Step 3: Check if User exists and get displayName
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 3: Querying User by _id: ${senderId.toString()}`);
    const user = await User.findById(senderId).select("displayName phone").session(session);
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] User query result: ${user ? 'Found' : 'Not Found'}`);
    if (!user) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] User not found in database: senderId=${senderId}, socketId=${socket.id}`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "User not found - please register or verify your account",
      });
    }
    const senderDisplayName = user.displayName;
    console.log(
      `[SEND_TEXT_MESSAGE_DEBUG] Found existing user: senderId=${senderId}, phone=${user.phone}, displayName=${senderDisplayName}`
    );

    // Step 4: Validate groupId
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 4: Validating groupId: "${groupId}", isValid=${isValidObjectId(groupId)}`);
    if (!groupId || !isValidObjectId(groupId)) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] Invalid or missing groupId: "${groupId}"`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Invalid group ID",
      });
    }
    const castGroupId = new mongoose.Types.ObjectId(groupId);
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Casted groupId: ${castGroupId.toString()}`);

    // Step 5: Validate content
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 5: Validating content: length=${content ? content.trim().length : 0}`);
    if (!content || content.trim() === "") {
      console.error(`[SEND_TEXT_MESSAGE_ERROR] Empty content: "${content}"`);
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Message content cannot be empty",
      });
    }

    // Step 6: Verify group and membership
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 6: Querying Group by _id: ${castGroupId.toString()}`);
    const group = await Group.findById(castGroupId).session(session);
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Group query result: ${group ? 'Found' : 'Not Found'}`);
    if (!group) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] Group not found: groupId=${castGroupId}`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Group not found",
      });
    }

    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Checking membership: members=${group.members.map(id => id.toString()).join(', ')}`);
    const isMember = group.members.some((id) => id.equals(senderId));
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Is member: ${isMember}`);
    if (!isMember) {
      console.error(
        `[SEND_TEXT_MESSAGE_ERROR] Not authorized: senderId=${senderId}, groupId=${castGroupId}`
      );
      await session.abortTransaction();
      session.endSession();
      return callback({
        success: false,
        message: "Not authorized to send message",
      });
    }

    // Step 7: Create and save Chat document with displayName
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 7: Creating Chat document`);
    const chat = new Chat({
      senderId,
      senderDisplayName, // Store displayName directly
      groupId: castGroupId,
      type: "text",
      content: content.trim(),
      status: "sent",
      deletedFor: [],
    });

    await chat.save({ session });
    console.log(
      `[SEND_TEXT_MESSAGE_DEBUG] Message saved: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}, rawChat=${JSON.stringify(
        chat.toObject(),
        null,
        2
      )}`
    );

    // Step 8: Commit transaction
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 8: Committing transaction`);
    await session.commitTransaction();
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Transaction committed successfully`);

    // Step 9: Emit message to group room
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 9: Emitting message to group room`);
    const groupRoom = `group_${castGroupId}`;
    io.to(groupRoom).emit("new_text_message", { message: chat });
    console.log(
      `[SEND_TEXT_MESSAGE_DEBUG] Emitted new_text_message to groupRoom=${groupRoom}`
    );

    // Step 10: Update message status to delivered
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 10: Scheduling status update to delivered`);
    setTimeout(async () => {
      try {
        const updatedChat = await Chat.findByIdAndUpdate(
          chat._id,
          { status: "delivered" },
          { new: true }
        );
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Status update query result: ${updatedChat ? 'Updated' : 'Not Found'}`
        );
        if (updatedChat) {
          io.to(groupRoom).emit("message_status_update", {
            messageId: chat._id,
            status: "delivered",
          });
          console.log(
            `[SEND_TEXT_MESSAGE_DEBUG] Updated status to delivered: messageId=${chat._id}`
          );
        } else {
          console.warn(
            `[SEND_TEXT_MESSAGE_WARN] Failed to update status for messageId=${chat._id}`
          );
        }
      } catch (error) {
        console.error(
          `[SEND_TEXT_MESSAGE_ERROR] Failed to update status: messageId=${chat._id}, error=${error.message}, stack=${error.stack}`
        );
      }
    }, 100);

    // Step 11: Send success response
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 11: Sending success response`);
    callback({ success: true, message: chat });
    console.log(
      `[SEND_TEXT_MESSAGE_SUCCESS] Message sent: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}`
    );
  } catch (error) {
    console.error(
      `[SEND_TEXT_MESSAGE_ERROR] Failed: socketId=${socket.id}, userId="${socket.userId}", error=${error.message}, stack=${error.stack}`
    );
    await session.abortTransaction();
    callback({
      success: false,
      message: "Server error saving message",
      error: error.message,
    });
  } finally {
    session.endSession();
    console.log(`[SEND_TEXT_MESSAGE_DEBUG] Transaction session ended`);
  }
});
// socket.on("send_text_message", async (data, callback) => {
//   console.log(
//     `[SEND_TEXT_MESSAGE] Attempting to send message: socketId=${
//       socket.id
//     }, userId="${socket.userId}" (type: ${typeof socket.userId}), data=${JSON.stringify(
//       data,
//       null,
//       2
//     )}`
//   );

//   try {
//     const { groupId, content } = data;
//     let senderId = socket.userId;

//     // Step 1: Validate socket.userId and check onlineUsers
//     if (!senderId || typeof senderId !== "string") {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] Invalid or missing senderId: "${senderId}" (socketId=${socket.id})`
//       );
//       return callback({
//         success: false,
//         message: "Not authenticated - please join groups first",
//       });
//     }

//     // Check if user is in onlineUsers
//     if (!onlineUsers.has(senderId)) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] User not in onlineUsers: senderId=${senderId}, socketId=${socket.id}`
//       );
//       return callback({
//         success: false,
//         message: "User not connected - please join groups first",
//       });
//     }

//     // Step 2: Validate and cast senderId
//     if (!isValidObjectId(senderId)) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] senderId is not a valid ObjectId: "${senderId}" (socketId=${socket.id})`
//       );
//       return callback({
//         success: false,
//         message: "Invalid user ID format",
//       });
//     }
//     senderId = new mongoose.Types.ObjectId(senderId);

//     // Step 3: Verify user exists in database
//     const user = await User.findById(senderId).select("displayName");
//     if (!user) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] User not found in database: senderId=${senderId}, socketId=${socket.id}`
//       );
//       return callback({
//         success: false,
//         message: "User not found",
//       });
//     }
//     console.log(
//       `[SEND_TEXT_MESSAGE] Valid sender: senderId=${senderId}, displayName=${user.displayName}`
//     );

//     // Step 4: Validate groupId
//     if (!groupId || !isValidObjectId(groupId)) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] Invalid or missing groupId: "${groupId}"`
//       );
//       return callback({
//         success: false,
//         message: "Invalid group ID",
//       });
//     }
//     const castGroupId = new mongoose.Types.ObjectId(groupId);

//     // Step 5: Validate content
//     if (!content || content.trim() === "") {
//       console.error(`[SEND_TEXT_MESSAGE_ERROR] Empty content: "${content}"`);
//       return callback({
//         success: false,
//         message: "Message content cannot be empty",
//       });
//     }

//     // Step 6: Verify group and membership
//     const group = await Group.findById(castGroupId);
//     if (!group) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] Group not found: groupId=${castGroupId}`
//       );
//       return callback({
//         success: false,
//         message: "Group not found",
//       });
//     }

//     const isMember = group.members.some((id) => id.equals(senderId));
//     if (!isMember) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] Not authorized: senderId=${senderId}, groupId=${castGroupId}`
//       );
//       return callback({
//         success: false,
//         message: "Not authorized to send message",
//       });
//     }

//     // Step 7: Create and save Chat document
//     const chat = new Chat({
//       senderId,
//       groupId: castGroupId,
//       type: "text",
//       content: content.trim(),
//       status: "sent",
//       deletedFor: [],
//     });

//     await chat.save();
//     console.log(
//       `[SEND_TEXT_MESSAGE] Message saved: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}, rawChat=${JSON.stringify(
//         chat.toObject(),
//         null,
//         2
//       )}`
//     );

//     // Step 8: Populate senderId and verify
//     await chat.populate("senderId", "displayName");
//     if (!chat.senderId || !chat.senderId._id) {
//       console.error(
//         `[SEND_TEXT_MESSAGE_ERROR] Population failed for messageId=${chat._id}, senderId=${senderId}. Deleting invalid message.`
//       );
//       await Chat.findByIdAndDelete(chat._id);
//       return callback({
//         success: false,
//         message: "Sender not found in database after save",
//       });
//     }
//     console.log(
//       `[SEND_TEXT_MESSAGE] Populated successfully: messageId=${chat._id}, sender displayName=${chat.senderId.displayName}`
//     );

//     // Step 9: Emit message to group room
//     const groupRoom = `group_${castGroupId}`;
//     io.to(groupRoom).emit("new_text_message", { message: chat });
//     console.log(
//       `[SEND_TEXT_MESSAGE] Emitted new_text_message to groupRoom=${groupRoom}`
//     );

//     // Step 10: Update message status to delivered
//     setTimeout(async () => {
//       const updatedChat = await Chat.findByIdAndUpdate(
//         chat._id,
//         { status: "delivered" },
//         { new: true }
//       );
//       if (updatedChat) {
//         io.to(groupRoom).emit("message_status_update", {
//           messageId: chat._id,
//           status: "delivered",
//         });
//         console.log(
//           `[SEND_TEXT_MESSAGE] Updated status to delivered: messageId=${chat._id}`
//         );
//       } else {
//         console.warn(
//           `[SEND_TEXT_MESSAGE] Failed to update status for messageId=${chat._id}`
//         );
//       }
//     }, 100);

//     // Step 11: Send success response
//     callback({ success: true, message: chat });
//     console.log(
//       `[SEND_TEXT_MESSAGE_SUCCESS] Message sent: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}`
//     );
//   } catch (error) {
//     console.error(
//       `[SEND_TEXT_MESSAGE_ERROR] Failed: socketId=${socket.id}, userId="${socket.userId}", error=${error.message}, stack=${error.stack}`
//     );
//     callback({
//       success: false,
//       message: "Server error saving message",
//       error: error.message,
//     });
//   }
// });

    /** Remove member from group (self-leave or admin removal) */
    // socket.on("remove_group_member", async (data, callback) => {
    //   console.log(
    //     `[REMOVE_GROUP_MEMBER] Attempting to remove member: userId=${socket.userId}, data=${JSON.stringify(data)}`
    //   );

    //   try {
    //     const { groupId, memberId } = data;
    //     const userId = socket.userId;

    //     if (!userId) {
    //       console.error(`[REMOVE_GROUP_MEMBER_ERROR] Not authenticated: socketId=${socket.id}`);
    //       return callback({ success: false, message: "Not authenticated" });
    //     }
    //     if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
    //       console.error(`[REMOVE_GROUP_MEMBER_ERROR] Invalid IDs: groupId=${groupId}, memberId=${memberId}`);
    //       return callback({ success: false, message: "Invalid group or member ID" });
    //     }

    //     const group = await Group.findById(groupId);
    //     if (!group) {
    //       console.error(`[REMOVE_GROUP_MEMBER_ERROR] Group not found: groupId=${groupId}`);
    //       return callback({ success: false, message: "Group not found" });
    //     }

    //     // Check if user is a member (required for self-leave or removal)
    //     const isMember = group.members.map(id => id.toString()).includes(userId);
    //     if (!isMember) {
    //       return callback({ success: false, message: "You are not a member of this group" });
    //     }

    //     // Case 1: User is trying to leave themselves
    //     if (memberId === userId) {
    //       // Allow self-leave (even if creator — but warn UI not to allow it)
    //       if (memberId === group.createdBy.toString()) {
    //         // Optional: Prevent creator from leaving (recommended)
    //         return callback({ success: false, message: "Group creator cannot leave. Transfer ownership first or delete the group." });
    //       }
    //     }
    //     // Case 2: User is trying to remove someone else → must be creator or admin
    //     else {
    //       const isCreator = group.createdBy.toString() === userId;
    //       const isAdmin = group.admins?.map(id => id.toString()).includes(userId);
    //       if (!isCreator && !isAdmin) {
    //         console.error(`[REMOVE_GROUP_MEMBER_ERROR] Not authorized: userId=${userId} is not admin/creator`);
    //         return callback({ success: false, message: "Only admins or creator can remove members" });
    //       }

    //       // Prevent removing the creator
    //       if (memberId === group.createdBy.toString()) {
    //         console.error(`[REMOVE_GROUP_MEMBER_ERROR] Cannot remove creator: memberId=${memberId}`);
    //         return callback({ success: false, message: "Cannot remove group creator" });
    //       }
    //     }

    //     // Perform removal
    //     group.members = group.members.filter(id => id.toString() !== memberId);
    //     group.updatedAt = Date.now();
    //     await group.save();

    //     console.log(`[REMOVE_GROUP_MEMBER] Removed member: memberId=${memberId}, groupId=${groupId}`);

    //     // Notify removed user
    //     const removedSocketId = onlineUsers.get(memberId);
    //     if (removedSocketId) {
    //       io.to(removedSocketId).emit("removed_from_group", { groupId });
    //       io.to(removedSocketId).emit("stop_group_music", { groupId });
    //       io.sockets.sockets.get(removedSocketId)?.leave(`group_${groupId}`);
    //       console.log(`[REMOVE_GROUP_MEMBER] Notified removed member: memberId=${memberId}`);
    //     }

    //     // Notify remaining members
    //     const groupRoom = `group_${groupId}`;
    //     io.to(groupRoom).emit("group_member_removed", {
    //       groupId,
    //       removedMember: memberId,
    //     });

    //     callback({ success: true, group });
    //     console.log(`[REMOVE_GROUP_MEMBER_SUCCESS] Member removed from groupId=${groupId}`);
    //   } catch (error) {
    //     console.error(`[REMOVE_GROUP_MEMBER_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
    //     callback({ success: false, message: "Server error", error: error.message });
    //   }
    // });

    /** Remove member from group */
    // socket.on("remove_group_member", async (data, callback) => {
    //   console.log(
    //     `[REMOVE_GROUP_MEMBER] Attempting to remove member: userId=${
    //       socket.userId
    //     }, data=${JSON.stringify(data)}`
    //   );

    //   try {
    //     const { groupId, memberId } = data;
    //     const userId = socket.userId;

    //     if (!userId) {
    //       console.error(
    //         `[REMOVE_GROUP_MEMBER_ERROR] Not authenticated: socketId=${socket.id}`
    //       );
    //       return callback({ success: false, message: "Not authenticated" });
    //     }
    //     if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
    //       console.error(
    //         `[REMOVE_GROUP_MEMBER_ERROR] Invalid IDs: groupId=${groupId}, memberId=${memberId}`
    //       );
    //       return callback({
    //         success: false,
    //         message: "Invalid group or member ID",
    //       });
    //     }

    //     const group = await Group.findById(groupId);
    //     if (!group) {
    //       console.error(
    //         `[REMOVE_GROUP_MEMBER_ERROR] Group not found: groupId=${groupId}`
    //       );
    //       return callback({ success: false, message: "Group not found" });
    //     }

    //     if (group.createdBy.toString() !== userId) {
    //       console.error(
    //         `[REMOVE_GROUP_MEMBER_ERROR] Not authorized: userId=${userId}, groupCreator=${group.createdBy}`
    //       );
    //       return callback({ success: false, message: "Not authorized" });
    //     }

    //     if (memberId === group.createdBy.toString()) {
    //       console.error(
    //         `[REMOVE_GROUP_MEMBER_ERROR] Cannot remove creator: memberId=${memberId}`
    //       );
    //       return callback({
    //         success: false,
    //         message: "Cannot remove group creator",
    //       });
    //     }

    //     group.members = group.members.filter(
    //       (id) => id.toString() !== memberId
    //     );
    //     group.updatedAt = Date.now();
    //     await group.save();
    //     console.log(
    //       `[REMOVE_GROUP_MEMBER] Removed member: memberId=${memberId}, groupId=${groupId}`
    //     );

    //     const removedSocketId = onlineUsers.get(memberId);
    //     if (removedSocketId) {
    //       io.to(removedSocketId).emit("removed_from_group", { groupId });
    //       io.to(removedSocketId).emit("stop_group_music", { groupId });
    //       io.sockets.sockets.get(removedSocketId)?.leave(`group_${groupId}`);
    //       console.log(
    //         `[REMOVE_GROUP_MEMBER] Notified removed member: memberId=${memberId}, groupId=${groupId}`
    //       );
    //     }

    //     group.members.forEach((memberId) => {
    //       const memberSocketId = onlineUsers.get(memberId.toString());
    //       if (memberSocketId) {
    //         io.to(memberSocketId).emit("group_member_removed", {
    //           groupId,
    //           removedMember: memberId,
    //         });
    //         console.log(
    //           `[REMOVE_GROUP_MEMBER] Notified member: memberId=${memberId}, groupId=${groupId}`
    //         );
    //       }
    //     });

    //     callback({ success: true, group });
    //     console.log(
    //       `[REMOVE_GROUP_MEMBER_SUCCESS] Member removed from groupId=${groupId}`
    //     );
    //   } catch (error) {
    //     console.error(
    //       `[REMOVE_GROUP_MEMBER_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
    //     );
    //     callback({
    //       success: false,
    //       message: "Server error",
    //       error: error.message,
    //     });
    //   }
    // });

    /** Send text message */
    // socket.on("send_text_message", async (data, callback) => {
    //   console.log(
    //     `[SEND_TEXT_MESSAGE] Attempting to send message: userId=${
    //       socket.userId
    //     }, data=${JSON.stringify(data)}`
    //   );

    //   try {
    //     const { groupId, content } = data;
    //     const senderId = socket.userId;

    //     if (!senderId) {
    //       console.error(
    //         `[SEND_TEXT_MESSAGE_ERROR] Not authenticated: socketId=${socket.id}`
    //       );
    //       return callback({ success: false, message: "Not authenticated" });
    //     }
    //     if (!isValidObjectId(groupId)) {
    //       console.error(
    //         `[SEND_TEXT_MESSAGE_ERROR] Invalid groupId: ${groupId}`
    //       );
    //       return callback({ success: false, message: "Invalid group ID" });
    //     }
    //     if (!content || content.trim() === "") {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Empty content`);
    //       return callback({
    //         success: false,
    //         message: "Message content cannot be empty",
    //       });
    //     }

    //     const group = await Group.findById(groupId);
    //     if (!group) {
    //       console.error(
    //         `[SEND_TEXT_MESSAGE_ERROR] Group not found: groupId=${groupId}`
    //       );
    //       return callback({ success: false, message: "Group not found" });
    //     }

    //     const isMember = group.members.some((id) => id.toString() === senderId);
    //     if (!isMember) {
    //       console.error(
    //         `[SEND_TEXT_MESSAGE_ERROR] Not authorized: userId=${senderId}, groupId=${groupId}`
    //       );
    //       return callback({
    //         success: false,
    //         message: "Not authorized to send message",
    //       });
    //     }

    //     const chat = new Chat({
    //       senderId,
    //       groupId,
    //       type: "text",
    //       content,
    //       status: "sent",
    //     });

    //     await chat.save();
    //     await chat.populate("senderId", "displayName");
    //     console.log(
    //       `[SEND_TEXT_MESSAGE] Message saved: messageId=${chat._id}, groupId=${groupId}`
    //     );

    //     const groupRoom = `group_${groupId}`;
    //     io.to(groupRoom).emit("new_text_message", { message: chat });
    //     console.log(
    //       `[SEND_TEXT_MESSAGE] Emitted new_text_message to groupId=${groupId}`
    //     );

    //     setTimeout(async () => {
    //       const updatedChat = await Chat.findByIdAndUpdate(
    //         chat._id,
    //         { status: "delivered" },
    //         { new: true }
    //       );
    //       io.to(groupRoom).emit("message_status_update", {
    //         messageId: chat._id,
    //         status: "delivered",
    //       });
    //       console.log(
    //         `[SEND_TEXT_MESSAGE] Updated status to delivered: messageId=${chat._id}`
    //       );
    //     }, 100);

    //     callback({ success: true, message: chat });
    //     console.log(
    //       `[SEND_TEXT_MESSAGE_SUCCESS] Message sent: messageId=${chat._id}, groupId=${groupId}`
    //     );
    //   } catch (error) {
    //     console.error(
    //       `[SEND_TEXT_MESSAGE_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
    //     );
    //     callback({
    //       success: false,
    //       message: "Server error",
    //       error: error.message,
    //     });
    //   }
    // });

    /** Send text message – FIXED for senderId null */
    // socket.on("send_text_message", async (data, callback) => {
    //   console.log(`[SEND_TEXT_MESSAGE] Payload debug: socket.userId="${socket.userId}" (type: ${typeof socket.userId}), data=${JSON.stringify(data)}`);

    //   try {
    //     const { groupId, content } = data;
    //     let senderId = socket.userId;

    //     // 👈 STEP 1: Validate & cast senderId (prevents null save)
    //     if (!senderId || typeof senderId !== 'string') {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Invalid senderId: "${senderId}" (not a string)`);
    //       return callback({ success: false, message: "Invalid sender – join groups first" });
    //     }
    //     if (!isValidObjectId(senderId)) {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] senderId not valid ObjectId: "${senderId}"`);
    //       return callback({ success: false, message: "Invalid user ID format" });
    //     }
    //     senderId = new mongoose.Types.ObjectId(senderId);  // 👈 Force cast
    //     console.log(`[SEND_TEXT_MESSAGE] Casted senderId: ${senderId.toString()}`);

    //     // Validate other inputs
    //     if (!isValidObjectId(groupId)) {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Invalid groupId: "${groupId}"`);
    //       return callback({ success: false, message: "Invalid group ID" });
    //     }
    //     if (!content || content.trim() === '') {
    //       return callback({ success: false, message: "Empty content" });
    //     }

    //     // Check group & membership
    //     const group = await Group.findById(groupId);
    //     if (!group) {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Group not found: ${groupId}`);
    //       return callback({ success: false, message: "Group not found" });
    //     }
    //     const isMember = group.members.some(id => id.toString() === senderId.toString());
    //     if (!isMember) {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Not member: ${senderId} in ${groupId}`);
    //       return callback({ success: false, message: "Not a group member" });
    //     }

    //     // Create & save (with error handling)
    //     const chat = new Chat({
    //       senderId,  // 👈 Now guaranteed valid ObjectId
    //       groupId: new mongoose.Types.ObjectId(groupId),  // 👈 Cast for safety
    //       type: "text",
    //       content: content.trim(),
    //       status: "sent",
    //       deletedFor: [],
    //     });

    //     await chat.save();
    //     console.log(`[SEND_TEXT_MESSAGE] Saved raw: senderId=${senderId.toString()}, _id=${chat._id}`);

    //     // 👈 STEP 2: Populate & verify (cleanup if fails)
    //     await chat.populate("senderId", "displayName phone");  // Add phone if needed
    //     if (!chat.senderId || !chat.senderId._id) {
    //       console.error(`[SEND_TEXT_MESSAGE_ERROR] Populate failed! Raw senderId="${senderId}", deleting ${chat._id}`);
    //       await Chat.findByIdAndDelete(chat._id);  // 👈 Prevent junk in DB
    //       return callback({ success: false, message: "Sender user not found in database" });
    //     }
    //     console.log(`[SEND_TEXT_MESSAGE] Populated success: displayName="${chat.senderId.displayName}"`);

    //     // Emit to room
    //     const groupRoom = `group_${groupId}`;
    //     io.to(groupRoom).emit("new_text_message", { message: chat });
    //     console.log(`[SEND_TEXT_MESSAGE] Emitted to ${groupRoom}`);

    //     // Status update
    //     setTimeout(async () => {
    //       await Chat.findByIdAndUpdate(chat._id, { status: "delivered" });
    //       io.to(groupRoom).emit("message_status_update", { messageId: chat._id, status: "delivered" });
    //     }, 100);

    //     // Success response (now with populated senderId)
    //     callback({ success: true, message: chat });
    //     console.log(`[SEND_TEXT_MESSAGE_SUCCESS] Full response ready: senderId=${chat.senderId._id}`);
    //   } catch (error) {
    //     console.error(`[SEND_TEXT_MESSAGE_ERROR] Full error: ${error.message}, stack=${error.stack}`);
    //     callback({ success: false, message: "Server error saving message", error: error.message });
    //   }
    // });

    /** Send voice message */
    socket.on("send_voice_message", async (data, callback) => {
      console.log(
        `[SEND_VOICE_MESSAGE] Attempting to send voice message: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { groupId, voiceUrl, duration } = data;
        const senderId = socket.userId;

        if (!senderId) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Invalid groupId: ${groupId}`
          );
          return callback({ success: false, message: "Invalid group ID" });
        }
        if (!voiceUrl || !/^https?:\/\/.*\.(mp3|wav|ogg)$/.test(voiceUrl)) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Invalid voiceUrl: ${voiceUrl}`
          );
          return callback({ success: false, message: "Invalid voice URL" });
        }
        if (duration > 180) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Voice message too long: duration=${duration}`
          );
          return callback({
            success: false,
            message: "Voice message too long (max 3 minutes)",
          });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Group not found: groupId=${groupId}`
          );
          return callback({ success: false, message: "Group not found" });
        }

        const isMember = group.members.some((id) => id.toString() === senderId);
        if (!isMember) {
          console.error(
            `[SEND_VOICE_MESSAGE_ERROR] Not authorized: userId=${senderId}, groupId=${groupId}`
          );
          return callback({
            success: false,
            message: "Not authorized to send message",
          });
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
        console.log(
          `[SEND_VOICE_MESSAGE] Voice message saved: messageId=${chat._id}, groupId=${groupId}`
        );

        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("new_voice_message", { message: chat });
        console.log(
          `[SEND_VOICE_MESSAGE] Emitted new_voice_message to groupId=${groupId}`
        );

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
          console.log(
            `[SEND_VOICE_MESSAGE] Updated status to delivered: messageId=${chat._id}`
          );
        }, 100);

        callback({ success: true, message: chat });
        console.log(
          `[SEND_VOICE_MESSAGE_SUCCESS] Voice message sent: messageId=${chat._id}, groupId=${groupId}`
        );
      } catch (error) {
        console.error(
          `[SEND_VOICE_MESSAGE_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    /** Typing indicator */
    socket.on("typing", ({ groupId, typing }) => {
      console.log(
        `[TYPING] User typing status: userId=${socket.userId}, groupId=${groupId}, typing=${typing}`
      );

      const userId = socket.userId;
      if (!userId || !groupId || !isValidObjectId(groupId)) {
        console.error(
          `[TYPING_ERROR] Invalid input: userId=${userId}, groupId=${groupId}`
        );
        return;
      }

      const groupRoom = `group_${groupId}`;

      if (typing) {
        if (!typingUsers.has(groupId)) {
          typingUsers.set(groupId, new Set());
        }
        typingUsers.get(groupId).add(userId);
        console.log(
          `[TYPING] Added to typing users: userId=${userId}, groupId=${groupId}`
        );

        socket
          .to(groupRoom)
          .emit("user_typing", { userId, groupId, typing: true });
        console.log(`[TYPING] Emitted typing=true to groupId=${groupId}`);
      } else {
        if (typingUsers.has(groupId)) {
          typingUsers.get(groupId).delete(userId);
          if (typingUsers.get(groupId).size === 0) {
            typingUsers.delete(groupId);
            console.log(
              `[TYPING] Removed empty typing set for groupId=${groupId}`
            );
          }
        }

        socket
          .to(groupRoom)
          .emit("user_typing", { userId, groupId, typing: false });
        console.log(`[TYPING] Emitted typing=false to groupId=${groupId}`);
      }
    });

    /** Mark message as read */
    socket.on("mark_message_read", async (data, callback) => {
      console.log(
        `[MARK_MESSAGE_READ] Attempting to mark message read: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { messageId } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(
            `[MARK_MESSAGE_READ_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(messageId)) {
          console.error(
            `[MARK_MESSAGE_READ_ERROR] Invalid messageId: ${messageId}`
          );
          return callback({ success: false, message: "Invalid message ID" });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          console.error(
            `[MARK_MESSAGE_READ_ERROR] Message not found: messageId=${messageId}`
          );
          return callback({ success: false, message: "Message not found" });
        }

        message.status = "read";
        await message.save();
        console.log(
          `[MARK_MESSAGE_READ] Message marked read: messageId=${messageId}`
        );

        const groupRoom = `group_${message.groupId}`;
        io.to(groupRoom).emit("message_status_update", {
          messageId,
          status: "read",
          readBy: userId,
        });
        console.log(
          `[MARK_MESSAGE_READ] Emitted status update to groupId=${message.groupId}`
        );

        const senderSocketId = onlineUsers.get(message.senderId.toString());
        if (senderSocketId) {
          io.to(senderSocketId).emit("message_read", {
            messageId,
            readBy: userId,
          });
          console.log(
            `[MARK_MESSAGE_READ] Notified sender: senderId=${message.senderId}, messageId=${messageId}`
          );
        }

        callback({ success: true, message });
        console.log(
          `[MARK_MESSAGE_READ_SUCCESS] Message marked read: messageId=${messageId}`
        );
      } catch (error) {
        console.error(
          `[MARK_MESSAGE_READ_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    /** Get group messages with pagination */
    socket.on("get_group_messages", async (data, callback) => {
      console.log(
        `[GET_GROUP_MESSAGES] Fetching messages: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { groupId, page = 1, limit = 50 } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(
            `[GET_GROUP_MESSAGES_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(groupId)) {
          console.error(
            `[GET_GROUP_MESSAGES_ERROR] Invalid groupId: ${groupId}`
          );
          return callback({ success: false, message: "Invalid group ID" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          console.error(
            `[GET_GROUP_MESSAGES_ERROR] Group not found: groupId=${groupId}`
          );
          return callback({ success: false, message: "Group not found" });
        }

        const isMember = group.members.some((id) => id.toString() === userId);
        if (!isMember) {
          console.error(
            `[GET_GROUP_MESSAGES_ERROR] Not authorized: userId=${userId}, groupId=${groupId}`
          );
          return callback({ success: false, message: "Not authorized" });
        }

        const skip = (page - 1) * limit;
        const messages = await Chat.find({ groupId })
          .populate("senderId", "displayName")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);
        console.log(
          `[GET_GROUP_MESSAGES] Fetched ${messages.length} messages for groupId=${groupId}, page=${page}`
        );

        const unreadMessages = messages.filter((msg) => {
          // 🔒 SAFETY: Skip messages with missing or null senderId
          if (!msg.senderId) {
            console.warn(
              `[GET_GROUP_MESSAGES] Skipping message with null senderId: ${msg._id}`
            );
            return false;
          }
          return msg.senderId.toString() !== userId && msg.status === "sent";
        });
        if (unreadMessages.length > 0) {
          const unreadIds = unreadMessages.map((msg) => msg._id);
          await Chat.updateMany(
            { _id: { $in: unreadIds } },
            { status: "delivered" }
          );
          console.log(
            `[GET_GROUP_MESSAGES] Marked ${unreadMessages.length} messages as delivered for groupId=${groupId}`
          );
        }

        callback({
          success: true,
          messages: messages.reverse(),
          hasMore: messages.length === limit,
        });
        console.log(
          `[GET_GROUP_MESSAGES_SUCCESS] Messages fetched: groupId=${groupId}, page=${page}`
        );
      } catch (error) {
        console.error(
          `[GET_GROUP_MESSAGES_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    /** Delete message */
    socket.on("delete_message", async (data, callback) => {
      console.log(
        `[DELETE_MESSAGE] Attempting to delete message: userId=${
          socket.userId
        }, data=${JSON.stringify(data)}`
      );

      try {
        const { messageId, forEveryone = false } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(
            `[DELETE_MESSAGE_ERROR] Not authenticated: socketId=${socket.id}`
          );
          return callback({ success: false, message: "Not authenticated" });
        }
        if (!isValidObjectId(messageId)) {
          console.error(
            `[DELETE_MESSAGE_ERROR] Invalid messageId: ${messageId}`
          );
          return callback({ success: false, message: "Invalid message ID" });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          console.error(
            `[DELETE_MESSAGE_ERROR] Message not found: messageId=${messageId}`
          );
          return callback({ success: false, message: "Message not found" });
        }

        if (forEveryone && message.senderId.toString() !== userId) {
          console.error(
            `[DELETE_MESSAGE_ERROR] Not authorized to delete for everyone: userId=${userId}, senderId=${message.senderId}`
          );
          return callback({
            success: false,
            message: "Not authorized to delete for everyone",
          });
        }

        if (forEveryone) {
          message.content = "This message was deleted";
          message.deletedFor = [];
        } else {
          if (!message.deletedFor.includes(userId)) {
            message.deletedFor.push(userId);
          }
        }

        await message.save();
        console.log(
          `[DELETE_MESSAGE] Message deleted: messageId=${messageId}, forEveryone=${forEveryone}`
        );

        const groupRoom = `group_${message.groupId}`;
        io.to(groupRoom).emit("message_deleted", { message });
        console.log(
          `[DELETE_MESSAGE] Emitted message_deleted to groupId=${message.groupId}`
        );

        callback({ success: true, message });
        console.log(
          `[DELETE_MESSAGE_SUCCESS] Message deleted: messageId=${messageId}`
        );
      } catch (error) {
        console.error(
          `[DELETE_MESSAGE_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        callback({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    /** Join group room for real-time messaging */
    socket.on("join_group_room", async ({ groupId }) => {
      console.log(
        `[JOIN_GROUP_ROOM] Attempting to join room: userId=${socket.userId}, groupId=${groupId}`
      );

      if (!isValidObjectId(groupId)) {
        console.error(`[JOIN_GROUP_ROOM_ERROR] Invalid groupId: ${groupId}`);
        socket.emit("error", { message: "Invalid group ID" });
        return;
      }

      try {
        const group = await Group.findById(groupId);
        if (!group) {
          console.error(
            `[JOIN_GROUP_ROOM_ERROR] Group not found: groupId=${groupId}`
          );
          socket.emit("error", { message: "Group not found" });
          return;
        }

        const roomName = `group_${groupId}`;
        socket.join(roomName);
        console.log(
          `[JOIN_GROUP_ROOM] Joined room: groupId=${groupId}, socketId=${socket.id}`
        );

        if (group.musicUrl) {
          socket.emit("play_group_music", {
            groupId,
            musicUrl: group.musicUrl,
          });
          console.log(
            `[JOIN_GROUP_ROOM] Emitted play_group_music: groupId=${groupId}, musicUrl=${group.musicUrl}`
          );
        }
        socket.emit("group_room_joined", { groupId });
        console.log(
          `[JOIN_GROUP_ROOM_SUCCESS] Room joined: groupId=${groupId}`
        );
      } catch (error) {
        console.error(
          `[JOIN_GROUP_ROOM_ERROR] Failed: userId=${socket.userId}, error=${error.message}`
        );
        socket.emit("error", { message: "Server error", error: error.message });
      }
    });

    socket.on("uploading_media", async ({ senderId, groupId, uploading }) => {
      console.log(
        `[UPLOADING_MEDIA] Group upload indicator: userId=${socket.userId}, groupId=${groupId}, uploading=${uploading}`
      );
      try {
        if (!groupId || !isValidObjectId(groupId)) {
          console.error(`[UPLOADING_MEDIA_ERROR] Invalid groupId: ${groupId}`);
          return;
        }
        const group = await Group.findById(groupId);
        if (!group) return;

        // Emit to group room (efficient, since members are already joined)
        const groupRoom = `group_${groupId}`;
        socket
          .to(groupRoom)
          .emit("uploading_media", { senderId, groupId, uploading });
        console.log(`[UPLOADING_MEDIA] Emitted to group room: ${groupRoom}`);
      } catch (err) {
        console.error("[UPLOADING_MEDIA_ERROR]", err.message);
      }
    });

    /** Send media message (images/videos/files) to group */
    // socket.on("send_media", async ({ senderId, groupId, files }, callback) => {
    //   console.log(
    //     `[SEND_MEDIA] Attempting to send media: userId=${
    //       socket.userId
    //     }, groupId=${groupId}, files=${files?.length || 0}`
    //   );

    //   // Use provided callback if passed, else emit error
    //   const ack =
    //     callback || ((err) => socket.emit("media_error", { error: err }));

    //   try {
    //     if (
    //       !files ||
    //       !Array.isArray(files) ||
    //       files.length === 0 ||
    //       files.length > 10
    //     ) {
    //       return ack("Files must be a non-empty array (max 10)");
    //     }
    //     if (!groupId || !isValidObjectId(groupId)) {
    //       return ack("Invalid group ID");
    //     }

    //     const userId = socket.userId;
    //     if (!userId) {
    //       return ack("Not authenticated");
    //     }

    //     // Validate files (your existing logic)
    //     for (const file of files) {
    //       const { type, url, fileType, duration, fileName } = file;
    //       if (!["image", "video", "file"].includes(type)) {
    //         return ack(`Invalid media type: ${type}`);
    //       }
    //       if (!url || typeof url !== "string" || url.trim() === "") {
    //         return ack("Each file must have a valid URL");
    //       }
    //       if (!fileType || typeof fileType !== "string") {
    //         return ack("Each file must have a valid MIME type");
    //       }
    //       if (type === "image" && !fileType.startsWith("image/")) {
    //         return ack(`Invalid MIME type for image: ${fileType}`);
    //       }
    //       if (type === "video" && !fileType.startsWith("video/")) {
    //         return ack(`Invalid MIME type for video: ${fileType}`);
    //       }
    //       if (
    //         type === "video" &&
    //         (typeof duration !== "number" || duration <= 0 || duration > 300)
    //       ) {
    //         return ack("Video duration invalid (max 5 minutes)");
    //       }
    //       if (type === "file" && (!fileName || typeof fileName !== "string")) {
    //         return ack("Documents must have a file name");
    //       }
    //     }

    //     // Verify group membership (your existing pattern)
    //     const group = await Group.findById(groupId);
    //     if (!group) {
    //       return ack("Group not found");
    //     }
    //     const isMember = group.members.some((id) => id.toString() === userId);
    //     if (!isMember) {
    //       return ack("Not authorized to send message");
    //     }

    //     // Create Chat documents (adapted for group-only)
    //     const chats = [];
    //     for (const file of files) {
    //       const { type, url, fileType, duration, fileName } = file;
    //       const chat = new Chat({
    //         senderId,
    //         groupId, // Always set for groups
    //         type,
    //         content: url,
    //         fileType,
    //         fileName: type === "file" ? fileName : undefined,
    //         duration: type === "video" ? duration : 0,
    //         status: "sent",
    //         deletedFor: [],
    //       });
    //       await chat.save();
    //       await chat.populate("senderId", "displayName"); // For emission
    //       chats.push(chat);
    //     }

    //     // Prepare payload (your existing logic, simplified)
    //     const payload = chats.map((chat) => ({
    //       id: chat._id.toString(),
    //       senderId: chat.senderId.toString(),
    //       groupId: chat.groupId.toString(),
    //       content: chat.content,
    //       type: chat.type,
    //       fileType: chat.fileType,
    //       fileName: chat.fileName,
    //       duration: chat.duration,
    //       timestamp: chat.createdAt,
    //       status: chat.status,
    //     }));

    //     const groupRoom = `group_${groupId}`;
    //     io.to(groupRoom).emit("new_media_message", payload); // Use "new_media_message" to match your text/voice pattern
    //     console.log(
    //       `[SEND_MEDIA] Emitted new_media_message to group room: ${groupRoom}`
    //     );

    //     setTimeout(async () => {
    //       await Chat.updateMany(
    //         { _id: { $in: chats.map((c) => c._id) } },
    //         { status: "delivered" }
    //       );
    //       io.to(groupRoom).emit("message_status_update", {
    //         messageIds: chats.map((c) => c._id),
    //         status: "delivered",
    //       });
    //       console.log(
    //         `[SEND_MEDIA] Marked ${chats.length} media as delivered: groupId=${groupId}`
    //       );
    //     }, 100);

    //     // Respond to sender
    //     ack(null, { success: true, messages: payload });
    //     console.log(
    //       `[SEND_MEDIA_SUCCESS] Media sent: ${chats.length} files to groupId=${groupId}`
    //     );
    //   } catch (err) {
    //     console.error(
    //       `[SEND_MEDIA_ERROR] Failed: userId=${socket.userId}, error=${err.message}`
    //     );
    //     ack(`Server error: ${err.message}`);
    //   }
    // });

    /** Send media message – FIXED for groupId & senderId */
    socket.on("send_media", async (payload, callback) => {
      // 👈 STEP 1: Log EXACT payload (helps debug client emit)
      console.log(
        `[SEND_MEDIA] Exact payload received:`,
        JSON.stringify(payload, null, 2)
      );
      console.log(
        `[SEND_MEDIA] socket.userId="${
          socket.userId
        }" (type: ${typeof socket.userId})`
      );

      const { groupId, files } = payload; // Ignore senderId from payload (use socket)
      const ack =
        callback || ((err) => socket.emit("media_error", { error: err }));

      try {
        let senderId = socket.userId;
        // if (
        //   !senderId ||
        //   typeof senderId !== "string" ||
        //   !isValidObjectId(senderId)
        // ) {
        //   console.error(`[SEND_MEDIA_ERROR] Invalid senderId: "${senderId}"`);
        //   return ack("Invalid sender – join groups first");
        // }
        senderId = new mongoose.Types.ObjectId(senderId);
        console.log(`[SEND_MEDIA] Casted senderId: ${senderId.toString()}`);

        // 👈 STEP 2: groupId validation (with fallback log)
        if (!groupId) {
          console.error(
            `[SEND_MEDIA_ERROR] MISSING groupId in payload! Full payload was:`,
            JSON.stringify(payload)
          );
          return ack(
            "No group ID provided – select a group and include { groupId: '...' } in emit"
          );
        }
        if (!isValidObjectId(groupId)) {
          console.error(`[SEND_MEDIA_ERROR] Invalid groupId: "${groupId}"`);
          return ack("Invalid group ID format");
        }
        const castGroupId = new mongoose.Types.ObjectId(groupId);
        console.log(`[SEND_MEDIA] Casted groupId: ${castGroupId.toString()}`);

        // Files validation
        if (
          !files ||
          !Array.isArray(files) ||
          files.length === 0 ||
          files.length > 10
        ) {
          return ack("Files must be 1-10 items array");
        }
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const { type, url, fileType, duration = 0, fileName } = file;
          if (!["image", "video", "file"].includes(type))
            return ack(`Invalid type at ${i}: ${type}`);
          if (!url || typeof url !== "string" || !url.trim())
            return ack(`Invalid URL at ${i}`);
          if (!fileType || typeof fileType !== "string")
            return ack(`Invalid MIME at ${i}: ${fileType}`);
          if (type === "image" && !fileType.startsWith("image/"))
            return ack(`Bad image MIME: ${fileType}`);
          if (type === "video" && !fileType.startsWith("video/"))
            return ack(`Bad video MIME: ${fileType}`);
          if (
            type === "video" &&
            (typeof duration !== "number" || duration < 1 || duration > 300)
          )
            return ack("Video max 5 min");
          if (type === "file" && (!fileName || typeof fileName !== "string"))
            return ack("Files need name");
          console.log(
            `[SEND_MEDIA] File ${i} valid: ${type}, url=${url.substring(
              0,
              50
            )}...`
          );
        }

        // Group & membership check
        const group = await Group.findById(castGroupId);
        if (!group) return ack("Group not found");
        const isMember = group.members.some((id) => id.equals(senderId));
        if (!isMember) return ack("Not a group member");

        // Create chats
        const chats = [];
        for (const file of files) {
          const { type, url, fileType, duration = 0, fileName } = file;
          const chat = new Chat({
            senderId,
            groupId: castGroupId,
            type,
            content: url,
            fileType,
            fileName: type === "file" ? fileName : undefined,
            duration: type === "video" ? duration : 0,
            status: "sent",
            deletedFor: [],
          });
          await chat.save();
          await chat.populate("senderId", "displayName");
          if (!chat.senderId || !chat.senderId._id) {
            console.error(
              `[SEND_MEDIA_ERROR] Populate failed for ${chat._id} – deleting`
            );
            await Chat.findByIdAndDelete(chat._id);
            return ack("Sender not found");
          }
          chats.push(chat);
          console.log(`[SEND_MEDIA] Saved chat ${chat._id}: ${type}`);
        }

        // Payload for emit/response
        const responsePayload = chats.map((chat) => ({
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          groupId: chat.groupId.toString(),
          content: chat.content,
          type: chat.type,
          fileType: chat.fileType,
          fileName: chat.fileName,
          duration: chat.duration,
          timestamp: chat.createdAt,
          status: chat.status,
          displayName: chat.senderId.displayName,
        }));

        const groupRoom = `group_${groupId}`;
        io.to(groupRoom).emit("new_media_message", responsePayload);

        setTimeout(async () => {
          await Chat.updateMany(
            { _id: { $in: chats.map((c) => c._id) } },
            { status: "delivered" }
          );
          io.to(groupRoom).emit("message_status_update", {
            messageIds: chats.map((c) => c._id),
            status: "delivered",
          });
        }, 100);

        ack(null, { success: true, messages: responsePayload });
        console.log(
          `[SEND_MEDIA_SUCCESS] Sent ${chats.length} files to ${groupId}`
        );
      } catch (error) {
        console.error(`[SEND_MEDIA_ERROR] Full error: ${error.message}`);
        ack(`Server error: ${error.message}`);
      }
    });

    /** Leave group room */
    socket.on("leave_group_room", ({ groupId }) => {
      console.log(
        `[LEAVE_GROUP_ROOM] Attempting to leave room: userId=${socket.userId}, groupId=${groupId}`
      );

      if (!isValidObjectId(groupId)) {
        console.error(`[LEAVE_GROUP_ROOM_ERROR] Invalid groupId: ${groupId}`);
        return;
      }

      const roomName = `group_${groupId}`;
      socket.leave(roomName);
      socket.emit("stop_group_music", { groupId });
      socket.emit("group_room_left", { groupId });
      console.log(
        `[LEAVE_GROUP_ROOM_SUCCESS] Left room: groupId=${groupId}, socketId=${socket.id}`
      );
    });

    /** Get typing users in group */
    socket.on("get_typing_users", ({ groupId }) => {
      console.log(
        `[GET_TYPING_USERS] Fetching typing users: groupId=${groupId}`
      );

      if (!isValidObjectId(groupId)) {
        console.error(`[GET_TYPING_USERS_ERROR] Invalid groupId: ${groupId}`);
        return;
      }

      const typingSet = typingUsers.get(groupId) || new Set();
      const typingArray = Array.from(typingSet);
      socket.emit("typing_users", { groupId, users: typingArray });
      console.log(
        `[GET_TYPING_USERS_SUCCESS] Sent typing users: groupId=${groupId}, users=${typingArray}`
      );
    });

    /** Disconnect handling */
    socket.on("disconnect", async () => {
      const disconnectedUserId = socket.userId;
      if (!disconnectedUserId) {
        console.log(
          `[DISCONNECT] Unknown user disconnected: socketId=${socket.id}`
        );
        return;
      }

      console.log(
        `[DISCONNECT] User disconnected: userId=${disconnectedUserId}, socketId=${socket.id}`
      );

      onlineUsers.delete(disconnectedUserId);

      try {
        const user = await User.findByIdAndUpdate(
          disconnectedUserId,
          { online: false, lastSeen: new Date() },
          { new: true }
        );
        console.log(
          `[DISCONNECT] User updated: userId=${disconnectedUserId}, online=false`
        );

        typingUsers.forEach((userSet, groupId) => {
          if (userSet.has(disconnectedUserId)) {
            userSet.delete(disconnectedUserId);
            const groupRoom = `group_${groupId}`;
            socket.to(groupRoom).emit("user_typing", {
              userId: disconnectedUserId,
              groupId,
              typing: false,
            });
            console.log(
              `[DISCONNECT] Cleared typing status: userId=${disconnectedUserId}, groupId=${groupId}`
            );
          }
        });

        console.log(
          `[DISCONNECT_SUCCESS] User disconnected from group socket: userId=${disconnectedUserId}`
        );
      } catch (error) {
        console.error(
          `[DISCONNECT_ERROR] Failed: userId=${disconnectedUserId}, error=${error.message}`
        );
      }
    });
  });

  return io;
};
