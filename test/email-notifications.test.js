// E-mail copies of request notifications (2026-09-26). Under Jest services/emailService.js never connects to a mail
// server — every message is captured in emailService.sentForTests, which these tests read.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');
const emailService = require('../services/emailService');

const createdRequestIds = [];
const createdDocRequestIds = [];
beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  await getDb().collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  await getDb().collection('documentrequests').deleteMany({ id: { $in: createdDocRequestIds } });
  await cleanupAll();
  await closeDB();
});

const settle = () => new Promise(r => setTimeout(r, 150)); // e-mails are sent in the background
const mailTo = email => emailService.sentForTests.filter(m => m.to === email);

async function agentFor(role, extra) {
  const user = await createTestUser({ role, ...(extra || {}) });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('Request e-mails', () => {
  test('submitting a Partnership Request e-mails the submitter a receipt and every reviewer the new-request alert', async () => {
    const { agent, user } = await agentFor('potential_partner');
    const { user: staff } = await agentFor('Staff');
    const res = await agent.post('/api/requests').send({ institution: 'jesttest Mail University', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest mail' });
    expect(res.status).toBe(200);
    createdRequestIds.push(res.body.request.id);
    await settle();

    const receipt = mailTo(user.email).find(m => /Request received: jesttest Mail University/.test(m.subject));
    expect(receipt).toBeDefined();
    expect(receipt.text).toContain(`#REQ-${String(res.body.request.id).padStart(3, '0')}`);
    expect(receipt.text).toContain(`/partner/monitoring?type=pr&id=${res.body.request.id}`);

    const alert = mailTo(staff.email).find(m => /New request submitted: jesttest Mail University/.test(m.subject));
    expect(alert).toBeDefined();
    expect(alert.text).toContain(`/staff/requests?open=pr&id=${res.body.request.id}`);
  });

  test('a decision on the request e-mails the submitter', async () => {
    const { agent, user } = await agentFor('potential_partner');
    const { agent: admin } = await agentFor('Administrator');
    const res = await agent.post('/api/requests').send({ institution: 'jesttest Decision University', country: 'Japan', type: 'MOU', nature: 'Research', notes: 'jesttest mail' });
    createdRequestIds.push(res.body.request.id);
    const decided = await admin.patch(`/api/requests/${res.body.request.id}`).send({ status: 'Rejected', notes: 'jesttest' });
    expect(decided.status).toBe(200);
    await settle();
    expect(mailTo(user.email).some(m => /jesttest Decision University/.test(m.subject) && !/Request received/.test(m.subject))).toBe(true);
  });

  test('submitting a saved draft now alerts the reviewers and sends the receipt too', async () => {
    const { agent, user } = await agentFor('potential_partner');
    const { user: staff } = await agentFor('Staff');
    const draft = await agent.post('/api/requests').send({ institution: 'jesttest Draft Mail University', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest mail', isDraft: true });
    createdRequestIds.push(draft.body.request.id);
    await settle();
    expect(mailTo(user.email).some(m => /Draft Mail University/.test(m.subject))).toBe(false); // a draft sends nothing

    expect((await agent.post(`/api/requests/${draft.body.request.id}/submit`)).status).toBe(200);
    await settle();
    expect(mailTo(user.email).some(m => /Request received: jesttest Draft Mail University/.test(m.subject))).toBe(true);
    expect(mailTo(staff.email).some(m => /New request submitted: jesttest Draft Mail University/.test(m.subject))).toBe(true);
    const inApp = await getDb().collection('notifications').findOne({ targetEmail: staff.email, title: /Draft Mail University/ });
    expect(inApp).not.toBeNull();
  });

  test('submitting a Document Request e-mails the College Dean a receipt', async () => {
    const { agent, user } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const res = await agent.post('/api/document-requests').send({ institution: 'jesttest Mail College', documentTypes: ['jesttest Certificate'], notes: 'jesttest' });
    expect(res.status).toBe(200);
    createdDocRequestIds.push(res.body.request.id);
    await settle();
    const receipt = mailTo(user.email).find(m => /Document request received: jesttest Mail College/.test(m.subject));
    expect(receipt).toBeDefined();
    expect(receipt.html).toContain('Open in CIPRMS');
  });

  test('message text is escaped in the HTML body and nothing is sent to an invalid address', async () => {
    const msg = emailService.buildMessage('a@example.com', { title: '<script>x</script>', desc: 'a & b', link: '/x' });
    expect(msg.html).not.toContain('<script>x</script>');
    expect(msg.html).toContain('&lt;script&gt;');
    const before = emailService.sentForTests.length;
    const result = await emailService.sendNotificationEmails(['not-an-email', ''], { title: 't' });
    expect(result.sent).toEqual([]);
    expect(emailService.sentForTests.length).toBe(before);
  });
});
