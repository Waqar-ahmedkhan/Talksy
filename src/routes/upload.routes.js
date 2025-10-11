import express from 'express';
import multer from 'multer';
import { uploadFile, getFileUrl } from '../s3Service.js'; // adjust path if needed

const router = express.Router();

// Use memory storage so we can directly upload from buffer
const upload = multer({ storage: multer.memoryStorage() });

// --- Single File Upload ---
router.post('/single', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const fileName = `uploads/${Date.now()}-${req.file.originalname}`;
    await uploadFile(req.file.buffer, fileName, req.file.mimetype);
    const url = await getFileUrl(fileName);

    return res.status(200).json({
      success: true,
      file: {
        url,
        type: req.file.mimetype.startsWith('image')
          ? 'image'
          : req.file.mimetype.startsWith('video')
          ? 'video'
          : 'file',
        fileType: req.file.mimetype,
        fileName: req.file.originalname,
      },
    });
  } catch (error) {
    console.error('Error uploading single file:', error);
    return res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// --- Multiple File Upload (for chat/media) ---
router.post('/multiple', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded.' });
    }

    const uploadedFiles = await Promise.all(
      req.files.map(async (file) => {
        const fileName = `uploads/${Date.now()}-${file.originalname}`;
        await uploadFile(file.buffer, fileName, file.mimetype);
        const url = await getFileUrl(fileName);

        return {
          url,
          type: file.mimetype.startsWith('image')
            ? 'image'
            : file.mimetype.startsWith('video')
            ? 'video'
            : 'file',
          fileType: file.mimetype,
          fileName: file.originalname,
        };
      })
    );

    res.status(200).json({ success: true, files: uploadedFiles });
  } catch (error) {
    console.error('Error uploading multiple files:', error);
    res.status(500).json({ success: false, error: 'Error uploading files to S3.' });
  }
});

// --- Get File URL ---
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
