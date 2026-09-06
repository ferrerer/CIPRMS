// Covers the 2026-09-04 change: approving a (non-renewal) Partnership Request
// no longer flips its status directly — it hands off to Registry → Add New
// Partnership (pre-filled), and the request is only marked Approved/linked
// once that partnership is actually saved via POST /api/partnerships with a
// sourceRequestId. See cirl.js's POST /api/partnerships handler.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, staffAgent, submitterAgent;
let createdRequestIds = [];
let createdPartnershipIds = [];

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  submitterAgent = request.agent(app);
  await loginAs(submitterAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (createdPartnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: createdPartnershipIds } });
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  await db.collection('notifications').deleteMany({ title: { $regex: 'jesttest Conversion' } });
  await cleanupAll();
  await closeDB();
});

async function submitRequest(agent, institution) {
  const res = await agent.post('/api/requests').send({
    institution, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  createdRequestIds.push(res.body.request.id);
  return res.body.request;
}

test('Approving a new (non-renewal) request via POST /api/partnerships creates the partnership and marks the request Approved+linked', async () => {
  const reqEntry = await submitRequest(submitterAgent, 'jesttest Conversion University A');

  const res = await adminAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.alreadyConverted).toBeFalsy();
  const partnershipId = res.body.partnership.id;
  createdPartnershipIds.push(partnershipId);
  expect(res.body.partnership.sourceRequestId).toBe(reqEntry.id);

  const db = await connectDB();
  const updatedRequest = await db.collection('requests').findOne({ id: reqEntry.id });
  expect(updatedRequest.status).toBe('Approved');
  expect(updatedRequest.linkedPartnershipId).toBe(partnershipId);

  // Single source of truth — the same record is immediately visible through
  // the normal Registry list, not a separate/duplicate write.
  const listRes = await adminAgent.get('/api/partnerships');
  expect(listRes.body.some(p => p.id === partnershipId)).toBe(true);
});

test('Re-submitting the same sourceRequestId does not create a duplicate partnership (accidental double-click / re-opened tab)', async () => {
  const reqEntry = await submitRequest(submitterAgent, 'jesttest Conversion University B');

  const first = await adminAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  const firstId = first.body.partnership.id;
  createdPartnershipIds.push(firstId);

  const second = await adminAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  expect(second.status).toBe(200);
  expect(second.body.success).toBe(true);
  expect(second.body.alreadyConverted).toBe(true);
  expect(second.body.partnership.id).toBe(firstId);

  const db = await connectDB();
  const count = await db.collection('partnerships').countDocuments({ sourceRequestId: reqEntry.id });
  expect(count).toBe(1);
});

test('A request already Rejected cannot be converted', async () => {
  const reqEntry = await submitRequest(submitterAgent, 'jesttest Conversion University C');
  await adminAgent.patch(`/api/requests/${reqEntry.id}`).send({ status: 'Rejected' });

  const res = await adminAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  expect(res.status).toBe(409);

  const db = await connectDB();
  const count = await db.collection('partnerships').countDocuments({ sourceRequestId: reqEntry.id });
  expect(count).toBe(0);
});

test('A non-existent sourceRequestId is rejected with 404 and creates nothing', async () => {
  const res = await adminAgent.post('/api/partnerships').send({
    inst: 'jesttest Conversion Ghost University', country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: 99999999
  });
  expect(res.status).toBe(404);

  const db = await connectDB();
  const found = await db.collection('partnerships').findOne({ inst: 'jesttest Conversion Ghost University' });
  expect(found).toBeNull();
});

test('Staff has full parity: can convert a request into a partnership the same way Administrator does', async () => {
  const reqEntry = await submitRequest(submitterAgent, 'jesttest Conversion University D (Staff)');

  const res = await staffAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOU', nature: 'Research',
    cat: 'International', unit: ['CCS', 'CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  createdPartnershipIds.push(res.body.partnership.id);

  const db = await connectDB();
  const updatedRequest = await db.collection('requests').findOne({ id: reqEntry.id });
  expect(updatedRequest.status).toBe('Approved');
  expect(updatedRequest.linkedPartnershipId).toBe(res.body.partnership.id);
});

test('The submitter is notified once the request is converted to a Registry partnership', async () => {
  const reqEntry = await submitRequest(submitterAgent, 'jesttest Conversion University E');

  const res = await adminAgent.post('/api/partnerships').send({
    inst: reqEntry.institution, country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030',
    remarks: 'jesttest', sourceRequestId: reqEntry.id
  });
  createdPartnershipIds.push(res.body.partnership.id);

  const db = await connectDB();
  const updatedRequest = await db.collection('requests').findOne({ id: reqEntry.id });
  const notif = await db.collection('notifications').findOne({
    targetEmail: updatedRequest.submittedByEmail,
    title: { $regex: reqEntry.institution.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  });
  expect(notif).toBeTruthy();
});

test('Ordinary partnership creation (no sourceRequestId) still works unchanged', async () => {
  const res = await adminAgent.post('/api/partnerships').send({
    inst: 'jesttest Plain Manual University', country: 'Testland', region: 'Asia', type: 'MOA', nature: 'Research',
    cat: 'International', unit: ['CIRL'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.partnership.sourceRequestId).toBeUndefined();
  createdPartnershipIds.push(res.body.partnership.id);
});
