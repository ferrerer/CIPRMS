const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { findPossibleDuplicates, DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db;
let adminAgent, staffAgent, otherStaffAgent;
let adminUser, staffUser, otherStaffUser;
const seededDocIds = [];

async function nextId() {
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  return last.length ? last[0].id + 1 : 1;
}

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app);
  await loginAs(adminAgent, adminUser);

  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);

  otherStaffUser = await createTestUser({ role: 'Staff' });
  otherStaffAgent = request.agent(app);
  await loginAs(otherStaffAgent, otherStaffUser);
});

afterAll(async () => {
  for (const id of seededDocIds) {
    const doc = await db.collection('documents').findOne({ id });
    if (doc && doc.fileLink && doc.fileLink.startsWith('/uploads/documents/')) {
      const filePath = path.join(DOCUMENTS_DIR, path.basename(doc.fileLink));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
  if (seededDocIds.length) {
    await db.collection('documents').deleteMany({ id: { $in: seededDocIds } });
  }
  await cleanupAll();
  await closeDB();
});

describe('Document Duplicate Detection (findPossibleDuplicates)', () => {
  test('flags exact fileHash match with 100% confidence even if metadata differs', async () => {
    const sampleHash = crypto.createHash('sha256').update('exact-content-blob-12345').digest('hex');
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Agreement with Tokyo University',
      type: 'MOA',
      institution: 'Tokyo University',
      fileHash: sampleHash,
      fileLink: '/uploads/documents/tokyo-moa.pdf',
      originalFilename: 'tokyo-moa.pdf',
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const result = await findPossibleDuplicates(
      db,
      { institution: 'Tokyo Univ', documentType: 'MOU' },
      { fileHash: sampleHash, originalName: 'scanned_doc_rename.pdf' }
    );

    expect(result.found).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches.find((m) => m.id === id);
    expect(match).toBeDefined();
    expect(match.matchPercentage).toBe(100);
    expect(match.reasons.some((r) => /exact sha-256 hash/i.test(r))).toBe(true);
    expect(match.title).toBe('Agreement with Tokyo University');
    expect(match.type).toBe('MOA');
  });

  test('flags duplicate when extracted text has high token overlap (>45%) and institution matches', async () => {
    const docText = 'This Memorandum of Agreement is entered into by and between Camarines Sur Polytechnic Colleges and Kyoto Institute of Technology for collaborative academic research faculty exchange and student development program.';
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Kyoto Institute Collaboration MOA',
      type: 'MOA',
      institution: 'Kyoto Institute of Technology',
      rawText: docText,
      fileLink: '/uploads/documents/kyoto-moa.pdf',
      originalFilename: 'kyoto-moa.pdf',
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const incomingOcrText = 'MEMORANDUM OF AGREEMENT Kyoto Institute of Technology and Camarines Sur Polytechnic Colleges for collaborative academic research faculty exchange and student development program.';
    const result = await findPossibleDuplicates(
      db,
      {
        institution: 'Kyoto Institute of Technology',
        documentType: 'MOA',
        rawText: incomingOcrText
      },
      { originalName: 'kyoto_scan_copy.pdf' }
    );

    expect(result.found).toBe(true);
    const match = result.matches.find((m) => m.id === id);
    expect(match).toBeDefined();
    expect(match.reasons.some((r) => /text.*similarity/i.test(r))).toBe(true);
    expect(match.matchPercentage).toBeGreaterThanOrEqual(70);
  });

  test('prevents false positives: different institutions sharing document type MOA are NOT duplicates', async () => {
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Singha University MOA',
      type: 'MOA',
      institution: 'Singha University',
      fileLink: '/uploads/documents/singha-moa.pdf',
      originalFilename: 'singha-moa.pdf',
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const result = await findPossibleDuplicates(
      db,
      {
        institution: 'Harvard University',
        documentType: 'MOA'
      },
      { originalName: 'harvard_agreement.pdf' }
    );

    const match = result.matches.find((m) => m.id === id);
    expect(match).toBeUndefined();
  });

  test('prevents false positives: same institution with different types (MOU vs MOA) and distinct files without content overlap is not duplicate', async () => {
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Osaka University General MOU',
      type: 'MOU',
      institution: 'Osaka University',
      rawText: 'General cooperation agreement framework.',
      fileLink: '/uploads/documents/osaka-mou.pdf',
      originalFilename: 'osaka-mou.pdf',
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const result = await findPossibleDuplicates(
      db,
      {
        institution: 'Osaka University',
        documentType: 'Letter of Intent (LOI)',
        rawText: 'Proposal to initiate partnership discussions and exchange exploratory visits.'
      },
      { originalName: 'osaka_loi_proposal.pdf' }
    );

    const match = result.matches.find((m) => m.id === id);
    expect(match).toBeUndefined();
  });

  test('returns rich comparison metadata in matches array', async () => {
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Rich Metadata Test Agreement',
      type: 'MOA',
      institution: 'Auckland Polytechnic',
      startDate: '2026-01-01',
      endDate: '2031-01-01',
      fileLink: '/uploads/documents/auckland.pdf',
      originalFilename: 'auckland-original.pdf',
      uploadedAt: '2026-06-15T10:00:00.000Z'
    });
    seededDocIds.push(id);

    const result = await findPossibleDuplicates(
      db,
      {
        institution: 'Auckland Polytechnic',
        documentType: 'MOA'
      },
      { originalName: 'auckland-copy.pdf' }
    );

    expect(result.found).toBe(true);
    const match = result.matches.find((m) => m.id === id);
    expect(match).toBeDefined();
    expect(match).toHaveProperty('id', id);
    expect(match).toHaveProperty('title', 'Rich Metadata Test Agreement');
    expect(match).toHaveProperty('type', 'MOA');
    expect(match).toHaveProperty('institution', 'Auckland Polytechnic');
    expect(match).toHaveProperty('validity');
    expect(match).toHaveProperty('originalFilename', 'auckland-original.pdf');
    expect(match).toHaveProperty('uploadedAt');
    expect(match).toHaveProperty('fileLink', '/uploads/documents/auckland.pdf');
    expect(Array.isArray(match.reasons)).toBe(true);
    expect(typeof match.matchPercentage).toBe('number');
  });
});

describe('Document Upload Discard (DELETE /api/documents/:id)', () => {
  test('allows uploader to discard/delete their uploaded document and physical file', async () => {
    const id = await nextId();
    const testFileName = `test-discard-${Date.now()}.pdf`;
    const testFilePath = path.join(DOCUMENTS_DIR, testFileName);
    fs.writeFileSync(testFilePath, 'dummy pdf file content for discard test');

    await db.collection('documents').insertOne({
      id,
      title: 'Discardable Upload Test',
      type: 'MOA',
      institution: 'Discard Univ',
      fileLink: `/uploads/documents/${testFileName}`,
      uploadedByEmail: staffUser.email,
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    expect(fs.existsSync(testFilePath)).toBe(true);

    const res = await staffAgent.delete(`/api/documents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify document was removed from database
    const doc = await db.collection('documents').findOne({ id });
    expect(doc).toBeNull();

    // Verify physical file was unlinked
    expect(fs.existsSync(testFilePath)).toBe(false);
  });

  test('blocks non-uploader without Administrator role from deleting someone else document (403)', async () => {
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Protected Staff Document',
      type: 'MOU',
      institution: 'Protected Univ',
      uploadedByEmail: staffUser.email,
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const res = await otherStaffAgent.delete(`/api/documents/${id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only delete your own/i);

    // Document should still exist
    const doc = await db.collection('documents').findOne({ id });
    expect(doc).not.toBeNull();
  });

  test('Administrator can discard/delete any document regardless of who uploaded it', async () => {
    const id = await nextId();
    await db.collection('documents').insertOne({
      id,
      title: 'Staff Upload Cleaned by Admin',
      type: 'Contract',
      institution: 'Admin Cleanup Univ',
      uploadedByEmail: staffUser.email,
      uploadedAt: new Date().toISOString()
    });
    seededDocIds.push(id);

    const res = await adminAgent.delete(`/api/documents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const doc = await db.collection('documents').findOne({ id });
    expect(doc).toBeNull();
  });
});

describe('Shared Drag & Drop Uploader Helper (public/js/ciprms-uploader.js)', () => {
  test('file exists and contains CIPRMS.initDropzone definition', () => {
    const scriptPath = path.join(__dirname, '..', 'public', 'js', 'ciprms-uploader.js');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('CIPRMS.initDropzone');
    expect(content).toContain('ciprms-dropzone');
    expect(content).toContain('ciprms-dropzone-dragover');
    expect(content).toContain('DataTransfer');
  });
});
