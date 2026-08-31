// Covers the printable CSPC-F-CIRL-04 "Documents Request Form": the new
// contactNumber/documentForm/submittedAt fields on submission, the optional
// releasedBy/receivedBy sign-off fields on fulfillment, and the RBAC boundary
// on the /document-requests/:id/print and /api/document-requests/:id/pdf
// routes (owner + Administrator only).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, personnelAgent, otherPartnerAgent, staffAgent, requestId;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  otherPartnerAgent = request.agent(app);
  await loginAs(otherPartnerAgent, await createTestUser({ role: 'potential_partner' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (requestId) await db.collection('documentrequests').deleteOne({ id: requestId });
  await cleanupAll();
  await closeDB();
});

test('Submit Document Request: new printable-form fields (contactNumber, documentForm) persist', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest purpose',
    contactNumber: '0917-000-0000', documentForm: 'Printed Copy'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.contactNumber).toBe('0917-000-0000');
  expect(res.body.request.documentForm).toBe('Printed Copy');
  expect(typeof res.body.request.submittedAt).toBe('string');
  requestId = res.body.request.id;
});

test('Print/PDF RBAC: the requester (owner) can view and download', async () => {
  const printRes = await personnelAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);
  expect(printRes.text).toContain('DOCUMENTS REQUEST FORM');
  expect(printRes.text).toContain('0917-000-0000');

  const pdfRes = await personnelAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
  expect(pdfRes.headers['content-type']).toBe('application/pdf');
  expect(pdfRes.headers['content-disposition']).toContain(`Document_Request_${requestId}.pdf`);
});

test('Print/PDF RBAC: an unrelated potential_partner cannot view or download someone else\'s request', async () => {
  const printRes = await otherPartnerAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(403);

  const pdfRes = await otherPartnerAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(403);
});

test('Print/PDF RBAC: Administrator can view and download any request', async () => {
  const printRes = await adminAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);

  const pdfRes = await adminAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
});

// 2026-08-27 full-parity revision: Staff reviews Document Requests exactly
// like Administrator (canAccessDocumentRequest + REQUEST_REVIEWER_ROLES).
test('Print/PDF RBAC: Staff can view and download any request (full parity with Administrator)', async () => {
  const printRes = await staffAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);

  const pdfRes = await staffAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
});

test('Print/PDF RBAC: no session redirects instead of leaking the form', async () => {
  const printRes = await request(app).get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(302);

  const pdfRes = await request(app).get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(302);
});

test('Staff can move a Document Request to Under Review (full parity with Administrator)', async () => {
  const res = await staffAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Under Review', remark: 'jesttest staff review' });
  expect(res.status).toBe(200);
  expect(res.body.request.status).toBe('Under Review');
});

test('Fulfill Document Request: Approved By / Released By / Received By populate the form', async () => {
  const res = await adminAgent.patch(`/api/document-requests/${requestId}`).send({
    status: 'Fulfilled', remark: 'jesttest', releasedBy: 'Records Officer', receivedBy: 'Requester Name'
  });
  expect(res.status).toBe(200);
  expect(res.body.request.decidedBy).toBeTruthy();
  expect(res.body.request.releasedBy).toBe('Records Officer');
  expect(res.body.request.receivedBy).toBe('Requester Name');

  const printRes = await personnelAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.text).toContain('Records Officer');
  expect(printRes.text).toContain('Requester Name');
});
