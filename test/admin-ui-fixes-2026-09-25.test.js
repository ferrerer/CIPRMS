// Administrator / CIRL Staff UI fixes (2026-09-25): Top Partner Countries, Document Library and Search Results dark
// mode, the Custom Report Builder date filter, the Audit Trail search placeholder, and the attendance modal width.
// Page code is checked at source level (and the aggregation function is actually executed); the date filter is
// asserted against the real API with disposable fixtures. Behavior in a real browser was verified live separately.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Dashboard — Top Partner Countries aggregates the real records', () => {
  const src = read('views', 'administrator', 'admin_dashboard.ejs');
  // Execute the page's own lookup + aggregation code, exactly as shipped.
  const start = src.indexOf('const COUNTRY_CODE = {');
  const end = src.indexOf('function renderTopCountries(');
  const { aggregateCountries, countryToFlagEmoji } = new Function(`${src.slice(start, end)}\nreturn { aggregateCountries, countryToFlagEmoji };`)();
  const recs = list => list.map(country => ({ country }));

  test('spelling variants of one country (case, spacing, bare ISO code) count as one country', () => {
    const out = aggregateCountries(recs(['Philippines', 'philippines', '  Philippines ', 'ph', 'PH', 'Japan', 'JAPAN']));
    expect(out[0]).toMatchObject({ country: 'Philippines', code: 'ph', count: 5 });
    expect(out[1]).toMatchObject({ country: 'Japan', code: 'jp', count: 2 });
  });

  test('multiple partnerships from one country are summed, and the ranking is by that total', () => {
    const out = aggregateCountries(recs(['Japan', 'Japan', 'Japan', 'China', 'China', 'Australia']));
    expect(out.map(o => [o.country, o.count])).toEqual([['Japan', 3], ['China', 2], ['Australia', 1]]);
  });

  test('ties are ordered by name, so the list never reshuffles between refreshes', () => {
    const out = aggregateCountries(recs(['Thailand', 'Australia', 'Singapore', 'India']));
    expect(out.map(o => o.country)).toEqual(['Australia', 'India', 'Singapore', 'Thailand']);
  });

  test('a country we cannot identify keeps its own spelling (most-used variant), is never invented, and gets no flag', () => {
    const out = aggregateCountries(recs(['Xanadu', 'xanadu', 'Xanadu', '', '   ', null, undefined]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ country: 'Xanadu', code: null, count: 3 });
  });

  test('when two spellings are equally common, the capitalized one is shown', () => {
    const out = aggregateCountries(recs(['philipines', 'Philipines']));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ country: 'Philipines', count: 2 });
  });

  test('a misspelling is NOT guessed into a real country (only exact names/codes merge)', () => {
    const out = aggregateCountries(recs(['Philipines', 'Philippines']));
    expect(out.map(o => o.country).sort()).toEqual(['Philipines', 'Philippines']);
  });

  test('flags are found regardless of case, and unknown countries get no flag code', () => {
    expect(countryToFlagEmoji('philippines')).toBe('🇵🇭');
    expect(countryToFlagEmoji('JP')).toBe('🇯🇵');
    expect(countryToFlagEmoji('Nowhereland')).toBeNull();
    expect(countryToFlagEmoji('')).toBeNull();
  });

  test('empty input aggregates to nothing (no fabricated rows) and the widget words the two empty states differently', () => {
    expect(aggregateCountries([])).toEqual([]);
    expect(aggregateCountries(recs(['', null]))).toEqual([]);
    expect(src).toContain('No partnership has a country recorded yet.');
    expect(src).toContain('No partnership records yet.');
  });

  test('long names are cut with a tooltip, and the list is still fed by the live refresh', () => {
    expect(src).toContain('text-truncate" title="${esc(country)}"');
    expect(src).toContain('renderTopCountries(list);');
    expect(src).toContain('loadDashboardData(true)');
  });
});

describe('Document Library and Search Results — dark mode', () => {
  const docs = read('views', 'administrator', 'documents.ejs');
  const search = read('views', 'administrator', 'search_results.ejs');

  test('the nature-pill count badge (bg-white) is no longer light-on-white in dark mode', () => {
    expect(docs).toMatch(/\[data-bs-theme="dark"\] \.badge\.bg-white \{ background-color: rgba\(255,255,255,\.18\) !important; color: #f1f3f5 !important; \}/);
  });

  test('the Type filter, Preview/soft-blue/soft-info/soft-secondary buttons get readable dark-mode colours, hover and focus states', () => {
    for (const sel of ['.btn-outline-primary', '.btn-outline-primary:hover', '.btn-outline-primary.active', '.btn-soft-primary', '.btn-soft-primary:hover', '.btn-soft-info', '.btn-soft-secondary']) {
      expect(docs).toContain(`[data-bs-theme="dark"] ${sel}`);
    }
    expect(docs).toContain('[data-bs-theme="dark"] .btn-outline-primary:focus-visible');
  });

  test('all the new Document Library rules are dark-only, so light mode is untouched', () => {
    const block = docs.slice(docs.indexOf('Dark-mode contrast pass'), docs.indexOf('</style>', docs.indexOf('Dark-mode contrast pass')));
    const rules = block.split('\n').filter(l => /^\s*(\[data-bs-theme|\.)/.test(l) && l.includes('{'));
    expect(rules.length).toBeGreaterThan(8);
    for (const r of rules) expect(r.trim().startsWith('[data-bs-theme="dark"]')).toBe(true);
  });

  test('Search Results: the highlight is a dark-friendly amber with light text (was light text on pale yellow), dark only', () => {
    expect(search).toContain('[data-bs-theme="dark"] #search-page-results mark { background: rgba(247, 184, 75, .32); color: #ffe6b0; }');
    expect(search).toContain('#search-page-results mark { background: #fff3a3;');   // the light-mode rule is unchanged
    expect(search).toMatch(/\[data-bs-theme="dark"\] #search-page-results \.search-result-item:hover/);
  });
});

describe('Reports — Custom Report Builder date filter UI and Audit Trail search', () => {
  const src = read('views', 'administrator', 'reports.ejs');

  test('From later than To is flagged on the fields and blocks Preview and PDF/Excel; one bound alone or empty dates never do', () => {
    const fn = src.slice(src.indexOf('function validateCustomReportDates('), src.indexOf('function buildReportQueryParams'));
    expect(fn).toContain("from.value && to.value && from.value > to.value");
    expect(src).toContain('id="cr-date-error"');
    expect(src).toContain('Date To cannot be earlier than Date From.');
    expect(src).toMatch(/function previewCustomReport\(\) \{\s*if \(document\.getElementById\('cr-type'\)\.value !== 'Audit' && !validateCustomReportDates\(\)\) return;/);
    expect(src).toMatch(/if \(!validateCustomReportDates\(\)\) return;\s*var params = buildReportQueryParams\(\);\s*window\.open\('\/api\/reports\/partnerships\//);
  });

  test('the dates are sent unchanged as YYYY-MM-DD (no client-side date maths that could shift a day)', () => {
    expect(src).toContain("if (dateFrom) params.set('dateFrom', dateFrom);");
    expect(src).toContain("if (dateTo) params.set('dateTo', dateTo);");
  });

  test('the builder explains what the dates mean, and Reset clears any date error', () => {
    expect(src).toContain('overlaps the dates you choose');
    expect(src).toContain("document.getElementById('cr-date-from').classList.remove('is-invalid');");
  });

  test('the preview shows readable filter chips ("Date From: Sep 24, 2026") built without timezone conversion', () => {
    expect(src).toContain("dateFrom: 'Date From', dateTo: 'Date To'");
    expect(src).toContain('var niceDate = function (v)');
    expect(src).not.toContain('new Date(pair[1])');
  });

  test('the Audit Trail search placeholder names only what the search really matches', () => {
    expect(src).toContain("language: { search: { placeholder: 'Search action, record, performed by or date…' } }");
    // the searchable columns of the grid are exactly: #, Action, Record / Details, Performed By, Role, Date & Time
    expect(src).toContain("{ name: 'Record / Details'");
    expect(src).toContain("{ name: 'Performed By' }");
    expect(src).toContain("{ name: 'Date & Time' }");
    expect(src).not.toMatch(/placeholder: 'Search[^']*(institution|partner|country|status)/i);
  });

  test('the placeholder is readable in both themes and ellipsised, scoped to the Audit Trail so other tables keep the system-wide hidden placeholder (version bumped)', () => {
    const css = read('assets', 'css', 'ciprms-bridge.css');
    expect(css).toContain('#audit-grid .gridjs-search-input.gridjs-input::placeholder { color: #74788d; opacity: 1; }');
    expect(css).toContain('[data-bs-theme="dark"] #audit-grid .gridjs-search-input.gridjs-input::placeholder { color: #a5adbd; opacity: 1; }');
    expect(css).toContain('#audit-grid .gridjs-search-input.gridjs-input { text-overflow: ellipsis; }');
    // the team's rule that hides Grid.js's fallback text on every other table is still there and still global
    expect(css).toContain('.gridjs-search-input.gridjs-input::placeholder { color: transparent; }');
    const generic = css.split('\n').map(l => l.trim()).filter(l => l.startsWith('.gridjs-search-input.gridjs-input::placeholder') || l.startsWith('[data-bs-theme="dark"] .gridjs-search-input.gridjs-input::placeholder'));
    expect(generic).toEqual(['.gridjs-search-input.gridjs-input::placeholder { color: transparent; }']);
    expect(src).toContain('ciprms-bridge.css?v=20260925d');
  });
});

describe('Calendar — attendance modal is wider and scrolls inside itself', () => {
  const src = read('views', 'administrator', 'calendar.ejs');
  test('wider on desktop only, capped to the viewport, list scrolls with a sticky header', () => {
    expect(src).toMatch(/@media \(min-width: 992px\) \{ #attendance-modal \.modal-dialog \{ --vz-modal-width: 1040px; \} \}/);
    expect(src).toMatch(/@media \(min-width: 1400px\) \{ #attendance-modal \.modal-dialog \{ --vz-modal-width: 1160px; \} \}/);
    expect(src).toContain('#attendance-modal .modal-content { max-height: calc(100vh - 2rem); }');
    expect(src).toMatch(/#attendance-modal \.table-responsive \{ max-height: calc\(100vh - 21rem\);[^}]*overflow: auto; \}/);
    expect(src).toContain('#attendance-modal thead th { position: sticky; top: 0;');
  });
  test('the modal markup, columns and attendance code are unchanged (one modal, same ids)', () => {
    expect((src.match(/id="attendance-modal"/g) || []).length).toBe(1);
    expect(src).toContain('<th>Name</th><th>Role</th><th>Email</th><th>Invitation</th><th>Status</th><th>Time Joined</th>');
    expect(src).toContain("fetch('/api/calendarevents/' + id + '/attendance')");
  });
});

describe('Custom Report Builder — date boundaries against the real API (disposable fixtures)', () => {
  let admin, db;
  const stamp = Date.now(), TAG = `Jesttest DateBound ${stamp}`;
  const ids = [];
  beforeAll(async () => {
    db = await connectDB();
    admin = request.agent(app); await loginAs(admin, await createTestUser({ role: 'Administrator' }));
    const last = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const mk = (n, name, start, end) => ({ id: last + n, inst: `${TAG} ${name}`, country: 'Testland', type: 'MOA', cat: 'International', unit: ['CCS'], nature: ['Research'], region: 'Asia', status: 'Active', start, end, remarks: 'jesttest' });
    const docs = [mk(1, 'A', 'Mar 10, 2040', 'Mar 20, 2040'), mk(2, 'B', 'Mar 21, 2040', 'Mar 31, 2040'), mk(3, 'C', 'Feb 1, 2040', 'Feb 28, 2040')];
    ids.push(...docs.map(d => d.id));
    await db.collection('partnerships').insertMany(docs);
  });
  afterAll(async () => { await db.collection('partnerships').deleteMany({ id: { $in: ids } }); await cleanupAll(); await closeDB(); });
  const names = async q => ((await admin.get('/api/reports/custom/preview').query({ reportType: 'Summary', inst: TAG, ...q })).body.records || []).map(r => r.inst.slice(-1)).sort().join('');

  test('no dates: every record; empty date strings never filter', async () => {
    expect(await names({})).toBe('ABC');
    expect(await names({ dateFrom: '', dateTo: '' })).toBe('ABC');
  });
  test('Date From only: a record ending exactly on that day is included (inclusive boundary), earlier-ended ones are not', async () => {
    expect(await names({ dateFrom: '2040-03-20' })).toBe('AB');
    expect(await names({ dateFrom: '2040-03-21' })).toBe('B');
  });
  test('Date To only: a record starting exactly on that day is included, later-starting ones are not', async () => {
    expect(await names({ dateTo: '2040-03-21' })).toBe('ABC');
    expect(await names({ dateTo: '2040-03-20' })).toBe('AC');
  });
  test('both dates, and the same date in both fields, show the agreements running that day', async () => {
    expect(await names({ dateFrom: '2040-03-01', dateTo: '2040-03-15' })).toBe('A');
    expect(await names({ dateFrom: '2040-03-20', dateTo: '2040-03-20' })).toBe('A');
    expect(await names({ dateFrom: '2040-03-21', dateTo: '2040-03-21' })).toBe('B');
  });
  test('a reversed range and a range with no agreements return a real empty result, never fabricated rows', async () => {
    const rev = await admin.get('/api/reports/custom/preview').query({ reportType: 'Summary', inst: TAG, dateFrom: '2040-03-21', dateTo: '2040-03-20' });
    expect(rev.status).toBe(200); expect(rev.body.records).toEqual([]);
    expect(await names({ dateFrom: '2041-01-01' })).toBe('');
  });
  test('the chosen dates are echoed back with the result', async () => {
    const res = await admin.get('/api/reports/custom/preview').query({ reportType: 'Summary', inst: TAG, dateFrom: '2040-03-01', dateTo: '2040-03-15' });
    expect(res.body.filters).toMatchObject({ dateFrom: '2040-03-01', dateTo: '2040-03-15' });
    expect(res.body.periodLabel).toContain('2040-03-01');
  });
  test('Group By still works with a date range (grouped result covers only the matching records)', async () => {
    const res = await admin.get('/api/reports/custom/preview').query({ reportType: 'Summary', inst: TAG, dateFrom: '2040-03-20', groupBy: 'country' });
    expect(res.body.isComparison).toBe(true);
    const total = (res.body.comparisonData || []).reduce((n, r) => n + (r.Total || r.total || 0), 0);
    expect(total).toBe(2);
  });
});
