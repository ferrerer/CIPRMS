// Covers the 2026-08-27 draft/document collaboration workflow: reviewers
// (Administrator/Staff) and the request's own submitter (Auth.
// Personnel/potential_partner) can each add a new version to a Partnership
// Request's supportingDocuments history via the same widened
// POST /api/requests/:id/documents route, with a note, uploader identity,
// and role recorded — never replacing a previous version. Also covers the
// ownership boundary (a different user's request must be unreachable) and
// the terminal-status upload guard.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

// Smallest possible buffer that satisfies verifyMagicBytes' PNG signature
// check (it only reads the first 8 bytes) — a real image isn't needed to
// exercise the upload/route/history logic under test here.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

let adminAgent, staffAgent, submitterAgent, otherAgent;
let submitterUser, staffUser, requestId;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);
  submitterUser = await createTestUser({ role: 'potential_partner' });
  submitterAgent = request.agent(app);
  await loginAs(submitterAgent, submitterUser);
  otherAgent = request.agent(app);
  await loginAs(otherAgent, await createTestUser({ role: 'potential_partner' }));

  const res = await submitterAgent.post('/api/requests').send({
    institution: 'Jest Test Draft Collaboration University', country: 'Testland',
    type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  requestId = res.body.request.id;
});

afterAll(async () => {
  const db = await connectDB();
  if (requestId) {
    // Cleans up both the versions this test explicitly uploaded AND any
    // placeholder Document Library entry the pre-existing "auto-archive a
    // submission with no attachment" behavior creates on POST /api/requests
    // (unrelated to this feature, but still this test's residue to clear).
    // Physical files must be unlinked BEFORE the DB records are deleted —
    // once gone, cleanupAll()'s own uploadedByEmail-based sweep can no
    // longer find their fileLink to clean them up itself, which is exactly
    // how this test used to leave real PNG files orphaned on every run.
    const linked = await db.collection('documents').find({ requestId, requestType: 'partnership' }).toArray();
    await Promise.all(linked.map((doc) => {
      if (!doc.fileLink || !doc.fileLink.startsWith('/uploads/documents/')) return null;
      return fs.promises.unlink(path.join(DOCUMENTS_DIR, path.basename(doc.fileLink))).catch(() => {});
    }));
    await db.collection('documents').deleteMany({ requestId, requestType: 'partnership' });
    await db.collection('requests').deleteOne({ id: requestId });
  }
  await cleanupAll();
  await closeDB();
});

test('Staff (reviewer) uploads a draft version with a note — recorded with full metadata, request moves to Under Review', async () => {
  const res = await staffAgent
    .post(`/api/requests/${requestId}/documents`)
    .field('note', 'Please revise Article 4.')
    .attach('document', PNG_HEADER, 'revision-v2.png');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.status).toBe('Under Review');
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(1);
  expect(docs[0].note).toBe('Please revise Article 4.');
  expect(docs[0].uploaderRole).toBe('Staff');
  expect(docs[0].originalFilename).toBe('revision-v2.png');
  expect(typeof docs[0].fileSize).toBe('number');
  expect(docs[0].fileType).toBe('image/png');
});

// Document Library attribution fix (2026-09-14 follow-up): the request's own
// supportingDocuments entry above already correctly recorded Staff as the
// uploader — but the SEPARATE Document Library archive record this same
// upload creates used to always be attributed to the requester
// (target.submittedByEmail), so Staff's own upload never appeared in their
// own Document Library. This proves the fix: the archive record now belongs
// to the reviewer who actually uploaded it, and is correctly absent from the
// requester's own library.
test('Document Library attribution: Staff\'s reviewer upload above appears in STAFF\'s own library, not the requester\'s', async () => {
  // GET /api/documents is itself scoped to `uploadedByEmail === session.email`
  // server-side, so checking each agent's own response can never prove
  // anything about the OTHER agent's data by construction — the real
  // assertion has to be the raw record's uploadedByEmail field, queried
  // directly, which is exactly what the fix changed.
  const db = await connectDB();
  const archived = await db.collection('documents')
    .find({ requestType: 'partnership', requestId }).sort({ id: -1 }).limit(1).toArray();
  expect(archived.length).toBe(1);
  expect(archived[0].uploadedByEmail).toBe(staffUser.email); // the actual fix
  expect(archived[0].uploadedByEmail).not.toBe(submitterUser.email);

  // And Staff's own scoped Document Library view does pick it up.
  const staffLib = await staffAgent.get('/api/documents');
  expect(staffLib.body.some(d => d.id === archived[0].id)).toBe(true);
});

test('The requester (owner) can upload their own revised draft — appended, not replacing the previous version', async () => {
  const res = await submitterAgent
    .post(`/api/requests/${requestId}/documents`)
    .field('note', 'Article 4 updated per your comments.')
    .attach('document', PNG_HEADER, 'revision-v3.png');

  expect(res.status).toBe(200);
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(2); // v2 from Staff still present, v3 appended
  expect(docs[0].originalFilename).toBe('revision-v2.png');
  expect(docs[1].originalFilename).toBe('revision-v3.png');
  expect(docs[1].uploaderRole).toBe('potential_partner');
  expect(docs[1].note).toBe('Article 4 updated per your comments.');
});

// 2026-09-19: the file/image attachment became OPTIONAL — notes alone are a
// legitimate new version. This proves the notes-only path is accepted, saved
// with full metadata, appears in the version history, and creates NO
// Document Library record (nothing was actually uploaded to archive).
test('A notes-only version (no file) is accepted and appended to the history', async () => {
  const db = await connectDB();
  const beforeDocsCount = await db.collection('documents').countDocuments({ requestType: 'partnership', requestId });

  const res = await staffAgent
    .post(`/api/requests/${requestId}/documents`)
    .field('note', 'Updated the agreement details based on the latest review.');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.documentId).toBeNull();
  expect(res.body.fileLink).toBeNull();
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(3); // v2 (Staff), v3 (submitter), and this notes-only v4
  const notesOnly = docs[2];
  expect(notesOnly.note).toBe('Updated the agreement details based on the latest review.');
  expect(notesOnly.uploaderRole).toBe('Staff');
  expect(notesOnly.uploadedByEmail).toBe(staffUser.email);
  expect(notesOnly.uploadedAt).toBeTruthy();
  expect(notesOnly.documentId).toBeNull();
  expect(notesOnly.fileLink).toBeNull();
  expect(notesOnly.originalFilename).toBeNull();
  expect(notesOnly.fileType).toBeNull();
  expect(notesOnly.fileSize).toBe(0);

  // No new Document Library record was created for this notes-only version.
  const afterDocsCount = await db.collection('documents').countDocuments({ requestType: 'partnership', requestId });
  expect(afterDocsCount).toBe(beforeDocsCount);
});

test('A completely empty submission (no file, no note) is rejected — file-optional does not mean content-optional', async () => {
  const res = await staffAgent.post(`/api/requests/${requestId}/documents`).field('note', '');
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/file.*note|note.*file/i);
});

test('A different user cannot upload to someone else\'s request (ownership enforced server-side)', async () => {
  const res = await otherAgent
    .post(`/api/requests/${requestId}/documents`)
    .field('note', 'should be blocked')
    .attach('document', PNG_HEADER, 'intruder.png');
  expect(res.status).toBe(403);
});

test('Reviewer upload notifies the requester; requester upload notifies the reviewers', async () => {
  const db = await connectDB();
  const submitterNotifs = await db.collection('notifications').find({ targetEmail: submitterUser.email }).toArray();
  expect(submitterNotifs.some(n => n.title && n.title.includes('New draft uploaded'))).toBe(true);

  const adminNotifs = await db.collection('notifications').find({
    title: { $regex: 'Revised draft uploaded' },
    desc: { $regex: 'Jest Test Draft Collaboration University' }
  }).toArray();
  expect(adminNotifs.length).toBeGreaterThan(0);
});

test('Activity log records the note text for a draft upload', async () => {
  const db = await connectDB();
  const logs = await db.collection('activitylogs').find({ record: { $regex: 'Please revise Article 4' } }).toArray();
  expect(logs.length).toBeGreaterThan(0);
});

test('Uploads are blocked once the request has been decided', async () => {
  const decideRes = await adminAgent.patch(`/api/requests/${requestId}`).send({ status: 'Approved' });
  expect(decideRes.status).toBe(200);

  const uploadRes = await staffAgent
    .post(`/api/requests/${requestId}/documents`)
    .field('note', 'too late')
    .attach('document', PNG_HEADER, 'too-late.png');
  expect(uploadRes.status).toBe(400);
});
