// Role DISPLAY names are presentation-only:
//   stored role "Staff"           → shown as "CIRL Staff"
//   stored role "Auth. Personnel" → shown as "College Staff"   (it was shown as "Department/Colleges" for a while)
//   stored role "potential_partner" → shown as "Partner" (unchanged)
// The stored / session / RBAC VALUES must not change (sessions, the users collection, every permission check,
// <option value="…">, role filters, API payloads). These tests pin down BOTH halves.
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, getDb } = require('./helpers');

const COLLEGE_INTERNAL = 'Auth. Personnel'; // stored value — must NOT change
const STAFF_INTERNAL = 'Staff'; // stored value — must NOT change
const COLLEGE = 'College Staff'; // what users see
const CIRL = 'CIRL Staff'; // what users see
const PREVIOUS = 'Department/Colleges'; // an earlier display name — must not linger anywhere visible

beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  // POST /api/users stamps a real createdAt (not the jesttest tag), so remove those accounts by their jesttest email.
  await getDb().collection('users').deleteMany({ email: { $regex: '^jesttest\\.', $options: 'i' } });
  await cleanupAll();
  await closeDB();
});

// Visible text only: drop <script>/<style>/comments (role VALUES legitimately live in script maps and
// <option value="…"> attributes), then drop tags (so attribute values are not counted as visible).
const stripNonVisible = html => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const textOf = html => stripNonVisible(html).replace(/<[^>]+>/g, ' ');
// A bare "Staff" that is NOT already qualified as "CIRL Staff" / "College Staff" is an un-renamed role label.
const bareStaff = html => (textOf(html).match(/(?<!CIRL )(?<!College )\bStaff\b/g) || []);

async function agentFor(role) {
  const user = await createTestUser({ role });
  // createTestUser names every fixture "jesttest <role>" — which would put the literal role value into the
  // page as the user's display NAME (header/sidebar). Give it a neutral name so the tests judge role LABELS only.
  await getDb().collection('users').updateOne({ id: user.id }, { $set: { name: 'jesttest Display Tester' } });
  const agent = request.agent(app);
  const login = await loginAs(agent, user);
  return { agent, user, login };
}

describe('College Staff (stored "Auth. Personnel") — every page it can open shows the new name only', () => {
  let agent;
  beforeAll(async () => { ({ agent } = await agentFor(COLLEGE_INTERNAL)); });

  test.each(['/personnel/monitoring', '/personnel/requests', '/personnel/settings', '/personnel/calendar', '/calendar'])(
    '%s shows neither "Auth. Personnel" nor the previous "Department/Colleges"', async (path) => {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      const visible = textOf(res.text);
      expect(visible).not.toContain(COLLEGE_INTERNAL);
      expect(visible).not.toContain(PREVIOUS);
    });

  test('header subtitle, sidebar role label and Settings hero all read exactly "College Staff"', async () => {
    const mon = (await agent.get('/personnel/monitoring')).text;
    expect(mon).toMatch(/user-name-sub-text">College Staff</);
    expect(mon).toMatch(/id="sidebar-role-label"[\s\S]*?<span class="align-middle">College Staff<\/span>/);
    expect((await agent.get('/personnel/settings')).text).toContain('id="hero-role">College Staff<');
  });

  test('the admin-layout sidebar (reached via /calendar) uses the new label too', async () => {
    expect((await agent.get('/calendar')).text).toMatch(/class="align-middle">College Staff</);
  });
});

describe('CIRL Staff (stored "Staff") — every page it can open shows the new name', () => {
  let agent;
  beforeAll(async () => { ({ agent } = await agentFor(STAFF_INTERNAL)); });

  test('header subtitle, sidebar role label and Settings hero read exactly "CIRL Staff"', async () => {
    const dash = (await agent.get('/staff/dashboard')).text;
    expect(dash).toMatch(/user-name-sub-text">CIRL Staff</);
    expect(dash).toMatch(/class="align-middle">CIRL Staff<\/span>/);
    expect((await agent.get('/staff/settings')).text).toContain('id="hero-role">CIRL Staff<');
  });

  test.each(['/staff/dashboard', '/staff/calendar', '/staff/documents', '/staff/lifecycle', '/staff/requests', '/staff/settings', '/staff/notifications', '/staff/users', '/staff/reports'])(
    '%s has no un-renamed "Staff" role label', async (path) => {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(bareStaff(res.text)).toEqual([]);
    });
});

describe('Administrator / Staff see both new names wherever a role is shown — option VALUES stay internal', () => {
  test.each([['Administrator', '/users'], ['Staff', '/staff/users']])('%s → User Management (%s)', async (role, path) => {
    const { agent } = await agentFor(role);
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    // visible labels changed …
    expect(res.text).toContain(`<option value="Auth. Personnel">${COLLEGE}</option>`); // role filter
    expect(res.text).toContain(`<option value="Auth. Personnel" selected>${COLLEGE}</option>`); // Add/Edit User modal
    expect(res.text.split(`<option value="Staff">${CIRL}</option>`).length - 1).toBe(2); // filter + modal
    expect(res.text).toContain(`${COLLEGE}</th>`);
    expect(res.text).toContain(`${CIRL}</th>`); // permission-matrix column headers
    expect(textOf(res.text)).not.toContain(COLLEGE_INTERNAL);
    expect(textOf(res.text)).not.toContain(PREVIOUS);
    // … the client formatter maps labels, but badges/filters still key on the stored values
    expect(res.text).toContain(`if (role === 'Auth. Personnel') return '${COLLEGE}';`);
    expect(res.text).toContain(`if (role === 'Staff') return '${CIRL}';`);
    expect(res.text).toContain("if (role === 'Auth. Personnel') return `<span class=\"badge bg-warning-subtle text-warning\">${displayRole}</span>`;");
  });

  test('Administrator: Audit Trail role filter + Calendar recipients + Partnership Requests timeline', async () => {
    const { agent } = await agentFor('Administrator');
    const reports = await agent.get('/reports');
    expect(reports.status).toBe(200);
    expect(reports.text).toContain(`<option value="Auth. Personnel">${COLLEGE}</option>`);
    expect(reports.text).toContain(`<option value="Staff">${CIRL}</option>`);
    expect(reports.text).toContain(`if (role === 'Auth. Personnel') return '${COLLEGE}';`);
    expect(reports.text).toContain(`if (role === 'Staff') return '${CIRL}';`);
    expect(reports.text).toContain("'Auth. Personnel': 'bg-warning-subtle text-warning'"); // badge colour keyed on the stored value
    expect(reports.text).toContain("'Staff': 'bg-secondary-subtle text-secondary'");

    const calendar = await agent.get('/calendar');
    expect(calendar.text).toContain(`<option value="Auth. Personnel">${COLLEGE}</option>`);
    expect(calendar.text).toContain(`<option value="Staff">${CIRL}</option>`);
    expect(textOf(calendar.text)).not.toContain(PREVIOUS);

    const pr = await agent.get('/partnership-requests');
    expect(pr.status).toBe(200);
    expect(pr.text).toContain(`'Staff': '${CIRL}'`);
    expect(pr.text).toContain(`'Auth. Personnel': '${COLLEGE}'`);
  });

  test('Staff sees both new names in the Calendar recipients list too', async () => {
    const { agent } = await agentFor('Staff');
    const res = await agent.get('/staff/calendar');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<option value="Auth. Personnel">${COLLEGE}</option>`);
    expect(res.text).toContain(`<option value="Staff">${CIRL}</option>`);
  });

  test('Partner and College Staff timelines label both roles with the new names', async () => {
    for (const [role, path] of [['potential_partner', '/partner/monitoring'], [COLLEGE_INTERNAL, '/personnel/monitoring']]) {
      const { agent } = await agentFor(role);
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain(`'Staff': '${CIRL}'`);
      expect(res.text).toContain(`'Auth. Personnel': '${COLLEGE}'`);
      expect(textOf(res.text)).not.toContain(COLLEGE_INTERNAL);
    }
  });

  test('Partner keeps the label "Partner"', async () => {
    const { agent } = await agentFor('potential_partner');
    expect((await agent.get('/partner/monitoring')).text).toMatch(/user-name-sub-text">Partner</);
  });
});

describe('The stored role values, sessions and RBAC are UNCHANGED', () => {
  let admin;
  beforeAll(async () => { ({ agent: admin } = await agentFor('Administrator')); });

  test('the API still accepts the STORED values and rejects every display name as a role', async () => {
    for (const role of [STAFF_INTERNAL, COLLEGE_INTERNAL]) {
      const ok = await admin.post('/api/users').send({ name: 'jesttest Role Ok', email: uniqueEmail('ok'), role, password: 'TestPass123' });
      expect(ok.status).toBe(200);
      expect(ok.body.user.role).toBe(role);
      expect((await getDb().collection('users').findOne({ email: ok.body.user.email })).role).toBe(role); // the DB value is not the label
    }
    for (const label of [CIRL, COLLEGE, PREVIOUS]) {
      const bad = await admin.post('/api/users').send({ name: 'jesttest Bad Role', email: uniqueEmail('bad'), role: label, password: 'TestPass123' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('Invalid role.');
    }
  });

  test.each([
    [STAFF_INTERNAL, '/staff/dashboard'],
    [COLLEGE_INTERNAL, '/personnel/monitoring'],
    ['potential_partner', '/partner/monitoring']
  ])('a "%s" account logs in, lands on %s, and its SESSION role is still the stored value', async (role, home) => {
    const email = uniqueEmail('sess');
    const made = await admin.post('/api/users').send({ name: 'jesttest Session', email, role, password: 'TestPass123' });
    expect(made.status).toBe(200);
    const agent = request.agent(app);
    const login = await agent.post('/login').type('form').send({ username: email, password: 'TestPass123' });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe(home);
    expect((await agent.get('/api/me')).body.user.role).toBe(role);
  });

  test('permissions are exactly as before: CIRL Staff keeps staff access (but not Administrator management); College Staff stays out of admin/staff areas', async () => {
    const { agent: staff } = await agentFor(STAFF_INTERNAL);
    expect((await staff.get('/api/users')).status).toBe(200);
    expect((await staff.get('/api/activitylogs')).status).toBe(200);
    const denied = await staff.post('/api/users').send({ name: 'jesttest Escalation', email: uniqueEmail('esc'), role: 'Administrator', password: 'TestPass123' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('CIRL Staff cannot create Administrator accounts.'); // the visible message uses the display name

    const { agent: college } = await agentFor(COLLEGE_INTERNAL);
    for (const path of ['/dashboard', '/users', '/reports', '/partnership-requests', '/staff/dashboard', '/personnel/dashboard', '/personnel/documents', '/personnel/notifications']) {
      const res = await college.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/personnel/monitoring');
    }
    expect((await college.post('/api/users').send({ name: 'x', email: uniqueEmail('nope'), role: 'Staff' })).status).toBe(302);
  });
});

describe('Audit trail: stored text is raw; every DISPLAY of it uses the new names', () => {
  let admin;
  beforeAll(async () => { ({ agent: admin } = await agentFor('Administrator')); });

  const exportedRows = async () => {
    const res = await admin.get('/api/reports/activitylog/excel').buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const rows = [];
    wb.worksheets[0].eachRow(row => rows.push({ record: String(row.getCell(2).value || ''), by: String(row.getCell(3).value || ''), role: String(row.getCell(4).value || '') }));
    return rows;
  };

  test('NEW entries store the plain role; the Excel export shows the display names', async () => {
    const email = uniqueEmail('audit');
    const made = await admin.post('/api/users').send({ name: 'jesttest Audit College', email, role: COLLEGE_INTERNAL, password: 'TestPass123' });
    expect(made.status).toBe(200);
    expect((await admin.patch('/api/users/' + made.body.user.id).send({ role: STAFF_INTERNAL })).status).toBe(200);

    const logs = (await admin.get('/api/activitylogs')).body;
    const added = logs.find(l => l.action === 'ADD' && l.record.includes(email));
    expect(added.record).toContain(`(${COLLEGE_INTERNAL})`); // stored raw
    expect(added.role).toBe('Administrator');
    const edited = logs.find(l => l.action === 'EDIT' && l.record.includes('jesttest Audit College'));
    expect(edited.record).toContain(`role: ${STAFF_INTERNAL}`); // stored raw

    const rows = await exportedRows();
    const a = rows.find(r => r.record.includes(email)), e = rows.find(r => r.record.includes('jesttest Audit College') && r.record.includes('role:'));
    expect(a.record).toContain(`(${COLLEGE})`);
    expect(a.record).not.toContain(COLLEGE_INTERNAL);
    expect(e.record).toContain(`role: ${CIRL}`);
  });

  test('rows written before either rename (old stored names, and the interim "Department/Colleges" text) are translated on export while the API keeps the raw values', async () => {
    const db = getDb();
    const last = await db.collection('activitylogs').find({}).sort({ id: -1 }).limit(1).toArray();
    const base = (last.length ? last[0].id : 0) + 1;
    await db.collection('activitylogs').insertMany([
      { id: base, action: 'ADD', record: 'User created: jesttest Legacy College (Auth. Personnel) — jesttest.legacy1@example.com', by: 'jesttest Legacy Actor', role: COLLEGE_INTERNAL, date: 'Sep 1, 2026, 09:00 AM' },
      { id: base + 1, action: 'ADD', record: 'User created: jesttest Legacy Interim (Department/Colleges) — jesttest.legacy2@example.com', by: 'jesttest Legacy Actor', role: COLLEGE_INTERNAL, date: 'Sep 1, 2026, 09:01 AM' },
      { id: base + 2, action: 'ADD', record: 'User created: jesttest Legacy Staff (Staff) — jesttest.legacy3@example.com', by: 'jesttest Legacy Staff Actor', role: STAFF_INTERNAL, date: 'Sep 1, 2026, 09:02 AM' },
      { id: base + 3, action: 'EDIT', record: 'User updated: jesttest Legacy Edit — role: Staff, status: Active', by: 'jesttest Legacy Actor', role: 'Administrator', date: 'Sep 1, 2026, 09:03 AM' }
    ]);

    const raw = (await admin.get('/api/activitylogs')).body;
    expect(raw.find(l => l.record.includes('jesttest Legacy College')).role).toBe(COLLEGE_INTERNAL); // API data is NOT rewritten (filters depend on it)
    expect(raw.find(l => l.record.includes('jesttest Legacy College')).record).toContain('(Auth. Personnel)');
    expect(raw.find(l => l.record.includes('jesttest Legacy Staff')).role).toBe(STAFF_INTERNAL);

    const rows = await exportedRows();
    const find = s => rows.find(r => r.record.includes(s));
    expect(find('jesttest Legacy College').record).toContain(`(${COLLEGE})`);
    expect(find('jesttest Legacy College').role).toBe(COLLEGE);
    expect(find('jesttest Legacy Interim').record).toContain(`(${COLLEGE})`);
    expect(find('jesttest Legacy Interim').record).not.toContain(PREVIOUS);
    expect(find('jesttest Legacy Staff').record).toContain(`(${CIRL})`);
    expect(find('jesttest Legacy Staff').role).toBe(CIRL);
    expect(find('jesttest Legacy Edit').record).toContain(`role: ${CIRL}`);

    const pdf = await admin.get('/api/reports/activitylog/pdf').buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
