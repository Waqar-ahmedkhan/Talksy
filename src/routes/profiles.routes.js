// routes/profileRoutes.js
import express from "express";
   import {
     authenticateToken,
     createProfile,
     getMyProfile,
     getPublicProfiles,
     getProfilesFromContacts,
     getProfileWithChat,
     getChatList, // Added
   } from "../controllers/profiles.controller.js";
   

 const router = express.Router();

   // Protected routes
   router.post("/", authenticateToken, createProfile);                  // Create or update profile
   router.get("/me", authenticateToken, getMyProfile);                 // Get current user's profile
   router.post("/contacts", authenticateToken, getProfilesFromContacts); // Get profiles from contacts
   router.get("/with-chat/:phone", authenticateToken, getProfileWithChat); // Get profile + chat history
   router.get("/chats", authenticateToken, getChatList);   

   // Public routes
   router.get("/public", getPublicProfiles); 

export default router;
