// Covers the thesis's Black-Box Table 5 "Digital Workflow Module": Submit
// Partnership Request, Track Request Status, plus the self-service Withdraw
// endpoint (added this session) and its ownership boundary.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let submitterAgent, otherAgent, staffAgent, requestId;
const institution = 'Jest Test Requests University';

beforeAll(async () => {
  await connectDB();
  submitterAgent = request.agent(app);
  await loginAs(submitterAgent, await createTestUser({ role: 'potential_partner' }));
  otherAgent = request.agent(app);
  await loginAs(otherAgent, await createTestUser({ role: 'potential_partner' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (requestId) await db.collection('requests').deleteOne({ id: requestId });
  await cleanupAll();
  await closeDB();
});

test('Submit Partnership Request: potential_partner can submit one', async () => {
  const res = await submitterAgent.post('/api/requests').send({
    institution, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.status).toBe('Pending');
  requestId = res.body.request.id;
});

// Reversed 2026-08-27 — Staff can no longer submit Partnership Requests at all
// (the "+ New Partnership Request" button and its form were removed); every
// request-mutating route now uses requireRequester, which excludes Staff.
test('Submit Partnership Request: Staff cannot submit one (requireRequester excludes Staff)', async () => {
  const res = await staffAgent.post('/api/requests').send({
    institution: 'Jest Test Requests University (Staff, should be blocked)',
    country: 'Testland', type: 'MOU', nature: 'Research', notes: 'jesttest staff blocked'
  });
  expect(res.status).toBe(302); // requireRequester redirects non-requester roles
});

test('Duplicate active request for the same institution is rejected', async () => {
  const res = await otherAgent.post('/api/requests').send({
    institution, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest duplicate'
  });
  expect(res.status).toBe(409);
});

test('Track Request Status: the submitter sees it in their own request list', async () => {
  const res = await submitterAgent.get('/api/requests/mine');
  expect(res.status).toBe(200);
  const found = res.body.find(r => r.id === requestId);
  expect(found).toBeDefined();
  expect(found.institution).toBe(institution);
});

test('A different user cannot withdraw someone else\'s request', async () => {
  const res = await otherAgent.post(`/api/requests/${requestId}/withdraw`);
  expect(res.status).toBe(403);
});

test('A non-admin cannot approve/reject a request (PATCH is Administrator-only)', async () => {
  const res = await submitterAgent.patch(`/api/requests/${requestId}`).send({ status: 'Approved' });
  expect(res.status).toBe(302); // requireAdmin redirects non-admins
});

test('The original submitter can withdraw their own pending request', async () => {
  const res = await submitterAgent.post(`/api/requests/${requestId}/withdraw`);
  expect(res.status).toBe(200);
  expect(res.body.request.status).toBe('Withdrawn');
});

test('Withdrawing an already-withdrawn request is rejected', async () => {
  const res = await submitterAgent.post(`/api/requests/${requestId}/withdraw`);
  expect(res.status).toBe(400);
});

// 2026-08-27 full-parity revision: Staff shares Administrator's exact
// Approve/Reject authority and org-wide visibility over every submitted
// request — confirmed against a request submitted by a THIRD user Staff
// never interacted with, to prove this is real reviewer access, not an
// ownership-scoped coincidence.
describe('Requests full parity: Staff reviews like Administrator', () => {
  let reviewSubmitterAgent, staffRequestReviewId;
  const reviewInstitution = 'Jest Test Requests University (Staff Review Parity)';

  beforeAll(async () => {
    reviewSubmitterAgent = request.agent(app);
    await loginAs(reviewSubmitterAgent, await createTestUser({ role: 'potential_partner' }));
    const res = await reviewSubmitterAgent.post('/api/requests').send({
      institution: reviewInstitution, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
    });
    staffRequestReviewId = res.body.request.id;
  });

  afterAll(async () => {
    const db = await connectDB();
    if (staffRequestReviewId) await db.collection('requests').deleteOne({ id: staffRequestReviewId });
  });

  test('Staff sees every submitted request, not just their own (GET /api/requests)', async () => {
    const res = await staffAgent.get('/api/requests');
    expect(res.status).toBe(200);
    expect(res.body.some(r => r.id === staffRequestReviewId)).toBe(true);
  });

  test('Staff can approve a request submitted by someone else', async () => {
    const res = await staffAgent.patch(`/api/requests/${staffRequestReviewId}`).send({ status: 'Approved' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.request.status).toBe('Approved');
  });
});
