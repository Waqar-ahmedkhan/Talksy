import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const router = express.Router();
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10 // Max 10 files for multiple uploads
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
      // Log incoming field names for debugging
      console.log("Received field names:", Object.keys(req.files || {}));
      return res.status(400).json({ 
        error: "Unexpected field name. Use 'file' for /api/upload or 'files' for /api/upload-multiple."
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
};

// Single file upload endpoint (expects field name 'file')
router.post("/", upload.single("file"), handleMulterError, async (req, res) => {
  try {
    // Log received file for debugging
    console.log("Received file:", req.file);
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

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
    res.json({ url: fileUrl, fileType: file.mimetype });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  } finally {
    if (req.file) {
      const fs = require("fs").promises;
      try {
        await fs.unlink(req.file.path).catch(err => 
          console.error(`Failed to delete temp file ${req.file.path}:`, err)
        );
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    }
  }
});

// Multiple file upload endpoint (expects field name 'files')
router.post("/multiple", upload.array("files", 10), handleMulterError, async (req, res) => {
  try {
    // Log received files for debugging
    console.log("Received files:", req.files);
    const files = req.files;
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
        await Promise.all(
          req.files.map(file => fs.unlink(file.path).catch(err => 
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
