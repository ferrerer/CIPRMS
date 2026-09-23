// Covers the 2026-09-23 Custom Report Builder "properly complete" follow-up.
//
// Investigation finding: a live audit of computeCustomReportData() against real data (see the conversation
// this task came from) confirmed every Report Type, every Partnership Filter, every Group By option, Report
// Title propagation, and Date From/To semantics were ALREADY correct — matching the pre-existing 137 passing
// tests in test/reports.test.js. The ONE real, confirmed bug: previewCustomReport() (reports.ejs) never
// special-cased Report Type = "Audit" the way generateCustomReport() already did for PDF/Excel — clicking
// "Preview" with Audit selected silently queried /api/reports/custom/preview (a partnerships-only endpoint)
// and rendered a generic, unrelated partnership table under the "Audit" title. Fixed client-side only (no
// backend change): Preview now shows a clear message pointing to Generate PDF/Excel instead.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Custom Report Builder — Audit Preview no longer shows a misleading partnership table', () => {
  const view = read('views', 'administrator', 'reports.ejs');

  test('previewCustomReport() short-circuits for reportType=Audit before ever calling /api/reports/custom/preview', () => {
    const block = view.slice(view.indexOf('function previewCustomReport'), view.indexOf('function previewCustomReport') + 1200);
    expect(block).toMatch(/document\.getElementById\('cr-type'\)\.value === 'Audit'/);
    // The guard must come BEFORE the fetch call, not after.
    const guardPos = block.indexOf("=== 'Audit'");
    const fetchPos = block.indexOf("fetch('/api/reports/custom/preview");
    expect(guardPos).toBeGreaterThan(-1);
    expect(fetchPos).toBeGreaterThan(guardPos);
  });

  test('the Audit guard shows an explanatory error state pointing to Generate PDF/Excel, not a fabricated report', () => {
    const block = view.slice(view.indexOf('function previewCustomReport'), view.indexOf('function previewCustomReport') + 1200);
    expect(block).toMatch(/showRpmError\(/);
    expect(block).toMatch(/Generate PDF/);
    expect(block).toMatch(/Generate Excel/);
  });

  test('generateCustomReport() (PDF/Excel) already correctly redirected Audit to the real activity-log routes — unchanged by this fix', () => {
    const block = view.slice(view.indexOf('function generateCustomReport'), view.indexOf('function generateCustomReport') + 400);
    expect(block).toContain("type === 'Audit'");
    expect(block).toContain('/api/reports/activitylog/');
  });
});

describe('Custom Report Builder — backend Report Type / filter / Group By behavior (confirmatory, not a fix)', () => {
  let adminAgent;
  let partnershipIds = [];
  const stamp = Date.now();
  const TAG = `Jesttest CRBComplete ${stamp}`;
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

  beforeAll(async () => {
    const db = await connectDB();
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));

    const last = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const fixtures = [
      { id: last + 1, inst: `${TAG} Active`, country: 'Japan', type: 'MOA', cat: 'International', unit: ['CCS'], nature: ['Research'], region: 'Asia', status: 'Active', start: fmt(daysFromNow(-30)), end: fmt(daysFromNow(365)) },
      { id: last + 2, inst: `${TAG} ExpiringSoon`, country: 'Japan', type: 'MOU', cat: 'International', unit: ['CETE'], nature: ['Training'], region: 'Asia', status: 'Active', start: fmt(daysFromNow(-300)), end: fmt(daysFromNow(30)) },
      { id: last + 3, inst: `${TAG} Expired`, country: 'Philippines', type: 'MOA', cat: 'Local', unit: ['CIRL'], nature: ['Conference'], region: 'Local', status: 'Active', start: fmt(daysFromNow(-800)), end: fmt(daysFromNow(-30)) }
    ];
    partnershipIds = fixtures.map(f => f.id);
    await db.collection('partnerships').insertMany(fixtures.map(f => ({ ...f, remarks: 'jesttest' })));
  });

  afterAll(async () => {
    const db = await connectDB();
    await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    await cleanupAll();
    await closeDB();
  });

  const own = (records) => (records || []).filter(p => p.inst && p.inst.startsWith(TAG));

  test('Report Title is echoed exactly, never silently replaced with a generic title', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ title: 'My Exact Custom Title', reportType: 'Summary' });
    expect(res.body.title).toBe('My Exact Custom Title');
  });

  test('an omitted title falls back to "<Report Type> Report", not a blank title', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary' });
    expect(res.body.title).toBe('Summary Report');
  });

  test('Report Type "Active Partnerships" implies Active status even without an explicit Status filter', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Active Partnerships', inst: TAG });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].inst).toBe(`${TAG} Active`);
  });

  test('Report Type "Expired Partnerships" implies Expired status', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Expired Partnerships', inst: TAG });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('Expired');
  });

  test('Report Type "Summary" implies no status — shows every matching record regardless of status', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', inst: TAG });
    expect(own(res.body.records).length).toBe(3);
  });

  test('an explicit Status filter overrides whatever the Report Type implies', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Active Partnerships', status: 'Expired', inst: TAG });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('Expired');
  });

  test('Date From with no Date To still correctly bounds the result (an ended record before it is excluded)', async () => {
    const farFuture = new Date(); farFuture.setDate(farFuture.getDate() + 200);
    const res = await adminAgent.get('/api/reports/custom/preview').query({ dateFrom: farFuture.toISOString().slice(0, 10), inst: TAG });
    const mine = own(res.body.records);
    expect(mine.some(p => p.inst === `${TAG} Expired`)).toBe(false);
    expect(mine.some(p => p.inst === `${TAG} Active`)).toBe(true);
  });

  test('empty Date From and Date To never accidentally filter anything out', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ dateFrom: '', dateTo: '', inst: TAG });
    expect(own(res.body.records).length).toBe(3);
  });

  test('Group By Nature of Partnership uses the real stored values, not a hard-coded list', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ groupBy: 'nature', inst: TAG });
    expect(res.body.isComparison).toBe(true);
    const groups = res.body.comparisonData.map(r => r.group);
    expect(groups).toEqual(expect.arrayContaining(['Research', 'Training', 'Conference']));
  });

  test('every Group By option produces isComparison=true with real grouped rows', async () => {
    for (const [groupBy, label] of [['country', 'Country'], ['inst', 'Institution'], ['unit', 'College / Unit'], ['region', 'Region'], ['type', 'Agreement Type'], ['nature', 'Nature of Partnership'], ['cat', 'Category']]) {
      const res = await adminAgent.get('/api/reports/custom/preview').query({ groupBy, inst: TAG });
      expect(res.body.isComparison).toBe(true);
      expect(res.body.compareBy).toBe(label);
      expect(res.body.comparisonData.length).toBeGreaterThan(0);
    }
  });

  test('no matching filters returns a real empty result, never fabricated rows', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Jesttest Nonexistent Countryland' });
    expect(res.status).toBe(200);
    expect(res.body.totalRecords).toBe(0);
    expect(res.body.records).toEqual([]);
  });

  test('long institution/country/nature/multi-unit values are returned intact, not truncated by the API', async () => {
    const db = await connectDB();
    const last = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const longInst = `${TAG} ` + 'A Very Long Institution Name For Layout Testing Purposes Only'.repeat(2);
    const id = last + 1;
    partnershipIds.push(id);
    await db.collection('partnerships').insertOne({
      id, inst: longInst, country: 'A Very Long Country Name Value', type: 'MOU', cat: 'International',
      unit: ['CCS', 'CILS', 'CETE', 'CNAS'], nature: ['Student Exchange', 'Faculty Exchange'], region: 'Asia',
      status: 'Active', start: fmt(daysFromNow(-1)), end: fmt(daysFromNow(365)), remarks: 'jesttest'
    });
    const res = await adminAgent.get('/api/reports/custom/preview').query({ inst: TAG });
    const found = own(res.body.records).find(p => p.inst === longInst);
    expect(found).toBeDefined();
    expect(found.unit.length).toBe(4);
    expect(found.nature.length).toBe(2);
  });
});
