// User Management → System Users: newest-added account must appear first by
// default. Administrator and Staff share the exact same page (users.ejs) and
// the exact same GET /api/users query (requireStaffAccess), so this test
// covers both roles against that one shared endpoint.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, staffAgent;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

describe('GET /api/users — newest-first default ordering', () => {
  test('Newest account (highest id — createdAt is a display-only formatted string here, not chronologically sortable) appears before older ones, for both Administrator and Staff', async () => {
    const userA = await createTestUser({ role: 'Staff' }); // oldest
    const userB = await createTestUser({ role: 'Staff' }); // middle
    const userC = await createTestUser({ role: 'Staff' }); // newest

    const adminRes = await adminAgent.get('/api/users');
    expect(adminRes.status).toBe(200);
    const adminIds = adminRes.body.map(u => u.id);
    expect(adminIds.indexOf(userC.id)).toBeLessThan(adminIds.indexOf(userB.id));
    expect(adminIds.indexOf(userB.id)).toBeLessThan(adminIds.indexOf(userA.id));
    expect(adminRes.body[0].id).toBe(userC.id);

    const staffRes = await staffAgent.get('/api/users');
    expect(staffRes.status).toBe(200);
    expect(staffRes.body[0].id).toBe(userC.id);

    const userD = await createTestUser({ role: 'Staff' }); // newest of all
    const res2 = await adminAgent.get('/api/users');
    expect(res2.body[0].id).toBe(userD.id);
  });

  test('Editing an older user\'s profile does not move it to the top (createdAt/id are never touched by PATCH)', async () => {
    const older = await createTestUser({ role: 'Staff' });
    const newer = await createTestUser({ role: 'Staff' });

    const patchRes = await adminAgent.patch(`/api/users/${older.id}`).send({ unit: 'CIRL' });
    expect(patchRes.status).toBe(200);

    const res = await adminAgent.get('/api/users');
    const ids = res.body.map(u => u.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  test('Ordering is strictly descending by id across the entire result set, not just the test records', async () => {
    const res = await adminAgent.get('/api/users');
    const ids = res.body.map(u => u.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]).toBeGreaterThan(ids[i]);
    }
  });

  test('Staff sees the exact same newest-first order as Administrator (same endpoint, same query)', async () => {
    const adminRes = await adminAgent.get('/api/users');
    const staffRes = await staffAgent.get('/api/users');
    expect(staffRes.body.map(u => u.id)).toEqual(adminRes.body.map(u => u.id));
  });
});
