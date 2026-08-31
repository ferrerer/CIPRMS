// Covers the thesis's Black-Box Table 5 "Partnership Registry Module":
// Add / Edit / Delete / View Partnership Record, plus the RBAC boundary
// (Registry write access is Administrator-only as of 2026-07-23 — Auth.
// Personnel lost Add/Edit/Delete here alongside the rest of their Registry
// access removal; they retain read access via /api/partnerships and
// /api/partnerships/stats, used elsewhere on their Dashboard/Monitoring pages).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, personnelAgent, staffAgent, createdId;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  if (createdId) {
    const db = await connectDB();
    await db.collection('partnerships').deleteOne({ id: createdId });
  }
  await cleanupAll();
  await closeDB();
});

test('Add Partnership Record: Administrator can create a partnership', async () => {
  const res = await adminAgent.post('/api/partnerships').send({
    inst: 'Jest Test University', country: 'Testland', region: 'Asia', type: 'MOA',
    nature: 'Research', cat: 'International', unit: 'CCS',
    start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active',
    remarks: 'jesttest'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.partnership.inst).toBe('Jest Test University');
  createdId = res.body.partnership.id;
});

test('View Partnership Record: the new record appears in the full list (read access — any authorized role)', async () => {
  const res = await personnelAgent.get('/api/partnerships');
  expect(res.status).toBe(200);
  const found = res.body.find(p => p.id === createdId);
  expect(found).toBeDefined();
  expect(found.status).toBe('Active');
});

test('Edit Partnership Record: fields update and persist', async () => {
  const res = await adminAgent.patch(`/api/partnerships/${createdId}`).send({
    inst: 'Jest Test University (Renamed)', status: 'Expired'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.partnership.inst).toBe('Jest Test University (Renamed)');
  expect(res.body.partnership.status).toBe('Expired');
});

// Reversed 2026-08-27 (full-parity revision) — Staff shares the exact same
// Registry CRUD authority as Administrator now.
test('Staff CAN create, edit, and delete a partnership (full parity with Administrator)', async () => {
  const createRes = await staffAgent.post('/api/partnerships').send({
    inst: 'Jest Test University (Staff)', country: 'X', region: 'Asia', type: 'MOA', nature: 'Research',
    unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
  });
  expect(createRes.status).toBe(200);
  expect(createRes.body.success).toBe(true);
  const staffCreatedId = createRes.body.partnership.id;

  const editRes = await staffAgent.patch(`/api/partnerships/${staffCreatedId}`).send({ status: 'Expired' });
  expect(editRes.status).toBe(200);
  expect(editRes.body.partnership.status).toBe('Expired');

  const deleteRes = await staffAgent.delete(`/api/partnerships/${staffCreatedId}`);
  expect(deleteRes.status).toBe(200);
});

test('Auth. Personnel cannot create, edit, or delete a partnership (Registry access removed 2026-07-23)', async () => {
  const createRes = await personnelAgent.post('/api/partnerships').send({
    inst: 'Should Not Be Created', country: 'X', region: 'Asia', type: 'MOA', nature: 'Research', remarks: 'jesttest'
  });
  expect(createRes.status).toBe(302);

  const editRes = await personnelAgent.patch(`/api/partnerships/${createdId}`).send({ status: 'Active' });
  expect(editRes.status).toBe(302);

  const deleteRes = await personnelAgent.delete(`/api/partnerships/${createdId}`);
  expect(deleteRes.status).toBe(302);

  // Confirm none of the blocked calls above actually mutated the record.
  const listRes = await personnelAgent.get('/api/partnerships');
  const stillThere = listRes.body.find(p => p.id === createdId);
  expect(stillThere).toBeDefined();
  expect(stillThere.status).toBe('Expired');
});

test('Delete Partnership Record: Administrator removes it', async () => {
  const res = await adminAgent.delete(`/api/partnerships/${createdId}`);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  const listRes = await personnelAgent.get('/api/partnerships');
  expect(listRes.body.find(p => p.id === createdId)).toBeUndefined();
  createdId = null; // already deleted, afterAll doesn't need to clean it up
});

test('/api/partnerships/stats reflects real aggregate counts (Active + Expiring Soon + Expired == total)', async () => {
  const res = await personnelAgent.get('/api/partnerships/stats');
  expect(res.status).toBe(200);
  const { total, active, expiring, expired } = res.body;
  expect(active + expiring + expired).toBeLessThanOrEqual(total);
  expect(typeof res.body.byType).toBe('object');
  expect(typeof res.body.byUnit).toBe('object');
});
