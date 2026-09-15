// Covers the 2026-09-14 Staff Document Library correction: Administrator and
// Staff each get their own separate Document Library (already true via the
// existing uploadedByEmail-scoped OWN_SCOPE_ROLES filter — untouched here),
// but Staff previously had no way to directly upload/OCR into it at all:
// - views/administrator/documents.ejs gated the "Upload & Extract" button
//   and the entire upload modal behind `user.role === 'Administrator'` even
//   though the backend (requireUploader) already permitted Staff.
// - POST /api/ocr/extract was gated by requireAuth (any authenticated role)
//   rather than the same requireUploader gate the rest of the Document
//   Library routes use — tightened for explicit, future-proof intent.
// This file verifies the backend authorization and the real, live OCR
// pipeline for both Administrator and Staff, plus per-user library isolation.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
let adminUser, staffUser;
const createdDocIds = [];

// A real, Tesseract-readable PNG — same technique used for the health-check
// audit's live OCR verification (rendered SVG text -> raster), so this
// exercises the actual OCR engine, not a mock.
function buildTestImage(label) {
  const svg = `
    <svg width="900" height="260" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="40" y="60" font-family="Arial" font-size="30" font-weight="bold" fill="black">MEMORANDUM OF AGREEMENT</text>
      <text x="40" y="110" font-family="Arial" font-size="20" fill="black">Camarines Sur Polytechnic Colleges and Osaka University of Japan</text>
      <text x="40" y="150" font-family="Arial" font-size="18" fill="black">Uploaded by: ${label}</text>
      <text x="40" y="190" font-family="Arial" font-size="18" fill="black">Date of Signing: Jan 15, 2026</text>
      <text x="40" y="220" font-family="Arial" font-size="18" fill="black">Date of Expiration: Jan 15, 2031</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadAndWait(agent, imageBuffer, filename) {
  const uploadRes = await agent
    .post('/api/ocr/extract')
    .attach('document', imageBuffer, { filename, contentType: 'image/png' });
  expect(uploadRes.status).toBe(202);
  const jobId = uploadRes.body.jobId;

  let job;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const statusRes = await agent.get(`/api/ocr/status/${jobId}`);
    job = statusRes.body;
    if (job.status === 'done' || job.status === 'error') break;
  }
  return job;
}

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app);
  await loginAs(adminAgent, adminUser);
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  for (const id of createdDocIds) {
    const doc = await db.collection('documents').findOne({ id });
    if (doc && doc.fileLink && doc.fileLink.startsWith('/uploads/documents/')) {
      const filePath = path.join(DOCUMENTS_DIR, path.basename(doc.fileLink));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
  if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
  await cleanupAll();
  await closeDB();
});

describe('Backend authorization for OCR/direct upload (RBAC)', () => {
  // Every successful POST /api/ocr/extract starts a real, fire-and-forget
  // background job that archives a real document + physical file regardless
  // of whether the test awaits it (see ocrService.runJob's "always archive"
  // contract) — so each RBAC check here polls to completion and records the
  // documentId, exactly like the E2E tests below, purely so afterAll can
  // actually find and delete what these RBAC-only checks silently create.
  test('Administrator: POST /api/ocr/extract is allowed (202, not blocked)', async () => {
    const img = await buildTestImage('rbac-admin-check');
    const job = await uploadAndWait(adminAgent, img, 'a.png');
    expect(job.status).toBe('done');
    if (job.result && job.result.documentId) createdDocIds.push(job.result.documentId);
  }, 30000);

  test('Staff: POST /api/ocr/extract is allowed (202, not blocked) — the actual bug being fixed', async () => {
    const img = await buildTestImage('rbac-staff-check');
    const job = await uploadAndWait(staffAgent, img, 's.png');
    expect(job.status).toBe('done');
    if (job.result && job.result.documentId) createdDocIds.push(job.result.documentId);
  }, 30000);

  test('Auth. Personnel: OCR access is preserved unchanged (still allowed — not broadened, not revoked)', async () => {
    const img = await buildTestImage('rbac-personnel-check');
    const job = await uploadAndWait(personnelAgent, img, 'p.png');
    expect(job.status).toBe('done');
    if (job.result && job.result.documentId) createdDocIds.push(job.result.documentId);
  }, 30000);

  test('potential_partner: OCR access is preserved unchanged (still allowed — not broadened, not revoked)', async () => {
    const img = await buildTestImage('rbac-partner-check');
    const job = await uploadAndWait(partnerAgent, img, 'pp.png');
    expect(job.status).toBe('done');
    if (job.result && job.result.documentId) createdDocIds.push(job.result.documentId);
  }, 30000);

  test('Unauthenticated: POST /api/ocr/extract is rejected (redirected, never reaches the OCR pipeline)', async () => {
    const img = await buildTestImage('rbac-anon-check');
    const res = await request(app).post('/api/ocr/extract').attach('document', img, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(302); // requireUploader redirect — never starts a job, nothing to clean up
  });

  test('Administrator and Staff can both reach the Document Library listing/folder routes', async () => {
    const adminDocs = await adminAgent.get('/api/documents');
    expect(adminDocs.status).toBe(200);
    const staffDocs = await staffAgent.get('/api/documents');
    expect(staffDocs.status).toBe(200);
    const adminFolders = await adminAgent.get('/api/document-folders/mine');
    expect(adminFolders.status).toBe(200);
    const staffFolders = await staffAgent.get('/api/document-folders/mine');
    expect(staffFolders.status).toBe(200);
  });
});

describe('Real end-to-end OCR pipeline (actual Tesseract, not mocked) for Administrator and Staff', () => {
  test('Administrator: real OCR extracts text, classifies the document, and archives it to their own Document Library', async () => {
    const img = await buildTestImage('E2E Admin Upload');
    const job = await uploadAndWait(adminAgent, img, 'admin-e2e.png');

    expect(job.status).toBe('done');
    expect(job.result.method).toBe('ocr');
    expect(job.result.confidence).toBeGreaterThan(0);
    expect(job.result.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(job.result.documentType).toMatch(/Memorandum of Agreement/i);
    expect(job.result.country).toBe('Japan');
    expect(job.result.documentId).toBeTruthy();
    createdDocIds.push(job.result.documentId);

    const lib = await adminAgent.get('/api/documents');
    const entry = lib.body.find((d) => d.id === job.result.documentId);
    expect(entry).toBeTruthy();
    expect(entry.uploadedByEmail).toBe(adminUser.email);
  }, 45000);

  test('Staff: real OCR extracts text, classifies the document, and archives it to their OWN Document Library', async () => {
    const img = await buildTestImage('E2E Staff Upload');
    const job = await uploadAndWait(staffAgent, img, 'staff-e2e.png');

    expect(job.status).toBe('done');
    expect(job.result.method).toBe('ocr');
    expect(job.result.confidence).toBeGreaterThan(0);
    expect(job.result.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(job.result.documentType).toMatch(/Memorandum of Agreement/i);
    expect(job.result.country).toBe('Japan');
    expect(job.result.documentId).toBeTruthy();
    createdDocIds.push(job.result.documentId);

    const lib = await staffAgent.get('/api/documents');
    const entry = lib.body.find((d) => d.id === job.result.documentId);
    expect(entry).toBeTruthy();
    expect(entry.uploadedByEmail).toBe(staffUser.email);
  }, 45000);

  test('Separate libraries: Administrator does not see Staff\'s OCR upload, and Staff does not see Administrator\'s', async () => {
    // Relies on the two documentIds captured by the previous two tests.
    const [adminDocId, staffDocId] = createdDocIds;
    expect(adminDocId).toBeTruthy();
    expect(staffDocId).toBeTruthy();

    const adminLib = await adminAgent.get('/api/documents');
    expect(adminLib.body.some((d) => d.id === staffDocId)).toBe(false);

    const staffLib = await staffAgent.get('/api/documents');
    expect(staffLib.body.some((d) => d.id === adminDocId)).toBe(false);
  });
});
