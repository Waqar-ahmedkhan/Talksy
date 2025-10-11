import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const router = express.Router();
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10 // Max 10 files per request
  }
});

const s3 = new S3Client({
  region: "your-region", // Replace with your AWS region
  credentials: {
    accessKeyId: "your-access-key", // Replace with your AWS credentials
    secretAccessKey: "your-secret-key",
  },
});

// Middleware to handle Multer errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      // Log the incoming field names for debugging
      console.log("Received field names:", Object.keys(req.files || {}));
      return res.status(400).json({ 
        error: "Unexpected field name. Use 'file' for single file or 'files' for multiple files."
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
};

// Route for file uploads (supports both 'file' for single and 'files' for multiple uploads)
router.post("/upload", upload.fields([
  { name: "file", maxCount: 1 },
  { name: "files", maxCount: 10 }
]), handleMulterError, async (req, res) => {
  try {
    // Log received files for debugging
    console.log("Received files:", req.files);
    const files = req.files["files"] || (req.files["file"] ? [req.files["file"][0]] : []);
    if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/bmp",
      "image/tiff",
      "application/pdf",
      "video/mp4",
      "video/mpeg",
      "video/quicktime",
      "video/webm",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain"
    ];

    const uploadedFiles = [];

    for (const file of files) {
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      }

      const uploadParams = {
        Bucket: "your-bucket", // Replace with your S3 bucket name
        Key: `chat-files/${Date.now()}-${file.originalname}`,
        Body: require("fs").createReadStream(file.path),
        ContentType: file.mimetype,
      };
      await s3.send(new PutObjectCommand(uploadParams));
      const fileUrl = `https://your-bucket.s3.amazonaws.com/${uploadParams.Key}`;
      uploadedFiles.push({ url: fileUrl, fileType: file.mimetype });
    }

    res.json({ urls: uploadedFiles });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload files" });
  } finally {
    if (req.files) {
      const fs = require("fs").promises;
      try {
        const allFiles = [...(req.files["file"] || []), ...(req.files["files"] || [])];
        await Promise.all(
          allFiles.map(file => fs.unlink(file.path).catch(err => 
            console.error(`Failed to delete temp file ${file.path}:`, err)
          ))
        );
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    }
  }
});

export default router;
