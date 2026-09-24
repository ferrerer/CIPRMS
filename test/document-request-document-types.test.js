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

test('The Document(s) Requested list opens on click and on the Down arrow, not only when the field first gains focus (regression: it stayed shut until you clicked elsewhere and back)', async () => {
  const html = (await personnelAgent.get('/personnel/requests')).text;
  expect(html).toContain("input.addEventListener('focus', openDropdown);");
  expect(html).toContain("input.addEventListener('click', openDropdown);");
  expect(html).toContain("e.key === 'ArrowDown'");
});

test('Clear on the College Dean request form is hidden until something is entered, and goes away again when the form is empty', async () => {
  const html = (await personnelAgent.get('/personnel/requests')).text;
  const clear = html.match(/<button[^>]*id="clear-req-btn"[^>]*>/);
  expect(clear).not.toBeNull();
  expect(clear[0]).toContain('display:none');                       // not visible on an untouched form
  expect(clear[0]).toContain('onclick="resetForm()"');
  expect(html).toContain('function syncClearButton');
  expect(html).toContain("createDocCombo('f-type', syncClearButton)");   // picking / removing / typing a document counts
  expect(html).toContain("docForm.addEventListener('input', syncClearButton)");
  // clearing and a successful submit both hide it again
  expect(html.match(/syncClearButton\(\);/g).length).toBeGreaterThanOrEqual(2);
});

describe('College Dean request form: Contact No. is the number registered with the account', () => {
  const REGISTERED = '0917-123-4567';
  const formHtml = async (agent) => (await agent.get('/personnel/requests')).text;

  // A College Dean registered with a number (User Management → Add User / Edit User stores users.contactNumber).
  async function registeredAgent(number) {
    const user = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    if (number) await (await connectDB()).collection('users').updateOne({ email: user.email }, { $set: { contactNumber: number } });
    return { agent, user };
  }

  test('with a registered number the form shows it read-only — no field to type in — and Settings cannot change it', async () => {
    const { agent } = await registeredAgent(REGISTERED);
    const html = await formHtml(agent);
    expect(html).toContain(`<div class="dr-readonly">${REGISTERED}<small>Set when your account was registered</small></div>`);
    expect(html).toContain(`<input type="hidden" id="f-contact" value="${REGISTERED}">`);
    expect(html).not.toMatch(/<input[^>]*type="tel"[^>]*id="f-contact"/);            // nothing editable

    // a save from Settings that tries to change it is ignored, so the form still shows the registered one
    await agent.post('/api/personnel/profile').send({ name: 'jesttest Registered Number', contactNumber: '0999-999-9999' });
    expect(await formHtml(agent)).toContain(`<input type="hidden" id="f-contact" value="${REGISTERED}">`);
  });

  test('without a registered number the field is still a normal, empty input (nobody is blocked from submitting)', async () => {
    const { agent } = await registeredAgent('');
    const html = await formHtml(agent);
    const tag = html.match(/<input[^>]*id="f-contact"[^>]*>/)[0];
    expect(tag).toContain('type="tel"');
    expect(tag).not.toContain('value=');
    expect(html).not.toContain('Set when your account was registered</small>');
  });

  test('it is only ever the signed-in person\'s own number', async () => {
    const { agent } = await registeredAgent(REGISTERED);
    expect(await formHtml(personnelAgent)).not.toContain(REGISTERED);
    expect(await formHtml(agent)).toContain(REGISTERED);
  });

  test('the server enforces it: a submitted request carries the registered number whatever the client sends', async () => {
    const { agent } = await registeredAgent(REGISTERED);
    const res = await agent.post('/api/document-requests').send({ institution: 'CCS', documentTypes: ['jesttest doc'], notes: 'jesttest', contactNumber: '0999-000-0000' });
    expect(res.status).toBe(200);
    createdIds.push(res.body.request.id);
    expect(res.body.request.contactNumber).toBe(REGISTERED);

    const noNumber = await registeredAgent('');
    const typed = await noNumber.agent.post('/api/document-requests').send({ institution: 'CCS', documentTypes: ['jesttest doc'], notes: 'jesttest', contactNumber: '0918-111-2222' });
    createdIds.push(typed.body.request.id);
    expect(typed.body.request.contactNumber).toBe('0918-111-2222');                   // an account with none registered can still type one
  });

  test('the pre-filled number is not "input": Clear stays hidden until something else on the form is filled in', async () => {
    const { agent } = await registeredAgent(REGISTERED);
    expect(await formHtml(agent)).toContain("contact.value.trim() !== (contact.defaultValue || '').trim()");
  });
});
