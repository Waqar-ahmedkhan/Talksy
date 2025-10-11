import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

const router = express.Router();
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10 // Max 10 files for multiple uploads
  }
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Allowed file types, explicitly including video types and octet-stream
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
  "text/plain",
  "application/octet-stream" // Fallback for generic binary files
];

// Helper to check video duration using ffprobe
const checkVideoDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(new Error("Failed to probe video file"));
      }
      const duration = metadata.format.duration; // Duration in seconds
      if (duration > 300) { // 5 minutes = 300 seconds
        return reject(new Error("Video duration exceeds 5 minutes"));
      }
      resolve();
    });
  });
};

// Middleware to handle Multer errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.log("Multer error:", {
      code: err.code,
      message: err.message,
      fieldNames: Object.keys(req.files || {}),
      headers: req.headers,
      path: req.path
    });
    if (err.code === "LIMIT_UNEXPECTED_FIELD" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ 
        error: "Unexpected field name. Use 'file' for /api/upload or 'files' for /api/upload/multiple.",
        receivedFields: Object.keys(req.files || {})
      });
    }
    return res.status(400).json({ 
      error: `Multer error: ${err.message}`,
      code: err.code,
      receivedFields: Object.keys(req.files || {})
    });
  }
  next(err);
};

// Helper to generate presigned URL
const generatePresignedUrl = async (key) => {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key
  });
  return await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
};

// Single file upload endpoint (expects field name 'file')
router.post("/", upload.single("file"), handleMulterError, async (req, res) => {
  try {
    console.log("Received file:", req.file);
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    if (!allowedTypes.includes(req.file.mimetype)) {
      console.log("Unsupported MIME type debug:", {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        path: req.file.path,
        headers: req.headers
      });
      return res.status(400).json({ error: `Invalid video MIME type or unsupported file type: ${req.file.mimetype}` });
    }

    // Check video duration if file is a video
    if (req.file.mimetype.startsWith("video/")) {
      try {
        await checkVideoDuration(req.file.path);
      } catch (err) {
        console.log("Video duration error:", {
          filename: req.file.originalname,
          error: err.message
        });
        return res.status(400).json({ error: `Invalid video MIME type or duration (max 5 minutes): ${err.message}` });
      }
    }

    const key = `chat-files/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(req.file.path),
      ContentType: req.file.mimetype,
      ContentDisposition: `attachment; filename="${req.file.originalname}"`
    };

    await s3.send(new PutObjectCommand(uploadParams));
    const url = await generatePresignedUrl(key);
    res.json({ 
      url, 
      fileType: req.file.mimetype, 
      filename: req.file.originalname 
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  } finally {
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupErr) {
        console.error(`Failed to delete temp file ${req.file.path}:`, cleanupErr);
      }
    }
  }
});

// Multiple file upload endpoint (expects field name 'files')
router.post("/multiple", upload.array("files", 10), handleMulterError, async (req, res) => {
  try {
    console.log("Received files:", req.files);
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });

    const uploadedFiles = [];

    for (const file of files) {
      if (!allowedTypes.includes(file.mimetype)) {
        console.log("Unsupported MIME type debug:", {
          filename: file.originalname,
          mimetype: file.mimetype,
          path: file.path,
          headers: req.headers
        });
        return res.status(400).json({ error: `Invalid video MIME type or unsupported file type: ${file.mimetype}` });
      }

      // Check video duration if file is a video
      if (file.mimetype.startsWith("video/")) {
        try {
          await checkVideoDuration(file.path);
        } catch (err) {
          console.log("Video duration error:", {
            filename: file.originalname,
            error: err.message
          });
          return res.status(400).json({ error: `Invalid video MIME type or duration (max 5 minutes): ${err.message}` });
        }
      }

      const key = `chat-files/${Date.now()}-${file.originalname}`;
      const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
        Body: fs.createReadStream(file.path),
        ContentType: file.mimetype,
        ContentDisposition: `attachment; filename="${file.originalname}"`
      };

      await s3.send(new PutObjectCommand(uploadParams));
      const url = await generatePresignedUrl(key);
      uploadedFiles.push({ 
        url, 
        fileType: file.mimetype, 
        filename: file.originalname 
      });
    }

    res.json({ urls: uploadedFiles });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload files" });
  } finally {
    if (req.files) {
      try {
        await Promise.all(
          req.files.map(file => fs.promises.unlink(file.path).catch(err => 
            console.error(`Failed to delete temp file ${file.path}:`, err)
          ))
        );
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    }
  }
});

// Debug endpoint to capture any field name
router.post("/debug", upload.any(), async (req, res) => {
  try {
    console.log("Debug endpoint - Received files:", req.files);
    const fileDetails = await Promise.all(req.files.map(async file => {
      let duration = null;
      if (file.mimetype.startsWith("video/")) {
        try {
          await checkVideoDuration(file.path);
          duration = "Valid (≤ 5 minutes)";
        } catch (err) {
          duration = `Invalid: ${err.message}`;
        }
      }
      return {
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        duration: duration
      };
    }));
    res.json({ receivedFields: fileDetails });
  } catch (err) {
    console.error("Debug endpoint error:", err);
    res.status(500).json({ error: "Failed to process debug request" });
  }
});

export default router;