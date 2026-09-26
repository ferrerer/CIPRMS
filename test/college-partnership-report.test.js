// College Partnership Reports (2026-09-26): a College Dean sends CIRL a copy of an MOA/MOU the college already signed
// on its own. Filed as a Partnership Request (isCollegeReport) that CIRL records in the Registry.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');
const emailService = require('../services/emailService');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
const requestIds = [];
const partnershipIds = [];

beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  const db = getDb();
  const reqs = await db.collection('requests').find({ id: { $in: requestIds } }).toArray();
  const fs = require('fs'), path = require('path');
  for (const r of reqs) for (const d of (r.supportingDocuments || [])) {
    if (d.fileLink && d.fileLink.startsWith('/uploads/documents/')) fs.rmSync(path.join(__dirname, '..', d.fileLink), { force: true });
    if (d.documentId) await db.collection('documents').deleteOne({ id: d.documentId });
  }
  await db.collection('requests').deleteMany({ id: { $in: requestIds } });
  await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role, extra) {
  const user = await createTestUser({ role, ...(extra || {}) });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

const report = (over) => ({
  isCollegeReport: true, institution: `jesttest College Report University ${Date.now()}`, country: 'Japan', type: 'MOA',
  nature: 'Research', startDate: '2026-01-15', endDate: '2029-01-15', notes: 'jesttest report', ...over
});

describe('College Partnership Report — College Dean', () => {
  test('a Dean can send a report; it belongs to their own college, is Pending, and CIRL is alerted', async () => {
    const { agent, user } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const { user: staff } = await agentFor('Staff');
    const res = await agent.post('/api/requests').send(report({ unit: 'CAMS' }));
    expect(res.status).toBe(200);
    requestIds.push(res.body.request.id);
    expect(res.body.request).toMatchObject({ isCollegeReport: true, status: 'Pending', unit: 'CCS', submittedByEmail: user.email });
    expect(res.body.request.isSubmission).toBeUndefined();

    const alert = await getDb().collection('notifications').findOne({ targetEmail: staff.email, title: /College partnership reported/ });
    expect(alert).toMatchObject({ tag: 'College Partnership Report' });
    expect(alert.desc).toContain('(CCS)');
    await new Promise(r => setTimeout(r, 150));
    expect(emailService.sentForTests.some(m => m.to === user.email && /Partnership report received/.test(m.subject))).toBe(true);
  });

  test('the approved copy is attached without re-opening the review; the Dean can open the report later', async () => {
    const { agent } = await agentFor('Auth. Personnel', { unit: 'CETE' });
    const res = await agent.post('/api/requests').send(report());
    requestIds.push(res.body.request.id);
    const up = await agent.post(`/api/requests/${res.body.request.id}/documents`)
      .field('initial', '1').field('note', 'Approved copy').attach('document', PNG, { filename: 'signed.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    const stored = await getDb().collection('requests').findOne({ id: res.body.request.id });
    expect(stored.status).toBe('Pending');
    expect(stored.supportingDocuments).toHaveLength(1);
    const mine = (await agent.get('/api/requests/mine')).body;
    expect(mine.some(r => r.id === res.body.request.id && r.isCollegeReport)).toBe(true);
  });

  test('required fields and dates are enforced', async () => {
    const { agent } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    expect((await agent.post('/api/requests').send(report({ startDate: '' }))).status).toBe(400);
    expect((await agent.post('/api/requests').send(report({ endDate: '2025-01-01' }))).status).toBe(400);
    expect((await agent.post('/api/requests').send(report({ type: 'LOI' }))).status).toBe(400);
    expect((await agent.post('/api/requests').send(report({ country: '' }))).status).toBe(400);
  });

  test('every other Partnership Request route stays closed to a Dean', async () => {
    const { agent } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const normal = await agent.post('/api/requests').set('X-Requested-With', 'ciprms').send({ institution: 'jesttest X', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest' });
    expect(normal.status).toBe(403);
    const res = await agent.post('/api/requests').send(report());
    requestIds.push(res.body.request.id);
    expect((await agent.post(`/api/requests/${res.body.request.id}/withdraw`).set('X-Requested-With', 'ciprms')).status).toBe(403);
    expect((await agent.patch(`/api/requests/${res.body.request.id}/edit`).set('X-Requested-With', 'ciprms').send({ notes: 'x' })).status).toBe(403);
  });

  test('only a Dean can file a College Partnership Report (a Partner\'s flag is ignored)', async () => {
    const { agent } = await agentFor('potential_partner');
    const res = await agent.post('/api/requests').send(report());
    expect(res.status).toBe(200);
    requestIds.push(res.body.request.id);
    expect(res.body.request.isCollegeReport).toBeUndefined();
  });

  test('the form is on Requests (Submission of Approved MOA/MOU tab); Monitoring tracks the reports and links to it', async () => {
    const { agent } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const requests = (await agent.get('/personnel/requests')).text;
    expect(requests).toContain('id="tab-moa"');
    expect(requests).toContain('Submission of Approved MOA/MOU');
    for (const id of ['cr-inst', 'cr-country', 'cr-type', 'cr-nature', 'cr-start', 'cr-end', 'cr-file', 'cr-notes', 'cr-submit-btn']) expect(requests).toContain(`id="${id}"`);
    expect(requests).toContain('/velzon/assets/js/shared/country-options.js');
    expect(requests).toContain('id="docRequestForm"'); // the Document Request form is still there

    const monitoring = (await agent.get('/personnel/monitoring')).text;
    expect(monitoring).toContain('College Partnership Reports');
    expect(monitoring).toContain('href="/personnel/requests?tab=moa"');
    expect(monitoring).not.toContain('id="cr-report-modal"'); // one form only, on Requests
  });
});

describe('College Partnership Report — CIRL', () => {
  test('recording it in the Registry marks it Recorded and tells the Dean', async () => {
    const { agent, user } = await agentFor('Auth. Personnel', { unit: 'CNAS' });
    const res = await agent.post('/api/requests').send(report());
    const r = res.body.request;
    requestIds.push(r.id);

    const { agent: staff } = await agentFor('Staff');
    const saved = await staff.post('/api/partnerships').send({
      inst: r.institution, country: r.country, region: 'Asia', type: r.type, nature: r.nature, cat: 'International',
      unit: ['CNAS'], start: 'Jan 15, 2026', end: 'Jan 15, 2029', remarks: 'jesttest', sourceRequestId: r.id
    });
    expect(saved.status).toBe(200);
    partnershipIds.push(saved.body.partnership.id);

    const stored = await getDb().collection('requests').findOne({ id: r.id });
    expect(stored).toMatchObject({ status: 'Approved', linkedPartnershipId: saved.body.partnership.id });
    const note = await getDb().collection('notifications').findOne({ targetEmail: user.email, title: /Partnership recorded by CIRL/ });
    expect(note).not.toBeNull();
    expect(note.link).toBe(`/personnel/monitoring?type=pr&id=${r.id}`);
  });

  test('the review page labels reports and offers "Record in Registry"', async () => {
    const { agent } = await agentFor('Administrator');
    const html = (await agent.get('/partnership-requests')).text;
    expect(html).toContain('College Report');
    expect(html).toContain("r.isCollegeReport ? 'Record in Registry' : 'Approve'");
  });
});
