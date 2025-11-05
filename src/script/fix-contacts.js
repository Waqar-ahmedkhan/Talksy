// src/script/fix-contacts.js
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Connect to DB
await mongoose.connect(
  process.env.MONGODB_URI || "mongodb://localhost:27017/talksy"
);
console.log("Connected to MongoDB");

// Import models and function
const Contact = (await import(join(__dirname, "../models/Contact.js"))).default;
const { normalizePhoneNumber } = await import(
  join(__dirname, "../controllers/profiles.controller.js")
);

console.log("Fixing contacts...");

let fixed = 0;
const contacts = await Contact.find({});

for (const contact of contacts) {
  const normalized = normalizePhoneNumber(contact.phone);
  if (normalized && contact.phone !== normalized) {
    contact.phone = normalized;
    await contact.save();
    fixed++;
    console.log(`${contact.phone} → ${normalized}`);
  }
}

console.log(`\nDone! Fixed ${fixed} contacts.`);
mongoose.disconnect();
process.exit();
