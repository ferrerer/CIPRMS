// New Partnership → Document Library persistence investigation (2026-11).
//
// Root cause found: the Add New Partnership modal's OCR auto-fill (views/administrator/monitoring.ejs,
// assets/js/pages/registry-gridjs.init.js) called POST /api/ocr/extract to get suggested field values, but
// never called POST /api/ocr/confirm — the ONE call that actually archives the upload (see
// controllers/ocrController.js's own comment: "This endpoint does NOT save anything to the Document
// Library"). applyOcrToForm() only ever copied the EXTRACTED TEXT into the partnership form; the uploaded
// FILE itself was never linked to anything and its temp copy eventually leaked (see
// test/temp-file-cleanup.test.js for that half of the investigation). documents.ejs's own Document Library
// "Upload" flow already called /api/ocr/confirm correctly — this was an isolated gap in one flow, not a
// systemic one, and this suite exercises the two small, additive pieces that close it: a new `partnershipId`
// field on the archived document, and a `documentType` override so the archived record's type agrees with
// what the user actually saved. The client-side wiring that calls confirm only once a partnership really
// saved (submitPartnership(), registry-gridjs.init.js) is exercised live — see the chat response — since it
// is plain browser JS with no server endpoint of its own to call directly.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let agent, db, partnershipId;
const createdDocIds = [];

beforeAll(async () => {
  db = await connectDB();
  const user = await createTestUser({ role: 'Administrator' });
  agent = request.agent(app);
  await loginAs(agent, user);
});

afterAll(async () => {
  if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
  if (partnershipId) await db.collection('partnerships').deleteOne({ id: partnershipId });
  await cleanupAll();
  await closeDB();
});

async function extractAndWait(filePath) {
  const startRes = await agent.post('/api/ocr/extract').attach('document', filePath);
  expect(startRes.status).toBe(202);
  const jobId = startRes.body.jobId;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/ocr/status/' + jobId);
    if (res.body.status === 'done' || res.body.status === 'error') return jobId;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('OCR job did not finish in time.');
}

describe('OCR confirm now carries a partnership reference and a documentType override', () => {
  let jobId;
  const img = path.join(__dirname, '..', 'uploads', 'tmp', `${TEST_TAG}-partnership-doc-${Date.now()}.png`);

  beforeAll(async () => {
    await sharp({ create: { width: 900, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: Buffer.from(`<svg width="900" height="300"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="26" font-family="sans-serif">MEMORANDUM OF AGREEMENT</text><text x="20" y="120" font-size="22" font-family="sans-serif">between CSPC and ${TEST_TAG} Partnership Persistence University.</text></svg>`), top: 0, left: 0 }])
      .png().toFile(img);
    jobId = await extractAndWait(img);
  });

  afterAll(() => { fs.rmSync(img, { force: true }); });

  test('creating a real partnership first (mirrors submitPartnership() calling /api/partnerships before ever confirming the OCR job)', async () => {
    const res = await agent.post('/api/partnerships').send({
      inst: `${TEST_TAG} Partnership Persistence University`, country: 'Testland', type: 'MOA',
      unit: ['CCS'], nature: ['Research'], start: 'Jan 1, 2026', end: 'Jan 1, 2030'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    partnershipId = res.body.partnership.id;
  });

  test('confirming with partnershipId + documentType produces a Document Library record carrying both, linked to the real partnership', async () => {
    const res = await agent.post('/api/ocr/confirm').send({
      jobId, institution: `${TEST_TAG} Partnership Persistence University`, documentType: 'MOA', partnershipId
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.documentId).toBeTruthy();
    createdDocIds.push(res.body.documentId);

    const doc = await db.collection('documents').findOne({ id: res.body.documentId });
    expect(doc).toBeTruthy();
    expect(doc.partnershipId).toBe(partnershipId); // the new field this investigation adds
    expect(doc.type).toBe('MOA'); // the documentType override, not whatever OCR guessed on its own
    expect(doc.institution).toMatch(/Partnership Persistence University/);
    // The physical file truly exists where fileLink says it does — not a dangling DB-only reference.
    expect(doc.fileLink).toMatch(/^\/uploads\/documents\//);
    const onDisk = path.join(__dirname, '..', doc.fileLink.replace(/^\//, ''));
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  test('that same document is retrievable through the normal, RBAC-checked Document Library API — not a side channel', async () => {
    const res = await agent.get('/api/documents');
    expect(res.status).toBe(200);
    const mine = res.body.find(d => d.id === createdDocIds[0]);
    expect(mine).toBeTruthy();
    expect(mine.partnershipId).toBe(partnershipId);
  });

  test('a non-integer or absent partnershipId is simply omitted, not stored as a bogus value (API-level abuse guard)', async () => {
    const img2 = path.join(__dirname, '..', 'uploads', 'tmp', `${TEST_TAG}-partnership-doc2-${Date.now()}.png`);
    await sharp({ create: { width: 700, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: Buffer.from(`<svg width="700" height="200"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="24" font-family="sans-serif">MEMORANDUM OF UNDERSTANDING</text><text x="20" y="110" font-size="20" font-family="sans-serif">between CSPC and ${TEST_TAG} Abuse Guard College.</text></svg>`), top: 0, left: 0 }])
      .png().toFile(img2);
    const jobId2 = await extractAndWait(img2);
    const res = await agent.post('/api/ocr/confirm').send({ jobId: jobId2, partnershipId: 'not-a-number; DROP' });
    expect(res.status).toBe(200);
    createdDocIds.push(res.body.documentId);
    const doc = await db.collection('documents').findOne({ id: res.body.documentId });
    expect(doc.partnershipId).toBeUndefined();
    fs.rmSync(img2, { force: true });
  });
});

describe('The Add New Partnership modal\'s OCR panel help text is honest about when the file is actually archived', () => {
  test('no longer claims the file "is safely archived" before the partnership is even saved', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'monitoring.ejs'), 'utf8');
    const panel = view.slice(view.indexOf('id="ocr-panel"'), view.indexOf('id="ocr-panel"') + 2000);
    expect(panel).toMatch(/once you save the partnership/i);
  });
});

describe('Client-side wiring: registry-gridjs.init.js confirms/discards the OCR job correctly (source-level — the actual save flow is browser-tested live)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'pages', 'registry-gridjs.init.js'), 'utf8');

  test('submitPartnership() only confirms the OCR job AFTER /api/partnerships reports success, with the real saved values', () => {
    expect(src).toContain('var jobIdToConfirm = ocrJobId;');
    expect(src).toContain('confirmOcrDocument(jobIdToConfirm, inst, type, data.partnership.id);');
    // The confirm call is textually inside the res.ok&&data&&data.success branch, not before it.
    const successBranch = src.slice(src.indexOf('if(res.ok&&data&&data.success){'), src.indexOf('} else {', src.indexOf('if(res.ok&&data&&data.success){')));
    expect(successBranch).toContain('confirmOcrDocument(');
  });

  test('a document-archive failure never claims the partnership itself failed to save', () => {
    expect(src).toContain('Partnership saved, but the uploaded document could not be added to the Document Library');
  });

  test('closing the modal or starting a new extraction discards an unconfirmed job instead of leaking it', () => {
    expect(src).toContain('function discardOcrJob()');
    expect(src.match(/discardOcrJob\(\)/g).length).toBeGreaterThanOrEqual(4); // its own definition + startOcrExtraction + dismissOcrResult + hidden.bs.modal
  });
});
