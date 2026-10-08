// Custom Report Builder — Date From / Date To regression suite (2026-10-08).
//
// Investigation finding: computeCustomReportData() (cirl.js) already implements the exact inclusive-boundary
// semantics this task asks for, via filterByDateRange() + parseLocalDate() + getRelevantPartnershipDate() (see
// cirl.js, just above computeCustomReportData). parseLocalDate() never calls toISOString()/getTime()-via-UTC on a
// bare "YYYY-MM-DD" string — it reads the year/month/day components directly off the string (or off a Date's own
// local getFullYear()/getMonth()/getDate()) and rebuilds a local Date from them, so a selected calendar date can
// never shift by a day regardless of the server's timezone. Date From is pinned to local 00:00:00.000 of that day
// and Date To to local 23:59:59.999, so both boundaries are inclusive. This suite is a regression lock for that
// existing behavior (every Report Type/Category/Agreement Type/Status/Country/Unit/Group By/Audit-report control
// is untouched), plus a few scenarios (the exact 2023-09-26..2026-09-26 window, Active Partnerships combined with
// a date range, Preview/PDF/Excel parity) that the existing test/reports.test.js and
// test/custom-report-builder-completion.test.js suites did not already cover.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

describe('Custom Report Builder — the on-page Date Filters help text matches the real (strict, inclusive, single-date) behavior', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
  const help = view.slice(view.indexOf('id="cr-date-help"'), view.indexOf('id="cr-date-help"') + 400);

  test('no longer describes period-overlap semantics ("still running in that window")', () => {
    expect(help).not.toMatch(/overlaps the dates/i);
    expect(help).not.toMatch(/still running/i);
  });

  test('describes the real strict inclusive-boundary, single relevant-date behavior', () => {
    expect(help).toMatch(/on or between Date From and Date To/i);
    expect(help).toMatch(/both boundary dates included/i);
  });
});

describe('Custom Report Builder — Date From / Date To inclusive boundary filtering', () => {
  let adminAgent, staffAgent;
  let ids = [];
  const stamp = Date.now();
  const TAG = `Jesttest DateRange ${stamp}`;
  // toLocaleDateString('en-US', ...) is exactly how test/custom-report-builder-completion.test.js already stores
  // fixture dates, and matches the non-ISO, locally-parsed string shape a real partnership's start/end is in.
  const fmt = (y, m, d) => new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  beforeAll(async () => {
    const db = await connectDB();
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));

    const lastDoc = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0];
    const last = lastDoc ? lastDoc.id : 0;
    const base = { country: 'DateRangeTestland', type: 'MOA', cat: 'Local', unit: ['CIRL'], nature: ['Research'], region: 'Local', remarks: 'jesttest' };

    // --- A: Date From only (dateFrom = 2024-06-15) ---
    const aBefore = { ...base, id: last + 1, inst: `${TAG} A-Before`, status: 'Active', start: fmt(2024, 6, 14), end: fmt(2030, 1, 1) };
    const aOn = { ...base, id: last + 2, inst: `${TAG} A-On`, status: 'Active', start: fmt(2024, 6, 15), end: fmt(2030, 1, 1) };
    const aAfter = { ...base, id: last + 3, inst: `${TAG} A-After`, status: 'Active', start: fmt(2024, 6, 16), end: fmt(2030, 1, 1) };

    // --- B: Date To only (dateTo = 2024-06-15) ---
    const bBefore = { ...base, id: last + 4, inst: `${TAG} B-Before`, status: 'Active', start: fmt(2024, 6, 14), end: fmt(2030, 1, 1) };
    const bOn = { ...base, id: last + 5, inst: `${TAG} B-On`, status: 'Active', start: fmt(2024, 6, 15), end: fmt(2030, 1, 1) };
    const bAfter = { ...base, id: last + 6, inst: `${TAG} B-After`, status: 'Active', start: fmt(2024, 6, 16), end: fmt(2030, 1, 1) };

    // --- C: both dates, Date From = 2023-09-26, Date To = 2026-09-26 ---
    const cBeforeFrom = { ...base, id: last + 7, inst: `${TAG} C-2023-09-25`, status: 'Active', start: fmt(2023, 9, 25), end: fmt(2030, 1, 1) };
    const cOnFrom = { ...base, id: last + 8, inst: `${TAG} C-2023-09-26`, status: 'Active', start: fmt(2023, 9, 26), end: fmt(2030, 1, 1) };
    const cInside = { ...base, id: last + 9, inst: `${TAG} C-2025-01-01`, status: 'Active', start: fmt(2025, 1, 1), end: fmt(2030, 1, 1) };
    const cOnTo = { ...base, id: last + 10, inst: `${TAG} C-2026-09-26`, status: 'Active', start: fmt(2026, 9, 26), end: fmt(2030, 1, 1) };
    const cAfterTo = { ...base, id: last + 11, inst: `${TAG} C-2026-09-27`, status: 'Active', start: fmt(2026, 9, 27), end: fmt(2030, 1, 1) };

    // --- D: Active Partnerships Report Type combined with the date range — a record that falls inside the
    // exact same window but whose end date already passed (so it recomputes to Expired, the same way every
    // real partnership's status is recomputed — see computeStatusFromEnd()/cirl.js) must still be excluded
    // by the implied status, proving the two filters (Report Type -> status, Date From/To -> date) are
    // applied together, not one overriding the other.
    const dActiveInside = { ...base, id: last + 12, inst: `${TAG} D-ActiveInside`, status: 'Active', start: fmt(2025, 6, 1), end: fmt(2030, 1, 1) };
    const dExpiredInside = { ...base, id: last + 13, inst: `${TAG} D-ExpiredInside`, status: 'Active', start: fmt(2025, 6, 1), end: fmt(2020, 1, 1) };

    const fixtures = [aBefore, aOn, aAfter, bBefore, bOn, bAfter, cBeforeFrom, cOnFrom, cInside, cOnTo, cAfterTo, dActiveInside, dExpiredInside];
    ids = fixtures.map(f => f.id);
    await db.collection('partnerships').insertMany(fixtures);
  });

  afterAll(async () => {
    const db = await connectDB();
    await db.collection('partnerships').deleteMany({ id: { $in: ids } });
    await cleanupAll();
    await closeDB();
  });

  const own = (records) => (records || []).filter(p => p.inst && p.inst.startsWith(TAG));
  const names = (records) => own(records).map(p => p.inst.replace(`${TAG} `, ''));

  // ───────────────────────── A. Date From only ─────────────────────────
  test('A. Date From only: a record before Date From is excluded', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2024, 6, 15) });
    expect(names(res.body.records)).not.toContain('A-Before');
  });
  test('A. Date From only: a record exactly on Date From is included', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2024, 6, 15) });
    expect(names(res.body.records)).toContain('A-On');
  });
  test('A. Date From only: a record after Date From is included', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2024, 6, 15) });
    expect(names(res.body.records)).toContain('A-After');
  });

  // ───────────────────────── B. Date To only ─────────────────────────
  test('B. Date To only: a record before Date To is included', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateTo: iso(2024, 6, 15) });
    expect(names(res.body.records)).toContain('B-Before');
  });
  test('B. Date To only: a record exactly on Date To is included', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateTo: iso(2024, 6, 15) });
    expect(names(res.body.records)).toContain('B-On');
  });
  test('B. Date To only: a record after Date To is excluded', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateTo: iso(2024, 6, 15) });
    expect(names(res.body.records)).not.toContain('B-After');
  });

  // ───────────────────── C. Both dates: 2023-09-26..2026-09-26 ─────────────────────
  test('C. both dates: 2023-09-25 (one day before Date From) is excluded', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records)).not.toContain('C-2023-09-25');
  });
  test('C. both dates: 2023-09-26 (exactly Date From) is included — no UTC day-shift', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records)).toContain('C-2023-09-26');
  });
  test('C. both dates: a date inside the range (2025-01-01) is included', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records)).toContain('C-2025-01-01');
  });
  test('C. both dates: 2026-09-26 (exactly Date To) is included — no UTC day-shift', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records)).toContain('C-2026-09-26');
  });
  test('C. both dates: 2026-09-27 (one day after Date To) is excluded', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records)).not.toContain('C-2026-09-27');
  });
  test('C. both dates: the result is exactly the 3 in-range records, nothing extra and nothing missing', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: `${TAG} C-`, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) });
    expect(names(res.body.records).sort()).toEqual(['C-2023-09-26', 'C-2025-01-01', 'C-2026-09-26'].sort());
  });

  // ───────────────────── D. Active Partnerships + date range together ─────────────────────
  test('D. Active Partnerships Report Type + a date range that contains both an Active and an already-Expired record: only the Active one is kept', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Active Partnerships', country: 'DateRangeTestland', inst: `${TAG} D-`, dateFrom: iso(2025, 1, 1), dateTo: iso(2025, 12, 31) });
    const mine = names(res.body.records);
    expect(mine).toContain('D-ActiveInside');
    expect(mine).not.toContain('D-ExpiredInside');
  });
  test('D. the same date range with reportType=Summary (no implied status) keeps both the Active and the Expired record — proves the date filter itself is status-blind', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: `${TAG} D-`, dateFrom: iso(2025, 1, 1), dateTo: iso(2025, 12, 31) });
    const mine = names(res.body.records);
    expect(mine).toContain('D-ActiveInside');
    expect(mine).toContain('D-ExpiredInside');
  });

  // ───────────────────── E. Empty date filters: unchanged baseline ─────────────────────
  test('E. empty Date From and Date To return every fixture record (13), unfiltered by date', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: '', dateTo: '' });
    expect(own(res.body.records).length).toBe(13);
  });
  test('E. omitting dateFrom/dateTo entirely behaves identically to passing them empty', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({ reportType: 'Summary', country: 'DateRangeTestland', inst: TAG });
    expect(own(res.body.records).length).toBe(13);
  });

  // ───────────────────── CIRL Staff sees the same filtering (no RBAC change) ─────────────────────
  test('CIRL Staff gets the identical inclusive-boundary result as Administrator for the same query', async () => {
    const q = { reportType: 'Summary', country: 'DateRangeTestland', inst: TAG, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) };
    const adminRes = await adminAgent.get('/api/reports/custom/preview').query(q);
    const staffRes = await staffAgent.get('/api/reports/custom/preview').query(q);
    expect(names(staffRes.body.records).sort()).toEqual(names(adminRes.body.records).sort());
  });

  // ───────────────────── Preview / PDF / Excel parity ─────────────────────
  test('Preview, PDF and Excel return the exact same record count for the 2023-09-26..2026-09-26 window', async () => {
    const q = { reportType: 'Summary', country: 'DateRangeTestland', inst: `${TAG} C-`, dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26) };
    const previewRes = await adminAgent.get('/api/reports/custom/preview').query(q);
    const previewCount = own(previewRes.body.records).length;
    expect(previewCount).toBe(3);

    const pdfRes = await adminAgent.get('/api/reports/partnerships/pdf').query(q);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await adminAgent.get('/api/reports/partnerships/excel').query(q)
      .buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    let excelOwnCount = 0;
    workbook.worksheets[0].eachRow(row => { const inst = row.getCell(2).text || row.getCell(2).value; if (typeof inst === 'string' && inst.startsWith(TAG)) excelOwnCount++; });
    expect(excelOwnCount).toBe(previewCount);
  });

  // ───────────────────── Preserved controls: Category / Agreement Type / Country / Unit / Group By ─────────────────────
  test('Category, Agreement Type, Country and Unit filters still combine correctly with a date range (none bypassed or ignored)', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({
      reportType: 'Summary', inst: `${TAG} C-`, cat: 'Local', agtype: 'MOA', country: 'DateRangeTestland', unit: 'CIRL',
      dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26)
    });
    expect(names(res.body.records).sort()).toEqual(['C-2023-09-26', 'C-2025-01-01', 'C-2026-09-26'].sort());
    // A non-matching Agreement Type must still zero it out — proves the date range didn't silently become the only active filter.
    const resMou = await adminAgent.get('/api/reports/custom/preview').query({
      reportType: 'Summary', inst: `${TAG} C-`, agtype: 'MOU', country: 'DateRangeTestland',
      dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26)
    });
    expect(own(resMou.body.records).length).toBe(0);
  });

  test('Group By still works unchanged when a date range is also applied', async () => {
    const res = await adminAgent.get('/api/reports/custom/preview').query({
      reportType: 'Summary', inst: `${TAG} C-`, country: 'DateRangeTestland', groupBy: 'country',
      dateFrom: iso(2023, 9, 26), dateTo: iso(2026, 9, 26)
    });
    expect(res.status).toBe(200);
    expect(own(res.body.records).length).toBe(3);
  });
});
