import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import jwt from "jsonwebtoken"; // Optional: for authentication

const router = express.Router();

// Configure Multer storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = "./uploads";
    const timestamp = new Date().toISOString();
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      console.log(`[UPLOAD_DEBUG] Created upload directory: ${uploadDir}, timestamp=${timestamp}`);
      cb(null, uploadDir);
    } catch (err) {
      console.error(`[UPLOAD_ERROR] Failed to create upload directory: ${err.message}, timestamp=${timestamp}`);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    console.log(`[UPLOAD_DEBUG] Generating filename for file: ${file.originalname}, timestamp=${timestamp}`);
    cb(null, `${timestamp}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10, // Max 10 files for multiple uploads
  },
});

// Allowed file types, including audio
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
  "audio/mp4", // Added for .m4a (voice notes)
  "audio/mpeg", // Added for .mp3
  "audio/wav", // Added for .wav
  "audio/ogg", // Added for .ogg
];

// Initialize S3 client
const s3 = new S3Client({
  region: "your-region", // Replace with your AWS region, e.g., "us-east-1"
  credentials: {
    accessKeyId: "your-access-key", // Replace with your AWS access key
    secretAccessKey: "your-secret-key", // Replace with your AWS secret key
  },
});

// Middleware to verify JWT (optional)
const verifyToken = (req, res, next) => {
  const timestamp = new Date().toISOString();
  const authHeader = req.headers.authorization;
  console.log(`[AUTH_DEBUG] Authorization header: ${authHeader || 'none'}, timestamp=${timestamp}`);
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.warn(`[AUTH_WARN] Missing or invalid Authorization header, timestamp=${timestamp}`);
    // Comment out if authentication is not required
    // return res.status(401).json({ error: "Authentication required. Please provide a valid token." });
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, "your-jwt-secret"); // Replace with your JWT secret
    req.user = decoded; // Store decoded user data (e.g., userId)
    console.log(`[AUTH_DEBUG] Token verified: user=${JSON.stringify(decoded, null, 2)}, timestamp=${timestamp}`);
    next();
  } catch (err) {
    console.error(`[AUTH_ERROR] Invalid token: ${err.message}, timestamp=${timestamp}`);
    return res.status(401).json({ error: "Invalid token." });
  }
};

// Middleware to handle Multer errors
const handleMulterError = (err, req, res, next) => {
  const timestamp = new Date().toISOString();
  if (err instanceof multer.MulterError) {
    console.error(`[UPLOAD_ERROR] Multer error: code=${err.code}, field=${err.field}, message=${err.message}, timestamp=${timestamp}`);
    console.log(`[UPLOAD_DEBUG] Received field names: ${JSON.stringify(Object.keys(req.files || {}))}, body fields: ${JSON.stringify(Object.keys(req.body || {}))}, timestamp=${timestamp}`);
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        error: "Unexpected field name. Use 'file' for /api/upload or 'files' for /api/upload-multiple.",
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error(`[UPLOAD_ERROR] Unexpected error: ${err.message}, stack=${err.stack}, timestamp=${timestamp}`);
    return res.status(500).json({ error: "Server error during upload." });
  }
  next();
};

// Single file upload endpoint (expects field name 'file')
router.post("/", verifyToken, upload.single("file"), handleMulterError, async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[UPLOAD_DEBUG] Received request to /api/upload, userId=${req.user?.userId || 'unknown'}, timestamp=${timestamp}`);
  console.log(`[UPLOAD_DEBUG] Request headers: ${JSON.stringify(req.headers, null, 2)}, timestamp=${timestamp}`);
  console.log(`[UPLOAD_DEBUG] Request body fields: ${JSON.stringify(req.body, null, 2)}, file=${JSON.stringify(req.file, null, 2)}, timestamp=${timestamp}`);

  try {
    const file = req.file;
    if (!file) {
      console.error(`[UPLOAD_ERROR] No file uploaded, received fields=${JSON.stringify(Object.keys(req.body || {}))}, timestamp=${timestamp}`);
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    console.log(`[UPLOAD_DEBUG] File details: mimetype=${file.mimetype}, originalname=${file.originalname}, size=${file.size}, path=${file.path}, timestamp=${timestamp}`);
    if (!allowedTypes.includes(file.mimetype)) {
      console.error(`[UPLOAD_ERROR] Unsupported file type: ${file.mimetype}, filename=${file.originalname}, timestamp=${timestamp}`);
      return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
    }

    const uploadParams = {
      Bucket: "your-bucket", // Replace with your S3 bucket name
      Key: `chat-files/${Date.now()}-${file.originalname}`,
      Body: await fs.readFile(file.path),
      ContentType: file.mimetype,
    };

    console.log(`[UPLOAD_DEBUG] Uploading to S3: bucket=${uploadParams.Bucket}, key=${uploadParams.Key}, timestamp=${timestamp}`);
    await s3.send(new PutObjectCommand(uploadParams));
    const fileUrl = `https://${uploadParams.Bucket}.s3.${s3.config.region}.amazonaws.com/${uploadParams.Key}`;
    console.log(`[UPLOAD_DEBUG] File uploaded to S3: url=${fileUrl}, timestamp=${timestamp}`);

    res.status(200).json({
      success: true,
      file: {
        url: fileUrl,
        fileType: file.mimetype,
      },
    });
  } catch (err) {
    console.error(`[UPLOAD_ERROR] Failed to upload file: ${err.message}, stack=${err.stack}, timestamp=${timestamp}`);
    res.status(500).json({ error: "Failed to upload file to S3." });
  } finally {
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
        console.log(`[UPLOAD_DEBUG] Deleted temporary file: ${req.file.path}, timestamp=${timestamp}`);
      } catch (cleanupErr) {
        console.error(`[UPLOAD_ERROR] Failed to delete temporary file ${req.file.path}: ${cleanupErr.message}, timestamp=${timestamp}`);
      }
    }
  }
});

// Multiple file upload endpoint (expects field name 'files')
router.post("/multiple", verifyToken, upload.array("files", 10), handleMulterError, async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[UPLOAD_DEBUG] Received request to /api/upload-multiple, userId=${req.user?.userId || 'unknown'}, timestamp=${timestamp}`);
  console.log(`[UPLOAD_DEBUG] Request headers: ${JSON.stringify(req.headers, null, 2)}, timestamp=${timestamp}`);
  console.log(`[UPLOAD_DEBUG] Request body fields: ${JSON.stringify(req.body, null, 2)}, files=${JSON.stringify(req.files || [], null, 2)}, timestamp=${timestamp}`);

  try {
    const files = req.files;
    if (!files || files.length === 0) {
      console.error(`[UPLOAD_ERROR] No files uploaded, received fields=${JSON.stringify(Object.keys(req.body || {}))}, timestamp=${timestamp}`);
      return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
    }

    const uploadedFiles = [];
    for (const file of files) {
      console.log(`[UPLOAD_DEBUG] File details: mimetype=${file.mimetype}, originalname=${file.originalname}, size=${file.size}, path=${file.path}, timestamp=${timestamp}`);
      if (!allowedTypes.includes(file.mimetype)) {
        console.error(`[UPLOAD_ERROR] Unsupported file type: ${file.mimetype}, filename=${file.originalname}, timestamp=${timestamp}`);
        return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      }

      const uploadParams = {
        Bucket: "your-bucket", // Replace with your S3 bucket name
        Key: `chat-files/${Date.now()}-${file.originalname}`,
        Body: await fs.readFile(file.path),
        ContentType: file.mimetype,
      };

      console.log(`[UPLOAD_DEBUG] Uploading to S3: bucket=${uploadParams.Bucket}, key=${uploadParams.Key}, timestamp=${timestamp}`);
      await s3.send(new PutObjectCommand(uploadParams));
      const fileUrl = `https://${uploadParams.Bucket}.s3.${s3.config.region}.amazonaws.com/${uploadParams.Key}`;
      uploadedFiles.push({ url: fileUrl, fileType: file.mimetype });
      console.log(`[UPLOAD_DEBUG] File uploaded to S3: url=${fileUrl}, timestamp=${timestamp}`);
    }

    res.status(200).json({
      success: true,
      files: uploadedFiles,
    });
  } catch (err) {
    console.error(`[UPLOAD_ERROR] Failed to upload files: ${err.message}, stack=${err.stack}, timestamp=${timestamp}`);
    res.status(500).json({ error: "Failed to upload files to S3." });
  } finally {
    if (req.files && req.files.length > 0) {
      try {
        await Promise.all(
          req.files.map(file =>
            fs.unlink(file.path).catch(err =>
              console.error(`[UPLOAD_ERROR] Failed to delete temporary file ${file.path}: ${err.message}, timestamp=${timestamp}`)
            )
          )
        );
        console.log(`[UPLOAD_DEBUG] Deleted ${req.files.length} temporary files, timestamp=${timestamp}`);
      } catch (cleanupErr) {
        console.error(`[UPLOAD_ERROR] Cleanup error: ${cleanupErr.message}, timestamp=${timestamp}`);
      }
    }
  }
});

export default router;