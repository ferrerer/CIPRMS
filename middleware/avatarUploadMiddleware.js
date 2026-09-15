const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png']);

if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    return cb(new Error('Unsupported file type. Only JPG, JPEG, and PNG are accepted.'));
  }
  cb(null, true);
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_AVATAR_SIZE } });
