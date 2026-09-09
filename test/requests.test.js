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

// UI/UX + Data Display Consistency fix — Administrator → Partnership Requests
// (partnership_requests.ejs) renders GET /api/requests's response in the
// exact order returned, with no client-side re-sort (prData.filter() never
// reorders), so the newest-first default has to be enforced here, server-side.
describe('GET /api/requests — newest-first default ordering', () => {
  let orderIds = [];

  afterAll(async () => {
    if (orderIds.length) {
      const db = await connectDB();
      await db.collection('requests').deleteMany({ id: { $in: orderIds } });
      orderIds = [];
    }
  });

  async function submit(institution) {
    const res = await submitterAgent.post('/api/requests').send({
      institution, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
    });
    expect(res.status).toBe(200);
    orderIds.push(res.body.request.id);
    return res.body.request.id;
  }

  test('Newest request (highest id — this collection has no createdAt, and updatedAt is overwritten on every review action) appears before older ones', async () => {
    const idA = await submit('Jest Test Ordering Requests University A (oldest)');
    const idB = await submit('Jest Test Ordering Requests University B (middle)');
    const idC = await submit('Jest Test Ordering Requests University C (newest)');

    const res = await staffAgent.get('/api/requests');
    expect(res.status).toBe(200);
    const ids = res.body.map(r => r.id);
    const posA = ids.indexOf(idA), posB = ids.indexOf(idB), posC = ids.indexOf(idC);
    expect(posC).toBeLessThan(posB);
    expect(posB).toBeLessThan(posA);
    expect(res.body[0].id).toBe(idC);

    const idD = await submit('Jest Test Ordering Requests University D (newest of all)');
    const res2 = await staffAgent.get('/api/requests');
    expect(res2.body[0].id).toBe(idD);
  });

  test('Approving/rejecting an older request (which touches updatedAt) does not move it to the top', async () => {
    const idOld = await submit('Jest Test Ordering Requests University OLD (to be approved)');
    const idNew = await submit('Jest Test Ordering Requests University NEW (submitted after)');

    // Approve the OLDER request — this updates its updatedAt/decidedBy, but
    // must not change its position relative to the newer, untouched request.
    const patchRes = await staffAgent.patch(`/api/requests/${idOld}`).send({ status: 'Approved' });
    expect(patchRes.status).toBe(200);

    const res = await staffAgent.get('/api/requests');
    const ids = res.body.map(r => r.id);
    expect(ids.indexOf(idNew)).toBeLessThan(ids.indexOf(idOld));
  });

  test('Ordering is strictly descending by id across the entire result set, not just the test records', async () => {
    const res = await staffAgent.get('/api/requests');
    const ids = res.body.map(r => r.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]).toBeGreaterThan(ids[i]);
    }
  });
});
