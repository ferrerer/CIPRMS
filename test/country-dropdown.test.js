// Covers the 2026-09-22 "Country dropdown" change (Registry → Add/Edit Partnership's Country field became a
// closed <select>, was free text) AND its 2026-09-22 follow-up making that field a searchable combobox (type
// to filter by substring, selection still only ever comes from the real list). Source-content checks cover the
// client-only pieces (the option list, the combobox's search/select logic, the OCR/institution-autocomplete
// matching helpers, the edit-modal legacy-value safeguard) that have no server behavior of their own; supertest
// checks cover what actually persists through the real API, exactly like the rest of this form's existing
// validation (see partnerships.test.js).
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Country dropdown — markup and client-side matching logic', () => {
  const view = read('views', 'administrator', 'monitoring.ejs');
  const script = read('assets', 'js', 'pages', 'registry-gridjs.init.js');
  // COUNTRY_OPTIONS moved out to its own shared file (2026-09-23) so the Reports & Analytics Custom Report
  // Builder's Country filter can use the exact same list — see test/custom-report-country-search.test.js for
  // the "one shared list, not two" check. registry-gridjs.init.js now only reads the global this defines.
  const sharedCountryList = read('assets', 'js', 'shared', 'country-options.js');

  test('the Add Partnership form\'s Country field is a searchable text combobox, not a plain select or free-text input', () => {
    expect(view).toMatch(/id="f-country-input"[^>]*placeholder="Type to search countries…"/);
    expect(view).not.toMatch(/id="f-country"[^>]*placeholder="e\.g\. Japan"/);
    expect(view).not.toMatch(/<select class="form-select" id="f-country">/); // the old plain-<select> UI
  });

  test('the real value of record is still the hidden #f-country / #e-country <select>, populated with the full option list', () => {
    expect(view).toMatch(/<select class="d-none" id="f-country" aria-hidden="true">\s*<option value="">Select country…<\/option>/);
    expect(view).toMatch(/<select class="d-none" id="e-country" aria-hidden="true">\s*<option value="">Select country…<\/option>/);
  });

  test('the Edit Partnership modal\'s Country field is also the searchable combobox', () => {
    expect(view).toMatch(/id="e-country-input"[^>]*placeholder="Type to search countries…"/);
  });

  test('the combobox looks like a normal form control — same input styling, a dropdown caret, and a bounded (non-excessively-tall) results list', () => {
    expect(view).toMatch(/id="f-country-input"[^>]*class="form-control country-combo-input"|class="form-control country-combo-input"[^>]*id="f-country-input"/);
    expect(view).toContain('country-combo-caret');
    // Reuses the exact same bounded dropdown as Unit/Nature (max-height + scroll, not an unbounded list).
    expect(view).toMatch(/\.unit-combo-dropdown\s*\{[^}]*max-height:\s*220px[^}]*overflow-y:\s*auto/);
  });

  test('both selects get a "not in the list" hint element for the manual-selection-needed case', () => {
    expect(view).toContain('id="f-country-hint"');
    expect(view).toContain('id="e-country-hint"');
  });

  test('the option list is comprehensive and includes the Philippines by its normal English name', () => {
    expect(sharedCountryList).toContain("var COUNTRY_OPTIONS = [");
    expect(sharedCountryList).toContain("'Philippines'");
    const match = sharedCountryList.match(/var COUNTRY_OPTIONS = \[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    const count = (match[1].match(/'[^']+'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(190);
  });

  test('the Registry page loads the shared list before registry-gridjs.init.js, which no longer defines its own copy', () => {
    const sharedTagPos = view.indexOf('/velzon/assets/js/shared/country-options.js');
    const registryTagPos = view.indexOf('/velzon/assets/js/pages/registry-gridjs.init.js');
    expect(sharedTagPos).toBeGreaterThan(-1);
    expect(registryTagPos).toBeGreaterThan(-1);
    expect(sharedTagPos).toBeLessThan(registryTagPos);
    expect(script).not.toMatch(/var COUNTRY_OPTIONS = \[/);
  });

  test('an exact or known-alias match auto-selects; an unrecognized value is never guessed at', () => {
    expect(script).toContain('function resolveCountryOption(raw)');
    expect(script).toContain('function setCountryField(prefix, raw)');
    expect(script).toMatch(/COUNTRY_ALIASES\s*=\s*\{[\s\S]*?'usa':\s*'United States'/);
    // The whole point: on a miss, the select is left as-is (never assigned a wrong value) and a hint is shown.
    expect(script).toMatch(/if \(matched\) \{\s*select\.value = matched;/);
    expect(script).toContain('not in the list above; please select the country manually');
  });

  test('OCR auto-fill and approved-request conversion both route Country through the same safe matcher', () => {
    const ocrBlock = script.slice(script.indexOf('function applyOcrToForm'), script.indexOf('function applyOcrToForm') + 2000);
    expect(ocrBlock).toContain("setCountryField('f', r.country)");
    const reqBlock = script.slice(script.indexOf('function applyRequestToForm'), script.indexOf('function applyRequestToForm') + 1000);
    expect(reqBlock).toContain('setCountryField(\'f\', r.country)');
  });

  test('the worldwide-institution-search auto-fill also uses the safe matcher, not a raw .value assignment', () => {
    const block = script.slice(script.indexOf('function selectInstitution'), script.indexOf('function selectInstitution') + 800);
    expect(block).toContain('setCountryField(instPrefix, u.country)');
    expect(block).not.toContain('countryEl.value = u.country');
  });

  test('opening Edit pre-fills the existing country, injecting it as a preserved option if this list doesn\'t carry it (never silently blanked/altered)', () => {
    expect(script).toContain('function setEditCountryValue(value)');
    const block = script.slice(script.indexOf('function setEditCountryValue'), script.indexOf('function setEditCountryValue') + 900);
    expect(block).toContain('data-legacy-country');
    expect(script).toMatch(/openEditModal\(id\)\{[\s\S]{0,700}setEditCountryValue\(p\.country\)/);
  });

  test('submitPartnership()/saveEdit() still read Country via plain .value — no payload/field-name change for the backend', () => {
    expect(script).toContain("country:document.getElementById('f-country').value.trim()");
    expect(script).toContain("country:document.getElementById('e-country').value.trim()");
  });

  test('createCountryCombo filters by substring anywhere in the name (not just a prefix)', () => {
    expect(script).toContain('function createCountryCombo(prefix)');
    const block = script.slice(script.indexOf('function createCountryCombo'), script.indexOf('populateCountrySelect(\'f-country\')'));
    expect(block).toContain("c.toLowerCase().indexOf(q) !== -1");
  });

  test('picking a result sets the real hidden select (only ever a real value, never arbitrary typed text) and closes the dropdown', () => {
    const block = script.slice(script.indexOf('function createCountryCombo'), script.indexOf('populateCountrySelect(\'f-country\')'));
    expect(block).toMatch(/function selectValue\(val\)\s*\{\s*select\.value = val;\s*input\.value = val;/);
    expect(block).toContain('closeDropdown();');
  });

  test('a change event is dispatched on selection, preserving the existing map-location-preview refresh behavior', () => {
    const block = script.slice(script.indexOf('function createCountryCombo'), script.indexOf('populateCountrySelect(\'f-country\')'));
    expect(block).toContain("select.dispatchEvent(new Event('change', { bubbles: true }))");
  });

  test('Enter selects an exact or prefix match; Escape and blur discard an unmatched, never-selected typed query', () => {
    const block = script.slice(script.indexOf('function createCountryCombo'), script.indexOf('populateCountrySelect(\'f-country\')'));
    expect(block).toMatch(/e\.key === 'Enter'/);
    expect(block).toMatch(/e\.key === 'Escape'/);
    expect(block).toContain("input.value = select.value || ''"); // reverts a partial/unselected query
  });

  // A real bug caught in live browser testing: Bootstrap's modal also closes on Escape (its default behavior),
  // so Escape typed into this field to dismiss ONLY the country results — without stopping propagation — also
  // silently closed the whole Add/Edit Partnership modal and discarded every other field already filled in.
  test('Escape only closes the country dropdown, not the whole Add/Edit Partnership modal (stops propagation to Bootstrap\'s own Escape-closes-modal handler)', () => {
    const block = script.slice(script.indexOf('function createCountryCombo'), script.indexOf('populateCountrySelect(\'f-country\')'));
    expect(block).toMatch(/e\.key === 'Escape' && dropdown\.style\.display === 'block'/);
    expect(block).toMatch(/e\.key === 'Escape'[^}]*e\.stopPropagation\(\)/s);
  });

  test('clicking outside the open dropdown closes it (extends the existing Unit/Nature outside-click handler)', () => {
    expect(script).toMatch(/\['unit', 'nature', 'country'\]\.forEach/);
  });

  test('the combobox is wired up for both the Add form and the Edit modal at load, alongside the existing Unit/Nature combos', () => {
    expect(script).toContain("createCountryCombo('f')");
    expect(script).toContain("createCountryCombo('e')");
  });

  test('a value set externally (OCR, edit-load, the map-preview "Did you mean" suggestion) is mirrored into the visible search input', () => {
    expect(script).toContain('function syncCountryDisplay(prefix)');
    const setCountryBlock = script.slice(script.indexOf('function setCountryField'), script.indexOf('function setCountryField') + 900);
    expect(setCountryBlock).toContain('syncCountryDisplay(prefix)');
    const setEditBlock = script.slice(script.indexOf('function setEditCountryValue'), script.indexOf('function setEditCountryValue') + 900);
    expect(setEditBlock).toContain("syncCountryDisplay('e')");
    expect(script).toMatch(/loc-suggest[\s\S]{0,600}syncCountryDisplay\(prefix\)/);
  });
});

describe('Country dropdown — server-side behavior (real API)', () => {
  let adminAgent;
  let ids = [];

  beforeAll(async () => {
    await connectDB();
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  });

  afterAll(async () => {
    if (ids.length) {
      const db = await connectDB();
      await db.collection('partnerships').deleteMany({ id: { $in: ids } });
    }
    await cleanupAll();
    await closeDB();
  });

  test('Philippines can be selected/submitted and is stored exactly as sent', async () => {
    const res = await adminAgent.post('/api/partnerships').send({
      inst: 'Jesttest Country Dropdown PH University', country: 'Philippines', region: 'Local', type: 'MOA',
      nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(res.status).toBe(200);
    expect(res.body.partnership.country).toBe('Philippines');
    ids.push(res.body.partnership.id);

    const listRes = await adminAgent.get('/api/partnerships');
    const found = listRes.body.find(p => p.id === res.body.partnership.id);
    expect(found.country).toBe('Philippines');
  });

  test('a different real country can be selected on edit and is stored/updated correctly', async () => {
    const created = await adminAgent.post('/api/partnerships').send({
      inst: 'Jesttest Country Dropdown Edit University', country: 'Japan', region: 'Asia', type: 'MOA',
      nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    ids.push(created.body.partnership.id);
    const editRes = await adminAgent.patch(`/api/partnerships/${created.body.partnership.id}`).send({ country: 'South Korea' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.partnership.country).toBe('South Korea');
  });

  test('editing an existing partnership WITHOUT changing its (pre-dropdown, non-standard) legacy country value still succeeds', async () => {
    // Simulates a real record saved before this field became a dropdown — its stored country never has to be
    // one of the ~199 options for the record to keep working (openEditModal's setEditCountryValue is what
    // keeps this visible/selected in the browser; the API side must simply never reject the unchanged resubmit).
    const created = await adminAgent.post('/api/partnerships').send({
      inst: 'Jesttest Country Dropdown Legacy University', country: 'Legacy Freeform Country Name', region: 'Asia',
      type: 'MOA', nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(created.status).toBe(200); // country itself was never enum-restricted server-side (see cirl.js comment)
    ids.push(created.body.partnership.id);
    const editRes = await adminAgent.patch(`/api/partnerships/${created.body.partnership.id}`).send({
      country: 'Legacy Freeform Country Name', coordinator: 'jesttest Someone'
    });
    expect(editRes.status).toBe(200);
    expect(editRes.body.partnership.country).toBe('Legacy Freeform Country Name');
  });

  test('an unreasonably long country value is rejected server-side (defense-in-depth, not just the client dropdown)', async () => {
    const res = await adminAgent.post('/api/partnerships').send({
      inst: 'Jesttest Country Dropdown Overlong University', country: 'X'.repeat(101), region: 'Asia', type: 'MOA',
      nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country/i);
  });

  test('country aggregation (Dashboard "Top Partnership Countries" / /api/partnerships/stats) still counts a dropdown-selected Philippines entry', async () => {
    const res = await adminAgent.post('/api/partnerships').send({
      inst: 'Jesttest Country Dropdown Stats University', country: 'Philippines', region: 'Local', type: 'MOA',
      nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    ids.push(res.body.partnership.id);
    const statsRes = await adminAgent.get('/api/partnerships/stats');
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.byCountry.Philippines).toBeGreaterThanOrEqual(1);
  });

  test('global search still finds a partnership by its (now dropdown-selected) country', async () => {
    const stamp = Date.now();
    const res = await adminAgent.post('/api/partnerships').send({
      inst: `Jesttest Country Dropdown Search University ${stamp}`, country: 'Kazakhstan', region: 'Asia', type: 'MOA',
      nature: 'Research', unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    ids.push(res.body.partnership.id);
    const searchRes = await adminAgent.get('/api/search').query({ q: 'Kazakhstan' });
    expect(searchRes.status).toBe(200);
    const hit = searchRes.body.partnerships.find(p => p.id === res.body.partnership.id);
    expect(hit).toBeDefined();
  });
});
