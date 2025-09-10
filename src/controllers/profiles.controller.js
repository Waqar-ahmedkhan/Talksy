import jwt from "jsonwebtoken";
   import Profile from "../models/Profile.js";
   import Chat from "../models/Chat.js";
   import User from "../models/User.js"; // Import User model for online status

   /**
    * Middleware to verify JWT token
    */
   export const authenticateToken = (req, res, next) => {
     try {
       const authHeader = req.headers["authorization"];
       const token = authHeader?.split(" ")[1];

       if (!token) {
         return res.status(401).json({ error: "Access token is required" });
       }

       const decoded = jwt.verify(token, process.env.JWT_SECRET);
       req.user = decoded; // { phone, iat, exp }
       next();
     } catch (err) {
       console.error("JWT verification failed:", err.message);
       return res.status(403).json({ error: "Invalid or expired token" });
     }
   };

   /**
    * Helper: Format profile for response
    */
   const formatProfile = (profile, user) => ({
     id: profile?._id || null,
     phone: profile?.phone || null,
     displayName: profile?.displayName || "Unknown",
     randomNumber: profile?.randomNumber || "",
     isVisible: profile?.isVisible ?? false,
     isNumberVisible: profile?.isNumberVisible ?? false,
     avatarUrl: profile?.avatarUrl || "",
     createdAt: profile?.createdAt || null,
     online: user?.online ?? false,
     lastSeen: user?.lastSeen || null,
   });

   /**
    * Generate 11-digit random number
    */
   const generateRandom11DigitNumber = () => {
     return Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("");
   };

   /**
    * Create or Update Profile
    */
   export const createProfile = async (req, res) => {
     try {
       console.log("Request headers:", req.headers); // Debug
       console.log("Request body:", req.body); // Debug
       if (!req.body || typeof req.body !== "object") {
         return res.status(400).json({ error: "Request body is missing or invalid JSON" });
       }

       const { displayName, isVisible = false, isNumberVisible = false, avatarUrl = "" } = req.body;
       const phone = req.user?.phone;

       if (!phone) return res.status(401).json({ error: "Phone number not found in token" });
       if (!displayName?.trim()) return res.status(400).json({ error: "Display name is required" });

       let profile = await Profile.findOne({ phone });

       if (profile) {
         profile.displayName = displayName.trim();
         profile.isVisible = isVisible;
         profile.isNumberVisible = isNumberVisible;
         profile.avatarUrl = avatarUrl.trim();
       } else {
         profile = new Profile({
           phone,
           displayName: displayName.trim(),
           randomNumber: generateRandom11DigitNumber(),
           isVisible,
           isNumberVisible,
           avatarUrl: avatarUrl.trim(),
         });
       }

       await profile.save();

       // Create or update corresponding User entry
       let user = await User.findOne({ phone });
       if (!user) {
         user = new User({
           phone,
           displayName: displayName.trim(),
           online: false,
           lastSeen: new Date(),
         });
         await user.save();
       }

       return res.status(201).json({
         success: true,
         message: "Profile saved successfully",
         profile: formatProfile(profile, user),
       });
     } catch (err) {
       console.error("createProfile error:", err);
       return res.status(500).json({ error: "Server error", details: err.message });
     }
   };

   /**
    * Get My Profile
    */
   export const getMyProfile = async (req, res) => {
     try {
       const profile = await Profile.findOne({ phone: req.user.phone });
       if (!profile) return res.status(404).json({ error: "Profile not found" });

       const user = await User.findOne({ phone: req.user.phone });

       return res.json({ success: true, profile: formatProfile(profile, user) });
     } catch (err) {
       console.error("getMyProfile error:", err);
       res.status(500).json({ error: "Server error" });
     }
   };

   /**
    * Get Public Profiles (paginated)
    */
   export const getPublicProfiles = async (req, res) => {
     try {
       const page = parseInt(req.query.page) || 1;
       const limit = parseInt(req.query.limit) || 20;
       const skip = (page - 1) * limit;

       const publicProfiles = await Profile.find({ isVisible: true })
         .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone")
         .skip(skip)
         .limit(limit)
         .sort({ createdAt: -1 });

       const phoneNumbers = publicProfiles.map((p) => p.phone);
       const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
       const userMap = new Map(users.map((u) => [u.phone, u]));

       return res.json({
         success: true,
         page,
         limit,
         profiles: publicProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
       });
     } catch (err) {
       console.error("getPublicProfiles error:", err);
       res.status(500).json({ error: "Server error" });
     }
   };

   /**
    * Get Profiles from Contacts
    */
   export const getProfilesFromContacts = async (req, res) => {
     try {
       const { contacts } = req.body;
       if (!Array.isArray(contacts) || contacts.length === 0) {
         return res.status(400).json({ error: "Contacts array is required" });
       }

       const matchedProfiles = await Profile.find({ phone: { $in: contacts } })
         .select("displayName randomNumber isVisible isNumberVisible avatarUrl createdAt phone");

       const phoneNumbers = matchedProfiles.map((p) => p.phone);
       const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
       const userMap = new Map(users.map((u) => [u.phone, u]));

       return res.json({
         success: true,
         profiles: matchedProfiles.map((profile) => formatProfile(profile, userMap.get(profile.phone))),
       });
     } catch (err) {
       console.error("getProfilesFromContacts error:", err);
       res.status(500).json({ error: "Server error" });
     }
   };

   /**
    * Format chat for response
    */
   const formatChat = (chat) => ({
     id: chat?._id || null,
     senderId: chat?.senderId?._id || null,
     receiverId: chat?.receiverId?._id || null,
     type: chat?.type || "text",
     content: chat?.content?.substring(0, 50) + (chat?.content?.length > 50 ? "..." : "") || "", // Truncate to 50 chars
     duration: chat?.duration || null,
     status: chat?.status || "sent",
     createdAt: chat?.createdAt || null,
     pinned: chat?.pinned || false, // Include pinned status
   });

   /**
    * Get profile + chat history with target user
    */
   export const getProfileWithChat = async (req, res) => {
     try {
       const myPhone = req.user.phone;
       const targetPhone = req.params.phone;

       if (!targetPhone) {
         return res.status(400).json({ error: "Target phone number is required" });
       }

       // Find my profile to get my _id
       const myProfile = await Profile.findOne({ phone: myPhone });
       if (!myProfile) {
         return res.status(404).json({ error: "Your profile not found" });
       }

       // Find target profile to get their _id
       const targetProfile = await Profile.findOne({ phone: targetPhone });
       if (!targetProfile) {
         return res.status(404).json({ error: "Target profile not found" });
       }

       // Find target user for online status
       const targetUser = await User.findOne({ phone: targetPhone });

       // Find chat history using _id (both directions)
       const chats = await Chat.find({
         $or: [
           { senderId: myProfile._id, receiverId: targetProfile._id },
           { senderId: targetProfile._id, receiverId: myProfile._id },
         ],
       })
         .sort({ createdAt: -1 }) // Newest first
         .limit(50); // Last 50 messages for performance

       return res.json({
         success: true,
         profile: formatProfile(targetProfile, targetUser),
         chatHistory: chats.map(formatChat),
       });
     } catch (err) {
       console.error("getProfileWithChat error:", err);
       res.status(500).json({ error: "Server error", details: err.message });
     }
   };

   /**
    * Get Chat List with Profiles and Latest Messages
    */
   export const getChatList = async (req, res) => {
     try {
       const myPhone = req.user.phone;
       const page = parseInt(req.query.page) || 1;
       const limit = parseInt(req.query.limit) || 20;

       // Validate pagination parameters
       if (page < 1 || limit < 1 || limit > 100) {
         return res.status(400).json({
           success: false,
           error: "Invalid pagination parameters: page must be >= 1, limit must be 1-100",
         });
       }
       const skip = (page - 1) * limit;

       // Find my profile
       const myProfile = await Profile.findOne({ phone: myPhone });
       if (!myProfile) {
         return res.status(404).json({ success: false, error: "Your profile not found" });
       }

       // Find all 1-to-1 chats where I'm involved, excluding deleted messages
       const chats = await Chat.find({
         $and: [
           { $or: [{ senderId: myProfile._id }, { receiverId: myProfile._id }] },
           { receiverId: { $ne: null } }, // Ensure 1-to-1 chats only
           { deletedFor: { $ne: myProfile._id } }, // Exclude messages deleted for me
         ],
       })
         .sort({ pinned: -1, createdAt: -1 }) // Sort by pinned first, then createdAt
         .populate("senderId receiverId", "phone displayName avatarUrl isVisible isNumberVisible randomNumber createdAt");

       // If no chats exist, return empty list
       if (!chats || chats.length === 0) {
         return res.json({
           success: true,
           page,
           limit,
           total: 0,
           chats: [],
         });
       }

       // Get user data for online status
       const phoneNumbers = [
         ...new Set([
           ...chats.map((chat) => chat.senderId?.phone).filter(Boolean),
           ...chats.map((chat) => chat.receiverId?.phone).filter(Boolean),
         ]),
       ];
       const users = await User.find({ phone: { $in: phoneNumbers } }).select("phone online lastSeen");
       const userMap = new Map(users.map((u) => [u.phone, u]));

       // Group chats by the other participant's _id
       const chatMap = new Map();
       for (const chat of chats) {
         // Skip if senderId or receiverId is missing
         if (!chat.senderId || !chat.receiverId) {
           console.warn(`Chat ${chat._id} missing senderId or receiverId`);
           continue;
         }

         const otherProfileId =
           chat.senderId._id.toString() === myProfile._id.toString()
             ? chat.receiverId._id.toString()
             : chat.senderId._id.toString();

         if (!chatMap.has(otherProfileId)) {
           const otherProfile =
             chat.senderId._id.toString() === myProfile._id.toString() ? chat.receiverId : chat.senderId;
           chatMap.set(otherProfileId, {
             profile: otherProfile,
             latestMessage: chat,
             unreadCount:
               chat.receiverId._id.toString() === myProfile._id.toString() &&
               ["sent", "delivered"].includes(chat.status)
                 ? 1
                 : 0,
             pinned: chat.pinned,
           });
         } else {
           const existing = chatMap.get(otherProfileId);
           // Update latest message and pinned status if this chat is newer
           if (new Date(chat.createdAt) > new Date(existing.latestMessage.createdAt)) {
             existing.latestMessage = chat;
             existing.pinned = chat.pinned;
           }
           // Increment unread count if message is sent/delivered to me
           if (
             chat.receiverId._id.toString() === myProfile._id.toString() &&
             ["sent", "delivered"].includes(chat.status)
           ) {
             existing.unreadCount += 1;
           }
         }
       }

       // Convert map to array and sort: pinned chats first, then by latest message timestamp
       const chatList = Array.from(chatMap.values())
         .sort((a, b) => {
           if (a.pinned && !b.pinned) return -1;
           if (!a.pinned && b.pinned) return 1;
           return new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt);
         })
         .slice(skip, skip + limit);

       // Format response
       const formattedChatList = chatList.map((item) => ({
         profile: formatProfile(item.profile, userMap.get(item.profile?.phone)),
         latestMessage: formatChat(item.latestMessage),
         unreadCount: item.unreadCount,
         pinned: item.pinned,
       }));

       return res.json({
         success: true,
         page,
         limit,
         total: chatMap.size,
         chats: formattedChatList,
       });
     } catch (err) {
       console.error("getChatList error:", err);
       return res.status(500).json({
         success: false,
         error: "Server error",
         details: err.message,
       });
     }
   };