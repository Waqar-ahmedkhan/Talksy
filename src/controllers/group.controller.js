import { isValidObjectId } from "mongoose";
import validator from "validator";
import Group from "../models/Group.js";
import Chat from "../models/Chat.js";
import User from "../models/User.js";
import Profile from "../models/Profile.js";
import Contact from "../models/Contact.js";
import moment from "moment-timezone";
import Block from "../models/Block.js";
const logTimestamp = () =>
  moment().tz("Asia/Karachi").format("DD/MM/YYYY, hh:mm:ss a");

const formatProfile = (profile, user, customName = null, isBlocked = false) => {
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
    avatarUrl: profile?.avatarUrl || "",
    fcmToken: profile?.fcmToken || user?.fcmToken || "",
    createdAt: profile?.createdAt?.toISOString() || null,
    online: user?.online ?? false,
    lastSeen: user?.lastSeen?.toISOString() || null,
    customName: customName || null,
    isBlocked,
  };
  console.log(
    `[formatProfile] Formatted profile: phone=${phone}, displayName=${displayName}, customName=${customName}, isBlocked=${isBlocked}, timestamp=${timestamp}`
  );
  return formatted;
};

// Format chat message for response
const formatChat = (chat, userId) => {
  const timestamp = logTimestamp();
  const isUrl =
    chat.content &&
    validator.isURL(chat.content, {
      protocols: ["http", "https"],
      require_protocol: true,
    });
  const content = isUrl ? chat.content : validator.escape(chat.content || "");
  const displayContent =
    content.length > 50 ? content.substring(0, 47) + "..." : content;
  const formatted = {
    id: chat._id.toString(),
    senderId: chat.senderId?.toString() || null,
    senderDisplayName: chat.senderDisplayName || "Unknown",
    groupId: chat.groupId?.toString() || null,
    type: chat.type || "text",
    content,
    displayContent,
    duration: chat.duration || 0,
    fileName: chat.fileName || null,
    fileType: chat.fileType || null,
    status: chat.status || "sent",
    createdAt: chat.createdAt?.toISOString() || null,
    pinned: chat.pinned || false,
  };
  console.log(
    `[formatChat] Formatted chat: id=${chat._id}, groupId=${chat.groupId}, isUrl=${isUrl}, timestamp=${timestamp}`
  );
  return formatted;
};

// GET /api/groups/chats
export const getGroupChatList = async (req, res) => {
  const timestamp = logTimestamp();
  const userId = req.user?._id?.toString();
  console.log(
    `[getGroupChatList] Starting: userId=${userId}, query=${JSON.stringify(
      req.query
    )}, timestamp=${timestamp}`
  );

  try {
    // Validate authentication
    if (!userId || !isValidObjectId(userId)) {
      console.error(
        `[getGroupChatList_ERROR] Invalid userId: ${userId}, timestamp=${timestamp}`
      );
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    }

    // Validate pagination parameters
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 20;
    if (page < 1) {
      console.error(
        `[getGroupChatList_ERROR] Invalid page: ${page}, timestamp=${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, message: "Page must be >= 1" });
    }
    if (limit < 1 || limit > 100) {
      console.error(
        `[getGroupChatList_ERROR] Invalid limit: ${limit}, timestamp=${timestamp}`
      );
      return res
        .status(400)
        .json({ success: false, message: "Limit must be between 1 and 100" });
    }

    // Fetch groups where user is a member
    const skip = (page - 1) * limit;
    const groups = await Group.find({ members: userId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const totalGroups = await Group.countDocuments({ members: userId });
    console.log(
      `[getGroupChatList] Found ${groups.length} groups for userId=${userId}, total=${totalGroups}, page=${page}, limit=${limit}, timestamp=${timestamp}`
    );

    if (groups.length === 0) {
      console.log(
        `[getGroupChatList] No groups found for userId=${userId}, timestamp=${timestamp}`
      );
      return res.status(200).json({
        success: true,
        page,
        limit,
        total: 0,
        chats: [],
      });
    }

    // Fetch blocked users to exclude blocked members
    const blockedUsers = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }],
    }).select("blockerId blockedId");
    const blockedIds = new Set(
      blockedUsers.map((block) =>
        block.blockerId.toString() === userId
          ? block.blockedId.toString()
          : block.blockerId.toString()
      )
    );
    console.log(
      `[getGroupChatList] Blocked users: ${Array.from(blockedIds).join(
        ", "
      )}, timestamp=${timestamp}`
    );

    // Fetch latest message and unread count for each group
    const groupIds = groups.map((group) => group._id);
    const latestMessages = await Chat.aggregate([
      { $match: { groupId: { $in: groupIds }, deletedFor: { $ne: userId } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$groupId",
          latestMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$senderId", userId] },
                    { $in: ["$status", ["sent", "delivered"]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    console.log(
      `[getGroupChatList] Fetched latest messages for ${latestMessages.length} groups, timestamp=${timestamp}`
    );

    // Fetch user and profile data for group members
    const allMemberIds = [
      ...new Set(
        groups.flatMap((group) => group.members.map((id) => id.toString()))
      ),
    ];
    const [profiles, users, contacts] = await Promise.all([
      Profile.find({ _id: { $in: allMemberIds } })
        .select(
          "phone displayName randomNumber isVisible isNumberVisible avatarUrl fcmToken createdAt"
        )
        .lean(),
      User.find({ _id: { $in: allMemberIds } })
        .select("phone online lastSeen fcmToken")
        .lean(),
      Contact.find({ userId, contactId: { $in: allMemberIds } })
        .select("contactId customName")
        .lean(),
    ]);
    const profileMap = new Map(profiles.map((p) => [p._id.toString(), p]));
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    const contactMap = new Map(
      contacts.map((c) => [c.contactId.toString(), c.customName])
    );
    console.log(
      `[getGroupChatList] Fetched ${profiles.length} profiles, ${users.length} users, ${contacts.length} contacts, timestamp=${timestamp}`
    );

    // Format response
    const chats = await Promise.all(
      groups.map(async (group) => {
        const groupIdStr = group._id.toString();
        const latestMessageData = latestMessages.find(
          (m) => m._id.toString() === groupIdStr
        );
        let latestMessage = null;
        if (latestMessageData?.latestMessage) {
          // Populate senderId for latest message
          const sender = await User.findById(
            latestMessageData.latestMessage.senderId
          )
            .select("displayName")
            .lean();
          latestMessageData.latestMessage.senderDisplayName =
            sender?.displayName || "Unknown";
          latestMessage = formatChat(latestMessageData.latestMessage, userId);
        }

        // Format group members
        const formattedMembers = group.members
          .filter((memberId) => !blockedIds.has(memberId.toString()))
          .map((memberId) => {
            const profile = profileMap.get(memberId.toString());
            const user = userMap.get(memberId.toString());
            const customName = contactMap.get(memberId.toString());
            const isBlocked = blockedIds.has(memberId.toString());
            return formatProfile(profile, user, customName, isBlocked);
          });

        return {
          group: {
            id: groupIdStr,
            name: group.name,
            channelId: group.channelId?.toString() || null,
            createdBy: formatProfile(
              profileMap.get(group.createdBy.toString()),
              userMap.get(group.createdBy.toString()),
              contactMap.get(group.createdBy.toString()),
              blockedIds.has(group.createdBy.toString())
            ),
            members: formattedMembers,
            admins: group.admins
              .filter((adminId) => !blockedIds.has(adminId.toString()))
              .map((adminId) =>
                formatProfile(
                  profileMap.get(adminId.toString()),
                  userMap.get(adminId.toString()),
                  contactMap.get(adminId.toString()),
                  blockedIds.has(adminId.toString())
                )
              ),
            musicUrl: group.musicUrl || null,
            pictureUrl: group.pictureUrl || null,
            createdAt: group.createdAt?.toISOString() || null,
            updatedAt: group.updatedAt?.toISOString() || null,
          },
          latestMessage,
          unreadCount: latestMessageData?.unreadCount || 0,
        };
      })
    );

    console.log(
      `[getGroupChatList_SUCCESS] Response ready: total=${totalGroups}, chats=${chats.length}, page=${page}, limit=${limit}, timestamp=${timestamp}`
    );
    return res.status(200).json({
      success: true,
      page,
      limit,
      total: totalGroups,
      chats,
    });
  } catch (error) {
    console.error(
      `[getGroupChatList_ERROR] Failed: userId=${userId}, error=${error.message}, stack=${error.stack}, timestamp=${timestamp}`
    );
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};
