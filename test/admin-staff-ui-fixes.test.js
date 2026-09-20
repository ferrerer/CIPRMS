// Administrator / CIRL Staff UI fixes (2026-09-20) — the parts that are checkable from the rendered
// HTML and the APIs. (The geometry of the calendar, the modals and the PDF is verified in a real
// browser / by test/document-request-pdf-layout.test.js.)
//   1. Calendar: the calendar card is no longer stretched to a fixed-height sidebar box.
//   2. Requests: View Draft cards can shrink and wrap; modals are swapped, never stacked, and each
//      is driven through ONE Bootstrap instance (getOrCreateInstance), never `new bootstrap.Modal(...)`.
//   3. (PDF: see document-request-pdf-layout.test.js.)
//   4. Document Library: no "Accreditation" in the Type Filter — but Accreditation records stay.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, adminAgent, staffAgent, collegeAgent, adminUser, staffUser;
const createdDocIds = [];

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app); await loginAs(adminAgent, adminUser);
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app); await loginAs(staffAgent, staffUser);
  collegeAgent = request.agent(app); await loginAs(collegeAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
});
afterAll(async () => {
  if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
  await cleanupAll();
  await closeDB();
});

const ADMIN_STAFF_PAGES = (kind) => ({ Administrator: { agent: () => adminAgent, url: { calendar: '/calendar', requests: '/partnership-requests', documents: '/documents' }[kind] },
                                       'CIRL Staff': { agent: () => staffAgent, url: { calendar: '/staff/calendar', requests: '/staff/requests', documents: '/staff/documents' }[kind] } });

describe('Calendar layout (Administrator and CIRL Staff share one template)', () => {
  test.each(Object.entries(ADMIN_STAFF_PAGES('calendar')))('%s: the calendar card is content-height and the Upcoming list flexes instead of a fixed 400px box', async (_role, { agent, url }) => {
    const res = await agent().get(url);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="card cal-card"');
    expect(res.text).not.toMatch(/class="[^"]*card-h-100/);                  // the stretch that left ~290px of empty card
    expect(res.text).toContain('class="col-xl-3 cal-side"');
    expect(res.text).toContain('class="cal-upcoming-scroll');
    expect(res.text).not.toMatch(/data-simplebar[^>]*height:\s*400px/); // the fixed-height box that set the row height
    expect(res.text).toContain('id="upcoming-event-list"');
    expect(res.text).toContain('aspectRatio: calendarAspect(window.innerWidth)');
    expect(res.text).toContain("classList.toggle('cal-card-fill'");
  });

  test('the calendar keeps its management controls for Administrator/Staff and stays view-only for College Staff', async () => {
    for (const agent of [adminAgent, staffAgent]) {
      const html = (await agent.get(agent === adminAgent ? '/calendar' : '/staff/calendar')).text;
      expect(html).toContain('id="btn-new-event"');
      expect(html).toContain('class="external-event fc-event');
    }
    const college = await collegeAgent.get('/personnel/calendar');
    expect(college.status).toBe(200);
    expect(college.text).not.toContain('id="btn-new-event"');
    expect(college.text).toContain('class="card cal-card"');
  });
});

describe('Requests — View Draft', () => {
  test.each(Object.entries(ADMIN_STAFF_PAGES('requests')))('%s: draft cards can shrink and wrap long filenames/notes', async (_role, { agent, url }) => {
    const res = await agent().get(url);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/\.draft-item\s*\{\s*min-width:\s*0;\s*\}/);
    expect(res.text).toMatch(/\.draft-card\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(res.text).toContain('flex-grow-1 border rounded p-3 draft-card');
    expect(res.text).toContain('d-flex gap-3 mb-3 draft-item');
  });

  test.each(Object.entries(ADMIN_STAFF_PAGES('requests')))('%s: every modal goes through one Bootstrap instance and the draft/preview modals swap instead of stacking', async (_role, { agent, url }) => {
    const html = (await agent().get(url)).text;
    expect(html).not.toMatch(/new bootstrap\.Modal\(document/);                 // a fresh instance per open was the duplicate-plugin bug
    expect(html).toContain('bootstrap.Modal.getOrCreateInstance(document.getElementById(id))');
    expect(html).toContain("swapToModal('pr-draft-modal', 'pr-modal')");
    expect(html).toContain("swapToModal('dr-draft-modal', 'dr-modal')");
    expect(html).toContain("swapToModal('draft-preview-modal', (prefix || 'pr') + '-draft-modal')");
    expect(html).toContain('MODAL_RETURN_TO');
    expect(html).not.toContain('draftPreviewReturnTo');                          // the old one-off return logic is gone
  });

  test('the behaviour the page depends on is untouched: reviewers can still add a draft version', async () => {
    const submitter = request.agent(app);
    await loginAs(submitter, await createTestUser({ role: 'potential_partner' }));
    const created = await submitter.post('/api/requests').send({ institution: 'jesttest UI fixes University', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest' });
    const id = created.body.request.id;
    try {
      const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const up = await staffAgent.post(`/api/requests/${id}/documents`).field('note', 'a note').attach('document', PNG, 'jesttest_' + 'long_'.repeat(20) + '.png');
      expect(up.status).toBe(200);
      expect(up.body.request.supportingDocuments).toHaveLength(1);
    } finally {
      const linked = await db.collection('documents').find({ requestId: id, requestType: 'partnership' }).toArray();
      const fs = require('fs'), path = require('path'), { DOCUMENTS_DIR } = require('../services/documentLibraryService');
      linked.forEach(d => { if (d.fileLink && d.fileLink.startsWith('/uploads/documents/')) try { fs.unlinkSync(path.join(DOCUMENTS_DIR, path.basename(d.fileLink))); } catch (_) { /* already gone */ } });
      await db.collection('documents').deleteMany({ requestId: id, requestType: 'partnership' });
      await db.collection('requests').deleteOne({ id });
    }
  });
});

describe('Document Request print view', () => {
  test('a long unbroken value wraps inside its cell instead of stretching the form table past the sheet', async () => {
    const submitter = request.agent(app);
    await loginAs(submitter, await createTestUser({ role: 'potential_partner' }));
    const created = await submitter.post('/api/document-requests').send({ institution: 'jesttest Print Office', documentTypes: ['jesttest doc'], notes: 'jesttest ' + 'Unbroken_'.repeat(20) });
    const id = created.body.request.id;
    try {
      const res = await adminAgent.get('/document-requests/' + id + '/print');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/table\.form-table td \{[^}]*overflow-wrap:\s*anywhere/);
      expect(res.text).toContain('Unbroken_Unbroken_');
    } finally {
      await db.collection('documentrequests').deleteOne({ id });
    }
  });
});

describe('Document Library — Type Filter', () => {
  test.each(Object.entries(ADMIN_STAFF_PAGES('documents')))('%s: the Type Filter offers All / MOA / MOU / Other and no Accreditation', async (_role, { agent, url }) => {
    const res = await agent().get(url);
    expect(res.status).toBe(200);
    const group = res.text.match(/id="type-filter-group"[\s\S]*?<\/div>/)[0];
    const labels = [...group.matchAll(/onclick="filterType\('([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['All', 'MOA', 'MOU', 'Other']);
    expect(group).not.toMatch(/accreditation/i);
    expect(res.text).not.toContain("filterType('Accreditation'");
  });

  test('existing Accreditation records are untouched: still stored, still returned by the API, still rendered under "All"', async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last[0].id + 1;
    createdDocIds.push(id);
    await db.collection('documents').insertOne({
      id, title: 'jesttest Accreditation certificate', type: 'Accreditation', partner: 'jesttest', date: 'Sep 20, 2026', status: 'Active',
      tags: ['Accreditation'], uploadedBy: 'jesttest', uploadedByEmail: adminUser.email, uploadedAt: new Date().toISOString()
    });
    const api = await adminAgent.get('/api/documents');
    expect(api.body.some(d => d.id === id && d.type === 'Accreditation')).toBe(true);
    // the page's own renderer still special-cases the type (icon, level, certificate number) — only the filter button went
    const html = (await adminAgent.get('/documents')).text;
    expect(html).toContain("doc.type === 'Accreditation'");
    expect(html).toContain('accreditationLevel');
    expect(await db.collection('documents').countDocuments({ id, type: 'Accreditation' })).toBe(1);
  });
});
