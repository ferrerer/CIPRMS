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

let db;

beforeAll(async () => {
  db = await connectDB();
});

afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

describe('Dashboard "Top Partner Countries" widget (the Potential Partner dashboard it was first fixed on has since been removed)', () => {
  test('Administrator dashboard\'s equivalent widget (the known-good reference implementation) is unaffected', async () => {
    const adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="top-countries-list"');
  });

  test('the Top Partner Countries list, map and charts re-read the data on a live partnership update (they used to load once and go stale)', async () => {
    for (const [role, path] of [['Administrator', '/dashboard'], ['Staff', '/staff/dashboard']]) {
      const agent = request.agent(app);
      await loginAs(agent, await createTestUser({ role }));
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain("CIPRMS.live(['partnership.updated', 'partnership.statusChanged']");
      expect(res.text).toContain('function loadDashboardData');
      expect(res.text).toContain("fetch('/api/partnerships', { cache: 'no-store' })");
    }
  });
});

// 2026-09-19: "Partnership by Country" (a DIFFERENT widget from "Top Partner
// Countries" above — this is the #country-chart ApexCharts bar chart) was
// capped to the Top 8 countries by count, entirely client-side (the chart's
// own inline script slices the already-sorted country list before handing it
// to ApexCharts). A live browser is needed to prove only 8 bars actually
// render (covered by Playwright), but Jest can verify: the capping mechanism
// is present in the shipped template, and — critically — that the backend
// API this chart reads from was NOT limited to 8 server-side, which would
// have silently broken every OTHER consumer of the full country breakdown
// (Reports & Analytics' "Partnership by Country" report/PDF/Excel) and the
// percentage-of-full-population guarantee this same chart depends on.
describe('Administrator/Staff dashboard: "Partnership by Country" chart capped at Top 8 (display-only)', () => {
  let adminAgent, staffAgent, fs, path;

  beforeAll(async () => {
    fs = require('fs');
    path = require('path');
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  });

  test('the shipped dashboard template slices the sorted country list to a max of 8 for display', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'admin_dashboard.ejs'), 'utf8');
    expect(html).toMatch(/COUNTRY_CHART_MAX_ENTRIES\s*=\s*8/);
    expect(html).toMatch(/displayedCountryEntries\s*=\s*countryEntries\.slice\(0,\s*COUNTRY_CHART_MAX_ENTRIES\)/);
  });

  test('/api/partnerships/stats byCountry is NOT limited server-side — the full country breakdown is still returned', async () => {
    const res = await adminAgent.get('/api/partnerships/stats');
    expect(res.status).toBe(200);
    expect(typeof res.body.byCountry).toBe('object');
    // Real data in this shared database already has more than 8 distinct
    // countries (confirmed via prior sessions' live verification); this
    // guards against a future regression that caps byCountry itself rather
    // than only the dashboard's own display slice.
    expect(Object.keys(res.body.byCountry).length).toBeGreaterThan(8);
  });

  test('Administrator and Staff dashboards both ship the identical capping mechanism (shared template)', async () => {
    const adminRes = await adminAgent.get('/dashboard');
    const staffRes = await staffAgent.get('/staff/dashboard');
    expect(adminRes.status).toBe(200);
    expect(staffRes.status).toBe(200);
    expect(adminRes.text).toContain('COUNTRY_CHART_MAX_ENTRIES');
    expect(staffRes.text).toContain('COUNTRY_CHART_MAX_ENTRIES');
  });
});
