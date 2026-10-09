// GET /api/system-status (services/systemStatusService.js) — a real, reusable availability check reusing
// each integration's OWN existing signal (googleCalendarService/googleDocsService's lastSyncOk, emailService's
// isConfigured()/verify(), a live MongoDB ping) rather than a parallel fictional monitoring system. This
// file proves: it is open to every authenticated role (not Administrator-only, unlike the detailed
// /api/google-*/status routes it deliberately does not replace), it reports the real state of this
// environment's services, and a real failure — simulated safely via this process's own DB connection, and
// via a disposable integration-status document, never a real outage — is reported per-feature, with
// everything else still reported available and unrelated endpoints still fully usable.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const systemStatusService = require('../services/systemStatusService');
const emailService = require('../services/emailService');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('GET /api/system-status — availability and shape', () => {
  test('an unauthenticated request is rejected, not served', async () => {
    const res = await request(app).get('/api/system-status');
    expect(res.status).toBe(302);
  });

  test.each(['Administrator', 'Staff', 'Auth. Personnel', 'potential_partner'])(
    '%s can read it — this is intentionally open to every signed-in role, not Administrator-only', async (role) => {
      const { agent } = await agentFor(role);
      const res = await agent.get('/api/system-status');
      expect(res.status).toBe(200);
      expect(typeof res.body.coreAvailable).toBe('boolean');
      // "not_configured" is a legitimate, milder-than-"degraded" overall state — e.g. this real environment
      // has no MAIL_USER/MAIL_APP_PASSWORD set, so email is the worst thing reported, not a real failure.
      expect(['available', 'not_configured', 'degraded', 'unavailable']).toContain(res.body.overall);
      expect(Array.isArray(res.body.services)).toBe(true);
      const keys = res.body.services.map(s => s.key);
      expect(keys).toEqual(expect.arrayContaining(['database', 'googleCalendar', 'googleDocs', 'email', 'ocr']));
      for (const s of res.body.services) {
        expect(['available', 'degraded', 'not_configured', 'unavailable']).toContain(s.state);
        expect(typeof s.label).toBe('string');
        expect(typeof s.message).toBe('string');
      }
    });

  test('reflects this real environment correctly: database up, email not configured here (no MAIL_USER/MAIL_APP_PASSWORD set)', async () => {
    const { agent } = await agentFor('Administrator');
    const res = await agent.get('/api/system-status');
    const byKey = Object.fromEntries(res.body.services.map(s => [s.key, s]));
    expect(byKey.database.state).toBe('available');
    expect(byKey.email.state).toBe('not_configured');
    expect(byKey.ocr.state).toBe('available');
    expect(res.body.coreAvailable).toBe(true);
    // Email being unconfigured is a real, non-"available" entry — the aggregate must reflect it rather than
    // silently reporting a clean "available" for the whole app (the false-reassurance half of brief §16).
    expect(res.body.overall).not.toBe('available');
  });

  test('never exposes account-linking detail the admin-only /api/google-calendar/status route carries (connectedByEmail, redirect URI)', async () => {
    const { agent } = await agentFor('Staff');
    const res = await agent.get('/api/system-status');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/connectedByEmail|redirectUri|googleAccountEmail/);
  });
});

describe('GET /api/system-status — a real (safely simulated) database outage', () => {
  test('reports coreAvailable:false / overall:"unavailable" while the database is down, and recovers immediately once it is back — never a stale cached failure', async () => {
    const { agent } = await agentFor('Administrator');
    expect((await agent.get('/api/system-status')).body.coreAvailable).toBe(true);

    await closeDB();
    try {
      const down = await agent.get('/api/system-status');
      expect(down.status).toBe(200); // the status check itself must never 500/crash just because the thing it is checking is down
      expect(down.body.coreAvailable).toBe(false);
      expect(down.body.overall).toBe('unavailable');
      const db = down.body.services.find(s => s.key === 'database');
      expect(db.state).toBe('unavailable');
    } finally {
      await connectDB();
    }

    const recovered = await agent.get('/api/system-status');
    expect(recovered.body.coreAvailable).toBe(true);
    expect(recovered.body.services.find(s => s.key === 'database').state).toBe('available');
  });

  test('checkDatabase() in isolation agrees with the route (same signal, directly unit-testable)', async () => {
    expect((await systemStatusService.checkDatabase()).state).toBe('available');
    await closeDB();
    try {
      expect((await systemStatusService.checkDatabase()).state).toBe('unavailable');
    } finally {
      await connectDB();
    }
    expect((await systemStatusService.checkDatabase()).state).toBe('available');
  });
});

describe('GET /api/system-status — a degraded (not fully down) Google integration does not affect unrelated features', () => {
  // test/setup-env.js points the real service at a throw-away collection name for the whole Jest process
  // specifically so no test can ever read/write/wipe the organization's real Google Calendar connection —
  // reusing that exact env var here (rather than the real collection name) is what keeps this test on the
  // same safe footing as googleCalendarService.js itself.
  const integrationCollectionName = process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION;

  afterEach(async () => {
    await getDb().collection(integrationCollectionName).deleteMany({});
  });

  test('a real lastSyncOk:false integration record is reported as "degraded", clears once fixed, and an unrelated endpoint stays fully usable throughout', async () => {
    expect(integrationCollectionName).toBe('jesttest_googleCalendarIntegration'); // guards against ever running this against the real collection
    const { agent } = await agentFor('Administrator');
    const db = getDb();
    const col = db.collection(integrationCollectionName);

    await col.deleteMany({}); // this is a single-document integration record in the real app
    await col.insertOne({
      connectedByEmail: `${TEST_TAG}.gcal@example.com`, connectedByName: `${TEST_TAG} Fixture`, connectedAt: new Date().toISOString(),
      lastSyncOk: false, lastSyncError: 'invalid_grant', lastSyncAt: new Date().toISOString()
    });

    const degraded = await agent.get('/api/system-status');
    const gcal = degraded.body.services.find(s => s.key === 'googleCalendar');
    expect(gcal.state).toBe('degraded');
    expect(gcal.message).toMatch(/invalid_grant/);
    expect(degraded.body.coreAvailable).toBe(true); // one degraded integration is not "CIPRMS is down" (brief §11)
    expect(degraded.body.services.find(s => s.key === 'database').state).toBe('available');

    // an unrelated, unrelated-to-Google feature keeps working exactly as if nothing were wrong
    const unrelated = await agent.get('/api/me');
    expect(unrelated.status).toBe(200);

    await col.updateOne({ connectedByEmail: `${TEST_TAG}.gcal@example.com` }, { $set: { lastSyncOk: true, lastSyncError: null } });
    const fixed = await agent.get('/api/system-status');
    expect(fixed.body.services.find(s => s.key === 'googleCalendar').state).toBe('available');
  });
});

describe('GET /api/system-status — email state transitions (mocked SMTP sign-in, never a real send)', () => {
  // This real environment has no MAIL_USER/MAIL_APP_PASSWORD set, so "configured" + "verify() outcome"
  // can only be exercised by temporarily substituting emailService's own exported functions — the same
  // monkey-patch-then-restore pattern test/centralized-notification-system.test.js already uses for
  // sendNotificationEmails. Nothing here ever calls the real nodemailer transporter or sends mail.
  const originalIsConfigured = emailService.isConfigured;
  const originalVerify = emailService.verify;
  afterEach(() => {
    emailService.isConfigured = originalIsConfigured;
    emailService.verify = originalVerify;
  });

  test('missing configuration is reported as "not_configured", not a failure', async () => {
    emailService.isConfigured = () => false;
    expect((await systemStatusService.checkEmail()).state).toBe('not_configured');
  });

  test('valid configuration + a successful provider sign-in check is reported as "available"', async () => {
    emailService.isConfigured = () => true;
    emailService.verify = async () => ({ ok: true });
    const result = await systemStatusService.checkEmail();
    expect(result.state).toBe('available');
    expect(result.message).toBe('Connected.');
  });

  test('valid configuration + a provider sign-in failure is reported as "unavailable", surfacing the real reason', async () => {
    emailService.isConfigured = () => true;
    emailService.verify = async () => ({ ok: false, error: 'Invalid login: 535-5.7.8 Username and Password not accepted.' });
    const result = await systemStatusService.checkEmail();
    expect(result.state).toBe('unavailable');
    expect(result.message).toBe('Invalid login: 535-5.7.8 Username and Password not accepted.');
  });

  test('a provider verify() that hangs past the timeout is reported as "unavailable", never left pending forever', async () => {
    emailService.isConfigured = () => true;
    emailService.verify = () => new Promise(() => {}); // never resolves — proves the timeout wrapper, not emailService.verify, ends this
    const result = await systemStatusService.checkEmail();
    expect(result.state).toBe('unavailable');
  }, 10000);

  test('end-to-end via the route: fixing a reported credential failure clears the warning, and an unrelated endpoint stays usable throughout', async () => {
    const user = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, user);

    emailService.isConfigured = () => true;
    emailService.verify = async () => ({ ok: false, error: 'Invalid login: 535-5.7.8 Username and Password not accepted.' });
    const broken = await agent.get('/api/system-status');
    expect(broken.status).toBe(200);
    const emailEntry = broken.body.services.find(s => s.key === 'email');
    expect(emailEntry.state).toBe('unavailable');
    expect(emailEntry.message).toMatch(/Username and Password not accepted/);
    expect(broken.body.coreAvailable).toBe(true); // email failing is not "CIPRMS is down"
    expect((await agent.get('/api/me')).status).toBe(200); // unrelated feature is unaffected

    // "Retry" is just this same GET again — proving it is a real recheck, not a cached/stale answer.
    emailService.verify = async () => ({ ok: true });
    const fixed = await agent.get('/api/system-status');
    expect(fixed.body.services.find(s => s.key === 'email').state).toBe('available');
  });
});
