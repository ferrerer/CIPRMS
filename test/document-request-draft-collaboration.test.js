// Covers the 2026-08-27 Document Request draft/document collaboration
// workflow — the Document Request analog of
// test/request-draft-collaboration.test.js. Reviewers (Administrator/Staff)
// and an owning potential_partner submitter can each add a new version to a
// Document Request's supportingDocuments history via the same widened POST
// /api/document-requests/:id/documents route, with a note, uploader
// identity, and role recorded — never replacing a previous version.
// 2026-09-22: College Dean (role "Auth. Personnel") lost upload rights on
// its own Document Requests — it may only submit and track drafts, not add
// new versions; that stays reviewer/potential_partner-only. Also covers the
// ownership boundary and the terminal-status upload guard.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

// Smallest possible buffer that satisfies verifyMagicBytes' PNG signature
// check (it only reads the first 8 bytes).
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

let adminAgent, staffAgent, submitterAgent, otherAgent, partnerAgent;
let submitterUser, otherUser, staffUser, partnerUser, requestId, partnerRequestId;
let v1FileLink, v2FileLink;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);
  submitterUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  submitterAgent = request.agent(app);
  await loginAs(submitterAgent, submitterUser);
  otherUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  otherAgent = request.agent(app);
  await loginAs(otherAgent, otherUser);
  partnerUser = await createTestUser({ role: 'potential_partner' });
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, partnerUser);

  const res = await submitterAgent.post('/api/document-requests').send({
    institution: 'Jest Test DR Draft Collaboration Inst', documentType: 'MOA', notes: 'jesttest'
  });
  requestId = res.body.request.id;

  const partnerRes = await partnerAgent.post('/api/document-requests').send({
    institution: 'Jest Test DR Partner Draft Collaboration Inst', documentType: 'MOU', notes: 'jesttest partner'
  });
  partnerRequestId = partnerRes.body.request.id;
});

afterAll(async () => {
  const db = await connectDB();
  // Physical files must be unlinked BEFORE the DB records are deleted — see
  // the matching comment in request-draft-collaboration.test.js.
  for (const id of [requestId, partnerRequestId]) {
    if (!id) continue;
    const linked = await db.collection('documents').find({ requestId: id, requestType: 'document' }).toArray();
    await Promise.all(linked.map((doc) => {
      if (!doc.fileLink || !doc.fileLink.startsWith('/uploads/documents/')) return null;
      return fs.promises.unlink(path.join(DOCUMENTS_DIR, path.basename(doc.fileLink))).catch(() => {});
    }));
    await db.collection('documents').deleteMany({ requestId: id, requestType: 'document' });
    await db.collection('documentrequests').deleteOne({ id });
  }
  await cleanupAll();
  await closeDB();
});

test('Staff (reviewer) uploads a draft version with a note — recorded with full metadata, request auto-advances Received to Preparing', async () => {
  const res = await staffAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Please revise section 2.')
    .attach('document', PNG_HEADER, 'reviewed-document.png');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.status).toBe('Preparing');
  expect(res.body.request.statusHistory[res.body.request.statusHistory.length - 1]).toEqual(
    expect.objectContaining({ from: 'Received', to: 'Preparing' })
  );
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(1);
  expect(docs[0].note).toBe('Please revise section 2.');
  expect(docs[0].uploaderRole).toBe('Staff');
  expect(docs[0].originalFilename).toBe('reviewed-document.png');
  expect(typeof docs[0].fileSize).toBe('number');
  expect(docs[0].fileType).toBe('image/png');
  v1FileLink = docs[0].fileLink;
});

// Document Library attribution fix (2026-09-14 follow-up) — see the matching
// test in request-draft-collaboration.test.js for the Partnership Request
// analog and full rationale.
test('Document Library attribution: Staff\'s reviewer upload above appears in STAFF\'s own library, not the requester\'s', async () => {
  const db = await connectDB();
  const archived = await db.collection('documents')
    .find({ requestType: 'document', requestId }).sort({ id: -1 }).limit(1).toArray();
  expect(archived.length).toBe(1);
  expect(archived[0].uploadedByEmail).toBe(staffUser.email); // the actual fix
  expect(archived[0].uploadedByEmail).not.toBe(submitterUser.email);

  const staffLib = await staffAgent.get('/api/documents');
  expect(staffLib.body.some(d => d.id === archived[0].id)).toBe(true);
});

// 2026-09-22: College Dean can submit and track a Document Request but no
// longer uploads new versions of its own draft — only a reviewer
// (Administrator/Staff) or an owning potential_partner may.
test('The requester (College Dean / Auth. Personnel) cannot upload a revised draft to their own request', async () => {
  const db = await connectDB();
  const before = await db.collection('documentrequests').findOne({ id: requestId });

  const res = await submitterAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Updated sections 2 and 4.')
    .attach('document', PNG_HEADER, 'revised-document.png');

  expect(res.status).toBe(403);
  const after = await db.collection('documentrequests').findOne({ id: requestId });
  expect(after.supportingDocuments.length).toBe(before.supportingDocuments.length);
});

test('A second reviewer (Administrator) can also add a version — versions accumulate across reviewers', async () => {
  const res = await adminAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Updated sections 2 and 4.')
    .attach('document', PNG_HEADER, 'revised-document.png');

  expect(res.status).toBe(200);
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(2);
  expect(docs[0].originalFilename).toBe('reviewed-document.png');
  expect(docs[1].originalFilename).toBe('revised-document.png');
  expect(docs[1].uploaderRole).toBe('Administrator');
  expect(docs[1].note).toBe('Updated sections 2 and 4.');
  v2FileLink = docs[1].fileLink;
});

test('A potential_partner submitter CAN upload their own revised draft — the Dean-only restriction does not apply to Partner', async () => {
  const res = await partnerAgent
    .post(`/api/document-requests/${partnerRequestId}/documents`)
    .field('note', 'Partner revision.')
    .attach('document', PNG_HEADER, 'partner-revision.png');

  expect(res.status).toBe(200);
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(1);
  expect(docs[0].uploaderRole).toBe('potential_partner');
  expect(docs[0].note).toBe('Partner revision.');
});

describe('Preview + Download: every historical draft, not just the latest', () => {
  test('The original submitter can download v1 (Staff-uploaded) — correct bytes, correct Content-Type, original filename preserved', async () => {
    const res = await submitterAgent.get(v1FileLink);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG_HEADER)).toBe(0); // byte-for-byte, not corrupted
  });

  test('The original submitter can also download v2 (a reviewer\'s later upload) — both versions remain independently accessible', async () => {
    const res = await submitterAgent.get(v2FileLink);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG_HEADER)).toBe(0);
  });

  test('Administrator and Staff can download any version (reviewer full access)', async () => {
    const adminV1 = await adminAgent.get(v1FileLink);
    expect(adminV1.status).toBe(200);
    const staffV2 = await staffAgent.get(v2FileLink);
    expect(staffV2.status).toBe(200);
  });

  test('An unrelated user cannot download either version via direct URL, even without ever attempting an upload', async () => {
    const res1 = await otherAgent.get(v1FileLink);
    expect(res1.status).toBe(403);
    const res2 = await otherAgent.get(v2FileLink);
    expect(res2.status).toBe(403);
  });

  test('An unauthenticated request is redirected, not served the file', async () => {
    const res = await request(app).get(v1FileLink);
    expect(res.status).toBe(302);
  });
});

// 2026-09-19: the file/image attachment became OPTIONAL — notes alone are a
// legitimate new version, same rule as the Partnership Request analog in
// request-draft-collaboration.test.js.
test('A notes-only version (no file) is accepted and appended to the history', async () => {
  const db = await connectDB();
  const beforeDocsCount = await db.collection('documents').countDocuments({ requestType: 'document', requestId });

  const res = await staffAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Updated the agreement details based on the latest review.');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.documentId).toBeNull();
  expect(res.body.fileLink).toBeNull();
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(3); // v1 (Staff), v2 (Administrator), and this notes-only v3
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

  const afterDocsCount = await db.collection('documents').countDocuments({ requestType: 'document', requestId });
  expect(afterDocsCount).toBe(beforeDocsCount);
});

test('A completely empty submission (no file, no note) is rejected — file-optional does not mean content-optional', async () => {
  const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`).field('note', '');
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/file.*note|note.*file/i);
});

test('A different user cannot upload to someone else\'s document request (ownership enforced server-side)', async () => {
  const res = await otherAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'should be blocked')
    .attach('document', PNG_HEADER, 'intruder.png');
  expect(res.status).toBe(403);
});

test('Reviewer upload notifies the requester; a partner\'s own upload notifies the reviewers', async () => {
  const db = await connectDB();
  const submitterNotifs = await db.collection('notifications').find({ targetEmail: submitterUser.email }).toArray();
  expect(submitterNotifs.some(n => n.title && n.title.includes('New draft uploaded'))).toBe(true);

  const reviewerNotifs = await db.collection('notifications').find({
    title: { $regex: 'Revised draft uploaded' },
    desc: { $regex: 'Jest Test DR Partner Draft Collaboration Inst' }
  }).toArray();
  expect(reviewerNotifs.length).toBeGreaterThan(0);
});

test('Activity log records the note text for a draft upload', async () => {
  const db = await connectDB();
  const logs = await db.collection('activitylogs').find({ record: { $regex: 'Please revise section 2' } }).toArray();
  expect(logs.length).toBeGreaterThan(0);
});

test('Uploads are blocked once the document request has been decided', async () => {
  // Request is already at 'Preparing' (auto-advanced by the first draft
  // upload above) — walk the rest of the pipeline to its terminal stage.
  await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Awaiting for Approval' });
  await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Approved' });
  await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Release' });
  const decideRes = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Completed' });
  expect(decideRes.status).toBe(200);
  expect(decideRes.body.request.status).toBe('Completed');

  const uploadRes = await staffAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'too late')
    .attach('document', PNG_HEADER, 'too-late.png');
  expect(uploadRes.status).toBe(400);
});
