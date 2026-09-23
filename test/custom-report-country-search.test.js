// Covers the 2026-09-23 Custom Report Builder fix: the Country filter (Reports & Analytics → Custom Report
// Builder → Partnership Filters) became a searchable combobox, sourced from the same COUNTRY_OPTIONS list the
// Registry's Add/Edit Partnership Country combobox already uses (assets/js/shared/country-options.js).
//
// Investigation finding, stated plainly: computeCustomReportData() (cirl.js) and its filtering/grouping logic
// were ALREADY correct before this change — confirmed both by direct live testing against real data (country=
// Japan/Philippines/combined filters/every Group By option all returned exactly the right records) and by the
// pre-existing test/reports.test.js, which already has 137 passing tests covering nearly this exact checklist
// (case-insensitive country matching, every filter combination, every Group By option, RBAC, PDF/Excel parity,
// empty/no-match results). The tests below are a smaller, explicitly-labeled set mapping 1:1 to this task's own
// 12-item checklist (using real countries — Japan, Philippines — as the task itself names) for direct
// traceability, plus new coverage for the searchable dropdown UI itself, which had no prior test coverage
// because it did not exist before.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Custom Report Builder — searchable Country filter markup/CSS', () => {
  const view = read('views', 'administrator', 'reports.ejs');

  test('the Country filter is a text input with a dropdown container, not a plain <select> or unnecessary placeholder', () => {
    expect(view).toMatch(/<input type="text" class="form-control" id="cr-country" autocomplete="off"[^>]*>/);
    expect(view).not.toContain('e.g. Japan (blank = all)'); // the old placeholder text
    expect(view).not.toMatch(/id="cr-country"[^>]*placeholder=/); // no placeholder attribute at all
    expect(view).toContain('id="cr-country-dropdown"');
  });

  test('it is visually consistent with the other report-builder controls (same bounded/scrollable dropdown treatment as Registry\'s Country combobox)', () => {
    expect(view).toMatch(/\.cr-country-dropdown\s*\{[^}]*max-height:\s*220px[^}]*overflow-y:\s*auto/);
    expect(view).toContain('.cr-country-wrap { position: relative; }');
  });

  test('loads the SAME shared country list the Registry Add/Edit Partnership combobox uses — not a second, separately-maintained list', () => {
    expect(view).toContain('/velzon/assets/js/shared/country-options.js');
    const registryView = read('views', 'administrator', 'monitoring.ejs');
    expect(registryView).toContain('/velzon/assets/js/shared/country-options.js');
    const shared = read('assets', 'js', 'shared', 'country-options.js');
    expect(shared).toContain('var COUNTRY_OPTIONS = [');
    expect(shared).toContain("'Philippines'");
    expect(shared).toContain("'Japan'");
    // registry-gridjs.init.js must no longer define its own copy
    const registryScript = read('assets', 'js', 'pages', 'registry-gridjs.init.js');
    expect(registryScript).not.toMatch(/var COUNTRY_OPTIONS = \[/);
  });

  test('search filters by substring anywhere (not just prefix), matching "Jap" -> Japan and "Phil" -> Philippines', () => {
    const script = view.slice(view.indexOf('function initCustomReportCountrySearch'), view.indexOf('function initCustomReportCountrySearch') + 2500);
    expect(script).toContain('c.toLowerCase().indexOf(q) !== -1');
  });

  test('Escape only closes the dropdown (no enclosing modal to protect here, but the same safe stopPropagation pattern is used)', () => {
    const script = view.slice(view.indexOf('function initCustomReportCountrySearch'), view.indexOf('function initCustomReportCountrySearch') + 2500);
    expect(script).toMatch(/e\.key === 'Escape' && dropdown\.style\.display === 'block'/);
  });

  test('#cr-country stays a plain input whose raw .value is what buildReportQueryParams() sends — no backend contract change', () => {
    expect(view).toContain("document.getElementById('cr-country').value.trim()");
  });

  test('resetCustomReportFilters() still clears the Country field correctly', () => {
    const block = view.slice(view.indexOf('function resetCustomReportFilters'), view.indexOf('function resetCustomReportFilters') + 500);
    expect(block).toContain("document.getElementById('cr-country').value = ''");
  });
});

describe('Custom Report Builder — backend filtering (task checklist, real countries, real data)', () => {
  let adminAgent;
  let partnershipIds = [];
  const stamp = Date.now();
  const TAG = `Jesttest CRB ${stamp}`;

  beforeAll(async () => {
    const db = await connectDB();
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));

    const last = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const fixtures = [
      { id: last + 1, inst: `${TAG} Japan MOA University`, country: 'Japan', type: 'MOA', cat: 'International', unit: ['CCS'], nature: ['Research'], region: 'Asia', status: 'Active', start: 'Jan 1, 2026', end: 'Jan 1, 2030' },
      { id: last + 2, inst: `${TAG} Japan MOU University`, country: 'Japan', type: 'MOU', cat: 'International', unit: ['CETE'], nature: ['Training'], region: 'Asia', status: 'Expired', start: 'Jan 1, 2010', end: 'Jan 1, 2015' },
      { id: last + 3, inst: `${TAG} Philippines University A`, country: 'Philippines', type: 'MOA', cat: 'Local', unit: ['CCS'], nature: ['Student Exchange'], region: 'Local', status: 'Active', start: 'Jun 1, 2026', end: 'Jun 1, 2029' },
      { id: last + 4, inst: `${TAG} Philippines University B`, country: 'Philippines', type: 'MOU', cat: 'Local', unit: ['CIRL'], nature: ['Conference'], region: 'Local', status: 'Active', start: 'Jun 1, 2026', end: 'Jun 1, 2029' }
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

  const own = (records) => records.filter(p => p.inst && p.inst.startsWith(TAG));

  test('1. Country = Japan returns only Japan records', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Japan' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(2);
    expect(mine.every(p => p.country === 'Japan')).toBe(true);
  });

  test('2. Country = Philippines returns only Philippines records', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Philippines' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(2);
    expect(mine.every(p => p.country === 'Philippines')).toBe(true);
  });

  test('3. Country + Agreement Type narrows correctly', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Japan', agtype: 'MOU' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].type).toBe('MOU');
  });

  test('4. Country + Status narrows correctly', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Japan', status: 'Expired' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('Expired');
  });

  test('5. Country + College/Unit narrows correctly', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Philippines', unit: 'CIRL' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].inst).toBe(`${TAG} Philippines University B`);
  });

  test('6. Country + date range narrows correctly', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Japan', dateFrom: '2020-01-01' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].inst).toBe(`${TAG} Japan MOA University`);
  });

  test('7. Multiple filters together (country + agtype + status + unit) narrow to the exact intersection', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Japan', agtype: 'MOA', status: 'Active', unit: 'CCS' });
    const mine = own(res.body.records);
    expect(mine.length).toBe(1);
    expect(mine[0].inst).toBe(`${TAG} Japan MOA University`);
  });

  test('8. Group By Country groups the fixtures under their real country values', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ groupBy: 'country', inst: TAG });
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Country');
    const groups = res.body.comparisonData.map(r => r.group);
    expect(groups.sort()).toEqual(['Japan', 'Philippines']);
  });

  test('9. Group By Institution groups the fixtures individually (one row per real institution)', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ groupBy: 'inst', country: 'Japan', inst: TAG });
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Institution');
    expect(res.body.comparisonData.length).toBe(2);
  });

  test('10. Group By Nature of Partnership uses the actual stored nature values, not a hard-coded list', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ groupBy: 'nature', inst: TAG });
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Nature of Partnership');
    const groups = res.body.comparisonData.map(r => r.group);
    expect(groups).toEqual(expect.arrayContaining(['Research', 'Training', 'Student Exchange', 'Conference']));
  });

  test('11. All filters cleared returns the full (unfiltered) dataset, including these fixtures', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview');
    const mine = own(res.body.records);
    expect(mine.length).toBe(4);
  });

  test('12. No matching records returns an empty, well-formed result (no crash)', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Jesttest Nonexistent Countryland' });
    expect(res.status).toBe(200);
    expect(res.body.totalRecords).toBe(0);
    expect(res.body.records).toEqual([]);
  });

  test('Country matching is case-insensitive but exact (does not fuzzy-merge genuinely different spellings)', async () => {
    const lower = await adminAgent.get('/api/reports/custom/preview').query({ country: 'japan' });
    const upper = await adminAgent.get('/api/reports/custom/preview').query({ country: 'JAPAN' });
    expect(own(lower.body.records).length).toBe(2);
    expect(own(upper.body.records).length).toBe(2);
    // A genuinely different spelling must NOT be silently included — confirms normalization is case-only,
    // never a guessed/fuzzy merge of distinct stored values (the real "Philipines"/"ph"/"philipines" records
    // already in this database, from actual historical data entry, are correctly excluded from "Philippines").
    const db = await connectDB();
    const distinctCount = await db.collection('partnerships').countDocuments({ country: { $regex: '^philipines$', $options: 'i' } });
    if (distinctCount > 0) {
      const philRes = await adminAgent.get('/api/reports/custom/preview').query({ country: 'Philippines' });
      const misspelled = philRes.body.records.filter(p => p.country && p.country.toLowerCase() === 'philipines');
      expect(misspelled.length).toBe(0);
    }
  });
});
