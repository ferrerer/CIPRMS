// Covers input validation/normalization for the 2026-09-02 "Document(s)
// Requested" combobox redesign: POST /api/document-requests accepts a free-
// form documentTypes array (predefined suggestions and/or custom text, one
// or many), with server-side normalization that doesn't trust the client
// (trimming, per-item length cap, item-count cap, non-string rejection) —
// the UI never enforces these alone.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let personnelAgent;
const createdIds = [];

beforeAll(async () => {
  await connectDB();
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (createdIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: createdIds } });
  await cleanupAll();
  await closeDB();
});

test('Whitespace around each document name is trimmed before storage', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: ['  MOUs  ', '  jesttest Custom  '], notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdIds.push(res.body.request.id);
  expect(res.body.request.documentTypes).toEqual(['MOUs', 'jesttest Custom']);
});

test('Blank/whitespace-only entries in the array are dropped, not stored as empty items', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: ['MOUs', '   ', '', 'jesttest Real Entry'], notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdIds.push(res.body.request.id);
  expect(res.body.request.documentTypes).toEqual(['MOUs', 'jesttest Real Entry']);
});

test('Non-string array entries are rejected without crashing the request', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: ['jesttest Valid', 42, { evil: true }, null], notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdIds.push(res.body.request.id);
  expect(res.body.request.documentTypes).toEqual(['jesttest Valid']);
});

test('A single, absurdly long document name is capped at 300 characters', async () => {
  const long = 'jesttest ' + 'x'.repeat(400);
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: [long], notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdIds.push(res.body.request.id);
  expect(res.body.request.documentTypes[0].length).toBe(300);
});

test('An excessive number of items is capped at 20', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `jesttest Item ${i}`);
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: many, notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdIds.push(res.body.request.id);
  expect(res.body.request.documentTypes.length).toBe(20);
});

test('Missing institution is still rejected even with a valid documentTypes array', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    documentTypes: ['jesttest Valid'], notes: 'jesttest'
  });
  expect(res.status).toBe(400);
});
