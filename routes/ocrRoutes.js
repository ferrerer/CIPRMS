const express = require('express');
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const verifyMagicBytes = require('../middleware/verifyMagicBytes');
const ocrController = require('../controllers/ocrController');

const router = express.Router();

// Wrapped manually (instead of `upload.single('document')` directly) so a
// rejected file type or an over-limit file returns a clean JSON 400 instead
// of falling through to Express's default HTML error page.
router.post('/extract', (req, res) => {
  upload.single('document')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Maximum size is 10MB.'
        : err.message;
      return res.status(400).json({ success: false, error: message });
    }
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.file && !verifyMagicBytes(req.file)) {
      return res.status(400).json({ success: false, error: 'Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.' });
    }
    ocrController.extract(req, res);
  });
});

router.get('/status/:jobId', ocrController.status);

module.exports = router;
