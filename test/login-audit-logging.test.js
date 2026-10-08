// Login-attempt audit logging investigation (2026-10-21).
//
// Root cause found: POST /login and POST /logout (cirl.js) never called logActivity() at all — every
// successful sign-in, every failed attempt (wrong password, unknown account, disabled account, a Google-only
// account trying a password, a legacy plain-text account, a validation error) and every sign-out left
// absolutely no Audit Trail record. This suite locks in the fix: a real, server-side-only audit row for every
// branch, using the safe failure categories this task's own brief specified, with no password/hash/token ever
// stored, no user-enumeration leak in the login RESPONSE (the audit `reason` is for an authorized
// Administrator reviewing the trail afterward, never shown to the person attempting to log in), and no
// fabricated actor for an attempt against an account that doesn't exist.
//
// Rate limiting (LOGIN_BLOCKED) is NOT covered here: makeRateLimiter() (cirl.js) is an intentional no-op under
// NODE_ENV=test (every other login test in this project already depends on that — without it, the shared,
// IP-keyed limiter would spuriously fail whichever test happens to run its 11th login in 15 minutes), so the
// limiter's own handler() — where that logging lives — never runs in this process. It is verified separately,
// live, against a real (non-test-mode) server — see the chat response for that result.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const stamp = Date.now();
const unknownEmail = `${TEST_TAG}.nosuchaccount.${stamp}@example.com`;

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

// Every activitylogs row this suite's own logins/attempts could have produced, scoped by email OR (for an
// unresolved attempt, which has no email) by the attempted identifier appearing in `record`/`targetId`.
async function entriesFor(email) {
  return db.collection('activitylogs').find({ $or: [{ email }, { record: { $regex: email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }] }).sort({ id: 1 }).toArray();
}

describe('A. Successful login', () => {
  test('LOGIN_SUCCESS is recorded exactly once, server-side, with the full safe field set — and never a password/hash/token', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    const res = await loginAs(agent, user);
    expect(res.status).toBe(302); // real login redirects; nothing client-side reported this — the server already wrote the row before responding

    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGIN_SUCCESS');
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.category).toBe('Authentication');
    expect(e.status).toBe('success');
    const userDoc = await db.collection('users').findOne({ id: user.id });
    expect(e.by).toBe(userDoc.name);
    expect(e.role).toBe('Staff');
    expect(e.targetType).toBe('login_attempt');
    expect(e.targetId).toBe(user.email);
    expect(e.timestamp).toBeInstanceOf(Date);
    expect(typeof e.date).toBe('string'); // the pre-existing display string is still there, unchanged in meaning
    expect(e.ip === null || typeof e.ip === 'string').toBe(true);
    expect(e.requestId).toBeTruthy();

    // No secret of any kind, anywhere in the stored document.
    const blob = JSON.stringify(e).toLowerCase();
    expect(blob).not.toContain(user.password.toLowerCase());
    expect(blob).not.toMatch(/\$2[aby]\$/); // a bcrypt hash's own signature
    expect(blob).not.toContain('token');
    expect(blob).not.toContain('secret');
  });
});

describe('B. Failed login — wrong password', () => {
  test('LOGIN_FAILED is recorded with reason "invalid_credentials", actor is the real (known) account, and the HTTP response stays generic', async () => {
    const user = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: 'DefinitelyWrongPassword1' });
    expect(res.status).toBe(401); // 2026-10-28 brute-force-protection investigation — see auth.test.js's own comment on this
    expect(res.text).toContain('Invalid email or password.');

    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGIN_FAILED');
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('failure');
    expect(entries[0].details.reason).toBe('invalid_credentials');
    expect(entries[0].email).toBe(user.email); // the account IS known — this is useful, legitimate security signal, not enumeration (see C)
    const blob = JSON.stringify(entries[0]).toLowerCase();
    expect(blob).not.toContain('definitelywrongpassword1'.toLowerCase());
  });
});

describe('C. Unknown account', () => {
  test('a failed authentication event is still recorded, with NO fabricated user id, and the response cannot be told apart from a wrong-password response', async () => {
    const wrongPasswordRes = await request(app).post('/login').type('form').send({ username: (await createTestUser()).email, password: 'WrongPassword1' });
    const unknownRes = await request(app).post('/login').type('form').send({ username: unknownEmail, password: 'WhateverPassword1' });
    expect(unknownRes.status).toBe(wrongPasswordRes.status);
    expect(unknownRes.text).toBe(wrongPasswordRes.text); // byte-identical — no enumeration signal in the HTTP response

    const entries = (await entriesFor(unknownEmail)).filter(e => e.action === 'LOGIN_FAILED');
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.details.reason).toBe('account_not_found');
    expect(e.email).toBeNull();           // actor: genuinely unknown — never fabricated
    expect(e.by).toBe('Unknown');         // not the generic 'System' fallback (nothing automatic did this)
    expect(e.targetId).toBe(unknownEmail); // the attempt's OWN input is fine to keep — it's not a confirmation of anything
  });
});

describe('D. Logout', () => {
  test('LOGOUT is recorded for the signed-in account exactly once', async () => {
    const user = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.post('/logout').send();
    expect(res.status).toBe(200);

    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGOUT');
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('Authentication');
    expect(entries[0].status).toBe('success');
  });

  test('logging out twice in a row (double-click / retry) does not write a second LOGOUT for an already-ended session', async () => {
    const user = await createTestUser();
    const agent = request.agent(app);
    await loginAs(agent, user);
    await agent.post('/logout').send();
    await agent.post('/logout').send(); // same agent, cookie now refers to a destroyed session
    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGOUT');
    expect(entries).toHaveLength(1);
  });
});

describe('E. Repeated attempts', () => {
  test('attempt, attempt, succeed produces three distinct, non-deduplicated records — in order', async () => {
    const user = await createTestUser({ role: 'Staff' });
    await request(app).post('/login').type('form').send({ username: user.email, password: 'Bad1' });
    await request(app).post('/login').type('form').send({ username: user.email, password: 'Bad2' });
    await request(app).post('/login').type('form').send({ username: user.email, password: user.password });

    const entries = await entriesFor(user.email);
    expect(entries.map(e => e.action)).toEqual(['LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN_SUCCESS']);
    expect(new Set(entries.map(e => e.id)).size).toBe(3); // three distinct rows, not one coalesced/overwritten entry
  });
});

describe('F. Disabled and other non-generic account states', () => {
  test('a disabled (Inactive) account logs LOGIN_FAILED / account_disabled', async () => {
    const user = await createTestUser();
    await db.collection('users').updateOne({ id: user.id }, { $set: { status: 'Inactive' } });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.text).toContain('inactive');
    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGIN_FAILED');
    expect(entries).toHaveLength(1);
    expect(entries[0].details.reason).toBe('account_disabled');
  });

  test('a Google-only account (no local password) attempting a password login logs its own distinct reason', async () => {
    const user = await createTestUser();
    await db.collection('users').updateOne({ id: user.id }, { $unset: { password: '' } });
    await request(app).post('/login').type('form').send({ username: user.email, password: 'anything' });
    const entries = (await entriesFor(user.email)).filter(e => e.action === 'LOGIN_FAILED');
    expect(entries).toHaveLength(1);
    expect(entries[0].details.reason).toBe('google_account_only');
  });

  test('a malformed request (missing password) logs validation_error with no identifiable actor', async () => {
    const res = await request(app).post('/login').type('form').send({ username: `${TEST_TAG}.novalidation.${stamp}@example.com` });
    expect(res.status).toBe(400); // malformed request, not a real attempt against any account
    const entries = (await entriesFor(`${TEST_TAG}.novalidation.${stamp}@example.com`)).filter(e => e.action === 'LOGIN_FAILED');
    expect(entries).toHaveLength(1);
    expect(entries[0].details.reason).toBe('validation_error');
    expect(entries[0].email).toBeNull();
  });
});

describe('G. Unauthorized access to a protected action is itself audited (FORBIDDEN)', () => {
  test('CIRL Staff attempting an Administrator-only action is denied AND the attempt is recorded, with the real actor and the attempted route as the target', async () => {
    const staff = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, staff);
    // /api/google-calendar/status is requireAdmin-only (connecting the org Google account is deliberately
    // more sensitive than the requireStaffAccess surface Staff already shares with Administrator elsewhere).
    const res = await agent.get('/api/google-calendar/status').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);

    // denyAccess() deliberately fires this write without awaiting it (unlike the login/logout routes above,
    // it runs on nearly every request app-wide, and must never add a DB round-trip to an already-denied
    // request's latency) — same settle-and-check pattern already used elsewhere in this suite for other
    // intentionally fire-and-forget writes (e.g. test/email-notifications.test.js, test/profile-avatar.test.js).
    await new Promise(r => setTimeout(r, 150));
    const entries = (await entriesFor(staff.email)).filter(e => e.action === 'FORBIDDEN');
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('Security');
    expect(entries[0].status).toBe('blocked');
    expect(entries[0].targetId).toBe('/api/google-calendar/status');
  });

  test('a plain 401 (not signed in at all) is NOT audited — routine, not a security event', async () => {
    const before = await db.collection('activitylogs').countDocuments({ action: 'FORBIDDEN' });
    await request(app).get('/api/google-calendar/status').set('X-Requested-With', 'ciprms');
    const after = await db.collection('activitylogs').countDocuments({ action: 'FORBIDDEN' });
    expect(after).toBe(before);
  });
});

describe('H. Audit Trail RBAC is unchanged — Administrator/Staff only', () => {
  test('a Partner cannot read /api/activitylogs', async () => {
    const partner = await createTestUser({ role: 'potential_partner' });
    const agent = request.agent(app);
    await loginAs(agent, partner);
    const res = await agent.get('/api/activitylogs').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test('Administrator sees every role\'s entries; Staff sees only their own (pre-existing scoping, unaffected)', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const staff = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app), staffAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(staffAgent, staff);

    const adminView = await adminAgent.get('/api/activitylogs');
    expect(adminView.body.some(e => e.email === staff.email)).toBe(true);
    const staffView = await staffAgent.get('/api/activitylogs');
    expect(staffView.body.every(e => e.email === staff.email)).toBe(true);
    expect(staffView.body.some(e => e.email === admin.email)).toBe(false);
  });
});

describe('Audit Trail UI describes the new fields honestly', () => {
  test('reports.ejs: new Category/Status/IP columns and filters exist, and the date-range filter uses local-date, not UTC, semantics', () => {
    const fs = require('fs');
    const path = require('path');
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
    expect(view).toContain("id=\"audit-filter-category\"");
    expect(view).toContain("id=\"audit-filter-status\"");
    expect(view).toContain("{ name: 'IP Address'");
    expect(view).toContain('function auditLocalDate(ymd, endOfDay)');
    expect(view).not.toMatch(/if \(from && d < new Date\(from\)\)/); // the old UTC-midnight comparison is gone
  });
});
