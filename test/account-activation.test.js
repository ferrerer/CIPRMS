// A new account made in User Management → Add User must fill up the activation form (Department/College,
// Institution, Designation, Contact Number) on first sign-in before it can see anything in the system.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, getDb } = require('./helpers');

const createdEmails = [];
beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  // Accounts made through POST /api/users carry a real createdAt date, so cleanupAll() would not sweep them.
  if (createdEmails.length) await getDb().collection('users').deleteMany({ email: { $in: createdEmails } });
  await cleanupAll();
  await closeDB();
});

async function adminAgent() {
  const admin = await createTestUser({ role: 'Administrator' });
  const agent = request.agent(app);
  await loginAs(agent, admin);
  return agent;
}

async function newAccount(admin, role = 'Auth. Personnel') {
  const email = uniqueEmail('activate');
  createdEmails.push(email);
  const made = await admin.post('/api/users').send({ name: 'jesttest Activate', email, role, password: 'TestPass123' });
  expect(made.status).toBe(200);
  expect(made.body.user.activated).toBe(false);
  const agent = request.agent(app);
  const login = await agent.post('/login').type('form').send({ username: email, password: 'TestPass123' });
  return { agent, email, login };
}

const DETAILS = { unit: 'CCS', institution: 'Camarines Sur Polytechnic Colleges', position: 'Coordinator', contactNumber: '0917-123-4567' };

describe('Account activation on first sign-in', () => {
  test('a new account lands on the activation form and cannot reach any page or API until activated', async () => {
    const admin = await adminAgent();
    const { agent, login } = await newAccount(admin);
    expect(login.headers.location).toBe('/activate');

    const page = await agent.get('/activate');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Complete Your Account Setup');

    const home = await agent.get('/personnel/monitoring');
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe('/activate');

    const api = await agent.get('/api/partnerships/mine');
    expect(api.status).toBe(403);
    expect(api.body.code).toBe('ACTIVATION_REQUIRED');
  });

  test('all four details are required, and a valid contact number', async () => {
    const admin = await adminAgent();
    const { agent, email } = await newAccount(admin);
    for (const missing of Object.keys(DETAILS)) {
      const res = await agent.post('/api/activate').send({ ...DETAILS, [missing]: '' });
      expect(res.status).toBe(400);
    }
    expect((await agent.post('/api/activate').send({ ...DETAILS, contactNumber: 'call me' })).status).toBe(400);
    expect((await getDb().collection('users').findOne({ email })).activated).toBe(false);
  });

  test('activating saves the details and opens the system', async () => {
    const admin = await adminAgent();
    const { agent, email } = await newAccount(admin);
    const res = await agent.post('/api/activate').send(DETAILS);
    expect(res.body).toMatchObject({ success: true, redirect: '/personnel/monitoring' });

    const stored = await getDb().collection('users').findOne({ email });
    expect(stored).toMatchObject({ ...DETAILS, activated: true });

    expect((await agent.get('/personnel/monitoring')).status).toBe(200);
    const again = await agent.get('/activate');
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe('/personnel/monitoring');
  });

  test('User Management cannot flip the activation flag, and existing accounts without the flag are unaffected', async () => {
    const admin = await adminAgent();
    const { email } = await newAccount(admin);
    const stored = await getDb().collection('users').findOne({ email });
    expect((await admin.patch('/api/users/' + stored.id).send({ activated: true })).status).toBe(200);
    expect((await getDb().collection('users').findOne({ email })).activated).toBe(false);

    // createTestUser() inserts a record with no `activated` field — like every account made before this feature.
    const legacy = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    const login = await loginAs(agent, legacy);
    expect(login.headers.location).toBe('/staff/dashboard');
  });
});
