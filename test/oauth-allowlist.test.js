// Verifies the strict allowlist authorization policy (2026-09-05):
// authenticating via Google/CSPC only proves WHO a person is — it must
// never itself grant a CIPRMS session or role. Only an email an
// Administrator/Staff has already created in User Management (an existing,
// Active `users` record) may pass through /auth/google/callback into an
// authorized session.
//
// No real Google network call is exercised here, matching this project's
// established convention for OAuth-adjacent tests (see the header comment
// in test/google-calendar.test.js) — a live OAuth consent screen requires a
// human and cannot be driven headlessly. Instead, passport itself is
// mocked so that passport.authenticate('google', ...) hands the real
// cirl.js callback handler a synthetic Google profile built from the
// `x-test-google-email` test header. Every line of the actual allowlist
// logic in cirl.js (lookup → status check → session creation) still runs
// exactly as it would for a real login; only the network round-trip to
// Google is replaced.
jest.mock('passport', () => ({
  initialize: () => (req, res, next) => next(),
  session: () => (req, res, next) => next(),
  use: () => {},
  serializeUser: () => {},
  deserializeUser: () => {},
  authenticate: (strategy, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    return (req, res, next) => {
      if (!callback) return res.redirect('/'); // /auth/google itself — unused by these tests
      const testEmail = req.headers['x-test-google-email'];
      if (!testEmail) return callback(null, false, { message: 'no test identity supplied' });
      return callback(null, {
        id: 'test-google-id-' + testEmail,
        displayName: req.headers['x-test-google-name'] || 'Test Google User',
        emails: [{ value: testEmail }]
      }, null);
    };
  }
}));

const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, cleanupAll, uniqueEmail } = require('./helpers');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Google OAuth allowlist — /auth/google/callback', () => {
  test('TEST 3: an authenticated Google identity with no matching CIPRMS user is rejected — no session, no auto-created account', async () => {
    const unknownEmail = uniqueEmail('unknownggl');
    const agent = request.agent(app);

    const res = await agent.get('/auth/google/callback').set('x-test-google-email', unknownEmail);
    expect(res.status).toBe(200); // re-renders index with an error, never a redirect into the app
    expect(res.text).toMatch(/not authorized to access CIPRMS/i);

    const created = await db.collection('users').findOne({ email: unknownEmail });
    expect(created).toBeNull();

    // No authorized CIPRMS session exists — protected pages and APIs must reject it,
    // not merely fail to show a link to them.
    const dashRes = await agent.get('/dashboard');
    expect(dashRes.status).toBe(302);
    expect(dashRes.headers.location).toBe('/');

    const lifecycleRes = await agent.get('/lifecycle');
    expect(lifecycleRes.status).toBe(302);

    const staffLifecycleRes = await agent.get('/staff/lifecycle');
    expect(staffLifecycleRes.status).toBe(302);

    const reportsRes = await agent.get('/reports');
    expect(reportsRes.status).toBe(302);

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(302);

    const usersApiRes = await agent.get('/api/users');
    expect(usersApiRes.status).toBe(302);
  });

  test('email matching is case-insensitive and whitespace-trimmed, but still requires an existing record', async () => {
    const agent = request.agent(app);
    const res = await agent.get('/auth/google/callback').set('x-test-google-email', '  StillUnknown.jesttest@Example.com  ');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/not authorized to access CIPRMS/i);
  });

  test('TEST 1 / TEST 2: an authorized, Active Staff user succeeds via Google and loads their real CIPRMS role', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);

    // Uppercased on purpose — proves matching normalizes case rather than requiring an exact stored-case match.
    const res = await agent.get('/auth/google/callback').set('x-test-google-email', user.email.toUpperCase());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/dashboard');

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.role).toBe('Staff');
    expect(meRes.body.user.email).toBe(user.email);

    // Role comes from the CIPRMS record, never from the Google profile itself.
    const usersApiRes = await agent.get('/api/users');
    expect(usersApiRes.status).toBe(200);
  });

  test('TEST 1: an authorized Administrator succeeds via Google and retains Administrator access', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);

    const res = await agent.get('/auth/google/callback').set('x-test-google-email', admin.email);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');

    const dashRes = await agent.get('/dashboard');
    expect(dashRes.status).toBe(200);
  });

  test('TEST 4: an Inactive CIPRMS user is denied even with a valid, matching Google identity, and no session is created', async () => {
    const user = await createTestUser({ role: 'Staff' });
    await db.collection('users').updateOne({ id: user.id }, { $set: { status: 'Inactive' } });
    const agent = request.agent(app);

    const res = await agent.get('/auth/google/callback').set('x-test-google-email', user.email);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/inactive/i);

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(302);

    const dashRes = await agent.get('/staff/dashboard');
    expect(dashRes.status).toBe(302);
  });

  test('TEST 5: a Staff account authorized via Google still cannot reach an Administrator-only page', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await agent.get('/auth/google/callback').set('x-test-google-email', user.email);

    const res = await agent.get('/registry'); // Administrator-only since 2026-07-23
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/dashboard');
  });

  test('a deleted/never-authorized identity cannot be revived by hitting the callback a second time', async () => {
    const email = uniqueEmail('neverexisted');
    const agent = request.agent(app);
    await agent.get('/auth/google/callback').set('x-test-google-email', email);
    await agent.get('/auth/google/callback').set('x-test-google-email', email);

    const created = await db.collection('users').findOne({ email });
    expect(created).toBeNull();
  });
});

describe('Public self-registration (/signup) is disabled', () => {
  test('POST /signup never creates an account or session, regardless of input', async () => {
    const email = uniqueEmail('shouldnotexist');
    const agent = request.agent(app);

    const res = await agent.post('/signup').type('form').send({
      username: 'Should Not Exist', email, password: 'StrongPass1', confirmPassword: 'StrongPass1'
    });
    expect(res.status).toBe(200); // re-renders /signup with the disabled notice, never a redirect
    expect(res.text).toMatch(/self-registration is disabled/i);

    const created = await db.collection('users').findOne({ email });
    expect(created).toBeNull();

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(302); // requireAuth redirect — confirms no session was created
  });

  test('GET /signup still renders without crashing (route kept, not 404, but leads nowhere)', async () => {
    const res = await request(app).get('/signup');
    expect(res.status).toBe(200);
  });
});
