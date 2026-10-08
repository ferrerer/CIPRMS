// Upload/OCR performance investigation (2026-11) — temp-file leak half.
//
// Root cause: ocrService.js's job-expiry sweep (setInterval, JOB_TTL_MS = 10 minutes in production) only
// ever removed the expired job's in-memory record (`jobs.delete(id)`) — a job a user extracted but never
// confirmed OR discarded (closed the tab, abandoned the modal — the actual New Partnership bug,
// test/partnership-document-persistence.test.js, was one easy way to reach exactly this state) kept its
// temp file sitting in uploads/tmp forever: nothing else ever referenced that path again once the job
// record itself was gone.
//
// This test exercises the REAL sweep (same setInterval, same code), just with a short real TTL/sweep
// interval instead of the real 10-minute one, via OCR_JOB_TTL_MS/OCR_JOB_SWEEP_MS — two env vars that only
// this one test file ever sets (jest.resetModules() + a fresh require keeps that scoped to this file;
// production, and every other test, never sets them and gets the unchanged 10-minute/60-second defaults).
jest.setTimeout(60000);

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

describe('An expired, never-confirmed OCR job cleans up its own temp file (not just its in-memory record)', () => {
  let ocrService, tmpFile;

  beforeAll(async () => {
    // Comfortably longer than real OCR on a tiny image takes (observed ~1.5-3s elsewhere in this suite) —
    // too short a TTL here would let the sweep delete the job record while OCR is still mid-flight, before
    // it ever reaches 'done', which is a bug in the TEST's own timing, not evidence of anything wrong with
    // the sweep itself.
    process.env.OCR_JOB_TTL_MS = '5000';
    process.env.OCR_JOB_SWEEP_MS = '500';
    jest.resetModules();
    ocrService = require('../services/ocrService');

    tmpFile = path.join(os.tmpdir(), `ciprms-ocr-ttl-test-${Date.now()}.png`);
    await sharp({ create: { width: 200, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: Buffer.from('<svg width="200" height="80"><rect width="100%" height="100%" fill="white"/><text x="10" y="45" font-size="22" font-family="sans-serif">Hello</text></svg>'), top: 0, left: 0 }])
      .png().toFile(tmpFile);
  });

  afterAll(() => {
    delete process.env.OCR_JOB_TTL_MS;
    delete process.env.OCR_JOB_SWEEP_MS;
    try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
  });

  test('the sweep deletes the leaked temp file once the (short, test-only) TTL has passed — never confirmed, never discarded', async () => {
    const jobId = ocrService.startJob(tmpFile, 'image/png', { originalName: 'hello.png' });

    // Wait for the real OCR to actually finish (small image — fast), confirming the job reached 'done'
    // with its tempFilePath set, exactly the state a real abandoned upload would be in. Polls getJob()
    // defensively against a null return too — the sweep deleting the record before OCR even reaches
    // 'done' would itself be a sign the TTL above is set too short relative to real OCR time, not a pass.
    const createdAt = Date.now();
    let job = null;
    const doneDeadline = createdAt + 20000;
    do {
      job = ocrService.getJob(jobId);
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < doneDeadline);
    expect(job).not.toBeNull();
    expect(job.status).toBe('done');
    expect(fs.existsSync(tmpFile)).toBe(true); // still there — not yet confirmed or discarded

    // Past the test TTL counted from job creation, and at least one sweep tick beyond that.
    const remaining = 5000 - (Date.now() - createdAt) + 700;
    await new Promise(r => setTimeout(r, Math.max(remaining, 700)));

    expect(ocrService.getJob(jobId)).toBeNull(); // the in-memory record is gone (always was)
    expect(fs.existsSync(tmpFile)).toBe(false);  // the file is now ALSO gone — the actual fix
  });
});
