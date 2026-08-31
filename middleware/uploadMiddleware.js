const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'tmp');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // timestamp + random suffix guarantees we never collide with / overwrite an existing upload
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    return cb(new Error('Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.'));
  }
  cb(null, true);
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
