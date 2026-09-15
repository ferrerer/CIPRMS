// Covers the 2026-08-27 draft/document collaboration workflow: reviewers
// (Administrator/Staff) and the request's own submitter (Auth.
// Personnel/potential_partner) can each add a new version to a Partnership
// Request's supportingDocuments history via the same widened
// POST /api/requests/:id/documents route, with a note, uploader identity,
// and role recorded — never replacing a previous version. Also covers the
// ownership boundary (a different user's request must be unreachable) and
// the terminal-status upload guard.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

// Smallest possible buffer that satisfies verifyMagicBytes' PNG signature
// check (it only reads the first 8 bytes) — a real image isn't needed to
// exercise the upload/route/history logic under test here.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

let adminAgent, staffAgent, submitterAgent, otherAgent;
let submitterUser, requestId;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
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
