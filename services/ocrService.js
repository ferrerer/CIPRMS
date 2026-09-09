const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const { extractFields } = require('./extractionService');
const { UPLOAD_DIR } = require('../middleware/uploadMiddleware');
const { archiveToDocumentLibrary, findPossibleDuplicates } = require('./documentLibraryService');
const { analyzeImageQuality } = require('./imageQualityService');
const { getDb } = require('../db');

const OCR_TIMEOUT_MS = 90 * 1000;
const LOW_CONFIDENCE_THRESHOLD = 45;
const MIN_EMBEDDED_TEXT_LENGTH = 200; // above this, a PDF is treated as "digitally created" and skips OCR
const JOB_TTL_MS = 10 * 60 * 1000;

// In-memory job store (mirrors the pattern already used for the login rate
// limiter in cirl.js) — fine for a single-instance capstone deployment.
const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

// uploadedByEmail is stored on the job itself (not just passed through to
// runJob) so GET /api/ocr/status/:jobId can enforce ownership (S15, Roadmap
// v2 Phase G6, docs/SYSTEM_AUDIT_2026-07-16.md) — previously any
// requireUploader session could poll any other user's job by jobId.
function createJob(uploadedByEmail) {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'processing', progress: 0, stage: 'queued', result: null, error: null, createdAt: Date.now(), uploadedByEmail: uploadedByEmail || null });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

function getJob(id) {
  return jobs.get(id) || null;
}

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Image preprocessing (sharp) ───────────────────────────────────────────────
// Grayscale + normalize + upscale small images — improves Tesseract accuracy
// on low-resolution phone photos of printed documents.
async function preprocessImage(input) {
  const image = sharp(input).rotate(); // auto-orient using EXIF
  const meta = await image.metadata();
  let pipeline = image.grayscale().normalize();
  if (meta.width && meta.width < 1500) {
    pipeline = pipeline.resize({ width: Math.min(meta.width * 2, 3000) });
  }
  return pipeline.toBuffer();
}

// ── Core OCR over a single image buffer ───────────────────────────────────────
async function ocrImage(buffer, onProgress) {
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof onProgress === 'function') {
        onProgress(m.progress);
      }
    }
  });
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text || '', confidence: data.confidence || 0 };
  } finally {
    await worker.terminate();
  }
}

// Rasterizes every page of a PDF to PNG in a child process. Isolation is
// required here: pdf-parse and pdf-to-png-converter bundle incompatible major
// versions of pdfjs-dist, and loading both in one process trips pdfjs's own
// "API version does not match Worker version" guard.
function rasterizePdfPages(filePath, outDir) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'pdfRasterWorker.js'), filePath, outDir],
      { maxBuffer: 10 * 1024 * 1024, timeout: OCR_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return reject(new Error('Failed to render PDF pages: ' + err.message));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error('Failed to render PDF pages (unexpected renderer output).'));
        }
        if (!parsed.success) return reject(new Error(parsed.error || 'Failed to render PDF pages.'));
        resolve(parsed.files);
      }
    );
  });
}

// ── PDF handling: embedded-text fast path, OCR fallback for scanned pages ────
async function processPdf(filePath, jobId) {
  const buffer = await fsp.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  let embeddedText = '';
  let pageCount = 0;
  try {
    const parsed = await parser.getText();
    embeddedText = (parsed.pages || []).map((p) => p.text || '').join('\n\n').trim();
    pageCount = (parsed.pages || []).length;
  } finally {
    await parser.destroy();
  }

  if (embeddedText.length >= MIN_EMBEDDED_TEXT_LENGTH) {
    // Digitally created PDF — the text layer IS the ground truth, no OCR needed.
    // No rasterized page image exists on this fast path, so there's nothing
    // for the image-quality checks (section 8) to analyze.
    updateJob(jobId, { progress: 90, stage: 'extracting-text-layer' });
    return { text: embeddedText, confidence: 100, method: 'text-layer', pages: pageCount, imageQuality: null };
  }

  // Likely a scanned/image-based PDF — rasterize every page and OCR each one.
  updateJob(jobId, { progress: 15, stage: 'rendering-pdf-pages' });
  const pageDir = path.join(UPLOAD_DIR, `pages-${jobId}`);
  await fsp.mkdir(pageDir, { recursive: true });

  let pageFiles = [];
  try {
    pageFiles = await rasterizePdfPages(filePath, pageDir);
    if (pageFiles.length === 0) throw new Error('The PDF has no pages to process.');

    // Image quality (section 8) is analyzed once, on the first page only —
    // running it per-page for a multi-page scan would add real latency for
    // marginal benefit, and the first page is representative of how the
    // whole document was scanned.
    const firstPageBuffer = await fsp.readFile(pageFiles[0]);
    const imageQuality = await analyzeImageQuality(firstPageBuffer).catch(() => ({ metrics: {}, warnings: [] }));

    const texts = [];
    const confidences = [];
    for (let i = 0; i < pageFiles.length; i++) {
      const pageBaseProgress = 20 + Math.round((i / pageFiles.length) * 65);
      updateJob(jobId, { progress: pageBaseProgress, stage: `ocr-page-${i + 1}-of-${pageFiles.length}` });

      const pageBuffer = await fsp.readFile(pageFiles[i]);
      const processed = await preprocessImage(pageBuffer);
      const { text, confidence } = await ocrImage(processed, (p) => {
        updateJob(jobId, { progress: pageBaseProgress + Math.round((p * 65) / pageFiles.length) });
      });
      texts.push(text);
      confidences.push(confidence);
    }

    const avgConfidence = confidences.length
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 0;

    return { text: texts.join('\n\n'), confidence: avgConfidence, method: 'ocr', pages: pageFiles.length, imageQuality };
  } finally {
    // Rendered page images are scratch output — clean them up regardless of outcome.
    await fsp.rm(pageDir, { recursive: true, force: true });
  }
}

async function processImage(filePath, jobId) {
  updateJob(jobId, { progress: 15, stage: 'preprocessing-image' });
  const buffer = await fsp.readFile(filePath);

  // Image quality (section 8) runs against the original upload, before the
  // grayscale/normalize/upscale preprocessing below — that preprocessing is
  // meant to help Tesseract, but would mask the very issues (low-res, dark,
  // blurry) the user actually needs to be warned about.
  const imageQuality = await analyzeImageQuality(buffer).catch(() => ({ metrics: {}, warnings: [] }));

  const processed = await preprocessImage(buffer);

  updateJob(jobId, { progress: 25, stage: 'ocr-image' });
  const { text, confidence } = await ocrImage(processed, (p) => {
    updateJob(jobId, { progress: 25 + Math.round(p * 65) });
  });

  return { text, confidence, method: 'ocr', pages: 1, imageQuality };
}

// Archives the uploaded file to the Document Library — always, regardless of
// whether OCR extraction succeeded, so nothing a user uploads is ever quietly
// thrown away. Failures here are logged but never fail the OCR job itself.
async function archiveUpload(jobId, filePath, meta, extraction) {
  try {
    const archived = await archiveToDocumentLibrary(filePath, meta.originalName, extraction, meta);
    updateJob(jobId, { documentId: archived.documentId, fileLink: archived.fileLink });
    return archived;
  } catch (archiveErr) {
    console.error('Document library archiving failed:', archiveErr.message);
    return null;
  }
}

// ── Orchestration for a single uploaded file, tracked by jobId ───────────────
async function runJob(jobId, filePath, mimetype, meta = {}) {
  const startedAt = Date.now();
  try {
    updateJob(jobId, { progress: 5, stage: 'starting' });

    const ocrResult = await withTimeout(
      mimetype === 'application/pdf' ? processPdf(filePath, jobId) : processImage(filePath, jobId),
      OCR_TIMEOUT_MS,
      'OCR processing timed out. Try a smaller file or a clearer scan.'
    );

    const rawText = (ocrResult.text || '').trim();
    if (!rawText) {
      throw new Error('No readable text was found in the uploaded document.');
    }

    updateJob(jobId, { progress: 95, stage: 'extracting-fields' });
    const fields = extractFields(rawText);

    // Duplicate detection (section 6) — best-effort, never fails the job; an
    // unavailable DB just means no duplicate warning is shown.
    let duplicateWarning = { found: false, matches: [] };
    try {
      duplicateWarning = await findPossibleDuplicates(getDb(), fields, meta);
    } catch { /* duplicate check is best-effort */ }

    const processingTimeMs = Date.now() - startedAt;
    const result = {
      rawText,
      confidence: ocrResult.confidence,
      language: 'eng',
      processingTimeMs,
      method: ocrResult.method,
      pages: ocrResult.pages,
      warning: ocrResult.confidence < LOW_CONFIDENCE_THRESHOLD
        ? 'Low OCR confidence — please double-check the extracted data carefully before saving.'
        : null,
      imageQuality: ocrResult.imageQuality || null,
      duplicateWarning,
      ...fields
    };

    const archived = await archiveUpload(jobId, filePath, meta, result);
    if (archived) { result.documentId = archived.documentId; result.fileLink = archived.fileLink; }

    updateJob(jobId, { status: 'done', progress: 100, stage: 'done', result });
  } catch (err) {
    // Even on OCR failure, the raw upload is still a real document — archive it
    // (with no extracted metadata) rather than discarding it.
    await archiveUpload(jobId, filePath, meta, null);
    updateJob(jobId, { status: 'error', progress: 100, stage: 'error', error: err.message || 'OCR processing failed.' });
  } finally {
    // No-op if archiveUpload already moved the file out of the temp folder.
    fs.unlink(filePath, () => {});
  }
}

function startJob(filePath, mimetype, meta) {
  const jobId = createJob(meta && meta.uploadedByEmail);
  runJob(jobId, filePath, mimetype, meta); // fire-and-forget; progress/result polled via getJob()
  return jobId;
}

module.exports = { startJob, getJob };
