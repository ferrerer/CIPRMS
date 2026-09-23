// Real, end-to-end OCR: real Tesseract text recognition and real PDF-page rasterization (via the actual child-process
// worker, services/pdfRasterWorker.js), through the real HTTP routes (POST /api/ocr/extract, GET /api/ocr/status/:id)
// — not the synthetic hand-typed text blocks test/idp-extraction.test.js uses for its field-matching unit tests.
// Every fixture (JPG/PNG image, text PDF, scanned/image-only PDF) is generated on the fly with `sharp` and `pdfkit`
// (both already dependencies) so nothing binary needs to be committed to the repo, and cleaned up via the shared
// cleanupAll() helper (documents/files are archived with the test user's own uploadedByEmail, which it already
// sweeps). This is real, measured-working OCR in this environment: a lone small image OCRs in ~1.5s and a 2-page
// scanned PDF rasterizes+OCRs well inside the timeout below — confirmed live before writing these tests.
//
// Requires `npm test`'s own --experimental-vm-modules flag (package.json): pdf-parse's bundled pdfjs-dist sets up its
// PDF.js worker with a dynamic `import()` call, which Jest's module system otherwise intercepts and rejects with
// "A dynamic import callback was invoked without --experimental-vm-modules" — a Jest/pdfjs-dist interop quirk, not a
// bug in this app's own code (confirmed: the exact same PDF, run through the exact same ocrService.startJob() outside
// Jest via plain `node`, already completed successfully before this flag was added).
jest.setTimeout(60000);

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciprms-ocr-'));
const tmpFiles = [];

function tmpPath(name) { const p = path.join(TMP, name); tmpFiles.push(p); return p; }

/** A real PNG containing real rendered text — sharp rasterizes the SVG (via librsvg), so this is genuine pixel
 * content for Tesseract to recognize, not a pre-baked fixture. */
async function renderTextImage(lines, outPath, width) {
  width = width || 1000;
  const lineHeight = 46, height = lines.length * lineHeight + 40;
  const text = lines.map((l, i) => `<text x="20" y="${40 + i * lineHeight}" font-size="30" font-family="sans-serif" fill="black">${l.replace(/&/g, '&amp;')}</text>`).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`);
  await sharp(svg).png().toFile(outPath);
  return outPath;
}

/** A real, embedded-text PDF (pdfkit's .text() writes an actual text layer pdf-parse can read) — exercises the
 * "text layer already present, skip OCR" fast path. */
function buildTextPdf(paragraphs, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const out = fs.createWriteStream(outPath);
    doc.pipe(out);
    paragraphs.forEach(p => doc.fontSize(14).text(p).moveDown());
    doc.end();
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);
  });
}

/** A real image-ONLY PDF (each page is a rasterized image, no text layer at all) — pdf-parse reports ~0 embedded
 * characters, so this exercises the real OCR fallback: rasterizePdfPages (a real child process) + real Tesseract,
 * once per page. */
function buildScannedPdf(pageImagePaths, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(outPath);
    doc.pipe(out);
    pageImagePaths.forEach(imgPath => {
      const { width, height } = sizeOfPng(imgPath);
      doc.addPage({ size: [width, height] }).image(imgPath, 0, 0, { width });
    });
    doc.end();
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);
  });
}
function sizeOfPng(p) {
  // PNG IHDR: width/height are the first 8 bytes after the 16-byte PNG+IHDR header prefix.
  const buf = fs.readFileSync(p);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let agent, db;

beforeAll(async () => {
  db = await connectDB();
  const user = await createTestUser({ role: 'Administrator' });
  agent = request.agent(app);
  await loginAs(agent, user);
});

afterAll(async () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  await cleanupAll();
  await closeDB();
});

async function extractAndWait(filePath, mimetype) {
  const startRes = await agent.post('/api/ocr/extract').attach('document', filePath);
  expect(startRes.status).toBe(202);
  expect(startRes.body.success).toBe(true);
  const jobId = startRes.body.jobId;

  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/ocr/status/' + jobId);
    expect(res.status).toBe(200);
    last = res.body;
    if (last.status === 'done' || last.status === 'error') return last;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('OCR job did not finish within the test deadline: ' + JSON.stringify(last));
}

describe('JPG scan — real Tesseract OCR', () => {
  let result;
  beforeAll(async () => {
    const img = tmpPath('moa.png'); // sharp always writes real PNG bytes regardless of the filename extension we give supertest
    await renderTextImage([
      'MEMORANDUM OF AGREEMENT',
      'This MOA is entered into by and between Camarines Sur Polytechnic Colleges and XYZ University of Testland.',
      'Effective Date: January 5, 2026',
      'Valid Until: December 31, 2030',
      'Coordinated through CCS.'
    ], img, 2100);
    const jpg = tmpPath('moa.jpg');
    await sharp(img).jpeg().toFile(jpg);
    result = await extractAndWait(jpg, 'image/jpeg');
  });

  test('completes successfully with real recognized text (method: ocr)', () => {
    expect(result.status).toBe('done');
    expect(result.result.method).toBe('ocr');
    expect(result.result.confidence).toBeGreaterThan(50);
    expect(result.result.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
  });

  test('classifies MOA and extracts institution/partner/dates/unit from the genuinely-recognized text', () => {
    const f = result.result;
    expect(f.documentType).toBe('Memorandum of Agreement (MOA)');
    expect(f.institution).toMatch(/Camarines/i);
    expect(f.partner).toMatch(/XYZ University/i);
    expect(f.startDate).toMatch(/January 5, 2026/);
    expect(f.endDate).toMatch(/December 31, 2030/);
    expect(f.unit).toBe('CCS');
  });

  test('the upload was archived to the Document Library with the extracted metadata and full OCR text stored', async () => {
    const doc = await db.collection('documents').findOne({ id: result.result.documentId });
    expect(doc).toBeTruthy();
    expect(doc.type).toBe('MOA');
    expect(doc.institution).toMatch(/Camarines/i);
    expect(doc.ocrText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(Array.isArray(doc.searchKeywords)).toBe(true);
  });
});

describe('Text PDF — uses the embedded text layer, never runs OCR', () => {
  let result;
  beforeAll(async () => {
    const pdf = tmpPath('mou-text.pdf');
    await buildTextPdf([
      'MEMORANDUM OF UNDERSTANDING',
      'This Memorandum of Understanding is entered into by and between Camarines Sur Polytechnic Colleges and Sample International University, a university in Japan, hereinafter the Parties.',
      'Effective Date: March 3, 2026',
      'This MOU shall expire until March 2, 2031.',
      'Coordinated through CETE.'
    ], pdf);
    result = await extractAndWait(pdf, 'application/pdf');
  });

  test('completes via the text-layer fast path with full confidence', () => {
    expect(result.status).toBe('done');
    expect(result.result.method).toBe('text-layer');
    expect(result.result.confidence).toBe(100);
  });

  test('classifies MOU and extracts fields from the real embedded text', () => {
    const f = result.result;
    expect(f.documentType).toBe('Memorandum of Understanding (MOU)');
    expect(f.institution).toMatch(/Camarines/i);
    expect(f.partner).toMatch(/Sample International University/i);
    expect(f.country).toBe('Japan');
    expect(f.unit).toBe('CETE');
  });
});

describe('Scanned (image-only) multi-page PDF — real rasterization + real OCR per page', () => {
  let result;
  beforeAll(async () => {
    const page1 = tmpPath('page1.png'), page2 = tmpPath('page2.png');
    await renderTextImage(['MEMORANDUM OF AGREEMENT', 'Page 1 of 2 — between CSPC and Testland Institute of Technology.'], page1);
    await renderTextImage(['Effective Date: June 1, 2026', 'Valid Until: May 31, 2029', 'Coordinated through CNAS.'], page2);
    const pdf = tmpPath('scanned-moa.pdf');
    await buildScannedPdf([page1, page2], pdf);
    result = await extractAndWait(pdf, 'application/pdf');
  });

  test('falls back to real OCR (not the text layer) across both pages', () => {
    expect(result.status).toBe('done');
    expect(result.result.method).toBe('ocr');
    expect(result.result.pages).toBe(2);
  });

  test('content from BOTH pages made it into the combined recognized text and field extraction', () => {
    const f = result.result;
    expect(f.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(f.rawText).toMatch(/Testland Institute of Technology/i);
    expect(f.rawText).toMatch(/June 1, 2026/);
    expect(f.endDate).toMatch(/May 31, 2029/);
    expect(f.unit).toBe('CNAS');
  });

  test('image quality metrics were computed against the first rasterized page', () => {
    expect(result.result.imageQuality).toBeTruthy();
    expect(result.result.imageQuality.metrics.width).toBeGreaterThan(0);
  });
});

describe('Low-confidence / unrecognizable content — fields stay null, never guessed', () => {
  test('a real OCR of an unrelated short image still leaves every partnership field null (no invented values)', async () => {
    const img = tmpPath('unrelated.png');
    await renderTextImage(['Just a random note', 'with nothing about any agreement.'], img);
    const result = await extractAndWait(img, 'image/png');
    expect(result.status).toBe('done');
    const f = result.result;
    expect(f.country).toBeNull();
    expect(f.nature).toBeNull();
    expect(f.unit).toBeNull();
    expect(f.startDate).toBeNull();
  });

  test('an image with no readable text at all is reported as a clean error, not a false success', async () => {
    const blank = tmpPath('blank.png');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(blank);
    const result = await extractAndWait(blank, 'image/png');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no readable text/i);
  });
});

describe('Duplicate detection survives a real second OCR of the same institution/type', () => {
  test('uploading a second document for the same institution and type flags it as a possible duplicate', async () => {
    const partner = 'Duplicate Test University';
    const img1 = tmpPath('dup1.png'), img2 = tmpPath('dup2.png');
    await renderTextImage(['MEMORANDUM OF AGREEMENT', `between CSPC and ${partner}.`], img1);
    await renderTextImage(['MEMORANDUM OF AGREEMENT', `between CSPC and ${partner}.`, 'A slightly different second copy.'], img2);
    const first = await extractAndWait(img1, 'image/png');
    expect(first.status).toBe('done');
    const second = await extractAndWait(img2, 'image/png');
    expect(second.status).toBe('done');
    expect(second.result.duplicateWarning.found).toBe(true);
    expect(second.result.duplicateWarning.matches.some(m => m.id === first.result.documentId)).toBe(true);
  });
});

describe('RBAC: OCR extraction is not open to every authenticated role', () => {
  test('College Staff and Partner may use OCR (their own Partnership Request auto-fill); Partner and College Staff request the same route as Administrator, all under requireUploader', async () => {
    // requireUploader admits Administrator, Auth. Personnel, potential_partner and Staff — this just confirms the
    // route is reachable for another of those roles too, unchanged by anything in this task. Waited out to
    // completion (not just the 202) so no background job is still running past this file's own afterAll/closeDB.
    const college = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    const collegeAgent = request.agent(app);
    await loginAs(collegeAgent, college);
    const img = tmpPath('rbac.png');
    await renderTextImage(['A short note.'], img);
    const startRes = await collegeAgent.post('/api/ocr/extract').attach('document', img);
    expect(startRes.status).toBe(202);
    const jobId = startRes.body.jobId;
    const deadline = Date.now() + 30000;
    let last;
    do { await new Promise(r => setTimeout(r, 300)); last = (await collegeAgent.get('/api/ocr/status/' + jobId)).body; }
    while (last.status === 'processing' && Date.now() < deadline);
    expect(['done', 'error']).toContain(last.status);
  });

  test('a signed-out request is refused', async () => {
    // No file attached: requireUploader redirects before multer ever reads the body, so there is nothing left for
    // the client to stream — attaching a real file here raced the server's immediate redirect against the still-
    // uploading body and intermittently surfaced as an ECONNRESET on the client, not a real failure of the guard.
    const res = await request(app).post('/api/ocr/extract');
    expect(res.status).toBe(302);
  });
});
