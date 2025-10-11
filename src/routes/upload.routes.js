import express from 'express';
import multer from 'multer';
import { uploadFile, getFileUrl } from '../s3Service.js'; // Adjust path to go up one level

const router = express.Router();

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Route to handle a single file upload
// The field name in the form should be 'image'
router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const fileBuffer = req.file.buffer;
    // Create a unique file name to avoid overwrites
    const fileName = `uploads/${Date.now()}-${req.file.originalname}`;
    const mimeType = req.file.mimetype;

    // Upload the file to S3
    await uploadFile(fileBuffer, fileName, mimeType);

    // Get the public URL of the uploaded file
    const fileUrl = await getFileUrl(fileName);

    res.status(200).json({
      message: 'File uploaded successfully!',
      fileName: fileName,
      url: fileUrl,
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ message: 'Error uploading file to S3.' });
  }
});

// Route to get a download URL for an existing file
router.get('/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        const url = await getFileUrl(fileName);
        res.status(200).json({ url });
    } catch (error) {
        console.error('Error getting file URL:', error);
        res.status(500).json({ message: 'Error getting file URL.' });
    }
});

export default router;