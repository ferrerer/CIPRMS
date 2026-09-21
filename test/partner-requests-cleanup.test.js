// Potential Partner: Requests ("Submission Of MOA/MOU"), Partnership Request form, Monitoring and Settings cleanup.
// The Partner submission rides on the EXISTING document-request endpoints (create + optional file upload),
// so notes-only, file/image-only and file+notes must all be accepted with no backend change — and nothing may
// change for Administrator, CIRL Staff or College Staff.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

beforeAll(async () => { await connectDB(); });
// cleanupAll() does not sweep the documentrequests collection, so every request this file creates is tracked
// here and deleted explicitly — otherwise each run would leave real-looking records in the shared database.
const createdDocRequestIds = [];
const track = res => { if (res && res.body && res.body.request) createdDocRequestIds.push(res.body.request.id); return res; };
afterAll(async () => {
  if (createdDocRequestIds.length) await getDb().collection('documentrequests').deleteMany({ id: { $in: createdDocRequestIds } });
  // cleanupAll() does not sweep the profiles collection either; the "profile endpoint untouched" test below stores one
  await getDb().collection('profiles').deleteMany({ email: { $regex: '^jesttest\\.', $options: 'i' } });
  await cleanupAll();
  await closeDB();
});

// Smallest buffer that satisfies verifyMagicBytes' PNG signature (same fixture the other upload tests use).
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const MOA_MOU_TYPE = 'MOA/MOU Submission';

const stripNonVisible = html => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const textOf = html => stripNonVisible(html).replace(/<[^>]+>/g, ' ');

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('Partner → Requests page', () => {
  let agent, html;
  beforeAll(async () => { ({ agent } = await agentFor('potential_partner')); html = (await agent.get('/partner/requests')).text; });

  test('the section is titled "Submission Of MOA/MOU" — no "Document Request" wording remains on the page', () => {
    const visible = textOf(html);
    expect(visible).toContain('Submission Of MOA/MOU');
    expect(visible).not.toMatch(/Document Request/);
    expect(visible).not.toMatch(/Documents Request Form/);
  });

  test('the form takes Notes and an OPTIONAL File / Image (pdf/jpg/jpeg/png), and no longer has the document-type picker', () => {
    expect(html).toContain('id="dr-f-notes"');
    const file = html.match(/<input type="file"[^>]*id="dr-f-file"[^>]*>/)[0];
    expect(file).toContain('accept=".pdf,.jpg,.jpeg,.png"');
    expect(file).not.toMatch(/\brequired\b/); // the file must not be required
    expect(html).toContain('a file is optional');
    expect(html).not.toContain('dr-f-type-combo');
    expect(html).not.toContain('Printed Copy');
  });

  test('Partnership Request form: "Start New" and "Save as Draft" are gone, Submit Request stays', () => {
    const visible = textOf(html);
    expect(visible).not.toContain('Start New');
    expect(visible).not.toContain('Save as Draft');
    expect(html).not.toContain('onclick="saveDraft()"');
    expect(html).not.toContain('onclick="openNewRequestForm()"');
    expect(html).toContain('onclick="submitRequest(this)"');   // (the button hands itself to CIPRMS.busy, which ignores a second click)
    expect(visible).toContain('Submit Request');
    // the real form is intact
    for (const id of ['f-inst', 'f-country', 'f-type', 'f-nature', 'f-start', 'f-end', 'f-notes']) expect(html).toContain(`id="${id}"`);
  });

  test('client script keeps the notes-or-file rule and the two-step flow on the existing endpoints', () => {
    expect(html).toContain("CIPRMS.api('/api/document-requests'");
    expect(html).toContain("'/api/document-requests/' + id + '/documents'");
    expect(html).toContain("if (!notes && !file && !moaPendingId)"); // needs a note OR a file — never both
  });
});

describe('Partner submission: notes only / file only / file + notes (existing endpoints, no backend change)', () => {
  let partner, agent;
  beforeAll(async () => { ({ agent, user: partner } = await agentFor('potential_partner')); });

  const create = notes => agent.post('/api/document-requests').send({ institution: 'jesttest Partner University', documentTypes: [MOA_MOU_TYPE], notes }).then(track);
  const stored = id => getDb().collection('documentrequests').findOne({ id });

  test('NOTES ONLY (no file) is accepted and stored against the Partner', async () => {
    const res = await create('jesttest notes only: here is our MOA draft summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const doc = await stored(res.body.request.id);
    expect(doc.notes).toBe('jesttest notes only: here is our MOA draft summary');
    expect(doc.documentType).toBe(MOA_MOU_TYPE);
    expect(doc.requestedByEmail).toBe(partner.email);
    expect(doc.supportingDocuments || []).toHaveLength(0);
  });

  test('FILE/IMAGE + NOTES is accepted; the file is archived through the normal upload workflow', async () => {
    const made = await create('jesttest file + notes');
    const up = await agent.post('/api/document-requests/' + made.body.request.id + '/documents').attach('document', PNG_HEADER, 'signed-moa.png');
    expect(up.status).toBe(200);
    const doc = await stored(made.body.request.id);
    expect(doc.notes).toBe('jesttest file + notes');
    expect(doc.supportingDocuments).toHaveLength(1);
    expect(doc.supportingDocuments[0].originalFilename).toBe('signed-moa.png');
    expect(doc.supportingDocuments[0].uploaderRole).toBe('potential_partner');
    // archived into the Document Library exactly like every other upload
    const lib = await getDb().collection('documents').findOne({ requestId: made.body.request.id, requestType: 'document' });
    expect(lib).not.toBeNull();
  });

  test('FILE/IMAGE ONLY (empty notes) is accepted', async () => {
    const made = await create('');
    expect(made.status).toBe(200);
    const up = await agent.post('/api/document-requests/' + made.body.request.id + '/documents').attach('document', PNG_HEADER, 'only-a-file.png');
    expect(up.status).toBe(200);
    const doc = await stored(made.body.request.id);
    expect(doc.notes).toBe('');
    expect(doc.supportingDocuments).toHaveLength(1);
  });

  test('the upload step alone needs a file OR a note — a completely empty upload is still rejected (400)', async () => {
    const made = await create('jesttest empty-upload probe');
    const empty = await agent.post('/api/document-requests/' + made.body.request.id + '/documents').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/file, a note, or both/i);
  });

  test('a disallowed file type is still refused', async () => {
    const made = await create('jesttest bad file probe');
    const bad = await agent.post('/api/document-requests/' + made.body.request.id + '/documents').attach('document', Buffer.from('not an image'), 'notes.exe');
    expect(bad.status).toBe(400);
  });

  test('the SAME submission is visible to reviewers (Administrator and CIRL Staff) with its notes and file — review behaviour is unchanged', async () => {
    const made = await create('jesttest visible to reviewers');
    await agent.post('/api/document-requests/' + made.body.request.id + '/documents').attach('document', PNG_HEADER, 'for-reviewers.png');
    for (const role of ['Administrator', 'Staff']) {
      const { agent: reviewer } = await agentFor(role);
      const list = (await reviewer.get('/api/document-requests')).body;
      const mine = list.find(r => r.id === made.body.request.id);
      expect(mine).toBeDefined();
      expect(mine.notes).toBe('jesttest visible to reviewers');
      expect(mine.supportingDocuments.map(d => d.originalFilename)).toContain('for-reviewers.png');
    }
  });

  test('the Partnership Request Submit flow is unchanged: a Partner can still submit one directly (no draft step)', async () => {
    const res = await agent.post('/api/requests').send({ institution: 'jesttest Partner Institute', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest direct submit', isDraft: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.request.status).toBe('Pending');
    const mine = (await agent.get('/api/requests/mine')).body;
    expect(mine.some(r => r.id === res.body.request.id)).toBe(true);
  });
});

describe('Partner → Monitoring', () => {
  let html;
  beforeAll(async () => { const { agent } = await agentFor('potential_partner'); html = (await agent.get('/partner/monitoring')).text; });

  test('no "My Document Requests" and no "Document Verification" anywhere on the page', () => {
    const visible = textOf(html);
    expect(visible).not.toContain('My Document Requests');
    expect(visible).not.toMatch(/Document Verification/i);
    for (const gone of ['dr-monitor-body', 'doc-verification-body', 'dr-draft-modal', 'loadDRRequests', 'myDocRequests', 'DR_STAGE_LABEL']) expect(html).not.toContain(gone);
  });

  test('"My Partnership Requests" has NO "Attached Documents" column or field', () => {
    expect(textOf(html)).not.toContain('Attached Documents');
    expect(html).not.toContain('renderAttachedDocs');
    const head = html.slice(html.indexOf('id="pr-monitor-body"') - 900, html.indexOf('id="pr-monitor-body"'));
    expect(head).toContain('<th>Administrator</th><th class="text-end">Actions</th>');
    expect(html).not.toContain('colspan="9"'); // the empty/error rows match the (now 8-column) table
  });

  test('the rest of the page is intact: Partnership Requests, Approval Progress, Renewal Status, stat cards and the View Draft modal', () => {
    const visible = textOf(html);
    for (const keep of ['My Partnership Requests', 'Approval Progress', 'Renewal Status', 'Total Requests', 'In Progress', 'Approved']) expect(visible).toContain(keep);
    for (const keep of ['id="pr-monitor-body"', 'id="pr-draft-modal"', 'id="draft-preview-modal"', 'id="renewal-request-modal"', 'id="cnt-total"', 'id="cnt-docs"']) expect(html).toContain(keep);
  });
});

describe('Partner → Settings', () => {
  let html;
  beforeAll(async () => { const { agent } = await agentFor('potential_partner'); html = (await agent.get('/partner/settings')).text; });

  test('"Notification Preferences" (tab, switches and Save Preferences) is gone — Profile and Password remain', () => {
    expect(textOf(html)).not.toContain('Notification Preferences');
    expect(textOf(html)).not.toContain('Save Preferences');
    expect(html).not.toContain('id="tab-notif"');
    expect(html).not.toMatch(/id="n-(requests|approvals|documents|meetings|renewals)"/);
    const tabs = [...html.matchAll(/data-bs-toggle="tab" href="(#tab-[^"]+)"/g)].map(m => m[1]);
    expect(tabs).toEqual(['#tab-profile', '#tab-password']);
  });

  test('saving the profile echoes the STORED notification values back, so a saved "off" is never silently reset', () => {
    expect(html).toContain('storedNotifyPrefs');
    expect(html).toContain("NOTIFY_KEYS.forEach(function (k) { storedNotifyPrefs[k] = p[k]; });");
    expect(html).toContain("if (typeof storedNotifyPrefs[k] === 'boolean') payload[k] = storedNotifyPrefs[k];");
  });

  test('the notification API/profile endpoint itself is untouched (still stores the preference fields)', async () => {
    const { agent } = await agentFor('potential_partner');
    const res = await agent.post('/api/partner/profile').send({ organization: 'jesttest Org', contactName: 'jesttest Partner', notifyMeetings: false });
    expect(res.status).toBe(200);
    expect(res.body.profile.notifyMeetings).toBe(false);
    expect((await agent.get('/api/notifications/mine')).status).toBe(200);
  });
});

describe('Nothing changes for Administrator, CIRL Staff or College Staff', () => {
  test('College Staff keeps its Document Request form and its Monitoring "My Document Requests" section', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const req = (await agent.get('/personnel/requests')).text;
    expect(req).toContain('id="docRequestForm"');
    expect(textOf(req)).not.toContain('MOA/MOU');
    const mon = (await agent.get('/personnel/monitoring')).text;
    expect(textOf(mon)).toContain('My Document Requests');
  });

  test('Administrator and CIRL Staff keep their Partnership + Document Request review sections', async () => {
    for (const [role, path] of [['Administrator', '/partnership-requests'], ['Staff', '/staff/requests']]) {
      const { agent } = await agentFor(role);
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      const visible = textOf(res.text);
      expect(visible).toMatch(/Partnership Request/i);
      expect(visible).toMatch(/Document Request/i);
    }
  });

  test('a College Staff document request still works exactly as before (document types required)', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const missing = await agent.post('/api/document-requests').send({ institution: 'jesttest College' });
    expect(missing.status).toBe(400);
    const ok = track(await agent.post('/api/document-requests').send({ institution: 'jesttest College', documentTypes: ['MOA'], notes: 'jesttest' }));
    expect(ok.status).toBe(200);
  });
});
