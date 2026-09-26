// Google Docs agreement drafts (2026-09-26): who can see/create/unlink a request's drafts, who each draft is shared
// with, and the starting document. No real Google call is made — the two functions that talk to the Drive API
// (createAgreementDoc / reshareDoc) are replaced with spies, matching the convention of the other OAuth-adjacent
// suites (a live Google consent screen cannot be driven headlessly).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');
const googleDocsService = require('../services/googleDocsService');

let db;
const requestIds = [];

async function agentFor(user) {
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

async function insertRequest(fields) {
  const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last.length ? last[0].id : 0) + 1;
  await db.collection('requests').insertOne({
    id, institution: `${TEST_TAG} Docs University`, country: 'Japan', type: 'MOA', nature: 'Research',
    unit: 'CCS', status: 'Pending', notes: `${TEST_TAG} google docs`, date: 'Sep 26, 2026', ...fields
  });
  requestIds.push(id);
  return id;
}

beforeAll(async () => { db = await connectDB(); });
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db.collection('googleDocs').deleteMany({ requestId: { $in: requestIds } });
  await cleanupAll();
  await closeDB();
});

describe('Google Docs — connection settings', () => {
  test('only an Administrator can see the status or start a connection; secrets are never returned', async () => {
    const admin = await agentFor(await createTestUser({ role: 'Administrator' }));
    const status = await admin.get('/api/google-docs/status');
    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(false);
    expect(status.body.redirectUri).toMatch(/\/api\/google-docs\/callback$/);
    expect(JSON.stringify(status.body)).not.toMatch(/refresh|secret|token/i);

    const staff = await agentFor(await createTestUser({ role: 'Staff' }));
    expect((await staff.get('/api/google-docs/status')).status).toBe(302);
    expect((await staff.get('/api/google-docs/connect')).headers.location).not.toMatch(/accounts\.google\.com/);
  });

  test('the callback refuses a missing or wrong state without calling Google', async () => {
    const admin = await agentFor(await createTestUser({ role: 'Administrator' }));
    const res = await admin.get('/api/google-docs/callback').query({ code: 'abc', state: 'forged' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/settings?googleDocs=error&reason=state');
  });
});

describe('Google Docs — drafts on a Partnership Request', () => {
  test('creating a draft shares it with reviewers (edit), the submitter (comment) and deans of the unit (view)', async () => {
    const partner = await createTestUser({ role: 'potential_partner' });
    const staff = await createTestUser({ role: 'Staff' });
    const inactiveStaff = await createTestUser({ role: 'Staff' });
    await db.collection('users').updateOne({ id: inactiveStaff.id }, { $set: { status: 'Inactive' } });
    const deanCcs = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    const deanOther = await createTestUser({ role: 'Auth. Personnel', unit: 'CAMS' });
    const id = await insertRequest({ submittedByEmail: partner.email, requestedBy: 'jesttest Partner' });

    const create = jest.spyOn(googleDocsService, 'createAgreementDoc').mockImplementation(async (_db, req, kind, recipients) => ({
      fileId: 'jesttest-file', title: `${kind} Draft — ${req.institution}`, url: 'https://docs.google.com/document/d/jesttest-file/edit',
      sharing: recipients.map(r => ({ ...r, ok: true }))
    }));

    const staffAgent = await agentFor(staff);
    const res = await staffAgent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    const [, passedRequest, kind, recipients] = create.mock.calls[0];
    expect(passedRequest.id).toBe(id);
    expect(kind).toBe('MOA');
    const roleOf = email => (recipients.find(r => r.email === email) || {}).role;
    expect(roleOf(staff.email)).toBe('writer');
    expect(roleOf(partner.email)).toBe('commenter');
    expect(roleOf(deanCcs.email)).toBe('reader');
    expect(roleOf(deanOther.email)).toBeUndefined();
    expect(roleOf(inactiveStaff.email)).toBeUndefined();
    expect(new Set(recipients.map(r => r.email)).size).toBe(recipients.length); // one entry per person

    const stored = await db.collection('googleDocs').findOne({ requestId: id });
    expect(stored).toMatchObject({ kind: 'MOA', fileId: 'jesttest-file', createdByEmail: staff.email });
    const note = await db.collection('notifications').findOne({ targetEmail: partner.email, title: /MOA draft shared/ });
    expect(note).not.toBeNull();
  });

  test('reviewers see the drafts with sharing details; the submitter sees only the link; anyone else is refused', async () => {
    const partner = await createTestUser({ role: 'potential_partner' });
    const otherPartner = await createTestUser({ role: 'potential_partner' });
    const staff = await createTestUser({ role: 'Staff' });
    const id = await insertRequest({ submittedByEmail: partner.email });
    await db.collection('googleDocs').insertOne({
      id: 900000 + id, requestId: id, kind: 'MOU', title: 'jesttest MOU Draft', fileId: 'f',
      url: 'https://docs.google.com/document/d/f/edit', createdByName: 'jesttest', createdAt: new Date().toISOString(),
      sharing: [{ email: partner.email, role: 'commenter', ok: true }]
    });

    const asStaff = await (await agentFor(staff)).get(`/api/requests/${id}/google-docs`);
    expect(asStaff.status).toBe(200);
    expect(asStaff.body.connected).toBe(false);
    expect(asStaff.body.docs[0].sharing).toHaveLength(1);

    const asOwner = await (await agentFor(partner)).get(`/api/requests/${id}/google-docs`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.docs[0]).toMatchObject({ kind: 'MOU', url: 'https://docs.google.com/document/d/f/edit' });
    expect(asOwner.body.docs[0].sharing).toBeUndefined();
    expect(asOwner.body.connected).toBeUndefined();

    expect((await (await agentFor(otherPartner)).get(`/api/requests/${id}/google-docs`)).status).toBe(403);
  });

  test('only Administrator/Staff can create, re-share or unlink; bad input and a missing connection are clear errors', async () => {
    const partner = await createTestUser({ role: 'potential_partner' });
    const admin = await createTestUser({ role: 'Administrator' });
    const id = await insertRequest({ submittedByEmail: partner.email });
    const partnerAgent = await agentFor(partner);
    const adminAgent = await agentFor(admin);

    expect((await partnerAgent.post(`/api/requests/${id}/google-docs`).set('X-Requested-With', 'ciprms').send({ kind: 'MOA' })).status).toBe(403);
    expect((await adminAgent.post(`/api/requests/${id}/google-docs`).send({ kind: 'Letter' })).status).toBe(400);
    expect((await adminAgent.post('/api/requests/99999999/google-docs').send({ kind: 'MOA' })).status).toBe(404);

    // Not connected (the test run uses its own empty integration collection) → the real service refuses clearly.
    const notConnected = await adminAgent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
    expect(notConnected.status).toBe(422);
    expect(notConnected.body.error).toMatch(/not connected/i);

    const docId = 900000 + id;
    await db.collection('googleDocs').insertOne({ id: docId, requestId: id, kind: 'MOA', title: 't', fileId: 'f', url: 'https://docs.google.com/document/d/f/edit', sharing: [] });
    expect((await partnerAgent.delete(`/api/google-docs/${docId}`).set('X-Requested-With', 'ciprms')).status).toBe(403);

    const reshare = jest.spyOn(googleDocsService, 'reshareDoc').mockResolvedValue([{ email: partner.email, role: 'commenter', ok: true }]);
    const reshared = await adminAgent.post(`/api/google-docs/${docId}/reshare`);
    expect(reshared.status).toBe(200);
    expect(reshare).toHaveBeenCalledWith(expect.anything(), 'f', expect.any(Array), expect.stringContaining('#REQ-'));
    expect((await db.collection('googleDocs').findOne({ id: docId })).sharing).toHaveLength(1);

    expect((await adminAgent.delete(`/api/google-docs/${docId}`)).status).toBe(200);
    expect(await db.collection('googleDocs').findOne({ id: docId })).toBeNull();
  });

  test('a draft request (not yet submitted) cannot get a Google Doc', async () => {
    const admin = await agentFor(await createTestUser({ role: 'Administrator' }));
    const id = await insertRequest({ status: 'Draft' });
    const create = jest.spyOn(googleDocsService, 'createAgreementDoc');
    expect((await admin.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Google Docs — starting document', () => {
  test('is filled from the request, escapes its text, and differs for MOA and MOU', () => {
    const req = { id: 7, institution: 'Kyushu <b>University</b>', country: 'Japan', nature: 'Research', unit: ['CCS', 'CETE'], startDate: 'Jan 1, 2027', endDate: 'Jan 1, 2030' };
    const moa = googleDocsService.buildAgreementHtml(req, 'MOA');
    const mou = googleDocsService.buildAgreementHtml(req, 'MOU');
    expect(moa).toContain('MEMORANDUM OF AGREEMENT');
    expect(mou).toContain('MEMORANDUM OF UNDERSTANDING');
    expect(moa).toContain('#REQ-007');
    expect(moa).toContain('Kyushu &lt;b&gt;University&lt;/b&gt;');
    expect(moa).not.toContain('<b>University</b>');
    expect(moa).toContain('CCS, CETE');
    expect(moa).toContain('Jan 1, 2030');
  });

  test('asks Google only for access to the files CIPRMS itself creates', () => {
    expect(googleDocsService.SCOPES).toEqual(['https://www.googleapis.com/auth/drive.file']);
  });
});
