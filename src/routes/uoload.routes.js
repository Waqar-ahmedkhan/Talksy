// routes/upload.js
import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const router = express.Router();
const upload = multer({ dest: "uploads/" });
const s3 = new S3Client({
  region: "your-region", // Replace with your AWS region
  credentials: {
    accessKeyId: "your-access-key", // Replace with your AWS credentials
    secretAccessKey: "your-secret-key",
  },
});

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const uploadParams = {
      Bucket: "your-bucket", // Replace with your S3 bucket name
      Key: `chat-files/${Date.now()}-${file.originalname}`,
      Body: require("fs").createReadStream(file.path),
      ContentType: file.mimetype,
    };
    await s3.send(new PutObjectCommand(uploadParams));
    const fileUrl = `https://your-bucket.s3.amazonaws.com/${uploadParams.Key}`;
    res.json({ url: fileUrl, fileType: file.mimetype });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  } finally {
    if (req.file) require("fs").unlinkSync(req.file.path); // Clean up temp file
  }
});

export default router;