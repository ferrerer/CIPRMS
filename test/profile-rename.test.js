// Renaming an account in Settings must stick and must also rename the requestor on the account's own requests —
// the name is copied into each request when it is created, so without this every request already submitted (and its
// request form / print / PDF) kept showing the old name.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

beforeAll(async () => { await connectDB(); });
// cleanupAll() does not sweep the documentrequests collection, so the ones created here are deleted explicitly.
const docRequestIds = [];
afterAll(async () => {
  if (docRequestIds.length) await getDb().collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
  await getDb().collection('profiles').deleteMany({ email: { $regex: '^jesttest\\.', $options: 'i' } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('Settings rename → requestor name on requests', () => {
  test('College Dean: the new name shows on the request form page and on their existing Document Requests', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const made = await agent.post('/api/document-requests').send({ institution: 'jesttest College', documentTypes: ['jesttest doc'], notes: 'jesttest rename' });
    expect(made.status).toBe(200);
    docRequestIds.push(made.body.request.id);
    const oldName = made.body.request.requestedBy;
    expect(oldName).not.toBe('Renamed College Person');

    const save = await agent.post('/api/personnel/profile').send({ name: 'Renamed College Person', dept: 'CCS', position: 'Coordinator', institution: 'CSPC' });
    expect(save.status).toBe(200);

    // the request form's "Name of Requestor" is rendered from the account name
    const form = await agent.get('/personnel/requests');
    expect(form.text).toContain('Renamed College Person');
    expect(form.text).not.toContain(`<div class="dr-readonly">${oldName}</div>`);

    // ...and the request they already submitted now carries it too
    const mine = (await agent.get('/api/document-requests/mine')).body.find(r => r.id === made.body.request.id);
    expect(mine.requestedBy).toBe('Renamed College Person');
  });

  test('Partner: renaming the contact person renames the requestor on their Partnership Requests', async () => {
    const { agent } = await agentFor('potential_partner');
    const made = await agent.post('/api/requests').send({ institution: 'jesttest Rename Org', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest rename partner' });
    expect(made.status).toBe(200);

    const save = await agent.post('/api/partner/profile').send({ organization: 'jesttest Rename Org', contactName: 'Renamed Partner Person' });
    expect(save.status).toBe(200);

    const mine = (await agent.get('/api/requests/mine')).body.find(r => r.id === made.body.request.id);
    expect(mine.requestedBy).toBe('Renamed Partner Person');
  });

  test('another account\'s requests are never renamed', async () => {
    const { agent: a } = await agentFor('Auth. Personnel');
    const { agent: b } = await agentFor('Auth. Personnel');
    const other = await b.post('/api/document-requests').send({ institution: 'jesttest Other', documentTypes: ['jesttest doc'], notes: 'jesttest other' });
    docRequestIds.push(other.body.request.id);
    const before = other.body.request.requestedBy;

    await a.post('/api/personnel/profile').send({ name: 'Somebody Else Entirely', dept: 'CCS', position: 'Coordinator', institution: 'CSPC' });

    const stillMine = (await b.get('/api/document-requests/mine')).body.find(r => r.id === other.body.request.id);
    expect(stillMine.requestedBy).toBe(before);
  });
});

describe('Department / Institution / Position are fixed at registration', () => {
  const REGISTERED = { unit: 'CCS', institution: 'Camarines Sur Polytechnic Colleges', position: 'Coordinator' };

  async function registeredAgent(role) {
    const { agent, user } = await agentFor(role);
    await getDb().collection('users').updateOne({ email: user.email }, { $set: REGISTERED });
    return { agent, user };
  }

  test.each([
    ['College Dean', 'Auth. Personnel', '/api/personnel/profile'],
    ['CIRL Staff', 'Staff', '/api/staff/profile'],
    ['Administrator', 'Administrator', '/api/admin/profile']
  ])('%s: Settings shows the registered values and ignores any attempt to change them', async (_label, role, url) => {
    const { agent, user } = await registeredAgent(role);

    const before = (await agent.get(url)).body;
    expect(before).toMatchObject({ dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator', email: user.email });

    const save = await agent.post(url).send({ name: 'Only The Name Changes', dept: 'CIRL', position: 'Hacked Position', institution: 'Hacked School' });
    expect(save.status).toBe(200);
    expect(save.body.profile).toMatchObject({ name: 'Only The Name Changes', dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator' });

    const stored = await getDb().collection('users').findOne({ email: user.email });
    expect(stored.name).toBe('Only The Name Changes');
    expect(stored.unit).toBe('CCS');
    expect(stored.institution).toBe(REGISTERED.institution);
    expect(stored.position).toBe('Coordinator');
    expect((await agent.get(url)).body).toMatchObject({ dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator' });
  });

  test('a save with no name is rejected — the name is the only thing Settings edits', async () => {
    const { agent } = await registeredAgent('Auth. Personnel');
    expect((await agent.post('/api/personnel/profile').send({ name: '   ' })).status).toBe(400);
    expect((await agent.post('/api/personnel/profile').send({ dept: 'CIRL' })).status).toBe(400);
  });

  test('the three fields are read-only on every Settings page', async () => {
    for (const [role, path] of [['Auth. Personnel', '/personnel/settings'], ['Staff', '/staff/settings'], ['Administrator', '/admin/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      for (const id of ['s-dept', 's-position', 's-institution']) {
        const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
        expect(tag).not.toBeNull();
        expect(tag[0]).toContain(' readonly ');
      }
      expect(html).not.toContain('<select class="form-select" id="s-dept"');
      expect(html).toContain("body: JSON.stringify({ name, contactNumber })");   // the name and the contact number are all Settings sends
    }
  });

  test('every Settings page still builds the profile card in updateCard() — typing a name must not throw (regression: "initials is not defined")', async () => {
    for (const [role, path] of [['Auth. Personnel', '/personnel/settings'], ['Staff', '/staff/settings'], ['Administrator', '/admin/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      const start = html.indexOf('function updateCard()');
      expect(start).toBeGreaterThan(-1);
      const body = html.slice(start, html.indexOf('function applyPhoto', start));
      // every variable the function reads must be declared inside it
      for (const v of ['name', 'dept', 'pos', 'inst', 'phone', 'parts', 'initials']) expect(body).toContain(`const ${v} =`);
      expect(body).toContain('av.textContent = initials');
      expect(body).toContain("document.getElementById('info-phone').textContent = phone");
    }
  });

  test('College Dean Settings: Cancel is hidden until something is changed, and the save button reads "Saved Changes" after saving', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const html = (await agent.get('/personnel/settings')).text;
    const cancel = html.match(/<button[^>]*id="cancel-btn"[^>]*>/);
    expect(cancel).not.toBeNull();
    expect(cancel[0]).toContain('display:none');                      // not visible on a clean form
    expect(html).toContain('oninput="onNameInput()"');                // editing the name is what reveals it
    expect(html).toContain('function syncButtons');
    expect(html).toContain('Saved Changes');
    expect(html).toContain('justSaved = true;');                      // set only after the server accepted the save
  });

  test('User Management registers them: Add User stores all three and Edit User can correct them', async () => {
    const { agent: admin } = await agentFor('Administrator');
    const email = `jesttest.reg.${Date.now()}@example.com`;
    const created = await admin.post('/api/users').send({ name: 'jesttest Registered', email, role: 'Auth. Personnel', password: 'TestPass123', unit: 'CAS', institution: 'CSPC Main', position: 'Faculty' });
    expect(created.status).toBe(200);
    expect(created.body.user).toMatchObject({ unit: 'CAS', institution: 'CSPC Main', position: 'Faculty' });

    const edited = await admin.patch('/api/users/' + created.body.user.id).send({ unit: 'CEA', institution: ' CSPC Naga ', position: 'Dean' });
    expect(edited.status).toBe(200);
    expect(edited.body.user).toMatchObject({ unit: 'CEA', institution: 'CSPC Naga', position: 'Dean' });
  });
});

describe('Contact Number in Settings (Administrator, CIRL Staff, College Dean)', () => {
  const CASES = [
    ['Administrator', 'Administrator', '/api/admin/profile', '/admin/settings'],
    ['CIRL Staff', 'Staff', '/api/staff/profile', '/staff/settings'],
    ['College Dean', 'Auth. Personnel', '/api/personnel/profile', '/personnel/settings']
  ];

  test.each(CASES)('%s: the number is saved with the name, comes back on the profile, and is stored on the account', async (_label, role, url) => {
    const { agent, user } = await agentFor(role);
    expect((await agent.get(url)).body.contactNumber).toBe('');                       // nothing yet

    const save = await agent.post(url).send({ name: 'Has A Number', contactNumber: '  0917-123-4567 ' });
    expect(save.status).toBe(200);
    expect(save.body.profile).toMatchObject({ name: 'Has A Number', contactNumber: '0917-123-4567' });   // trimmed
    expect((await agent.get(url)).body.contactNumber).toBe('0917-123-4567');
    expect((await getDb().collection('users').findOne({ email: user.email })).contactNumber).toBe('0917-123-4567');

    // a save that does not mention the number leaves it alone (an older page, a script)
    expect((await agent.post(url).send({ name: 'Still Has A Number' })).body.profile.contactNumber).toBe('0917-123-4567');
    // an empty one clears it
    const cleared = await agent.post(url).send({ name: 'Still Has A Number', contactNumber: '   ' });
    expect(cleared.body.profile.contactNumber).toBe('');
    expect((await getDb().collection('users').findOne({ email: user.email })).contactNumber).toBe('');
  });

  test.each([['letters', '0917-ABC-4567'], ['too short', '12345'], ['script', '<script>1234567</script>'], ['too long', '1'.repeat(30)]])(
    'a %s number is refused with a plain message and nothing (not even the name) is saved', async (_why, bad) => {
      const { agent, user } = await agentFor('Auth. Personnel');
      const before = await getDb().collection('users').findOne({ email: user.email });
      const res = await agent.post('/api/personnel/profile').send({ name: 'Should Not Save', contactNumber: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid contact number/i);
      const after = await getDb().collection('users').findOne({ email: user.email });
      expect(after.name).toBe(before.name);
      expect(after.contactNumber || '').toBe('');
    });

  test('a non-string number is ignored, not stored', async () => {
    const { agent, user } = await agentFor('Staff');
    const res = await agent.post('/api/staff/profile').send({ name: 'Numeric', contactNumber: 9171234567 });
    expect(res.status).toBe(200);
    expect((await getDb().collection('users').findOne({ email: user.email })).contactNumber || '').toBe('');
  });

  test.each(CASES)('%s Settings page has the Contact Number field, warns about letters, shows it on the profile card and sends it on save', async (_label, role, _url, page) => {
    const { agent } = await agentFor(role);
    const html = (await agent.get(page)).text;
    const tag = html.match(/<input[^>]*id="s-contact"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).toContain('type="tel"');
    expect(tag[0]).not.toContain('readonly');                                          // unlike department/position/institution, this one is editable
    expect(tag[0]).not.toContain('disabled');
    expect(html).toContain('id="s-contact-warn"');
    expect(html).toContain('id="info-phone"');
    expect(html).toContain("data.contactNumber || ''");
  });

  test('College Dean: changing only the number counts as a change (Cancel appears, Saved Changes goes back to Update Settings)', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const html = (await agent.get('/personnel/settings')).text;
    expect(html).toContain("var savedContact = ''");
    expect(html).toContain("document.getElementById('s-contact').value.trim() !== savedContact");
    expect(html).toContain('savedContact = contactNumber;');                            // only after the server accepted the save
    expect(html).toContain('oninput="onContactInput()"');
    // the number input is what runs syncButtons() for this page
    const fn = html.slice(html.indexOf('function onContactInput()'), html.indexOf('function applyPhoto'));
    expect(fn).toContain('syncButtons();');
  });
});

describe('Changing the password ends the session — the person signs in again with the new password', () => {
  test.each([
    ['Administrator', 'Administrator', '/api/admin/password'],
    ['CIRL Staff', 'Staff', '/api/staff/password'],
    ['College Dean', 'Auth. Personnel', '/api/personnel/password'],
    ['Partner', 'potential_partner', '/api/partner/password']
  ])('%s: the session is ended, the old password stops working and the new one signs in', async (_label, role, url) => {
    const { agent, user } = await agentFor(role);
    expect((await agent.get('/api/me')).status).toBe(200);            // signed in before

    const res = await agent.post(url).send({ oldPassword: user.password, newPassword: 'BrandNew123' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, reloginRequired: true });

    // this browser is signed out now: an authenticated route sends it back to the login page
    const after = await agent.get('/api/me');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/');

    // the old password no longer signs in, the new one does
    const oldLogin = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(oldLogin.status).toBe(200);                                // the login page again, not a redirect
    expect(oldLogin.text).toContain('Invalid email or password.');
    const fresh = request.agent(app);
    const newLogin = await fresh.post('/login').type('form').send({ username: user.email, password: 'BrandNew123' });
    expect(newLogin.status).toBe(302);
    expect((await fresh.get('/api/me')).status).toBe(200);
  });

  test('a wrong current password does NOT end the session', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const res = await agent.post('/api/personnel/password').send({ oldPassword: 'not-my-password', newPassword: 'BrandNew123' });
    expect(res.status).toBe(400);
    expect((await agent.get('/api/me')).status).toBe(200);
  });

  test('the Settings pages tell the person to log in again and go to the login page, which confirms it', async () => {
    for (const [role, path] of [['Administrator', '/admin/settings'], ['Staff', '/staff/settings'], ['Auth. Personnel', '/personnel/settings'], ['potential_partner', '/partner/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      expect(html).toContain('Please log in again');
      expect(html).toContain("/?passwordChanged=1");
    }
    const login = await request(app).get('/?passwordChanged=1');
    expect(login.status).toBe(200);
    expect(login.text).toContain('Please log in again with your new password.');
    expect((await request(app).get('/')).text).not.toContain('Please log in again with your new password.');
  });
});
