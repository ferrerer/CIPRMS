// Covers the 2026-08-27 Document Request draft/document collaboration
// workflow — the Document Request analog of
// test/request-draft-collaboration.test.js. Reviewers (Administrator/Staff)
// and the request's own submitter (Auth. Personnel/potential_partner) can
// each add a new version to a Document Request's supportingDocuments
// history via the same widened POST /api/document-requests/:id/documents
// route, with a note, uploader identity, and role recorded — never
// replacing a previous version. Also covers the ownership boundary and the
// terminal-status upload guard.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

// Smallest possible buffer that satisfies verifyMagicBytes' PNG signature
// check (it only reads the first 8 bytes).
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

let adminAgent, staffAgent, submitterAgent, otherAgent;
let submitterUser, otherUser, requestId;
let v1FileLink, v2FileLink;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  submitterUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  submitterAgent = request.agent(app);
  await loginAs(submitterAgent, submitterUser);
  otherUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  otherAgent = request.agent(app);
  await loginAs(otherAgent, otherUser);

  const res = await submitterAgent.post('/api/document-requests').send({
    institution: 'Jest Test DR Draft Collaboration Inst', documentType: 'MOA', notes: 'jesttest'
  });
  requestId = res.body.request.id;
});

afterAll(async () => {
  const db = await connectDB();
  if (requestId) {
    await db.collection('documents').deleteMany({ requestId, requestType: 'document' });
    await db.collection('documentrequests').deleteOne({ id: requestId });
  }
  await cleanupAll();
  await closeDB();
});

test('Staff (reviewer) uploads a draft version with a note — recorded with full metadata, request moves to Under Review', async () => {
  const res = await staffAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Please revise section 2.')
    .attach('document', PNG_HEADER, 'reviewed-document.png');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.status).toBe('Under Review');
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(1);
  expect(docs[0].note).toBe('Please revise section 2.');
  expect(docs[0].uploaderRole).toBe('Staff');
  expect(docs[0].originalFilename).toBe('reviewed-document.png');
  expect(typeof docs[0].fileSize).toBe('number');
  expect(docs[0].fileType).toBe('image/png');
  v1FileLink = docs[0].fileLink;
});

test('The requester (owner) can upload their own revised draft — appended, not replacing the previous version', async () => {
  const res = await submitterAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'Updated sections 2 and 4.')
    .attach('document', PNG_HEADER, 'revised-document.png');

  expect(res.status).toBe(200);
  const docs = res.body.request.supportingDocuments;
  expect(docs.length).toBe(2);
  expect(docs[0].originalFilename).toBe('reviewed-document.png');
  expect(docs[1].originalFilename).toBe('revised-document.png');
  expect(docs[1].uploaderRole).toBe('Auth. Personnel');
  expect(docs[1].note).toBe('Updated sections 2 and 4.');
  v2FileLink = docs[1].fileLink;
});

describe('Preview + Download: every historical draft, not just the latest', () => {
  test('The original submitter can download v1 (Staff-uploaded) — correct bytes, correct Content-Type, original filename preserved', async () => {
    const res = await submitterAgent.get(v1FileLink);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG_HEADER)).toBe(0); // byte-for-byte, not corrupted
  });

  test('The original submitter can also download v2 (their own upload) — both versions remain independently accessible', async () => {
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

test('A different user cannot upload to someone else\'s document request (ownership enforced server-side)', async () => {
  const res = await otherAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'should be blocked')
    .attach('document', PNG_HEADER, 'intruder.png');
  expect(res.status).toBe(403);
});

test('Reviewer upload notifies the requester; requester upload notifies the reviewers', async () => {
  const db = await connectDB();
  const submitterNotifs = await db.collection('notifications').find({ targetEmail: submitterUser.email }).toArray();
  expect(submitterNotifs.some(n => n.title && n.title.includes('New draft uploaded'))).toBe(true);

  const reviewerNotifs = await db.collection('notifications').find({
    title: { $regex: 'Revised draft uploaded' },
    desc: { $regex: 'Jest Test DR Draft Collaboration Inst' }
  }).toArray();
  expect(reviewerNotifs.length).toBeGreaterThan(0);
});

test('Activity log records the note text for a draft upload', async () => {
  const db = await connectDB();
  const logs = await db.collection('activitylogs').find({ record: { $regex: 'Please revise section 2' } }).toArray();
  expect(logs.length).toBeGreaterThan(0);
});

test('Uploads are blocked once the document request has been decided', async () => {
  const decideRes = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Fulfilled' });
  expect(decideRes.status).toBe(200);

  const uploadRes = await staffAgent
    .post(`/api/document-requests/${requestId}/documents`)
    .field('note', 'too late')
    .attach('document', PNG_HEADER, 'too-late.png');
  expect(uploadRes.status).toBe(400);
});
