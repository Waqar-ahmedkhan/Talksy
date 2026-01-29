import { Server } from 'socket.io';
import Channel from '../models/Channel.js';
import Group from '../models/Group.js';
import Chat from '../models/Chat.js';
import User from '../models/User.js';
import moment from 'moment-timezone';
import Profile from '../models/Profile.js';
import { isValidObjectId } from 'mongoose';
import mongoose from 'mongoose';

const logTimestamp = () => moment().tz('Asia/Karachi').format('DD/MM/YYYY, hh:mm:ss a');

export const normalizePhoneNumber = (phone) => {
  const timestamp = logTimestamp();
  if (!phone || typeof phone !== 'string') {
    console.warn(`[normalizePhoneNumber] Invalid or missing phone number: ${phone} at ${timestamp}`);
    return null;
  }
  let normalized = phone.trim().replace(/[\s-]/g, '');
  if (!normalized.startsWith('+') && /^\d{10}$/.test(normalized)) {
    normalized = `+92${normalized}`;
  }
  console.log(`[normalizePhoneNumber] Normalized: ${phone} -> ${normalized} at ${timestamp}`);
  return normalized;
};

export const formatProfile = (profile, user, customName = null, isBlocked = false) => {
  const timestamp = logTimestamp();
  const phone = profile?.phone || '';
  const name = customName || profile?.displayName || 'Unknown';
  const displayName = name && phone ? name : name || phone || 'Unknown';

  const formatted = {
    id: profile?._id?.toString() || null,
    userId: user?._id?.toString() || null,
    phone,
    displayName,
    randomNumber: profile?.randomNumber || '',
    isVisible: profile?.isVisible ?? false,
    isNumberVisible: profile?.isNumberVisible ?? false,
    avatarUrl: profile?.avatarUrl || '',
    fcmToken: profile?.fcmToken || user?.fcmToken || '',
    createdAt: profile?.createdAt?.toISOString() || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen?.toISOString() || null,
    customName: customName || null,
    isBlocked,
  };

  console.log(
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${customName}, isBlocked=${isBlocked} at ${timestamp}`,
  );
  return formatted;
};

const formatChatForEmission = (chat) => {
  if (!chat) return null;
  return {
    id: chat._id?.toString() || null,
    messageId: chat._id?.toString() || null, // Alternate field name for compatibility
    senderId: chat.senderId?.toString() || null,
    senderDisplayName: chat.senderDisplayName || '',
    groupId: chat.groupId?.toString() || null,
    type: chat.type || 'text',
    content: chat.content || '',
    displayContent: chat.type === 'text' && chat.content?.length > 50 ? `${chat.content.slice(0, 50)}...` : chat.content || '',
    fileType: chat.fileType || null,
    fileName: chat.fileName || '',
    duration: chat.duration || 0,
    clientId: chat.clientId || null,
    status: chat.status || 'sent',
    createdAt: chat.createdAt?.toISOString() || new Date().toISOString(),
    pinned: chat.pinned || false,
    deletedFor: Array.isArray(chat.deletedFor) ? chat.deletedFor.map((id) => id?.toString?.() || id) : [],
  };
};

export const initGroupSocket = (server) => {
  // 1️⃣ HELPER FUNCTION (Inside the main function - foolproof)
  const getGroupRoom = (groupId) => `group_${groupId}`;

  const io = new Server(server, {
    cors: { origin: '*' },
    path: '/group-socket',
  });

  const onlineUsers = new Map();
  const typingUsers = new Map();

  io.on('connection', (socket) => {
    console.log(
      `[GROUP_SOCKET] User connected: socketId=${socket.id}, time=${new Date().toLocaleString('en-PK', {
        timeZone: 'Asia/Karachi',
      })}`,
    );

    /** User joins group chatting system */
    socket.on('join_groups', async (userId) => {
      console.log(`[JOIN_GROUPS] Attempting to join: userId=${userId}, socketId=${socket.id}`);

      if (!userId || !isValidObjectId(userId)) {
        console.error(`[JOIN_GROUPS_ERROR] Invalid userId: ${userId}`);
        socket.emit('error', { message: 'Invalid user ID' });
        socket.disconnect();
        return;
      }

      const userIdStr = userId.toString();
      onlineUsers.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      try {
        const user = await User.findByIdAndUpdate(userIdStr, { online: true, lastSeen: new Date() }, { new: true });
        if (!user) {
          console.error(`[JOIN_GROUPS_ERROR] User not found: userId=${userIdStr}`);
          socket.emit('error', { message: 'User not found' });
          socket.disconnect();
          return;
        }
        console.log(`[JOIN_GROUPS] User updated: userId=${userIdStr}, online=true`);

        const userGroups = await Group.find({ members: userIdStr }).lean();
        console.log(`[JOIN_GROUPS] Found ${userGroups.length} groups for userId=${userIdStr}`);

        // FIX: Use getGroupRoom helper
        const groupRooms = userGroups.map((gr) => getGroupRoom(gr._id));
        if (groupRooms.length > 0) {
          socket.join(groupRooms);
          console.log(`[JOIN_GROUPS] User joined rooms: ${groupRooms.join(', ')}`);

          userGroups.forEach((group) => {
            if (group.musicUrl) {
              socket.emit('play_group_music', {
                groupId: group._id,
                musicUrl: group.musicUrl,
              });
              console.log(`[JOIN_GROUPS] Emitted play_group_music: groupId=${group._id}, musicUrl=${group.musicUrl}`);
            }
          });
        }

        console.log(`[JOIN_GROUPS_SUCCESS] User ${userIdStr} joined group chatting system`);
      } catch (error) {
        console.error(`[JOIN_GROUPS_ERROR] Failed for userId=${userIdStr}: ${error.message}`);
        socket.emit('error', {
          message: 'Failed to join groups',
          error: error.message,
        });
        socket.disconnect();
      }
    });

    socket.on('create_group', async (data, callback) => {
      const timestamp = logTimestamp();
      const userId = socket.userId;

      try {
        // Debug logging
        console.log(`[CREATE_GROUP] Attempting: userId=${userId}, data=${JSON.stringify(data)}, timestamp=${timestamp}`);

        // === AUTHENTICATION & INPUT VALIDATION ===
        if (!userId || !isValidObjectId(userId)) {
          console.error(`[CREATE_GROUP_ERROR] Invalid userId: ${userId}, timestamp=${timestamp}`);
          return callback({ success: false, message: 'Not authenticated' });
        }

        const { name, channelId, members = [], musicUrl, pictureUrl } = data;

        // Validate group name
        if (!name || typeof name !== 'string' || name.trim().length < 3) {
          console.error(`[CREATE_GROUP_ERROR] Invalid name: ${name}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Group name must be at least 3 characters',
          });
        }

        // Validate channelId if provided
        if (channelId) {
          if (!isValidObjectId(channelId)) {
            console.error(`[CREATE_GROUP_ERROR] Invalid channelId: ${channelId}, timestamp=${timestamp}`);
            return callback({ success: false, message: 'Invalid channel ID' });
          }

          const channel = await Channel.findById(channelId).lean();
          if (!channel) {
            console.error(`[CREATE_GROUP_ERROR] Channel not found: ${channelId}, timestamp=${timestamp}`);
            return callback({ success: false, message: 'Channel not found' });
          }
        }
        const musicUrlPattern = /^https?:\/\/.+\.(mp3|wav|ogg)(\?.*)?$/i;
        const pictureUrlPattern = /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;

        if (musicUrl && !musicUrlPattern.test(musicUrl)) {
          console.error(`[CREATE_GROUP_ERROR] Invalid musicUrl: ${musicUrl}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Invalid music URL format. Must end with .mp3, .wav, or .ogg',
          });
        }
        if (pictureUrl && !pictureUrlPattern.test(pictureUrl)) {
          console.error(`[CREATE_GROUP_ERROR] Invalid pictureUrl: ${pictureUrl}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Invalid picture URL format. Must end with .jpg, .jpeg, .png, .gif, or .webp',
          });
        }
        if (!Array.isArray(members)) {
          console.error(`[CREATE_GROUP_ERROR] Members must be an array, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Members must be an array',
          });
        }

        // Filter and validate member IDs
        const validMemberIds = members.filter((id) => isValidObjectId(id));
        if (validMemberIds.length !== members.length) {
          console.warn(`[CREATE_GROUP_WARN] Filtered out invalid member IDs, timestamp=${timestamp}`);
        }

        // Add creator to members
        const allMemberIds = [...new Set([userId.toString(), ...validMemberIds])];

        // === DATABASE OPERATIONS (OPTIMIZED) ===
        const [users, channel] = await Promise.all([
          User.find({ _id: { $in: allMemberIds } })
            .select('_id displayName')
            .lean(),
          channelId ? Channel.findById(channelId).lean() : null,
        ]);

        if (users.length !== allMemberIds.length) {
          const foundIds = users.map((u) => u._id.toString());
          const missing = allMemberIds.filter((id) => !foundIds.includes(id));
          console.error(`[CREATE_GROUP_ERROR] Members not found: ${missing}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: `Members not found: ${missing.join(', ')}`,
          });
        }

        // === CREATE GROUP ===
        const group = await Group.create({
          name: name.trim(),
          channelId: channelId || null,
          createdBy: userId,
          members: allMemberIds,
          admins: [userId],
          musicUrl: musicUrl || null,
          pictureUrl: pictureUrl || null,
        });

        console.log(`[CREATE_GROUP] Created: groupId=${group._id}, name=${group.name}, members=${group.members.length}, timestamp=${timestamp}`);

        // === NOTIFICATIONS ===
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(group._id);
        socket.join(groupRoom);

        // Fetch member profiles for notifications
        const profiles = await Profile.find({ _id: { $in: allMemberIds } })
          .select('displayName phone avatarUrl')
          .lean();

        const profileMap = new Map(profiles.map((p) => [p._id.toString(), p]));

        // Notify members
        group.members.forEach((memberId) => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          const profile = profileMap.get(memberId.toString());

          if (memberSocketId) {
            io.to(memberSocketId).emit('group_created', {
              group: group.toObject(),
              memberProfile: formatProfile(profile, null),
            });

            if (group.musicUrl) {
              io.to(memberSocketId).emit('play_group_music', {
                groupId: group._id,
                musicUrl: group.musicUrl,
              });
            }
          }
        });

        // === SUCCESS RESPONSE ===
        callback({
          success: true,
          group: group.toObject(),
        });

        console.log(`[CREATE_GROUP_SUCCESS] groupId=${group._id}, timestamp=${timestamp}`);
      } catch (error) {
        console.error(`[CREATE_GROUP_ERROR] userId=${socket.userId}, error=${error.message}, timestamp=${timestamp}`);

        callback({
          success: false,
          message: error.message || 'Server error creating group',
        });
      }
    });
    /** Update group picture */
    /** Update group name or picture */

    /** Add members to group */
    socket.on('add_group_members', async (data, callback) => {
      console.log(`[ADD_GROUP_MEMBERS] Attempting to add members: userId=${socket.userId}, data=${JSON.stringify(data)}`);

      try {
        const { groupId, memberIds } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] Not authenticated: socketId=${socket.id}`);
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(groupId)) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] Invalid groupId: ${groupId}`);
          return callback({ success: false, message: 'Invalid group ID' });
        }
        if (!memberIds.every(isValidObjectId)) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] Invalid memberIds: ${memberIds}`);
          return callback({ success: false, message: 'Invalid member IDs' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] Group not found: groupId=${groupId}`);
          return callback({ success: false, message: 'Group not found' });
        }

        if (group.createdBy.toString() !== userId) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] Not authorized: userId=${userId}, groupCreator=${group.createdBy}`);
          return callback({ success: false, message: 'Not authorized' });
        }

        const validMembers = await User.find({ _id: { $in: memberIds } });
        if (validMembers.length !== memberIds.length) {
          console.error(`[ADD_GROUP_MEMBERS_ERROR] One or more members not found: memberIds=${memberIds}`);
          return callback({
            success: false,
            message: 'One or more members not found',
          });
        }

        const existingMembers = group.members.map((id) => id.toString());
        const newMembers = memberIds.filter((id) => !existingMembers.includes(id));

        if (newMembers.length > 0) {
          group.members.push(...newMembers);
          group.updatedAt = Date.now();
          await group.save();
          console.log(`[ADD_GROUP_MEMBERS] Added ${newMembers.length} members to groupId=${groupId}`);

          // FIX: Use getGroupRoom helper
          const groupRoom = getGroupRoom(groupId);
          newMembers.forEach((memberId) => {
            const memberSocketId = onlineUsers.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit('added_to_group', { group });
              io.to(memberSocketId).emit('auto_join_group', { groupId });
              console.log(`[ADD_GROUP_MEMBERS] Notified new member: memberId=${memberId}, groupId=${groupId}`);
              if (group.musicUrl) {
                io.to(memberSocketId).emit('play_group_music', {
                  groupId,
                  musicUrl: group.musicUrl,
                });
                console.log(`[ADD_GROUP_MEMBERS] Emitted play_group_music to memberId=${memberId}`);
              }
            }
          });

          group.members.forEach((memberId) => {
            const memberSocketId = onlineUsers.get(memberId.toString());
            if (memberSocketId && memberId.toString() !== userId) {
              io.to(memberSocketId).emit('group_members_added', {
                groupId,
                newMembers,
              });
              console.log(`[ADD_GROUP_MEMBERS] Notified existing member: memberId=${memberId}, groupId=${groupId}`);
            }
          });
        } else {
          console.log(`[ADD_GROUP_MEMBERS] No new members to add: groupId=${groupId}`);
        }

        callback({ success: true, group });
        console.log(`[ADD_GROUP_MEMBERS_SUCCESS] Members added to groupId=${groupId}`);
      } catch (error) {
        console.error(`[ADD_GROUP_MEMBERS_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
        callback({
          success: false,
          message: 'Server error',
          error: error.message,
        });
      }
    });

    socket.on('update_group', async (data, callback) => {
      console.log(`[UPDATE_GROUP] Attempting to update: userId=${socket.userId}, data=${JSON.stringify(data)}`);
      try {
        const { groupId, name, pictureUrl } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(groupId)) {
          return callback({ success: false, message: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: 'Group not found' });
        }

        // Check if user is creator or admin
        const isCreator = group.createdBy.toString() === userId;
        const isAdmin = group.admins?.map((id) => id.toString()).includes(userId);
        if (!isCreator && !isAdmin) {
          return callback({
            success: false,
            message: 'Only admins can update group',
          });
        }

        // Validate updates
        if (name !== undefined) {
          if (!name || name.trim().length < 3) {
            return callback({
              success: false,
              message: 'Group name must be at least 3 characters',
            });
          }
          group.name = name.trim();
        }

        if (pictureUrl !== undefined) {
          if (pictureUrl && !/^https?:\/\/.*\.(jpg|jpeg|png|gif)$/.test(pictureUrl)) {
            return callback({
              success: false,
              message: 'Invalid picture URL format',
            });
          }
          group.pictureUrl = pictureUrl || null;
        }

        group.updatedAt = Date.now();
        await group.save();

        // Notify all members
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(groupId);
        io.to(groupRoom).emit('group_updated', { group });

        callback({ success: true, group });
        console.log(`[UPDATE_GROUP_SUCCESS] Group updated: groupId=${groupId}`);
      } catch (error) {
        console.error(`[UPDATE_GROUP_ERROR] ${error.message}`);
        callback({ success: false, message: 'Server error' });
      }
    });

    /** Get full group details with members and admins */
    socket.on('get_group_details', async (data, callback) => {
      console.log(`[GET_GROUP_DETAILS] Fetching: userId=${socket.userId}, groupId=${data.groupId}`);
      try {
        const { groupId } = data;
        const userId = socket.userId;

        if (!userId || !isValidObjectId(groupId)) {
          return callback({ success: false, message: 'Invalid input' });
        }

        const group = await Group.findById(groupId)
          .populate('createdBy', 'displayName phone')
          .populate('admins', 'displayName phone')
          .populate('members', 'displayName phone');

        if (!group) {
          return callback({ success: false, message: 'Group not found' });
        }

        // Check membership
        if (!group.members.map((m) => m._id.toString()).includes(userId)) {
          return callback({ success: false, message: 'Not a group member' });
        }

        // Fetch online status & lastSeen for all members
        const phoneNumbers = group.members.map((m) => m.phone);
        const users = await User.find({ phone: { $in: phoneNumbers } }).select('phone online lastSeen');
        const userMap = new Map(users.map((u) => [u.phone, u]));

        const membersWithStatus = group.members.map((member) => ({
          ...member.toObject(),
          online: userMap.get(member.phone)?.online || false,
          lastSeen: userMap.get(member.phone)?.lastSeen || null,
          isAdmin: group.admins.map((a) => a._id.toString()).includes(member._id.toString()),
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
        callback({ success: false, message: 'Server error' });
      }
    });

    /** Delete group (creator only) */
    socket.on('delete_group', async (data, callback) => {
      console.log(`[DELETE_GROUP] Attempting: userId=${socket.userId}, groupId=${data.groupId}`);
      try {
        const { groupId } = data;
        const userId = socket.userId;

        if (!userId || !isValidObjectId(groupId)) {
          return callback({ success: false, message: 'Invalid input' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: 'Group not found' });
        }

        if (group.createdBy.toString() !== userId) {
          return callback({
            success: false,
            message: 'Only creator can delete group',
          });
        }

        // Delete group and all messages
        await Group.deleteOne({ _id: groupId });
        await Chat.deleteMany({ groupId });

        // Notify all members
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(groupId);
        io.to(groupRoom).emit('group_deleted', { groupId });

        callback({ success: true, message: 'Group deleted' });
        console.log(`[DELETE_GROUP_SUCCESS] Group deleted: ${groupId}`);
      } catch (error) {
        console.error(`[DELETE_GROUP_ERROR] ${error.message}`);
        callback({ success: false, message: 'Server error' });
      }
    });

    /** Remove member from group (self-leave or admin/creator removal) */
    socket.on('remove_group_member', async (data, callback) => {
      console.log(`[REMOVE_GROUP_MEMBER] Attempting to remove member: userId=${socket.userId}, data=${JSON.stringify(data)}`);
      try {
        const { groupId, memberId } = data;
        const userId = socket.userId;

        if (!userId) {
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(groupId) || !isValidObjectId(memberId)) {
          return callback({
            success: false,
            message: 'Invalid group or member ID',
          });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          return callback({ success: false, message: 'Group not found' });
        }

        // Check if user is a member
        const isMember = group.members.map((id) => id.toString()).includes(userId);
        if (!isMember) {
          return callback({
            success: false,
            message: 'You are not a member of this group',
          });
        }

        // Case 1: User is trying to leave themselves
        if (memberId === userId) {
          // Creator cannot leave
          if (memberId === group.createdBy.toString()) {
            return callback({
              success: false,
              message: 'Group creator cannot leave. Delete the group instead.',
            });
          }

          // Admin can leave only if not the last admin
          const isAdmin = group.admins?.map((id) => id.toString()).includes(userId);
          if (isAdmin) {
            const activeAdmins = group.admins.filter(
              (adminId) => adminId.toString() !== userId && group.members.map((m) => m.toString()).includes(adminId.toString()),
            );
            if (activeAdmins.length === 0) {
              return callback({
                success: false,
                message: 'You are the last admin. Promote another admin before leaving.',
              });
            }
          }
        }
        // Case 2: User is trying to remove someone else ? must be creator or admin
        else {
          const isCreator = group.createdBy.toString() === userId;
          const isAdmin = group.admins?.map((id) => id.toString()).includes(userId);
          if (!isCreator && !isAdmin) {
            return callback({
              success: false,
              message: 'Only admins or creator can remove members',
            });
          }

          // Cannot remove the creator
          if (memberId === group.createdBy.toString()) {
            return callback({
              success: false,
              message: 'Cannot remove group creator',
            });
          }

          // Admins cannot remove other admins (optional � you can allow this if needed)
          if (isAdmin && !isCreator) {
            const targetIsAdmin = group.admins?.map((id) => id.toString()).includes(memberId);
            if (targetIsAdmin) {
              return callback({
                success: false,
                message: 'Admins cannot remove other admins',
              });
            }
          }
        }

        // Perform removal
        group.members = group.members.filter((id) => id.toString() !== memberId);
        group.updatedAt = Date.now();
        await group.save();

        // Notify removed user
        const removedSocketId = onlineUsers.get(memberId);
        if (removedSocketId) {
          io.to(removedSocketId).emit('removed_from_group', { groupId });
          io.to(removedSocketId).emit('stop_group_music', { groupId });
          // FIX: Use getGroupRoom helper
          io.sockets.sockets.get(removedSocketId)?.leave(getGroupRoom(groupId));
        }

        // Notify remaining members
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(groupId);
        io.to(groupRoom).emit('group_member_removed', {
          groupId,
          removedMember: memberId,
        });

        callback({ success: true, group });
        console.log(`[REMOVE_GROUP_MEMBER_SUCCESS] Member removed: ${memberId} from group ${groupId}`);
      } catch (error) {
        console.error(`[REMOVE_GROUP_MEMBER_ERROR] ${error.message}`);
        callback({ success: false, message: 'Server error' });
      }
    });

    socket.on('send_text_message', async (data, callback) => {
      const timestamp = new Date().toISOString();
      console.log(
        `[SEND_TEXT_MESSAGE] Attempting to send message: socketId=${socket.id}, userId="${
          socket.userId
        }" (type: ${typeof socket.userId}), data=${JSON.stringify(data, null, 2)}, timestamp=${timestamp}`,
      );

      try {
        const { groupId, content, clientId } = data;
        const senderIdStr = socket.userId;

        // Step 1: Validate socket.userId
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 1: Validating socket.userId: "${senderIdStr}", timestamp=${timestamp}`);
        if (!senderIdStr) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] socket.userId is null or undefined: socketId=${socket.id}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Authentication failed: user ID is missing. Please join groups first.',
          });
        }
        if (typeof senderIdStr !== 'string') {
          console.error(
            `[SEND_TEXT_MESSAGE_ERROR] socket.userId is not a string: value="${senderIdStr}", type=${typeof senderIdStr}, socketId=${
              socket.id
            }, timestamp=${timestamp}`,
          );
          return callback({
            success: false,
            message: 'Authentication failed: invalid user ID format.',
          });
        }

        // Step 2: Check onlineUsers
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 2: Checking onlineUsers: has=${onlineUsers.has(senderIdStr)}, timestamp=${timestamp}`);
        if (!onlineUsers.has(senderIdStr)) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] User not in onlineUsers: senderId=${senderIdStr}, socketId=${socket.id}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'User not connected - please join groups first.',
          });
        }

        // Step 3: Validate and cast senderId
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 3: Validating ObjectId: isValid=${isValidObjectId(senderIdStr)}, timestamp=${timestamp}`);
        if (!isValidObjectId(senderIdStr)) {
          console.error(
            `[SEND_TEXT_MESSAGE_ERROR] senderId is not a valid ObjectId: "${senderIdStr}", socketId=${socket.id}, timestamp=${timestamp}`,
          );
          return callback({
            success: false,
            message: 'Invalid user ID format.',
          });
        }
        const senderId = new mongoose.Types.ObjectId(senderIdStr);
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Casted senderId: ${senderId.toString()}, timestamp=${timestamp}`);

        // Step 4: Check if User exists and get displayName
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 4: Querying User by _id: ${senderId.toString()}, timestamp=${timestamp}`);
        const user = await User.findById(senderId).select('displayName phone');
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] User query result: ${user ? 'Found' : 'Not Found'}, user=${JSON.stringify(
            user ? user.toObject() : null,
            null,
            2,
          )}, timestamp=${timestamp}`,
        );
        if (!user) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] User not found in database: senderId=${senderId}, socketId=${socket.id}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'User not found - please register or verify your account.',
          });
        }
        const senderDisplayName = user.displayName;
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Found existing user: senderId=${senderId}, phone=${user.phone}, displayName=${senderDisplayName}, timestamp=${timestamp}`,
        );

        // Step 5: Validate groupId
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Step 5: Validating groupId: "${groupId}", isValid=${isValidObjectId(groupId)}, timestamp=${timestamp}`,
        );
        if (!groupId || !isValidObjectId(groupId)) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] Invalid or missing groupId: "${groupId}", timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Invalid group ID.',
          });
        }
        const castGroupId = new mongoose.Types.ObjectId(groupId);
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Casted groupId: ${castGroupId.toString()}, timestamp=${timestamp}`);

        // Step 6: Validate content
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 6: Validating content: length=${content ? content.trim().length : 0}, timestamp=${timestamp}`);
        if (!content || content.trim() === '') {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] Empty content: "${content}", timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Message content cannot be empty.',
          });
        }

        // Step 7: Verify group and membership
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 7: Querying Group by _id: ${castGroupId.toString()}, timestamp=${timestamp}`);
        const group = await Group.findById(castGroupId);
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Group query result: ${group ? 'Found' : 'Not Found'}, group=${JSON.stringify(
            group ? group.toObject() : null,
            null,
            2,
          )}, timestamp=${timestamp}`,
        );
        if (!group) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] Group not found: groupId=${castGroupId}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Group not found.',
          });
        }

        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Checking membership: members=${group.members.map((id) => id.toString()).join(', ')}, timestamp=${timestamp}`,
        );
        const isMember = group.members.some((id) => id.equals(senderId));
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Is member: ${isMember}, timestamp=${timestamp}`);
        if (!isMember) {
          console.error(`[SEND_TEXT_MESSAGE_ERROR] Not authorized: senderId=${senderId}, groupId=${castGroupId}, timestamp=${timestamp}`);
          return callback({
            success: false,
            message: 'Not authorized to send message.',
          });
        }

        // Step 8: Create and save Chat document with displayName
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 8: Creating Chat document, timestamp=${timestamp}`);
        const chat = new Chat({
          senderId,
          senderDisplayName, // Store displayName directly
          groupId: castGroupId,
          type: 'text',
          content: content.trim(),
          status: 'sent',
          clientId,
          deletedFor: [],
        });

        await chat.save();
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Message saved: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}, rawChat=${JSON.stringify(
            chat.toObject(),
            null,
            2,
          )}, timestamp=${timestamp}`,
        );

        // Step 9: Emit message to group room
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 9: Emitting message to group room, timestamp=${timestamp}`);
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(castGroupId);

        // EXPLICIT PAYLOAD CONSTRUCTION (Crucial for Flutter - ensure senderId is NOT empty)
        const messagePayload = {
          _id: chat._id.toString(),
          id: chat._id.toString(),
          senderId: senderId.toString(), // ?? EXPLICIT STRING CONVERSION
          senderDisplayName: senderDisplayName,
          groupId: castGroupId.toString(),
          type: 'text',
          content: chat.content,
          status: 'sent',
          clientId,
          createdAt: chat.createdAt.toISOString(),
          deletedFor: [],
        };

        io.to(groupRoom).emit('new_text_message', { message: messagePayload });
        console.log(
          `[SEND_TEXT_MESSAGE_DEBUG] Emitted new_text_message to groupRoom=${groupRoom}, senderId=${messagePayload.senderId}, timestamp=${timestamp}`,
        );

        // Step 10: Update message status to delivered
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 10: Scheduling status update to delivered, timestamp=${timestamp}`);
        setTimeout(async () => {
          try {
            const updateTimestamp = new Date().toISOString();
            console.log(`[SEND_TEXT_MESSAGE_DEBUG] Updating status for messageId=${chat._id}, timestamp=${updateTimestamp}`);
            const updatedChat = await Chat.findByIdAndUpdate(chat._id, { status: 'delivered' }, { new: true });
            console.log(
              `[SEND_TEXT_MESSAGE_DEBUG] Status update query result: ${updatedChat ? 'Updated' : 'Not Found'}, updatedChat=${JSON.stringify(
                updatedChat ? updatedChat.toObject() : null,
                null,
                2,
              )}, timestamp=${updateTimestamp}`,
            );
            if (updatedChat) {
              io.to(groupRoom).emit('message_status_update', {
                messageId: chat._id,
                status: 'delivered',
              });
              console.log(`[SEND_TEXT_MESSAGE_DEBUG] Updated status to delivered: messageId=${chat._id}, timestamp=${updateTimestamp}`);
            } else {
              console.warn(`[SEND_TEXT_MESSAGE_WARN] Failed to update status for messageId=${chat._id}, timestamp=${updateTimestamp}`);
            }
          } catch (error) {
            console.error(
              `[SEND_TEXT_MESSAGE_ERROR] Failed to update status: messageId=${chat._id}, error=${error.message}, stack=${
                error.stack
              }, timestamp=${new Date().toISOString()}`,
            );
          }
        }, 100);

        // Step 11: Send success response
        console.log(`[SEND_TEXT_MESSAGE_DEBUG] Step 11: Sending success response, timestamp=${timestamp}`);
        callback({ success: true, message: messagePayload });
        console.log(
          `[SEND_TEXT_MESSAGE_SUCCESS] Message sent: messageId=${chat._id}, groupId=${castGroupId}, senderId=${senderId}, timestamp=${timestamp}`,
        );
      } catch (error) {
        console.error(
          `[SEND_TEXT_MESSAGE_ERROR] Failed: socketId=${socket.id}, userId="${socket.userId}", error=${error.message}, stack=${
            error.stack
          }, timestamp=${new Date().toISOString()}`,
        );
        callback({
          success: false,
          message: 'Server error saving message.',
          error: error.message,
        });
      }
    });

    socket.on('send_voice_message', async ({ senderId, groupId, content, duration, fileType, fileName, clientId }, callback) => {
      const timestamp = moment().tz('Asia/Karachi').format('DD/MM/YYYY, hh:mm:ss a');
      console.log(
        `[SEND_VOICE_MESSAGE] Attempting to send voice message: userId=${socket.userId}, data=${JSON.stringify(
          { senderId, groupId, content, duration, fileType, fileName, clientId },
          null,
          2,
        )}, timestamp=${timestamp}`,
      );
      try {
        // Step 1: Validate input data
        if (
          !senderId ||
          !groupId ||
          !content ||
          typeof content !== 'string' ||
          content.trim() === '' ||
          senderId !== socket.userId ||
          !isValidObjectId(senderId) ||
          !isValidObjectId(groupId) ||
          typeof duration !== 'number' ||
          duration <= 0 ||
          duration > 180 ||
          !fileType?.startsWith('audio/')
        ) {
          console.error(
            `? [SEND_VOICE_MESSAGE_ERROR] Invalid data: senderId=${senderId}, groupId=${groupId}, content=${content}, duration=${duration}, fileType=${fileType}, socketId=${socket.id}, timestamp=${timestamp}`,
          );
          socket.emit('voice_error', {
            error: 'Invalid voice data, duration (max 3 minutes), or fileType (must be audio/*)',
          });
          if (callback)
            callback({
              success: false,
              message: 'Invalid voice data, duration, or fileType',
            });
          return;
        }
        const castSenderId = new mongoose.Types.ObjectId(senderId);
        const castGroupId = new mongoose.Types.ObjectId(groupId);
        console.log(`[SEND_VOICE_MESSAGE] Casted IDs: senderId=${castSenderId}, groupId=${castGroupId}, timestamp=${timestamp}`);

        // Step 2: Verify group and membership
        const group = await Group.findById(castGroupId);
        if (!group) {
          console.error(`? [SEND_VOICE_MESSAGE_ERROR] Group not found: groupId=${castGroupId}, timestamp=${timestamp}`);
          socket.emit('voice_error', { error: 'Group not found' });
          if (callback) callback({ success: false, message: 'Group not found' });
          return;
        }
        const isMember = group.members.some((id) => id.equals(castSenderId));
        if (!isMember) {
          console.error(`? [SEND_VOICE_MESSAGE_ERROR] Not authorized: senderId=${castSenderId}, groupId=${castGroupId}, timestamp=${timestamp}`);
          socket.emit('voice_error', {
            error: 'Not authorized to send message',
          });
          if (callback)
            callback({
              success: false,
              message: 'Not authorized to send message',
            });
          return;
        }

        // Step 3: Verify sender user and get displayName
        console.log(`[SEND_VOICE_MESSAGE_DEBUG] Step 3: Querying User by _id: ${castSenderId.toString()}, timestamp=${timestamp}`);
        const user = await User.findById(castSenderId).select('displayName phone');
        console.log(
          `[SEND_VOICE_MESSAGE_DEBUG] User query result: ${user ? 'Found' : 'Not Found'}, user=${JSON.stringify(
            user ? user.toObject() : null,
            null,
            2,
          )}, timestamp=${timestamp}`,
        );
        if (!user) {
          console.error(`? [SEND_VOICE_MESSAGE_ERROR] User not found in database: senderId=${castSenderId}, timestamp=${timestamp}`);
          socket.emit('voice_error', {
            error: 'User not found - please verify your account.',
          });
          if (callback)
            callback({
              success: false,
              message: 'User not found - please verify your account.',
            });
          return;
        }
        const senderDisplayName = user.displayName;
        console.log(`[SEND_VOICE_MESSAGE_DEBUG] Found user: senderId=${castSenderId}, displayName=${senderDisplayName}, timestamp=${timestamp}`);

        const chat = new Chat({
          senderId: castSenderId,
          senderDisplayName,
          groupId: castGroupId,
          type: 'voice',
          content,
          fileType,
          fileName: fileName || undefined,
          duration,
          status: 'sent',
          clientId,
          deletedFor: [],
        });
        await chat.save();
        console.log(`[SEND_VOICE_MESSAGE] Voice message saved: messageId=${chat._id}, groupId=${castGroupId}, timestamp=${timestamp}`);

        const voiceData = {
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          senderDisplayName: chat.senderDisplayName,
          groupId: chat.groupId.toString(),
          content: chat.content,
          type: chat.type,
          fileType: chat.fileType,
          fileName: chat.fileName || '',
          duration: chat.duration || 0,
          clientId,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          displayName: chat.senderDisplayName, // Keep for backward compatibility
        };

        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(castGroupId);
        io.to(groupRoom).emit('receive_voice', voiceData);
        console.log(`[SEND_VOICE_MESSAGE] Emitted receive_voice to groupRoom=${groupRoom}, messageId=${chat._id}, timestamp=${timestamp}`);

        const onlineMembers = group.members.filter((memberId) => {
          const memberSocketId = onlineUsers.get(memberId.toString());
          return memberSocketId && memberId.toString() !== castSenderId.toString();
        });
        if (onlineMembers.length > 0) {
          const updatedChat = await Chat.findByIdAndUpdate(chat._id, { status: 'delivered' }, { new: true });
          if (updatedChat) {
            voiceData.status = 'delivered';
            io.to(groupRoom).emit('message_status_update', {
              messageId: chat._id.toString(),
              status: 'delivered',
            });
            console.log(
              `[SEND_VOICE_MESSAGE] Updated status to delivered: messageId=${chat._id}, onlineMembers=${onlineMembers.length}, timestamp=${timestamp}`,
            );
          }
        }

        // Step 8: Notify sender
        socket.emit('voice_sent', voiceData);
        console.log(`[SEND_VOICE_MESSAGE] Emitted voice_sent to senderId=${castSenderId}, messageId=${chat._id}, timestamp=${timestamp}`);

        // Step 9: Send success response
        if (callback)
          callback({
            success: true,
            id: chat._id.toString(),
            message: voiceData,
          });
        console.log(`[SEND_VOICE_MESSAGE_SUCCESS] Voice message sent: messageId=${chat._id}, groupId=${castGroupId}, timestamp=${timestamp}`);
      } catch (error) {
        console.error(
          `? [SEND_VOICE_MESSAGE_ERROR] Failed: userId=${socket.userId}, error=${error.message}, stack=${error.stack}, timestamp=${timestamp}`,
        );
        socket.emit('voice_error', { error: 'Failed to send voice message' });
        if (callback)
          callback({
            success: false,
            message: 'Server error',
            error: error.message,
          });
      }
    });

    /** Typing indicator */
    socket.on('typing', ({ groupId, typing }) => {
      console.log(`[TYPING] User typing status: userId=${socket.userId}, groupId=${groupId}, typing=${typing}`);

      const userId = socket.userId;
      if (!userId || !groupId || !isValidObjectId(groupId)) {
        console.error(`[TYPING_ERROR] Invalid input: userId=${userId}, groupId=${groupId}`);
        return;
      }

      // FIX: Use getGroupRoom helper
      const groupRoom = getGroupRoom(groupId);

      if (typing) {
        if (!typingUsers.has(groupId)) {
          typingUsers.set(groupId, new Set());
        }
        typingUsers.get(groupId).add(userId);
        console.log(`[TYPING] Added to typing users: userId=${userId}, groupId=${groupId}`);

        socket.to(groupRoom).emit('user_typing', { userId, groupId, typing: true });
        console.log(`[TYPING] Emitted typing=true to groupId=${groupId}`);
      } else {
        if (typingUsers.has(groupId)) {
          typingUsers.get(groupId).delete(userId);
          if (typingUsers.get(groupId).size === 0) {
            typingUsers.delete(groupId);
            console.log(`[TYPING] Removed empty typing set for groupId=${groupId}`);
          }
        }

        socket.to(groupRoom).emit('user_typing', { userId, groupId, typing: false });
        console.log(`[TYPING] Emitted typing=false to groupId=${groupId}`);
      }
    });

    /** Mark message as read */
    socket.on('mark_message_read', async (data, callback) => {
      console.log(`[MARK_MESSAGE_READ] Attempting to mark message read: userId=${socket.userId}, data=${JSON.stringify(data)}`);

      try {
        const { messageId } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(`[MARK_MESSAGE_READ_ERROR] Not authenticated: socketId=${socket.id}`);
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(messageId)) {
          console.error(`[MARK_MESSAGE_READ_ERROR] Invalid messageId: ${messageId}`);
          return callback({ success: false, message: 'Invalid message ID' });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          console.error(`[MARK_MESSAGE_READ_ERROR] Message not found: messageId=${messageId}`);
          return callback({ success: false, message: 'Message not found' });
        }

        message.status = 'read';
        await message.save();
        console.log(`[MARK_MESSAGE_READ] Message marked read: messageId=${messageId}`);

        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(message.groupId);
        io.to(groupRoom).emit('message_status_update', {
          messageId,
          status: 'read',
          readBy: userId,
        });
        console.log(`[MARK_MESSAGE_READ] Emitted status update to groupId=${message.groupId}`);

        const senderSocketId = onlineUsers.get(message.senderId.toString());
        if (senderSocketId) {
          io.to(senderSocketId).emit('message_read', {
            messageId,
            readBy: userId,
          });
          console.log(`[MARK_MESSAGE_READ] Notified sender: senderId=${message.senderId}, messageId=${messageId}`);
        }

        callback({ success: true, message });
        console.log(`[MARK_MESSAGE_READ_SUCCESS] Message marked read: messageId=${messageId}`);
      } catch (error) {
        console.error(`[MARK_MESSAGE_READ_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
        callback({
          success: false,
          message: 'Server error',
          error: error.message,
        });
      }
    });

    socket.on('get_group_messages', async (data, callback) => {
      console.log(`[GET_GROUP_MESSAGES] Fetching messages: userId=${socket.userId}, data=${JSON.stringify(data)}`);

      try {
        const { groupId, page = 1, limit = 50 } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(`[GET_GROUP_MESSAGES_ERROR] Not authenticated: socketId=${socket.id}`);
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(groupId)) {
          console.error(`[GET_GROUP_MESSAGES_ERROR] Invalid groupId: ${groupId}`);
          return callback({ success: false, message: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
          console.error(`[GET_GROUP_MESSAGES_ERROR] Group not found: groupId=${groupId}`);
          return callback({ success: false, message: 'Group not found' });
        }

        const isMember = group.members.some((id) => id.toString() === userId);
        if (!isMember) {
          console.error(`[GET_GROUP_MESSAGES_ERROR] Not authorized: userId=${userId}, groupId=${groupId}`);
          return callback({ success: false, message: 'Not authorized' });
        }

        const skip = (page - 1) * limit;
        // Fetch messages with populated senderId
        const messages = await Chat.find({ groupId }).populate('senderId', 'displayName phone').sort({ createdAt: -1 }).skip(skip).limit(limit);
        console.log(`[GET_GROUP_MESSAGES] Fetched ${messages.length} messages for groupId=${groupId}, page=${page}`);

        const unreadMessages = messages.filter((msg) => {
          if (!msg.senderId) {
            console.warn(`[GET_GROUP_MESSAGES] Skipping message with null senderId: ${msg._id}`);
            return false;
          }
          return msg.senderId.toString() !== userId && msg.status === 'sent';
        });
        if (unreadMessages.length > 0) {
          const unreadIds = unreadMessages.map((msg) => msg._id);
          await Chat.updateMany({ _id: { $in: unreadIds } }, { status: 'delivered' });
          console.log(`[GET_GROUP_MESSAGES] Marked ${unreadMessages.length} messages as delivered for groupId=${groupId}`);
        }

        // FIX: Better handling of populated vs non-populated senderId
        const messagesPayload = messages.reverse().map((msg) => {
          const msgObj = msg.toObject();

          // Handle SenderID Retrieval (populated or raw)
          let validSenderId = '';
          let validDisplayName = 'Unknown';

          if (msgObj.senderId && typeof msgObj.senderId === 'object') {
            // Populated User Object
            validSenderId = msgObj.senderId._id ? msgObj.senderId._id.toString() : '';
            validDisplayName = msgObj.senderId.displayName || 'Unknown';
          } else if (msgObj.senderId) {
            // Raw ID String or ObjectId
            validSenderId = msgObj.senderId.toString();
          }

          const finalDisplayName = msgObj.senderDisplayName || validDisplayName;

          return {
            ...msgObj,
            id: msgObj._id.toString(),
            senderId: validSenderId, // ?? ENSURE NOT EMPTY
            senderDisplayName: finalDisplayName,
            groupId: msgObj.groupId?.toString?.() || msgObj.groupId,
          };
        });

        callback({
          success: true,
          messages: messagesPayload,
          hasMore: messages.length === limit,
        });
        console.log(`[GET_GROUP_MESSAGES_SUCCESS] Messages fetched: groupId=${groupId}, page=${page}`);
      } catch (error) {
        console.error(`[GET_GROUP_MESSAGES_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
        callback({
          success: false,
          message: 'Server error',
          error: error.message,
        });
      }
    });

    /** Delete message */
    socket.on('delete_message', async (data, callback) => {
      console.log(`[DELETE_MESSAGE] Attempting to delete message: userId=${socket.userId}, data=${JSON.stringify(data)}`);

      try {
        const { messageId, forEveryone = false } = data;
        const userId = socket.userId;

        if (!userId) {
          console.error(`[DELETE_MESSAGE_ERROR] Not authenticated: socketId=${socket.id}`);
          return callback({ success: false, message: 'Not authenticated' });
        }
        if (!isValidObjectId(messageId)) {
          console.error(`[DELETE_MESSAGE_ERROR] Invalid messageId: ${messageId}`);
          return callback({ success: false, message: 'Invalid message ID' });
        }

        const message = await Chat.findById(messageId);
        if (!message) {
          console.error(`[DELETE_MESSAGE_ERROR] Message not found: messageId=${messageId}`);
          return callback({ success: false, message: 'Message not found' });
        }

        if (forEveryone && message.senderId.toString() !== userId) {
          console.error(`[DELETE_MESSAGE_ERROR] Not authorized to delete for everyone: userId=${userId}, senderId=${message.senderId}`);
          return callback({
            success: false,
            message: 'Not authorized to delete for everyone',
          });
        }

        if (forEveryone) {
          message.content = 'This message was deleted';
          message.deletedFor = [];
        } else {
          if (!message.deletedFor.includes(userId)) {
            message.deletedFor.push(userId);
          }
        }

        await message.save();
        console.log(`[DELETE_MESSAGE] Message deleted: messageId=${messageId}, forEveryone=${forEveryone}`);

        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(message.groupId);
        const formattedMessage = formatChatForEmission(message);
        io.to(groupRoom).emit('message_deleted', { message: formattedMessage });
        console.log(`[DELETE_MESSAGE] Emitted message_deleted to groupId=${message.groupId}, senderId=${formattedMessage.senderId}`);

        callback({ success: true, message });
        console.log(`[DELETE_MESSAGE_SUCCESS] Message deleted: messageId=${messageId}`);
      } catch (error) {
        console.error(`[DELETE_MESSAGE_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
        callback({
          success: false,
          message: 'Server error',
          error: error.message,
        });
      }
    });

    socket.on('join_group_room', async ({ groupId }) => {
      console.log(`[JOIN_GROUP_ROOM] Attempting to join room: userId=${socket.userId}, groupId=${groupId}`);

      if (!isValidObjectId(groupId)) {
        console.error(`[JOIN_GROUP_ROOM_ERROR] Invalid groupId: ${groupId}`);
        socket.emit('error', { message: 'Invalid group ID' });
        return;
      }

      try {
        const group = await Group.findById(groupId);
        if (!group) {
          console.error(`[JOIN_GROUP_ROOM_ERROR] Group not found: groupId=${groupId}`);
          socket.emit('error', { message: 'Group not found' });
          return;
        }

        // FIX: Use getGroupRoom helper
        const roomName = getGroupRoom(groupId);
        socket.join(roomName);
        console.log(`[JOIN_GROUP_ROOM] Joined room: groupId=${groupId}, socketId=${socket.id}`);

        if (group.musicUrl) {
          socket.emit('play_group_music', {
            groupId,
            musicUrl: group.musicUrl,
          });
          console.log(`[JOIN_GROUP_ROOM] Emitted play_group_music: groupId=${groupId}, musicUrl=${group.musicUrl}`);
        }
        socket.emit('group_room_joined', { groupId });
        console.log(`[JOIN_GROUP_ROOM_SUCCESS] Room joined: groupId=${groupId}`);
      } catch (error) {
        console.error(`[JOIN_GROUP_ROOM_ERROR] Failed: userId=${socket.userId}, error=${error.message}`);
        socket.emit('error', { message: 'Server error', error: error.message });
      }
    });

    socket.on('uploading_media', async ({ senderId, groupId, uploading }) => {
      console.log(`[UPLOADING_MEDIA] Group upload indicator: userId=${socket.userId}, groupId=${groupId}, uploading=${uploading}`);
      try {
        if (!groupId || !isValidObjectId(groupId)) {
          console.error(`[UPLOADING_MEDIA_ERROR] Invalid groupId: ${groupId}`);
          return;
        }
        const group = await Group.findById(groupId);
        if (!group) return;

        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(groupId);
        socket.to(groupRoom).emit('uploading_media', { senderId, groupId, uploading });
        console.log(`[UPLOADING_MEDIA] Emitted to group room: ${groupRoom}`);
      } catch (err) {
        console.error('[UPLOADING_MEDIA_ERROR]', err.message);
      }
    });

    socket.on('send_media', async (payload, callback) => {
      const timestamp = new Date().toLocaleString('en-PK', {
        timeZone: 'Asia/Karachi',
      });
      console.log(
        `[SEND_MEDIA] Exact payload received: ${JSON.stringify(payload, null, 2)}, ` +
          `socket.userId="${socket.userId}" (type: ${typeof socket.userId}), ` +
          `timestamp=${timestamp}`,
      );

      const { groupId, files } = payload;
      const ack = callback || ((err) => socket.emit('media_error', { error: err }));

      try {
        // Step 1: Validate senderId
        const senderIdStr = socket.userId;
        if (!senderIdStr || typeof senderIdStr !== 'string' || !isValidObjectId(senderIdStr)) {
          console.error(
            `[SEND_MEDIA_ERROR] Invalid senderId: "${senderIdStr}" (type: ${typeof senderIdStr}), ` + `socketId=${socket.id}, timestamp=${timestamp}`,
          );
          return ack('Invalid sender � please join groups first');
        }
        const senderId = new mongoose.Types.ObjectId(senderIdStr);
        console.log(`[SEND_MEDIA] Casted senderId: ${senderId.toString()}, timestamp=${timestamp}`);

        // Step 2: Validate groupId
        if (!groupId) {
          console.error(`[SEND_MEDIA_ERROR] MISSING groupId in payload! Full payload: ${JSON.stringify(payload)}, ` + `timestamp=${timestamp}`);
          return ack("No group ID provided � select a group and include { groupId: '...' } in emit");
        }
        if (!isValidObjectId(groupId)) {
          console.error(`[SEND_MEDIA_ERROR] Invalid groupId: "${groupId}", timestamp=${timestamp}`);
          return ack('Invalid group ID format');
        }
        const castGroupId = new mongoose.Types.ObjectId(groupId);
        console.log(`[SEND_MEDIA] Casted groupId: ${castGroupId.toString()}, timestamp=${timestamp}`);

        // Step 3: Validate files
        if (!files || !Array.isArray(files) || files.length === 0 || files.length > 10) {
          console.error(`[SEND_MEDIA_ERROR] Invalid files array: length=${files?.length || 0}, ` + `timestamp=${timestamp}`);
          return ack('Files must be a non-empty array (1-10 items)');
        }
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const { type, url, fileType, duration = 0, fileName, clientId } = file;
          if (!['image', 'video', 'file'].includes(type)) {
            console.error(`[SEND_MEDIA_ERROR] Invalid type at index ${i}: ${type}, timestamp=${timestamp}`);
            return ack(`Invalid file type at index ${i}: ${type}`);
          }
          if (!url || typeof url !== 'string' || !url.trim()) {
            console.error(`[SEND_MEDIA_ERROR] Invalid URL at index ${i}: ${url}, timestamp=${timestamp}`);
            return ack(`Invalid URL at index ${i}`);
          }
          if (!fileType || typeof fileType !== 'string') {
            console.error(`[SEND_MEDIA_ERROR] Invalid MIME type at index ${i}: ${fileType}, timestamp=${timestamp}`);
            return ack(`Invalid MIME type at index ${i}: ${fileType}`);
          }
          if (type === 'image' && !fileType.startsWith('image/')) {
            console.error(`[SEND_MEDIA_ERROR] Bad image MIME at index ${i}: ${fileType}, timestamp=${timestamp}`);
            return ack(`Invalid MIME type for image: ${fileType}`);
          }
          if (type === 'video' && !fileType.startsWith('video/') && fileType !== 'application/octet-stream') {
            console.error(`[SEND_MEDIA_ERROR] Bad video MIME at index ${i}: ${fileType}, timestamp=${timestamp}`);
            return ack(`Invalid MIME type for video: ${fileType}`);
          }
          if (type === 'video' && (typeof duration !== 'number' || duration < 1 || duration > 300)) {
            console.warn(`[SEND_MEDIA_WARN] Invalid video duration at index ${i}: ${duration}, proceeding without duration, timestamp=${timestamp}`);
            file.duration = 0; // Reset to 0 for invalid duration
          }
          if (type === 'file' && (!fileName || typeof fileName !== 'string')) {
            console.error(`[SEND_MEDIA_ERROR] Missing fileName for file at index ${i}, timestamp=${timestamp}`);
            return ack('Documents must have a file name');
          }
          console.log(`[SEND_MEDIA] File ${i} valid: type=${type}, url=${url.substring(0, 50)}..., timestamp=${timestamp}`);
        }

        // Step 4: Verify group and membership
        const group = await Group.findById(castGroupId);
        if (!group) {
          console.error(`[SEND_MEDIA_ERROR] Group not found: groupId=${castGroupId}, timestamp=${timestamp}`);
          return ack('Group not found');
        }
        const isMember = group.members.some((id) => id.equals(senderId));
        if (!isMember) {
          console.error(`[SEND_MEDIA_ERROR] Sender not a member: senderId=${senderId}, groupId=${castGroupId}, timestamp=${timestamp}`);
          return ack('Not a group member');
        }

        // Step 5: Verify sender user and get displayName
        console.log(`[SEND_MEDIA_DEBUG] Step 5: Querying User by _id: ${senderId.toString()}, timestamp=${timestamp}`);
        const user = await User.findById(senderId).select('displayName phone');
        console.log(
          `[SEND_MEDIA_DEBUG] User query result: ${user ? 'Found' : 'Not Found'}, user=${JSON.stringify(
            user ? user.toObject() : null,
            null,
            2,
          )}, timestamp=${timestamp}`,
        );
        if (!user) {
          console.error(`[SEND_MEDIA_ERROR] User not found in database: senderId=${senderId}, timestamp=${timestamp}`);
          return ack('User not found - please verify your account.');
        }
        const senderDisplayName = user.displayName;
        console.log(`[SEND_MEDIA_DEBUG] Found user: senderId=${senderId}, displayName=${senderDisplayName}, timestamp=${timestamp}`);

        // Step 6: Create and save chat documents
        const chats = [];
        for (const file of files) {
          const { type, url, fileType, duration = 0, fileName, clientId } = file;
          const chat = new Chat({
            senderId,
            senderDisplayName, // Store displayName directly (like send_text_message)
            groupId: castGroupId,
            type,
            content: url,
            fileType,
            fileName: type === 'file' ? fileName : undefined,
            duration: type === 'video' ? duration : 0,
            status: 'sent',
            clientId,
            deletedFor: [],
          });
          await chat.save();
          chats.push(chat);
          console.log(`[SEND_MEDIA] Saved chat: id=${chat._id}, type=${type}, timestamp=${timestamp}`);
        }

        // Step 7: Prepare response payload
        const responsePayload = chats.map((chat) => ({
          id: chat._id.toString(),
          senderId: chat.senderId.toString(),
          senderDisplayName: chat.senderDisplayName, // Include in payload
          groupId: chat.groupId.toString(),
          content: chat.content,
          type: chat.type,
          fileType: chat.fileType,
          fileName: chat.fileName,
          duration: chat.duration,
          clientId: chat.clientId,
          timestamp: chat.createdAt.toISOString(),
          status: chat.status,
          displayName: chat.senderDisplayName, // Keep for backward compatibility
        }));

        // Step 8: Emit to group room
        // FIX: Use getGroupRoom helper
        const groupRoom = getGroupRoom(castGroupId);
        io.to(groupRoom).emit('new_media_message', responsePayload);
        console.log(`[SEND_MEDIA] Emitted new_media_message to groupRoom=${groupRoom}, timestamp=${timestamp}`);

        // Step 9: Update status to delivered
        setTimeout(async () => {
          try {
            await Chat.updateMany({ _id: { $in: chats.map((c) => c._id) } }, { status: 'delivered' });
            io.to(groupRoom).emit('message_status_update', {
              messageIds: chats.map((c) => c._id.toString()),
              status: 'delivered',
            });
            console.log(`[SEND_MEDIA] Marked ${chats.length} messages as delivered: groupId=${castGroupId}, timestamp=${timestamp}`);
          } catch (error) {
            console.error(`[SEND_MEDIA_ERROR] Failed to update status: error=${error.message}, timestamp=${timestamp}`);
          }
        }, 100);

        // Step 10: Send success response
        ack(null, { success: true, messages: responsePayload });
        console.log(`[SEND_MEDIA_SUCCESS] Sent ${chats.length} files to groupId=${castGroupId}, timestamp=${timestamp}`);
      } catch (error) {
        console.error(`[SEND_MEDIA_ERROR] Full error: ${error.message}, stack=${error.stack}, timestamp=${timestamp}`);
        ack(`Server error: ${error.message}`);
      }
    });

    /** Leave group room */
    socket.on('leave_group_room', ({ groupId }) => {
      console.log(`[LEAVE_GROUP_ROOM] Attempting to leave room: userId=${socket.userId}, groupId=${groupId}`);

      if (!isValidObjectId(groupId)) {
        console.error(`[LEAVE_GROUP_ROOM_ERROR] Invalid groupId: ${groupId}`);
        return;
      }

      // FIX: Use getGroupRoom helper
      const roomName = getGroupRoom(groupId);
      socket.leave(roomName);
      socket.emit('stop_group_music', { groupId });
      socket.emit('group_room_left', { groupId });
      console.log(`[LEAVE_GROUP_ROOM_SUCCESS] Left room: groupId=${groupId}, socketId=${socket.id}`);
    });

    /** Get typing users in group */
    socket.on('get_typing_users', ({ groupId }) => {
      console.log(`[GET_TYPING_USERS] Fetching typing users: groupId=${groupId}`);

      if (!isValidObjectId(groupId)) {
        console.error(`[GET_TYPING_USERS_ERROR] Invalid groupId: ${groupId}`);
        return;
      }

      const typingSet = typingUsers.get(groupId) || new Set();
      const typingArray = Array.from(typingSet);
      socket.emit('typing_users', { groupId, users: typingArray });
      console.log(`[GET_TYPING_USERS_SUCCESS] Sent typing users: groupId=${groupId}, users=${typingArray}`);
    });

    /** Disconnect handling */
    socket.on('disconnect', async () => {
      const disconnectedUserId = socket.userId;
      if (!disconnectedUserId) {
        console.log(`[DISCONNECT] Unknown user disconnected: socketId=${socket.id}`);
        return;
      }

      console.log(`[DISCONNECT] User disconnected: userId=${disconnectedUserId}, socketId=${socket.id}`);

      onlineUsers.delete(disconnectedUserId);

      try {
        const user = await User.findByIdAndUpdate(disconnectedUserId, { online: false, lastSeen: new Date() }, { new: true });
        console.log(`[DISCONNECT] User updated: userId=${disconnectedUserId}, online=false`);

        typingUsers.forEach((userSet, groupId) => {
          if (userSet.has(disconnectedUserId)) {
            userSet.delete(disconnectedUserId);
            // FIX: Use getGroupRoom helper
            const groupRoom = getGroupRoom(groupId);
            socket.to(groupRoom).emit('user_typing', {
              userId: disconnectedUserId,
              groupId,
              typing: false,
            });
            console.log(`[DISCONNECT] Cleared typing status: userId=${disconnectedUserId}, groupId=${groupId}`);
          }
        });

        console.log(`[DISCONNECT_SUCCESS] User disconnected from group socket: userId=${disconnectedUserId}`);
      } catch (error) {
        console.error(`[DISCONNECT_ERROR] Failed: userId=${disconnectedUserId}, error=${error.message}`);
      }
    });
  });

  return io;
};
