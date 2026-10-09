// Account Settings / Personal Details — backend error-handling investigation (2026-11).
//
// Root cause found: readOwnProfile()/saveOwnName() (cirl.js, shared by GET/POST /api/admin/profile,
// /api/staff/profile and /api/personnel/profile) used to answer a genuine server error with
// `res.status(500).json({ error: err.message })` — echoing the raw driver/internal error straight back to
// the client, unlike every other catch block in this file (see /api/admin/password's own comment: "must
// never echo raw internals... back to the client"). This suite proves the fixed behavior: a real failure
// (simulated safely by closing this process's own MongoDB connection, never a real outage) now logs
// server-side and answers a clean, generic 503 — and that the connection recovering clears it immediately,
// with no stale failure cached anywhere.
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Personal Details load/save — safe error responses on a real backend failure', () => {
  test.each([
    ['Administrator', 'Administrator', '/api/admin/profile'],
    ['CIRL Staff', 'Staff', '/api/staff/profile'],
    ['College Dean', 'Auth. Personnel', '/api/personnel/profile']
  ])('%s: GET and POST answer a clean 503 (never the raw driver error) when the database is unreachable, and recover once it is back', async (_label, role, url) => {
    const user = await createTestUser({ role });
    const agent = request.agent(app);
    await loginAs(agent, user);

    // Confirm the happy path first, on the SAME agent/session, before touching the connection.
    const healthy = await agent.get(url);
    expect(healthy.status).toBe(200);
    const registeredName = healthy.body.name;
    expect(registeredName).toBeTruthy();

    await closeDB();
    try {
      const getRes = await agent.get(url);
      expect(getRes.status).toBe(503);
      expect(getRes.body.error).toBe('Unable to load your profile right now. Please try again.');
      expect(getRes.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(getRes.body)).not.toMatch(/MongoClient|ECONNREFUSED|mongodb(\+srv)?:\/\/|Database not initialized/i);

      const postRes = await agent.post(url).send({ name: 'Should Not Be Saved' });
      expect(postRes.status).toBe(503);
      expect(postRes.body.error).toBe('Unable to save your name right now. Please try again.');
      expect(postRes.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(postRes.body)).not.toMatch(/MongoClient|ECONNREFUSED|mongodb(\+srv)?:\/\/|Database not initialized/i);
    } finally {
      await connectDB(); // must always run, even if an assertion above throws — every later test needs the DB back
    }

    // Recovery: the exact same, already-logged-in agent works again immediately — nothing was permanently
    // marked "down" by the outage above.
    const recovered = await agent.get(url);
    expect(recovered.status).toBe(200);
    expect(recovered.body.name).toBe(registeredName);

    const savedRecovered = await agent.post(url).send({ name: 'Recovered Fine' });
    expect(savedRecovered.status).toBe(200);
    expect(savedRecovered.body.profile.name).toBe('Recovered Fine');
    expect((await getDb().collection('users').findOne({ email: user.email })).name).toBe('Recovered Fine');
  });
});

describe('Personal Details — a failed load no longer leaves the form silently blank', () => {
  // Before: loadProfile() on every one of these three pages did `catch(_) { updateCard(); }` — any failure
  // (network blip, expired session, 503 above) was swallowed with zero feedback, so a real failure looked
  // exactly like "my registered details vanished" instead of "the page couldn't load them, try again."
  test.each([
    ['Administrator', '../views/administrator/admin_settings.ejs'],
    ['CIRL Staff', '../views/staff/staff_settings.ejs'],
    ['College Dean', '../views/auth. personnel/personnel_settings.ejs']
  ])('%s Settings: loadProfile() checks the response and shows an error toast instead of failing silently', (_label, relPath) => {
    const html = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
    const start = html.indexOf('async function loadProfile()');
    expect(start).toBeGreaterThan(-1);
    const body = html.slice(start, html.indexOf('async function saveSettings()', start));
    expect(body).toMatch(/if \(!res\.ok \|\| !data\) throw new Error/);
    expect(body).toContain('showToast(');
    expect(body).not.toContain('catch(_) { updateCard(); }'); // the old silent-failure catch block
  });

  test('College Dean Settings page uses "readonly" (not "disabled") for the registered-at-signup fields, matching Administrator and CIRL Staff', async () => {
    const user = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const html = (await agent.get('/personnel/settings')).text;
    for (const id of ['s-contact', 's-dept', 's-position', 's-institution']) {
      const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
      expect(tag).not.toBeNull();
      expect(tag[0]).toContain(' readonly ');
      expect(tag[0]).not.toContain(' disabled');
    }
    // Email is a deliberate, separate exception on every Settings page (it is the login identity, not a
    // registration field) — it stays "disabled" everywhere and this must keep working that way.
    const emailTag = html.match(/<input[^>]*id="s-email"[^>]*>/);
    expect(emailTag[0]).toContain('disabled');
  });
});
