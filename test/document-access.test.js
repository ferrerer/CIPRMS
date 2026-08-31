// Covers the 2026-07-29 bug fix: GET /uploads/documents/:filename previously
// applied the same "own uploads only" ownership check to Administrator as it
// did to Auth. Personnel/potential_partner — meaning Administrator got a 403
// trying to preview/download ANY supporting document a requester attached to
// a Partnership/Document Request, since the requester (never the admin) is
// always the uploader. Administrator is now exempt from that check; Auth.
// Personnel and potential_partner remain restricted to their own uploads.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let adminAgent, personnelAgent, partnerAgent, otherPartnerAgent;
let db;
let seededDocIds = [];
let seededFilePath;
const FILE_NAME = 'zztest-docaccess-' + Date.now() + '.pdf';

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  const partnerUser = await createTestUser({ role: 'potential_partner' });
  await loginAs(partnerAgent, partnerUser);
  otherPartnerAgent = request.agent(app);
  await loginAs(otherPartnerAgent, await createTestUser({ role: 'potential_partner' }));

  // A real file on disk, "uploaded" by the potential_partner test account —
  // mirrors what archiveToDocumentLibrary() would have produced.
  seededFilePath = path.join(DOCUMENTS_DIR, FILE_NAME);
  fs.writeFileSync(seededFilePath, 'ZZ Test document access fixture content');

  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  await db.collection('documents').insertOne({
    id, title: 'ZZ Test Document Access Fixture', type: 'MOA',
    fileLink: '/uploads/documents/' + FILE_NAME,
    uploadedByEmail: partnerUser.email, uploadedAt: new Date().toISOString()
  });
  seededDocIds.push(id);
});

afterAll(async () => {
  if (seededDocIds.length) await db.collection('documents').deleteMany({ id: { $in: seededDocIds } });
  if (seededFilePath && fs.existsSync(seededFilePath)) fs.unlinkSync(seededFilePath);
  await cleanupAll();
  await closeDB();
});

test('Administrator can open/download a document uploaded by a requester (the reported bug)', async () => {
  const res = await adminAgent.get('/uploads/documents/' + FILE_NAME);
  expect(res.status).toBe(200);
});

test('The actual uploader (potential_partner) can still access their own document', async () => {
  const res = await partnerAgent.get('/uploads/documents/' + FILE_NAME);
  expect(res.status).toBe(200);
});

test('A different potential_partner account cannot access someone else\'s document', async () => {
  const res = await otherPartnerAgent.get('/uploads/documents/' + FILE_NAME);
  expect(res.status).toBe(403);
});

test('Auth. Personnel cannot access a document they did not upload', async () => {
  const res = await personnelAgent.get('/uploads/documents/' + FILE_NAME);
  expect(res.status).toBe(403);
});

test('No session redirects rather than leaking the file', async () => {
  const res = await request(app).get('/uploads/documents/' + FILE_NAME);
  expect(res.status).toBe(302);
});
