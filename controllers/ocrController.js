const fs = require('fs');
const ocrService = require('../services/ocrService');

// POST /api/ocr/extract — accepts one document, starts OCR in the background,
// and immediately returns a jobId. The heavy work (rasterizing PDF pages,
// running Tesseract) happens after the response so the client can poll for
// real progress instead of blocking on one long request.
function extract(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file was uploaded.' });
  }

  try {
    const meta = {
      originalName: req.file.originalname,
      uploadedBy: (req.session && req.session.user && req.session.user.name) || 'Unknown',
      uploadedByEmail: (req.session && req.session.user && req.session.user.email) || null
    };
    const jobId = ocrService.startJob(req.file.path, req.file.mimetype, meta);
    res.status(202).json({ success: true, jobId });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: 'Failed to start OCR processing.' });
  }
}

// GET /api/ocr/status/:jobId — polled by the frontend for progress + final result.
function status(req, res) {
  const job = ocrService.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or has expired.' });
  }
  const sessionEmail = req.session && req.session.user && req.session.user.email;
  if (job.uploadedByEmail && job.uploadedByEmail !== sessionEmail) {
    return res.status(403).json({ success: false, error: 'You do not have access to this job.' });
  }

  res.json({
    success: true,
    status: job.status,      // 'processing' | 'done' | 'error'
    progress: job.progress,  // 0-100
    stage: job.stage,
    result: job.result,      // populated only once status === 'done'
    error: job.error
  });
}

module.exports = { extract, status };
