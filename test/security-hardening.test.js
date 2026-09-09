// 2026-09-06 security hardening pass (Phase 0 inspection -> approved fixes).
// One consolidated file for this pass's regression coverage, grouped by
// finding, rather than scattering a few tests each across many new files.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail } = require('./helpers');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Finding #1 — session email spoofing via profile forms', () => {
  test('POST /api/admin/profile ignores a submitted email — session identity never changes', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);

    const spoofEmail = uniqueEmail('spoofedadmin');
    const res = await agent.post('/api/admin/profile').send({
      name: 'Renamed Admin', email: spoofEmail, dept: 'CIRL', position: 'Head', institution: 'CSPC'
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBe(admin.email); // echoed value is the REAL session email, not the spoofed one

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(admin.email);

    // No account was created/altered for the spoofed email.
    expect(await db.collection('users').findOne({ email: spoofEmail })).toBeNull();
  });

  test('POST /api/personnel/profile ignores a submitted email — session identity never changes', async () => {
    const personnel = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, personnel);

    const spoofEmail = uniqueEmail('spoofedpersonnel');
    const res = await agent.post('/api/personnel/profile').send({
      name: 'Renamed Personnel', email: spoofEmail, dept: 'CCS', position: 'Coordinator', institution: 'CSPC'
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBe(personnel.email);

    const meRes = await agent.get('/api/me');
    expect(meRes.body.user.email).toBe(personnel.email);
    expect(await db.collection('users').findOne({ email: spoofEmail })).toBeNull();
  });

  test('POST /api/staff/profile ignores a submitted email — session identity never changes', async () => {
    const staff = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, staff);

    const spoofEmail = uniqueEmail('spoofedstaff');
    const res = await agent.post('/api/staff/profile').send({
      name: 'Renamed Staff', email: spoofEmail, dept: 'CIRL', position: 'Assistant', institution: 'CSPC'
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBe(staff.email);

    const meRes = await agent.get('/api/me');
    expect(meRes.body.user.email).toBe(staff.email);
    expect(await db.collection('users').findOne({ email: spoofEmail })).toBeNull();
  });

  test('A spoofed session email cannot be used to read another user\'s data via ownership-scoped routes', async () => {
    // Victim owns a draft request; attacker tries to "become" the victim via
    // the profile form, then reach the victim's own-scoped data.
    const victim = await createTestUser({ role: 'Auth. Personnel' });
    const attacker = await createTestUser({ role: 'Auth. Personnel' });
    const attackerAgent = request.agent(app);
    await loginAs(attackerAgent, attacker);

    await attackerAgent.post('/api/personnel/profile').send({
      name: 'Attacker', email: victim.email, dept: 'CCS', position: 'X', institution: 'CSPC'
    });

    // Attacker's session email must still be their own, so /api/requests/mine-style
    // ownership scoping (keyed on session email) still reflects the attacker, not the victim.
    const meRes = await attackerAgent.get('/api/me');
    expect(meRes.body.user.email).toBe(attacker.email);
    expect(meRes.body.user.email).not.toBe(victim.email);
  });
});

describe('Finding #2 — XSS: Dashboard DSS insight strings (server-rendered)', () => {
  let adminAgent, partnershipId;
  const XSS_INST = 'jesttest <script>alert(1)</script> Institute';

  beforeAll(async () => {
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));

    // Expiring within 90 days so it drives insightRenewal + the Expiring/Expired table.
    const end = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const res = await adminAgent.post('/api/partnerships').send({
      inst: XSS_INST, country: 'jesttest <img src=x onerror=alert(2)> Land', type: 'MOA',
      unit: 'CCS', start: 'Jan 1, 2020', end, status: 'Expiring Soon'
    });
    expect(res.status).toBe(200);
    partnershipId = res.body.partnership.id;
  });

  afterAll(async () => {
    if (partnershipId) await db.collection('partnerships').deleteOne({ id: partnershipId });
  });

  test('an institution/country name with a script payload renders escaped, never as raw HTML', async () => {
    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).not.toContain('<img src=x onerror=alert(2)>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('Finding #4 — unique users.email index', () => {
  test('a unique index on email exists on the users collection', async () => {
    const indexes = await db.collection('users').indexes();
    const emailIndex = indexes.find(ix => ix.key && Object.keys(ix.key).length === 1 && ix.key.email === 1);
    expect(emailIndex).toBeDefined();
    expect(emailIndex.unique).toBe(true);
  });

  test('two concurrent account creations for the same email cannot both succeed', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);

    const raceEmail = uniqueEmail('racecondition');
    try {
      const [resA, resB] = await Promise.all([
        agent.post('/api/users').send({ name: 'Race A', email: raceEmail, role: 'Staff', password: 'StrongPass1' }),
        agent.post('/api/users').send({ name: 'Race B', email: raceEmail, role: 'Staff', password: 'StrongPass1' })
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);
      const failed = resA.status === 400 ? resA : resB;
      expect(failed.body.error).toMatch(/already exists/i);

      const matches = await db.collection('users').find({ email: raceEmail }).toArray();
      expect(matches.length).toBe(1);
    } finally {
      // POST /api/users doesn't tag createdAt with TEST_TAG, so cleanupAll()
      // won't reach these — delete by the unique race email explicitly,
      // regardless of whether the assertions above passed or failed.
      await db.collection('users').deleteMany({ email: raceEmail });
    }
  });
});

describe('Finding #3 — document metadata ownership (PATCH /api/documents/:id)', () => {
  let uploaderDoc, otherDoc;

  beforeAll(async () => {
    const last = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
    const uploaderEmail = uniqueEmail('docowner');
    uploaderDoc = { id: (last.length ? last[0].id : 0) + 9001, title: 'jesttest Owned Doc', type: 'MOA', uploadedByEmail: uploaderEmail, uploadedAt: new Date().toISOString() };
    otherDoc = { id: uploaderDoc.id + 1, title: 'jesttest Other Doc', type: 'MOU', uploadedByEmail: uniqueEmail('someoneelse'), uploadedAt: new Date().toISOString() };
    await db.collection('documents').insertMany([uploaderDoc, otherDoc]);
  });

  afterAll(async () => {
    await db.collection('documents').deleteMany({ id: { $in: [uploaderDoc.id, otherDoc.id] } });
  });

  test('Auth. Personnel editing another user\'s document -> 403', async () => {
    const personnel = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, personnel);
    const res = await agent.patch(`/api/documents/${otherDoc.id}`).send({ title: 'Hijacked Title' });
    expect(res.status).toBe(403);
  });

  test('Auth. Personnel editing their own document -> 200', async () => {
    const owner = await createTestUser({ role: 'Auth. Personnel' });
    await db.collection('documents').updateOne({ id: uploaderDoc.id }, { $set: { uploadedByEmail: owner.email } });
    const agent = request.agent(app);
    await loginAs(agent, owner);
    const res = await agent.patch(`/api/documents/${uploaderDoc.id}`).send({ title: 'Corrected By Owner' });
    expect(res.status).toBe(200);
    expect(res.body.document.title).toBe('Corrected By Owner');
  });

  test('Administrator editing another user\'s document -> 200 (cross-user access preserved)', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    const res = await agent.patch(`/api/documents/${otherDoc.id}`).send({ title: 'Corrected By Administrator' });
    expect(res.status).toBe(200);
    expect(res.body.document.title).toBe('Corrected By Administrator');
  });
});

describe('Finding #5 — report query parameter type guards (NoSQL operator injection)', () => {
  let adminAgent, partnershipId;
  const XSS_TAG_INST = 'jesttest Finding5 Institute';

  beforeAll(async () => {
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    const res = await adminAgent.post('/api/partnerships').send({
      inst: XSS_TAG_INST, country: 'Testland', type: 'MOA',
      unit: 'CCS', start: 'Jan 1, 2020', end: 'Jan 1, 2030', cat: 'International'
    });
    expect(res.status).toBe(200);
    partnershipId = res.body.partnership.id;
  });

  afterAll(async () => {
    if (partnershipId) await db.collection('partnerships').deleteOne({ id: partnershipId });
  });

  test('a bracket-notation ?cat[$ne]=... on the Custom Report Builder cannot become a MongoDB operator', async () => {
    // If the injected object were applied as a real $ne operator, this record
    // (cat: 'International') would be wrongly EXCLUDED. The typeof guard
    // means the malformed field is ignored entirely (no cat filter applied),
    // so the record must still appear.
    const res = await adminAgent.get('/api/reports/custom/preview?cat[$ne]=International');
    expect(res.status).toBe(200);
    const titles = res.body.records.map(r => r.inst);
    expect(titles).toContain(XSS_TAG_INST);
  });

  test('a bracket-notation ?unit[$ne]=... on the Comparison Report Builder cannot become a MongoDB operator', async () => {
    const res = await adminAgent.get('/api/reports/comparison/preview?compType=Active vs Inactive&unit[$ne]=CCS');
    expect(res.status).toBe(200); // no crash from the malformed operator-shaped param
  });

  test('a normal string cat filter still works correctly (regression check)', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ cat: 'Local' });
    expect(res.status).toBe(200);
    const titles = res.body.records.map(r => r.inst);
    expect(titles).not.toContain(XSS_TAG_INST); // this record is International, not Local
  });
});

describe('Finding #9 — Document Access / OCR route coverage (cross-tenant IDOR)', () => {
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  test('an unauthenticated request cannot start an OCR job', async () => {
    const res = await request(app).post('/api/ocr/extract').attach('document', PNG_HEADER, 'noauth.png');
    expect(res.status).toBe(302); // requireAuth redirect, applied at the app.use('/api/ocr', ...) mount
  });

  test('an unauthenticated request cannot poll any OCR job status', async () => {
    const res = await request(app).get('/api/ocr/status/some-job-id');
    expect(res.status).toBe(302);
  });

  test('the job owner can poll their own OCR job and gets a real status back', async () => {
    const uploader = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, uploader);

    const startRes = await agent.post('/api/ocr/extract').attach('document', PNG_HEADER, 'own-doc.png');
    expect(startRes.status).toBe(202);
    expect(startRes.body.success).toBe(true);
    const jobId = startRes.body.jobId;

    const statusRes = await agent.get(`/api/ocr/status/${jobId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.success).toBe(true);
  });

  test('a different authenticated user cannot poll someone else\'s OCR job', async () => {
    const uploader = await createTestUser({ role: 'Auth. Personnel' });
    const uploaderAgent = request.agent(app);
    await loginAs(uploaderAgent, uploader);
    const startRes = await uploaderAgent.post('/api/ocr/extract').attach('document', PNG_HEADER, 'private-doc.png');
    const jobId = startRes.body.jobId;

    const attacker = await createTestUser({ role: 'Auth. Personnel' });
    const attackerAgent = request.agent(app);
    await loginAs(attackerAgent, attacker);
    const res = await attackerAgent.get(`/api/ocr/status/${jobId}`);
    expect(res.status).toBe(403);
  });

  test('polling a nonexistent OCR job id returns 404, not a crash', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Auth. Personnel' }));
    const res = await agent.get('/api/ocr/status/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('Finding #7 — logout is POST-only', () => {
  test('GET /logout no longer terminates the session (route no longer exists)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);

    const getRes = await agent.get('/logout');
    expect(getRes.status).not.toBe(302); // not the old logout-then-redirect behavior
    expect(getRes.status).toBe(404);

    // Session must still be alive — a protected page still works.
    const dashRes = await agent.get('/staff/dashboard');
    expect(dashRes.status).toBe(200);
  });

  test('POST /logout terminates the session', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);

    const postRes = await agent.post('/logout');
    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);

    const dashRes = await agent.get('/staff/dashboard');
    expect(dashRes.status).toBe(302); // session gone, bounced to login
  });
});

describe('Follow-up sweep — Auth. Personnel dashboard no longer ships hardcoded demo data (table + type chart)', () => {
  test('the rendered page contains no hardcoded expiring-partnership rows, and a real data-driven tbody exists', async () => {
    const personnel = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, personnel);
    const res = await agent.get('/personnel/dashboard');
    expect(res.status).toBe(200);
    // These exact hardcoded table rows (institution + fixed expiry date) are
    // what this fix removed. Checking for the date pairing (not just the bare
    // institution name) avoids a false positive against the still-untouched
    // world map widget below, which legitimately reuses some of the same
    // institution names in its own separate hardcoded marker array (a
    // documented, deliberately out-of-scope item — see the final report).
    expect(res.text).not.toContain('Jun 15, 2026');
    expect(res.text).not.toContain('Jan 5, 2026');
    expect(res.text).toContain('id="expiring-tbody"');
    // The type/status chart's series used to be a hardcoded [32,19,37,9,5] —
    // confirm the fetch-driven update call is present instead.
    expect(res.text).toContain('typeChart.updateSeries');
  });
});

describe('Finding #8 — secure cookie default', () => {
  // A NODE_ENV-based boolean was tried first and reverted after live
  // verification showed it breaks local HTTP development outright (see
  // cirl.js's cookie config comment) — `cookie.secure: 'auto'` is
  // express-session's own mechanism for this, so there is no static truth
  // table to unit-test here. What IS testable and matters: real requests
  // over a plain (non-TLS) connection — exactly what both local dev and
  // this entire Jest suite run over — must still receive a working session
  // cookie; a live HTTPS-vs-HTTP comparison is out of reach for Jest/
  // supertest and was instead verified manually (see the security review's
  // Playwright/browser verification notes) confirming Secure is actually
  // set once real TLS termination is in front of the app.
  test('over a plain (non-TLS) connection, login still sets a real, usable session cookie', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    const res = await agent.post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);

    // And the cookie is actually usable for a follow-up authenticated request —
    // the real symptom when `secure` is wrongly forced true over plain HTTP is a
    // cookie that gets set but is then silently dropped by the client.
    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(200);
  });
});
