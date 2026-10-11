// Responsible Unit retrieval/creation/persistence investigation (2026-11).
//
// Root cause / before state: the Add/Edit Partnership form's Responsible Unit field was a closed set
// hardcoded in TWO places — cirl.js's VALID_PARTNERSHIP_UNITS (server-side save validation) and
// registry-gridjs.init.js's own UNIT_OPTIONS (the dropdown) — with no way for an Administrator/Staff user
// to add a legitimately-missing unit without a code change, and no way the two copies could ever drift
// apart except by someone remembering to edit both. Both are now backed by one real collection
// (responsibleunits — db.js seeds it once, from that exact original 6-value list, so every existing
// partnership's stored `unit` keeps validating with zero migration) via GET/POST /api/responsible-units
// below, which cirl.js's own sanitizePartnershipFields()/validPartnershipUnitNames() now reads from
// instead of the old hardcoded array — adding a unit through this API is what actually makes it a legal
// value on a real partnership save, not just a cosmetic dropdown change.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db, adminAgent, staffAgent, deanAgent, partnerAgent;
const createdUnitIds = [];
const createdPartnershipIds = [];

beforeAll(async () => {
  db = await connectDB();
  const admin = await createTestUser({ role: 'Administrator' });
  const staff = await createTestUser({ role: 'Staff' });
  const dean = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  const partner = await createTestUser({ role: 'potential_partner' });
  adminAgent = request.agent(app); await loginAs(adminAgent, admin);
  staffAgent = request.agent(app); await loginAs(staffAgent, staff);
  deanAgent = request.agent(app); await loginAs(deanAgent, dean);
  partnerAgent = request.agent(app); await loginAs(partnerAgent, partner);
});

afterAll(async () => {
  if (createdPartnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: createdPartnershipIds } });
  if (createdUnitIds.length) await db.collection('responsibleunits').deleteMany({ id: { $in: createdUnitIds } });
  await cleanupAll();
  await closeDB();
});

describe('GET /api/responsible-units — retrieval', () => {
  test('returns the real, database-backed list, including the original seeded units ("do not remove existing options")', async () => {
    const res = await adminAgent.get('/api/responsible-units');
    expect(res.status).toBe(200);
    const names = res.body.map(u => u.name);
    for (const seed of ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL']) expect(names).toContain(seed);
  });

  test('Staff can also read the list (both roles manage this field today, per the existing /api/partnerships gate)', async () => {
    expect((await staffAgent.get('/api/responsible-units')).status).toBe(200);
  });

  test('College Dean, Partner and a signed-out request cannot read or create units (same RBAC boundary as /api/partnerships itself)', async () => {
    expect((await deanAgent.get('/api/responsible-units')).status).toBe(302);
    expect((await partnerAgent.get('/api/responsible-units')).status).toBe(302);
    expect((await request(app).get('/api/responsible-units')).status).toBe(302);
    expect((await deanAgent.post('/api/responsible-units').send({ name: `${TEST_TAG} Dean Snuck In Unit` })).status).toBe(302);
    expect((await request(app).post('/api/responsible-units').send({ name: `${TEST_TAG} Anon Unit` })).status).toBe(302);
    const leaked = await db.collection('responsibleunits').findOne({ name: { $regex: TEST_TAG } });
    expect(leaked).toBeNull(); // none of the rejected attempts above actually created anything
  });
});

describe('POST /api/responsible-units — creation, validation, duplicate prevention', () => {
  test('a well-formed new unit is created and persisted for real (not a JS-array-only or localStorage stand-in)', async () => {
    const name = `${TEST_TAG} New College of Testing`;
    const res = await adminAgent.post('/api/responsible-units').send({ name });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.unit.name).toBe(name);
    createdUnitIds.push(res.body.unit.id);

    const stored = await db.collection('responsibleunits').findOne({ id: res.body.unit.id });
    expect(stored).toBeTruthy();
    expect(stored.name).toBe(name);
    expect(stored.createdByEmail).toBeTruthy();

    // Visible again through a completely fresh request/agent — real server-side persistence, not
    // something only the one connection that created it can see.
    const freshAgent = request.agent(app);
    await loginAs(freshAgent, await createTestUser({ role: 'Staff' }));
    const listed = (await freshAgent.get('/api/responsible-units')).body.map(u => u.name);
    expect(listed).toContain(name);
  });

  test('leading/trailing whitespace is trimmed before saving', async () => {
    const name = `${TEST_TAG} Whitespace College`;
    const res = await adminAgent.post('/api/responsible-units').send({ name: `   ${name}   ` });
    expect(res.status).toBe(200);
    expect(res.body.unit.name).toBe(name); // not "   name   "
    createdUnitIds.push(res.body.unit.id);
  });

  test('an empty name is rejected', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('a whitespace-only name is rejected (trimming leaves nothing)', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: '     ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('a missing name field entirely is rejected, not a 500', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({});
    expect(res.status).toBe(400);
  });

  test('an exact duplicate of an existing (seeded) unit is rejected with a clear message', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: 'CIRL' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('a case-insensitive duplicate ("cirl" when "CIRL" already exists) is rejected, not silently created as a second entry', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: 'cirl' });
    expect(res.status).toBe(409);
    const all = await db.collection('responsibleunits').find({ name: { $regex: '^cirl$', $options: 'i' } }).toArray();
    expect(all.length).toBe(1); // still exactly the one original "CIRL" — no duplicate under any casing
  });

  test('a duplicate of a just-created custom unit is also rejected case-insensitively', async () => {
    const name = `${TEST_TAG} Case Test Institute`;
    const first = await adminAgent.post('/api/responsible-units').send({ name });
    createdUnitIds.push(first.body.unit.id);
    const dupe = await adminAgent.post('/api/responsible-units').send({ name: name.toUpperCase() });
    expect(dupe.status).toBe(409);
  });

  test('unsafe/markup-like input is rejected rather than stored verbatim', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: '<script>alert(1)</script>' });
    expect(res.status).toBe(400);
  });

  test('an overlong name is rejected', async () => {
    const res = await adminAgent.post('/api/responsible-units').send({ name: 'A'.repeat(200) });
    expect(res.status).toBe(400);
  });

  test('CIRL Staff can also create a unit (both roles manage this field today)', async () => {
    const name = `${TEST_TAG} Staff Created College`;
    const res = await staffAgent.post('/api/responsible-units').send({ name });
    expect(res.status).toBe(200);
    createdUnitIds.push(res.body.unit.id);
  });
});

describe('Partnership integration — the selected/created unit is actually saved on the partnership, not just the dropdown', () => {
  test('saving a partnership with an existing (seeded) unit stores that real value', async () => {
    const res = await adminAgent.post('/api/partnerships').send({
      inst: `${TEST_TAG} Existing Unit Partner`, country: 'Testland', type: 'MOA', nature: 'Research',
      unit: ['CETE'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(res.status).toBe(200);
    createdPartnershipIds.push(res.body.partnership.id);
    expect(res.body.partnership.unit).toEqual(['CETE']);
    const stored = await db.collection('partnerships').findOne({ id: res.body.partnership.id });
    expect(stored.unit).toEqual(['CETE']);
  });

  test('a brand-new Responsible Unit, created through the API, can immediately be used to save a partnership (previously impossible — it would have failed server-side validation even if the dropdown showed it)', async () => {
    const unitName = `${TEST_TAG} Brand New Responsible Unit`;
    const created = await adminAgent.post('/api/responsible-units').send({ name: unitName });
    expect(created.status).toBe(200);
    createdUnitIds.push(created.body.unit.id);

    const res = await adminAgent.post('/api/partnerships').send({
      inst: `${TEST_TAG} New Unit Partner`, country: 'Testland', type: 'MOA', nature: 'Research',
      unit: [unitName], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(res.status).toBe(200);
    createdPartnershipIds.push(res.body.partnership.id);
    expect(res.body.partnership.unit).toEqual([unitName]);
    const stored = await db.collection('partnerships').findOne({ id: res.body.partnership.id });
    expect(stored.unit).toEqual([unitName]);
  });

  test('a unit that genuinely does not exist anywhere is still rejected — the field is not wide open', async () => {
    const res = await adminAgent.post('/api/partnerships').send({
      inst: `${TEST_TAG} Should Not Be Created`, country: 'Testland', type: 'MOA', nature: 'Research',
      unit: [`${TEST_TAG} Totally Made Up Unit That Was Never Added`], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unit must only contain/);
  });

  test('editing an existing partnership to use a newly created unit also works (PATCH, not just POST)', async () => {
    const base = await adminAgent.post('/api/partnerships').send({
      inst: `${TEST_TAG} Patch Unit Partner`, country: 'Testland', type: 'MOA', nature: 'Research',
      unit: ['CCS'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest'
    });
    createdPartnershipIds.push(base.body.partnership.id);

    const unitName = `${TEST_TAG} Edit-Flow Unit`;
    const created = await adminAgent.post('/api/responsible-units').send({ name: unitName });
    createdUnitIds.push(created.body.unit.id);

    const patched = await adminAgent.patch(`/api/partnerships/${base.body.partnership.id}`).send({ unit: [unitName] });
    expect(patched.status).toBe(200);
    const stored = await db.collection('partnerships').findOne({ id: base.body.partnership.id });
    expect(stored.unit).toEqual([unitName]);
  });
});

describe('Source-level: the Responsible Unit combo now offers "+ Add Responsible Unit" instead of only the old hardcoded list', () => {
  const fs = require('fs');
  const path = require('path');
  const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'pages', 'registry-gridjs.init.js'), 'utf8');
  // 2026-11 Dynamic College/Unit Dropdowns: UNIT_OPTIONS/loadResponsibleUnits()/openAddResponsibleUnitModal()/
  // submitAddResponsibleUnit() were extracted out of registry-gridjs.init.js into this shared file so Reports
  // & Analytics' College/Unit filter and Comparison fields could reuse the exact same list and modal instead
  // of growing their own copy — same behavior, same real API call, just relocated.
  const sharedSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'shared', 'responsible-units.js'), 'utf8');

  test('UNIT_OPTIONS is loaded from the real API, not left as a permanently-fixed array', () => {
    expect(sharedSrc).toContain('function loadResponsibleUnits()');
    expect(sharedSrc).toContain("CIPRMS.api('/api/responsible-units'");
    expect(sharedSrc).toContain('loadResponsibleUnits();');
    // registry-gridjs.init.js no longer defines its own copy — it relies on the shared file (loaded first,
    // see monitoring.ejs's <script> order) for this exact same global.
    expect(jsSrc).not.toContain('function loadResponsibleUnits()');
  });

  test('only the Unit combo gets the add-new affordance — Nature and Country are unaffected', () => {
    expect(jsSrc).toContain("function createUnitCombo(prefix) { return createChipCombo(prefix, 'unit', UNIT_OPTIONS, { allowAddNew: true }); }");
    expect(jsSrc).toMatch(/function createNatureCombo\(prefix\) \{ return createChipCombo\(prefix, 'nature', NATURE_OPTIONS, \{ restrictToOptions: false \}\); \}/);
  });

  test('adding a unit auto-selects it on whichever form opened the modal, without a full page reload', () => {
    const fn = sharedSrc.slice(sharedSrc.indexOf('async function submitAddResponsibleUnit'), sharedSrc.indexOf('async function submitAddResponsibleUnit') + 2000);
    expect(fn).toContain('pendingUnitCombo.addValue(savedName)');
    expect(fn).not.toMatch(/location\.(reload|href)/);
  });

  test('the Add Responsible Unit modal is a separate, stackable, shared modal (not nested inside/replacing the Add Partnership modal, not duplicated per page)', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'monitoring.ejs'), 'utf8');
    // Monitoring includes the shared partial rather than defining its own copy of the modal markup...
    expect(view).toContain("include('../partials/add_unit_modal')");
    expect(view.indexOf("include('../partials/add_unit_modal')")).toBeGreaterThan(view.indexOf('<!--end delete modal -->'));
    // ...and Reports & Analytics' College/Unit filter/Comparison fields reuse that exact same partial too,
    // never a second "Add Unit" modal of its own.
    const reportsView = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
    expect(reportsView).toContain("include('../partials/add_unit_modal')");
    // The partial itself still defines one real, separate, top-level, stackable modal.
    const partial = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'add_unit_modal.ejs'), 'utf8');
    expect(partial).toContain('<div class="modal fade zoomIn" id="add-unit-modal"');
  });
});
