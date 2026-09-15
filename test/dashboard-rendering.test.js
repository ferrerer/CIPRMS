// Full system health-check audit (2026-09-12): the Potential Partner
// dashboard's "Top Partner Countries" card had NO test coverage at all before
// this file. Its client-side renderTopCountries() (real, live /api/partnerships
// data) targeted `document.getElementById('top-countries-list')`, but the
// actual card markup was still the pre-existing hardcoded EJS block (fake
// Japan/United States/etc. placeholder data, no matching container id) —
// found live via Playwright as a `TypeError: Cannot set properties of null
// (setting 'innerHTML')` console error on every load of /partner/dashboard,
// with the card silently continuing to display fictitious data instead of the
// requester's real partnerships. Fixed by replacing the hardcoded block with
// the same `<div id="top-countries-list">Loading…</div>` container pattern
// already used successfully by the Administrator dashboard's identical widget.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, agent;

beforeAll(async () => {
  db = await connectDB();
  agent = request.agent(app);
  await loginAs(agent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

describe('Potential Partner dashboard: "Top Partner Countries" widget', () => {
  test('renders the live-data container the client-side script targets, not the old hardcoded placeholder block', async () => {
    const res = await agent.get('/partner/dashboard');
    expect(res.status).toBe(200);
    // The real container renderTopCountries() writes into.
    expect(res.text).toContain('id="top-countries-list"');
    // This exact call signature (a literal `null` btn argument) only ever
    // appeared in the removed hardcoded topPartners forEach block — the live
    // JS renderer never emits an onclick handler for this widget at all, so
    // its presence would mean the fake block has regressed back in.
    expect(res.text).not.toContain('flyToContinent(null,');
  });

  test('Administrator dashboard\'s equivalent widget (the known-good reference implementation) is unaffected', async () => {
    const adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="top-countries-list"');
  });
});
