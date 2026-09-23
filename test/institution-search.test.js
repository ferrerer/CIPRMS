// Covers the 2026-09-23 Institution Name search improvement: /api/institutions (the "Worldwide DB" proxy
// behind the Add/Edit Partnership form's institution autocomplete) now ALSO searches this app's own
// previously-recorded partner institutions (`partnerships.inst`) and merges them ahead of the external
// universities.hipolabs.com results — a real, already-existing, zero-new-dependency data source that fills a
// confirmed gap (the external API has zero results for "TESDA", "DOST", or "Camarines", none of which are
// universities). No new field/shape was introduced: every result, internal or external, is still {name,
// country}, exactly what selectInstitution() in registry-gridjs.init.js already expects — so its Country/
// Region auto-fill, map-location behavior, and OCR compatibility all continue unchanged (verified by the
// existing Country dropdown/combobox tests, which exercise that same function).
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

jest.setTimeout(30000); // this route calls a real third-party API for the external half of its results

describe('Institution search — markup/CSS (visual consistency, no overflow)', () => {
  const view = read('views', 'administrator', 'monitoring.ejs');

  test('the worldwide-search results dropdown is height-capped and scrollable — cannot overflow the modal', () => {
    expect(view).toMatch(/#ac-dropdown,\s*#e-ac-dropdown\s*\{[^}]*max-height:\s*260px[^}]*overflow-y:\s*auto/);
  });

  test('the Institution and Country dropdowns share the same rounded-corner/shadow visual language', () => {
    const instRule = view.match(/#ac-dropdown, #e-ac-dropdown \{([^}]*)\}/)[1];
    const countryRule = view.match(/\.unit-combo-dropdown\s*\{([^}]*)\}/)[1];
    expect(instRule).toContain('border-radius: 8px');
    expect(countryRule).toContain('border-radius: 8px');
    expect(instRule).toMatch(/box-shadow: 0 10px 28px rgba\(20,25,45,\.14\)/);
    expect(countryRule).toMatch(/box-shadow: 0 10px 28px rgba\(20,25,45,\.14\)/);
  });

  test('existing markup — the Institution Name label, Worldwide DB badge, and both autocomplete dropdowns — is untouched', () => {
    expect(view).toContain('Institution Name');
    expect(view).toContain('Worldwide DB');
    expect(view).toContain('id="ac-dropdown"');
    expect(view).toContain('id="e-ac-dropdown"');
    expect(view).toContain('oninput="instSearch(this.value)"');
    expect(view).toContain("oninput=\"instSearch(this.value, 'e')\"");
  });
});

describe('Institution search — client-side behavior (debounce, keyboard nav, manual-entry messaging)', () => {
  const script = read('assets', 'js', 'pages', 'registry-gridjs.init.js');

  test('search is debounced (not fired on every keystroke) and requires a minimum query length', () => {
    const block = script.slice(script.indexOf('function instSearch'), script.indexOf('function instSearch') + 1400);
    expect(block).toMatch(/setTimeout\(function[\s\S]*?\},\s*300\)/);
    expect(block).toContain('q.length < 2');
  });

  test('keyboard navigation (Arrow keys, Enter, Escape) is supported', () => {
    expect(script).toContain('function instKeyNav(event, prefix)');
    const block = script.slice(script.indexOf('function instKeyNav'), script.indexOf('function instKeyNav') + 700);
    expect(block).toContain("'ArrowDown'");
    expect(block).toContain("'ArrowUp'");
    expect(block).toContain("'Enter'");
    expect(block).toContain("'Escape'");
  });

  test('clicking outside the open institution dropdown closes it', () => {
    const block = script.slice(script.lastIndexOf('function instKeyNav'));
    expect(block).toMatch(/document\.addEventListener\('click', function \(e\) \{\s*\['f', 'e'\]\.forEach/);
  });

  test('no matches found still lets the person keep the manually-typed institution name (never a dead end)', () => {
    expect(script).toContain('you can keep typing to use this name manually');
  });

  test('a value is only ever POSTed as free text — Institution Name was never turned into a closed list like Country', () => {
    expect(script).toContain("document.getElementById('f-inst').value.trim()");
  });
});

describe('Institution search — server-side behavior (real API, real data, no fabrication)', () => {
  let adminAgent;
  let partnershipIds = [];

  beforeAll(async () => {
    await connectDB();
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  });

  afterAll(async () => {
    if (partnershipIds.length) {
      const db = await connectDB();
      await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    }
    await cleanupAll();
    await closeDB();
  });

  test('requires authentication (unchanged RBAC)', async () => {
    const res = await request(app).get('/api/institutions').query({ name: 'harvard' });
    expect([302, 401]).toContain(res.status);
  });

  test('a query under 2 characters returns no results without calling anything', async () => {
    const res = await adminAgent.get('/api/institutions').query({ name: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('a real, well-known worldwide university is still found (external source unaffected)', async () => {
    const res = await adminAgent.get('/api/institutions').query({ name: 'Harvard' });
    expect(res.status).toBe(200);
    expect(res.body.some(u => /Harvard/i.test(u.name))).toBe(true);
  });

  test('malformed/hostile input is handled safely and never crashes or 500s', async () => {
    for (const q of ["Robert'); DROP TABLE partnerships;--", '<script>alert(1)</script>', 'x'.repeat(500)]) {
      const res = await adminAgent.get('/api/institutions').query({ name: q });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  test('a real, previously-recorded partner institution the external worldwide API does not have is now findable', async () => {
    const stamp = Date.now();
    const lastP = (await (await connectDB()).collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const id = lastP + 1;
    const db = await connectDB();
    const distinctiveName = `Jesttest Institution Search Agency ${stamp}`;
    await db.collection('partnerships').insertOne({
      id, inst: distinctiveName, country: 'Philippines', type: 'MOA', status: 'Active',
      unit: ['CCS'], nature: ['Training'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    partnershipIds.push(id);

    const res = await adminAgent.get('/api/institutions').query({ name: `Jesttest Institution Search Agency ${stamp}` });
    expect(res.status).toBe(200);
    const hit = res.body.find(u => u.name === distinctiveName);
    expect(hit).toBeDefined();
    expect(hit.country).toBe('Philippines'); // real, previously-entered country — never fabricated
  });

  test('an internal match is not duplicated if it also happens to appear externally, and results stay capped', async () => {
    const res = await adminAgent.get('/api/institutions').query({ name: 'University' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(15);
    const names = res.body.map(u => u.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length); // no duplicate name in the merged result set
  });

  test('confirmed limitation of the external worldwide database, documented rather than papered over with fake data: it has zero results for non-university government/training partners', async () => {
    const http = require('http');
    const raw = await new Promise(resolve => {
      http.get('http://universities.hipolabs.com/search?name=TESDA', r => {
        let data = ''; r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
      }).on('error', () => resolve([]));
    });
    expect(raw.length).toBe(0); // the gap this task's internal-data merge exists to cover
  });
});
