// src/s3Service.js
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Initialize the S3Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Upload a file to S3
export const uploadFile = async (fileBuffer, fileName, mimeType) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
    Body: fileBuffer,
    ContentType: mimeType,
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);
  console.log(`✅ File uploaded successfully: ${fileName}`);
};

// Get a signed URL (temporary link) for the file
export const getFileUrl = async (fileName) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
  };

  const command = new GetObjectCommand(params);
  const url = await getSignedUrl(s3Client, command, {
    expiresIn: 60 * 60 * 24 * 7,
  }); // 7 days
  return url;
};

// Delete file from S3
export const deleteFile = async (fileName) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
  };

  const command = new DeleteObjectCommand(params);
  await s3Client.send(command);
  console.log(`🗑️ File deleted successfully: ${fileName}`);
};
