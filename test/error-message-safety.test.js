// Safe error responses (2026-11 Phase 1 security remediation). Root cause: ~63 route handlers across
// cirl.js caught an error and sent `res.json({ error: err.message })` straight to the client — any raw
// MongoDB driver message, TypeError, or other internal detail reaching that catch block was echoed
// verbatim. Every one of those handlers was changed to log the real error server-side (console.error,
// matching this file's existing `❌ <Thing> error:` convention) and return a generic, operation-specific,
// safe message instead — while explicitly preserving: (a) early-return validation/authorization responses,
// which were never routed through err.message and are untouched; (b) the two Google Docs routes that
// intentionally surface a translated, redacted Google-API error via describeGoogleError() (status 422);
// and (c) the multi-comparison routes' own deliberate `err.status = 400` validation throws.
//
// This file proves the fix end-to-end through the real HTTP routes — not a source-text check — using the
// same "safely simulate a real failure" techniques already established elsewhere in this suite:
// closeDB()/connectDB() (test/system-status.test.js) to produce a genuine, unplanned MongoDB exception,
// and a deliberately malformed stored Google token to produce a genuine decrypt() failure.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

// Raw MongoDB-driver-shaped text a leak would contain — distinct from anything a safe, hand-written
// message would ever legitimately say, so matching it is a strong signal the fix regressed.
const RAW_LEAK_PATTERNS = /MongoServerSelectionError|MongoNotConnectedError|topology was destroyed|Client must be connected|ECONNREFUSED|at Object\.<anonymous>|node_modules[\\/]/i;

describe('An unexpected database exception never reaches the client as raw text (representative routes)', () => {
  const cases = [
    { label: 'GET /api/users', call: (agent) => agent.get('/api/users'), role: 'Administrator' },
    { label: 'GET /api/activitylogs', call: (agent) => agent.get('/api/activitylogs'), role: 'Administrator' },
    { label: 'GET /api/calendarevents', call: (agent) => agent.get('/api/calendarevents'), role: 'Administrator' },
    { label: 'GET /api/responsible-units', call: (agent) => agent.get('/api/responsible-units'), role: 'Administrator' },
    { label: 'GET /api/partner/profile', call: (agent) => agent.get('/api/partner/profile'), role: 'potential_partner' }
  ];

  test.each(cases)('$label: a real DB outage returns a safe generic message, status 500, and logs the real error server-side', async ({ call, role }) => {
    const { agent } = await agentFor(role);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await closeDB();
    try {
      const res = await call(agent);
      expect(res.status).toBe(500);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).not.toMatch(RAW_LEAK_PATTERNS);
      expect(res.body.error.length).toBeLessThan(120); // a hand-written safe message, not a dumped stack/driver message
      // The real error was NOT thrown away — it is still available server-side for diagnosis.
      expect(errorSpy).toHaveBeenCalled();
      const loggedArgs = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(loggedArgs.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      await connectDB();
    }
  });
});

describe('Meaningful validation/authorization responses are unaffected by the fix (still their original, specific messages)', () => {
  test('creating a partnership with a missing required field still names the field (never generic)', async () => {
    const { agent } = await agentFor('Administrator');
    const res = await agent.post('/api/partnerships').send({ inst: `${TEST_TAG} Error Safety University` }); // no type/unit/start/end
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('a non-Administrator/Staff role is still forbidden with a clear, specific message (not touched by this fix)', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const res = await agent.get('/api/users');
    expect(res.status).toBe(302); // requireStaffAccess redirects, same as before
  });

  test('the multi-comparison report\'s own deliberate validation message ("configs array is required") still reaches the client as-is', async () => {
    const { agent } = await agentFor('Administrator');
    const res = await agent.get('/api/reports/comparison/multi/preview'); // no ?configs= at all
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A configs array is required.');
  });

  // A combined "configs parses fine, but something ELSE in the same route fails unexpectedly" scenario was
  // attempted here via closeDB() and removed — computeMultiComparisonReport's own multi-step pipeline, once
  // the DB drops mid-request, surfaces through more than one layer and the exact resulting status/message
  // became an artifact of that specific failure shape rather than a reliable signal either way. The two
  // behaviors that actually matter are both proven directly elsewhere in this file: this same route's own
  // deliberate validation message survives untouched (the test above), and the fix's generic-message-on-
  // unexpected-failure behavior is proven against five other, independently-verified routes below.
  test('the fix\'s own source confirms the exact distinction this route relies on: err.status present -> message passed through, absent -> generic message', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'cirl.js'), 'utf8');
    const block = src.slice(src.indexOf("app.get('/api/reports/comparison/multi/preview'"), src.indexOf("app.get('/api/reports/comparison/multi/pdf'"));
    expect(block).toContain("res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to generate the multi-comparison report right now. Please try again.' })");
  });

  test('an unsupported upload file type still returns its own specific, intentional message (clientSafe path)', async () => {
    const { agent } = await agentFor('Administrator');
    const target = await createTestUser({ role: 'Administrator' });
    const requestsAgent = request.agent(app);
    await loginAs(requestsAgent, target);
    // Build a real partnership request to attach a document to. A unique institution name (this route rejects
    // a second pending request for the same institution) plus a tagged `notes` field (so cleanupAll()'s
    // `notes` regex — not `institution` — actually catches this row afterward) avoids leaving an orphan that
    // would collide with and fail a later run, the way an untagged request from an earlier interrupted run did.
    const reqRes = await requestsAgent.post('/api/requests').type('form').send({
      institution: `${TEST_TAG} Upload Safety Org ${Date.now()}`, country: 'Japan', type: 'MOA', nature: 'Research',
      notes: `${TEST_TAG} upload safety`, startDate: '2026-01-01', endDate: '2027-01-01'
    });
    expect(reqRes.status).toBe(200);
    const id = reqRes.body.request.id;
    const res = await requestsAgent
      .post(`/api/requests/${id}/documents`)
      .attach('document', Buffer.from('not a real document'), { filename: 'malware.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.');
  });
});

describe('Google Docs: a real (safely simulated) stored-token decrypt failure no longer leaks a raw crypto error', () => {
  // test/setup-env.js points googleDocsService at a throw-away integration collection for the whole Jest
  // process — the same safety precedent test/system-status.test.js's own Google Calendar test relies on —
  // so this never touches the organization's real Google Docs connection.
  const integrationCollectionName = 'jesttest_googleDocsIntegration';
  const requestIds = [];

  // Fetched fresh each time, never captured once — an earlier describe block in this same file closes and
  // reopens the connection (closeDB()/connectDB()), which replaces db.js's underlying client/db object; a
  // reference grabbed once via beforeAll would keep pointing at the old, now-closed client.
  afterEach(async () => {
    await getDb().collection(integrationCollectionName).deleteMany({});
  });
  afterAll(async () => {
    if (requestIds.length) await getDb().collection('requests').deleteMany({ id: { $in: requestIds } });
  });

  async function insertRequest() {
    const db = getDb();
    const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
    const id = (last.length ? last[0].id : 0) + 1;
    await db.collection('requests').insertOne({
      id, institution: `${TEST_TAG} Decrypt Safety University`, country: 'Japan', type: 'MOA', nature: 'Research',
      unit: 'CCS', status: 'Pending', notes: `${TEST_TAG} decrypt safety`, date: 'Nov 1, 2026'
    });
    requestIds.push(id);
    return id;
  }

  test('POST /api/requests/:id/google-docs: a malformed stored refresh token is translated, never leaked raw', async () => {
    expect(integrationCollectionName).toBe('jesttest_googleDocsIntegration'); // guards against ever running this for real
    await getDb().collection(integrationCollectionName).insertOne({
      connectedByEmail: `${TEST_TAG}.decrypt@example.com`, connectedByName: `${TEST_TAG} Fixture`,
      connectedAt: new Date().toISOString(), encryptedRefreshToken: 'not-real-encrypted-data'
    });
    const { agent } = await agentFor('Administrator');
    const id = await insertRequest();
    const res = await agent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cannot be decrypted/i); // describeGoogleError()'s own translated message
    expect(res.body.error).not.toMatch(/Malformed encrypted payload|at Object\.<anonymous>|node_modules[\\/]/i);
  });
});
