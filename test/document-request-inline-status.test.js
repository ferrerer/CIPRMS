// Document Requests (Administrator / CIRL Staff): the status is changed from a dropdown in the table's Status column,
// not from the details modal. The endpoint, its transition rules, RBAC and the realtime announcement are the existing
// ones (PATCH /api/document-requests/:id) and are asserted here for real; the page wiring is checked at source level
// and the behavior in a real browser (both roles, desktop + 390px) was verified live.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'partnership_requests.ejs'), 'utf8');
const block = (start, len) => src.slice(src.indexOf(start), src.indexOf(start) + len);

describe('Document Requests — inline status dropdown (page)', () => {
  test('each table row renders a status <select> in the Status column instead of a static badge', () => {
    expect(src).toContain('<td class="dr-status-cell">${drStatusSelectHtml(r)}</td>');
    const html = block('function drStatusSelectHtml(r)', 1500);
    expect(html).toContain('<select class="form-select form-select-sm dr-status-select');
    expect(html).toContain('data-id="${r.id}"');
  });

  test('the current status is the selected option, and the options are the existing workflow statuses', () => {
    const html = block('function drStatusSelectHtml(r)', 1500);
    expect(html).toContain("s === cs ? ' selected' : ''");
    expect(html).toContain('DR_WORKFLOW_STATUSES');
    expect(src).toContain("var DR_WORKFLOW_STATUSES = ['Received', 'Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed'];");
  });

  test('only the current stage and the next stage are selectable; a closed request is not editable; other roles get the badge', () => {
    const html = block('function drStatusSelectHtml(r)', 1500);
    expect(html).toContain("s !== cs && s !== next ? ' disabled' : ''");
    expect(html).toContain("terminal || !next || busy ? ' disabled' : ''");
    expect(html).toContain('if (!IS_ADMIN) return statusBadge(cs);');
  });

  test('the dropdown is coloured with the same classes as the status badges', () => {
    expect(src).toContain('function statusClasses(s)');
    expect(src).toContain('return `<span class="badge ${statusClasses(s)}">${s}</span>`;');
    expect(html()).toContain('${statusClasses(cs)}');
    function html() { return block('function drStatusSelectHtml(r)', 1500); }
  });

  test('a long status name is cut inside the control, not stretched across the table', () => {
    const css = block('.dr-status-select {', 420);
    expect(css).toMatch(/max-width: 200px/);
    expect(css).toMatch(/text-overflow: ellipsis/);
  });

  test('changing the dropdown calls the existing PATCH endpoint through the shared AJAX helper — no second update path', () => {
    const fn = block('async function submitDrStatusChange(', 3200);
    expect(fn).toContain("CIPRMS.api('/api/document-requests/' + id, { method: 'PATCH', json: body, quiet: true })");
    expect(src.match(/\/api\/document-requests\/' \+ id, \{ method: 'PATCH'/g).length).toBe(1);
    expect(src).not.toMatch(/fetch\('\/api\/document-requests\/'[^)]*PATCH/);
  });

  test('a change never reloads the page: the row is re-rendered from the response', () => {
    const fn = block('async function submitDrStatusChange(', 3200);
    expect(fn).toContain('Object.assign(r, res.data.request');
    expect(fn).toContain('renderDR();');
    expect(fn).not.toMatch(/location\.(reload|href)/);
  });

  test('failure: the previous status is restored (the row is rebuilt from the real data) and the shared error message is shown', () => {
    const fn = block('async function submitDrStatusChange(', 3200);
    expect(fn).toContain("showToast('<i class=\"ri-error-warning-line me-1\"></i>' + res.error, '#f06548')");
    expect(fn).toMatch(/if \(res\.status === 400 \|\| res\.status === 404 \|\| res\.status === 409\) \{ await refreshLive\(\)/);
    expect(fn).toMatch(/finally \{\s*drStatusInFlight\.delete\(id\);\s*renderDR\(\);/);
    // 403 / 5xx / timeout / network all arrive as { ok:false, error } from CIPRMS.api, whose messages are asserted below
    const rt = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ciprms-rt.js'), 'utf8');
    for (const s of ['status === 403', 'status === 409', 'status >= 500', 'The server took too long to respond', 'Network problem']) expect(rt).toContain(s);
  });

  test('double-click protection: one request per row at a time, the control is disabled while it runs and restored after', () => {
    const fn = block('async function submitDrStatusChange(', 3200);
    expect(fn).toContain('if (!r || drStatusInFlight.has(id)) return;');
    expect(fn).toContain('drStatusInFlight.add(id);');
    expect(block('function drStatusSelectHtml(r)', 1500)).toContain("const busy = drStatusInFlight.has(r.id);");
    const bind = block('function bindDrStatusSelects()', 900);
    expect(bind).toContain('if (drStatusInFlight.has(id)) { sel.value = previous; return; }');
  });

  test('one delegated listener, bound once (re-rendering the rows cannot pile up handlers)', () => {
    const bind = block('function bindDrStatusSelects()', 900);
    expect(bind).toContain("tbody.dataset.statusBound");
    expect((src.match(/bindDrStatusSelects\(\)/g) || []).length).toBe(2);   // the definition and the single call in init()
    expect(block('async function init()', 120)).toContain('bindDrStatusSelects();');
  });

  test('the status control is gone from the details modal, which still shows the status and every other detail/action', () => {
    expect(src).not.toContain('id="dr-status-update"');
    expect(src).not.toContain('Update Status');
    expect(src).not.toContain('populateDrStatusSelect');
    expect(src).not.toContain('updateDrStatus(');
    for (const s of ['id="dr-v-status"', 'id="dr-v-notes"', 'id="dr-received-by"', 'id="dr-remark-wrap"', 'id="dr-history-list"', 'onclick="openDRDraftModal()"', 'id="dr-modal-footer"', '/api/document-requests/${id}/pdf']) {
      expect(src).toContain(s);
    }
  });

  test('a Received By name from the modal is only used when the modal is open for THAT request', () => {
    expect(block('async function submitDrStatusChange(', 900)).toContain("currentDRId === id && document.getElementById('dr-modal').classList.contains('show')");
  });
});

describe('Document Requests — status endpoint contract (unchanged)', () => {
  let db, admin, staff, college, partner, collegeUser;
  const stamp = Date.now();
  const ids = [];

  beforeAll(async () => {
    db = await connectDB();
    admin = request.agent(app); await loginAs(admin, await createTestUser({ role: 'Administrator' }));
    staff = request.agent(app); await loginAs(staff, await createTestUser({ role: 'Staff' }));
    collegeUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    college = request.agent(app); await loginAs(college, collegeUser);
    partner = request.agent(app); await loginAs(partner, await createTestUser({ role: 'potential_partner' }));
  });
  afterAll(async () => {
    if (ids.length) await db.collection('documentrequests').deleteMany({ id: { $in: ids } });
    await cleanupAll();
    await closeDB();
  });
  const seed = async (status = 'Received') => {
    const last = (await db.collection('documentrequests').find({}).sort({ id: -1 }).limit(1).toArray())[0];
    const id = (last ? last.id : 0) + 1 + ids.length;
    await db.collection('documentrequests').insertOne({ id, institution: `jesttest InlineStatus ${stamp} ${id}`, documentType: 'MOA', documentTypes: ['MOA'], status, requestedBy: 'jesttest Requester', requestedByEmail: collegeUser.email, date: 'Sep 25, 2026', updatedAt: new Date().toISOString(), notes: 'jesttest' });
    ids.push(id);
    return id;
  };
  const statusOf = async id => (await db.collection('documentrequests').findOne({ id })).status;

  test.each([['Administrator', () => admin], ['CIRL Staff', () => staff]])('%s can move a request to the next stage with the existing PATCH request', async (label, who) => {
    const id = await seed('Received');
    const res = await who().patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.request.status).toBe('Preparing');
    expect(await statusOf(id)).toBe('Preparing');
    const doc = await db.collection('documentrequests').findOne({ id });
    expect(doc.statusHistory.at(-1)).toMatchObject({ from: 'Received', to: 'Preparing' });
  });

  test('a stage cannot be skipped or reversed (the dropdown disables those options, the server refuses them too)', async () => {
    const id = await seed('Received');
    const skip = await admin.patch(`/api/document-requests/${id}`).send({ status: 'Approved' });
    expect(skip.status).toBe(400);
    expect(await statusOf(id)).toBe('Received');
    await admin.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    const back = await admin.patch(`/api/document-requests/${id}`).send({ status: 'Received' });
    expect(back.status).toBe(400);
    expect(await statusOf(id)).toBe('Preparing');
  });

  test('an unknown status is rejected and a closed request cannot be changed', async () => {
    const id = await seed('Received');
    expect((await admin.patch(`/api/document-requests/${id}`).send({ status: 'Bogus' })).status).toBe(400);
    const done = await seed('Completed');
    const res = await admin.patch(`/api/document-requests/${done}`).send({ status: 'Received' });
    expect(res.status).toBe(400);
    expect(await statusOf(done)).toBe('Completed');
  });

  test('a missing request returns 404 (the page then re-reads the list)', async () => {
    expect((await admin.patch('/api/document-requests/99999999').send({ status: 'Preparing' })).status).toBe(404);
  });

  test('College Dean, Partner and signed-out users cannot change a status, and nothing changes', async () => {
    const id = await seed('Received');
    for (const agent of [college, partner, request.agent(app)]) {
      const res = await agent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
      expect([301, 302, 401, 403]).toContain(res.status);
    }
    expect(await statusOf(id)).toBe('Received');
  });

  test('the change is announced to the live-update system (the route is wrapped by announce("documentRequest"))', () => {
    const cirl = fs.readFileSync(path.join(__dirname, '..', 'cirl.js'), 'utf8');
    expect(cirl).toContain("app.patch('/api/document-requests/:id', requireStaffAccess, announce('documentRequest')");
    expect(src).toContain("'documentRequest.updated', 'documentRequest.statusChanged'");
  });
});
