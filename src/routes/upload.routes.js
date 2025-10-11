import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs"; // Import fs module for ESM

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

// Single file upload endpoint (expects field name 'file')
router.post("/", upload.single("file"), handleMulterError, async (req, res) => {
  try {
    console.log("Received file:", req.file); // Log full file object
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
      console.log("Unsupported MIME type debug:", {
        filename: file.originalname,
        mimetype: file.mimetype,
        path: file.path
      });
      return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
    }

    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `chat-files/${Date.now()}-${file.originalname}`,
      Body: fs.createReadStream(file.path),
      ContentType: file.mimetype,
    };
    await s3.send(new PutObjectCommand(uploadParams));
    const fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${uploadParams.Key}`;
    res.json({ url: fileUrl, fileType: file.mimetype });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  } finally {
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path).catch(err => 
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
    console.log("Received files:", req.files); // Log full file array
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
        console.log("Unsupported MIME type debug:", {
          filename: file.originalname,
          mimetype: file.mimetype,
          path: file.path
        });
        return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      }

      const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `chat-files/${Date.now()}-${file.originalname}`,
        Body: fs.createReadStream(file.path),
        ContentType: file.mimetype,
      };
      await s3.send(new PutObjectCommand(uploadParams));
      const fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${uploadParams.Key}`;
      uploadedFiles.push({ url: fileUrl, fileType: file.mimetype });
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
    res.json({ receivedFields: req.files.map(file => ({ fieldname: file.fieldname, originalname: file.originalname, mimetype: file.mimetype })) });
  } catch (err) {
    console.error("Debug endpoint error:", err);
    res.status(500).json({ error: "Failed to process debug request" });
  }
});

export default router;
