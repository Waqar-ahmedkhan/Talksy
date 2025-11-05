// src/script/fix-contacts.js
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

// Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

console.log("Connecting to MongoDB...");
console.log("MONGODB_URI:", process.env.MONGODB_URI?.slice(0, 30) + "...");

try {
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("Connected to MongoDB");
} catch (err) {
  console.error("Failed to connect to MongoDB:", err.message);
  process.exit(1);
}

// Import after connection
let Contact, normalizePhoneNumber;
try {
  const contactModule = await import(join(__dirname, "../models/Contact.js"));
  Contact = contactModule.default;

  const controllerModule = await import(
    join(__dirname, "../controllers/profiles.controller.js")
  );
  normalizePhoneNumber = controllerModule.normalizePhoneNumber;

  console.log("Models & functions loaded");
} catch (err) {
  console.error("Failed to import modules:", err.message);
  process.exit(1);
}

// === MAIN FIX LOGIC ===
console.log("\nStarting contact normalization...\n");

let fixed = 0;
let skipped = 0;

try {
  const contacts = await Contact.find({}).lean(); // lean() = faster, no Mongoose docs

  for (const contact of contacts) {
    const original = contact.phone;
    const normalized = normalizePhoneNumber(original);

    if (!normalized) {
      console.warn(`Invalid phone, skipping: ${original}`);
      skipped++;
      continue;
    }

    if (original !== normalized) {
      await Contact.updateOne(
        { _id: contact._id },
        { $set: { phone: normalized } }
      );
      console.log(`${original} → ${normalized}`);
      fixed++;
    }
  }
} catch (err) {
  console.error("Error during fix:", err.message);
  process.exit(1);
}

console.log("\nFix complete!");
console.log(`Fixed: ${fixed}`);
console.log(`Skipped (invalid): ${skipped}`);
console.log(`Total processed: ${fixed + skipped}`);

await mongoose.disconnect();
console.log("Disconnected from MongoDB");
process.exit(0);
