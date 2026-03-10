import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth';

const router = Router();
const coversDir = path.join(process.cwd(), 'uploads', 'covers');
fs.mkdirSync(coversDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, coversDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

router.post('/cover', authenticate, upload.single('cover'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Cover file is required' });
    return;
  }

  const baseUrl = String(process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const url = `${baseUrl}/api/uploads/covers/${req.file.filename}`;
  res.json({
    url,
    filename: req.file.filename,
    mime_type: req.file.mimetype,
    size: req.file.size,
  });
});

export default router;
