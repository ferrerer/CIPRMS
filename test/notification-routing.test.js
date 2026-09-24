// Where a notification click goes, for every role that has a bell: Administrator, CIRL Staff, College Dean
// and Partner. The stored `link` is whatever was right for the recipient when the notification was created;
// the API now also returns `href`, the destination re-resolved for the role that is actually reading it.
// These tests pin that down against (a) links of every vintage found in the database — stale routes,
// other roles' routes, removed pages, no link at all — (b) notifications produced by the REAL request flows,
// and (c) the security rules: only your own notifications, and nothing a notification carries can point
// off-site or at somebody else's record.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, agents, users;
const createdRequestIds = [], createdDocRequestIds = [];

beforeAll(async () => {
  db = await connectDB();
  agents = {}; users = {};
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partnerA', 'potential_partner', ''], ['partnerB', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }
});
afterAll(async () => {
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  if (createdDocRequestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: createdDocRequestIds } });
  await db.collection('documents').deleteMany({ $or: [{ requestType: 'partnership', requestId: { $in: createdRequestIds } }, { requestType: 'document', requestId: { $in: createdDocRequestIds } }] });
  await cleanupAll();
  await closeDB();
});

async function seedNotification(key, fields) {
  const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last[0] ? last[0].id : 0) + 1;
  await db.collection('notifications').insertOne({ id, targetEmail: users[key].email, unread: true, time: 'Sep 21, 2026', title: 'jesttest notification', desc: 'jesttest', ...fields });
  return id;
}
async function hrefOf(key, id) {
  const res = await agents[key].get('/api/notifications/mine');
  return res.body.find(n => n.id === id).href;
}

// [module, tag, stored link] -> href expected per role (null = same as the role's fallback)
const CASES = [
  // links the CURRENT code generates
  ['request', 'Partnership Request', '/partnership-requests?open=pr&id=7', { admin: '/partnership-requests?open=pr&id=7', staff: '/staff/requests?open=pr&id=7', college: '/personnel/monitoring', partnerA: '/partner/monitoring?type=pr&id=7' }],
  ['request', 'Document Request', '/partnership-requests?open=dr&id=8', { admin: '/partnership-requests?open=dr&id=8', staff: '/staff/requests?open=dr&id=8', college: '/personnel/monitoring?type=dr&id=8', partnerA: '/partner/requests?tab=dr' }],
  ['request', 'Partnership Request', '/staff/requests?open=pr&id=9', { admin: '/partnership-requests?open=pr&id=9', staff: '/staff/requests?open=pr&id=9', college: '/personnel/monitoring', partnerA: '/partner/monitoring?type=pr&id=9' }],
  ['request', 'Document Request', '/personnel/monitoring?type=dr&id=10', { admin: '/partnership-requests?open=dr&id=10', staff: '/staff/requests?open=dr&id=10', college: '/personnel/monitoring?type=dr&id=10', partnerA: '/partner/requests?tab=dr' }],
  ['request', 'Partnership Request', '/partner/monitoring?type=pr&id=11', { admin: '/partnership-requests?open=pr&id=11', staff: '/staff/requests?open=pr&id=11', college: '/personnel/monitoring', partnerA: '/partner/monitoring?type=pr&id=11' }],
  ['request', 'Document Request', '/partner/monitoring?type=dr&id=12', { admin: '/partnership-requests?open=dr&id=12', staff: '/staff/requests?open=dr&id=12', college: '/personnel/monitoring?type=dr&id=12', partnerA: '/partner/requests?tab=dr' }],
  ['calendar', 'Calendar', '/calendar?id=13', { admin: '/calendar?id=13', staff: '/staff/calendar?id=13', college: '/personnel/calendar?id=13', partnerA: '/partner/calendar?id=13' }],
  ['calendar', 'Calendar', '/staff/calendar?id=14', { admin: '/calendar?id=14', staff: '/staff/calendar?id=14', college: '/personnel/calendar?id=14', partnerA: '/partner/calendar?id=14' }],
  // vintages found in the database: another role's route, no id, removed pages
  ['calendar', 'Calendar', '/calendar', { admin: '/calendar', staff: '/staff/calendar', college: '/personnel/calendar', partnerA: '/partner/calendar' }],
  ['requests', 'Requests', '/personnel/requests', { admin: '/partnership-requests', staff: '/staff/requests', college: '/personnel/requests', partnerA: '/partner/requests' }],
  ['requests', 'Requests', '/viewonly/request-access?id=15', { admin: '/partnership-requests', staff: '/staff/requests', college: '/personnel/requests', partnerA: '/partner/requests' }],
  ['dashboard', 'Dashboard', '/dashboard', { admin: '/dashboard', staff: '/staff/dashboard', college: '/personnel/monitoring', partnerA: '/partner/monitoring' }],
  ['request', 'Document Request', '/partner/dashboard', { admin: '/partnership-requests', staff: '/staff/requests', college: '/personnel/requests', partnerA: '/partner/requests?tab=dr' }],
  // no link at all — resolved from the module, else a safe page of the role's own (never a dashboard)
  ['lifecycle', 'Lifecycle', undefined, { admin: '/lifecycle', staff: '/staff/lifecycle', college: '/personnel/monitoring', partnerA: '/partner/monitoring' }],
  ['request', 'Partnership Request', undefined, { admin: '/partnership-requests', staff: '/staff/requests', college: '/personnel/requests', partnerA: '/partner/requests' }],
  ['calendar', 'Calendar', undefined, { admin: '/calendar', staff: '/staff/calendar', college: '/personnel/calendar', partnerA: '/partner/calendar' }],
  ['mystery', 'Other', undefined, { admin: '/notifications', staff: '/staff/notifications', college: '/personnel/monitoring', partnerA: '/partner/monitoring' }]
];

describe('href is resolved for the role that is reading the notification', () => {
  test.each(['admin', 'staff', 'college', 'partnerA'])('%s: every stored-link vintage resolves to a page that role has', async (key) => {
    const seeded = [];
    for (const [module, tag, link] of CASES) seeded.push({ id: await seedNotification(key, { module, tag, ...(link === undefined ? {} : { link }) }), module, tag, link });
    for (let i = 0; i < CASES.length; i++) {
      const [, , , expected] = CASES[i];
      expect({ case: CASES[i].slice(0, 3), href: await hrefOf(key, seeded[i].id) }).toEqual({ case: CASES[i].slice(0, 3), href: expected[key] });
    }
    // the stored link itself is never rewritten
    const stored = await db.collection('notifications').findOne({ id: seeded[0].id });
    expect(stored.link).toBe(CASES[0][2]);
  });

  test('the same href is served by /api/notifications (the Notifications page feed) and /api/notifications/mine (the bell)', async () => {
    const id = await seedNotification('staff', { module: 'calendar', tag: 'Calendar', link: '/calendar?id=21' });
    const a = (await agents.staff.get('/api/notifications')).body.find(n => n.id === id);
    const b = (await agents.staff.get('/api/notifications/mine')).body.find(n => n.id === id);
    expect(a.href).toBe('/staff/calendar?id=21');
    expect(b.href).toBe(a.href);
  });

  test('read and unread notifications resolve identically', async () => {
    const unread = await seedNotification('college', { module: 'request', tag: 'Document Request', link: '/personnel/monitoring?type=dr&id=31', unread: true });
    const read = await seedNotification('college', { module: 'request', tag: 'Document Request', link: '/personnel/monitoring?type=dr&id=31', unread: false });
    expect(await hrefOf('college', unread)).toBe('/personnel/monitoring?type=dr&id=31');
    expect(await hrefOf('college', read)).toBe('/personnel/monitoring?type=dr&id=31');
  });

  test('College Dean, CIRL Staff and Partner are never sent to a Dashboard; only Administrator and CIRL Staff keep theirs, and only when the notification is about it', async () => {
    for (const key of ['college', 'partnerA']) {
      for (const link of ['/dashboard', '/staff/dashboard', '/personnel/dashboard', '/partner/dashboard', '/partner/documents', '/partner/notifications', '/personnel/documents']) {
        const id = await seedNotification(key, { module: 'dashboard', tag: 'Dashboard', link });
        expect(await hrefOf(key, id)).not.toMatch(/dashboard/i);
      }
    }
    const requestLinkForStaff = await seedNotification('staff', { module: 'request', tag: 'Partnership Request', link: '/partnership-requests?open=pr&id=3' });
    expect(await hrefOf('staff', requestLinkForStaff)).toBe('/staff/requests?open=pr&id=3');
  });

  test('hostile or malformed links can never produce an off-site or script destination, or smuggle in a non-numeric id', async () => {
    const attempts = ['https://evil.example/phish', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example', 'data:text/html,x', '/partner/requests?tab=dr&id=1;drop', '/calendar?id=abc<script>'];
    for (const link of attempts) {
      const id = await seedNotification('partnerA', { module: 'request', tag: 'Document Request', link });
      const href = await hrefOf('partnerA', id);
      expect(href).toMatch(/^\/partner\/(requests|monitoring|calendar)(\?[a-z]+=[a-z0-9]+(&id=\d+)?)?$/);
      expect(href).not.toMatch(/evil|javascript|script|drop/);
    }
  });

  test.each(['admin', 'staff', 'college', 'partnerA'])('%s: every href produced above really opens (HTTP 200, not bounced to another page)', async (key) => {
    const hrefs = new Set(CASES.map(c => c[3][key]));
    for (const href of hrefs) {
      const res = await agents[key].get(href);
      expect({ href, status: res.status }).toEqual({ href, status: 200 });
    }
  });
});

describe('notifications produced by the real request flows route correctly', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  test('Partnership Request: reviewers get a deep link to it; the Partner gets one back to Monitoring when it is decided', async () => {
    const created = await agents.partnerA.post('/api/requests').send({ institution: 'jesttest Routing University', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest' });
    expect(created.status).toBe(200);
    const id = created.body.request.id;
    createdRequestIds.push(id);

    for (const [key, base] of [['admin', '/partnership-requests'], ['staff', '/staff/requests']]) {
      const n = (await agents[key].get('/api/notifications/mine')).body.find(x => x.module === 'request' && /open=pr&id=/.test(x.link || '') && x.link.endsWith('id=' + id));
      expect(n).toBeTruthy();
      expect(n.href).toBe(`${base}?open=pr&id=${id}`);
      expect((await agents[key].get(n.href)).status).toBe(200);
    }

    const decided = await agents.staff.patch(`/api/requests/${id}`).send({ status: 'Rejected' });
    expect(decided.status).toBe(200);
    const back = (await agents.partnerA.get('/api/notifications/mine')).body.find(x => x.module === 'request' && /pr/.test(x.link || '') && x.link.endsWith('id=' + id));
    expect(back).toBeTruthy();
    expect(back.href).toBe(`/partner/monitoring?type=pr&id=${id}`);
    expect((await agents.partnerA.get(back.href)).status).toBe(200);
  });

  test('Document Request from College Dean: reviewers and the requester each land on their own page for it', async () => {
    const created = await agents.college.post('/api/document-requests').send({ institution: 'CCS', documentTypes: ['jesttest doc'], notes: 'jesttest' });
    expect(created.status).toBe(200);
    const id = created.body.request.id;
    createdDocRequestIds.push(id);
    const forStaff = (await agents.staff.get('/api/notifications/mine')).body.find(x => (x.link || '').endsWith('open=dr&id=' + id));
    expect(forStaff.href).toBe(`/staff/requests?open=dr&id=${id}`);
    expect((await agents.staff.get(forStaff.href)).status).toBe(200);

    expect((await agents.staff.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' })).status).toBe(200);
    const forCollege = (await agents.college.get('/api/notifications/mine')).body.find(x => (x.link || '').includes('id=' + id));
    expect(forCollege.href).toBe(`/personnel/monitoring?type=dr&id=${id}`);
    expect((await agents.college.get(forCollege.href)).status).toBe(200);
  });

  test('MOA/MOU submission from a Partner: reviewers deep-link to it; the Partner is sent to the Requests page on its MOA/MOU tab (there is no per-request Partner page)', async () => {
    const created = await agents.partnerA.post('/api/document-requests').send({ institution: 'jesttest Partner Org', documentTypes: ['MOA/MOU Submission'], notes: 'jesttest' });
    expect(created.status).toBe(200);
    const id = created.body.request.id;
    createdDocRequestIds.push(id);
    expect((await agents.staff.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' })).status).toBe(200);
    const forPartner = (await agents.partnerA.get('/api/notifications/mine')).body.find(x => x.module === 'request' && /Document/.test(x.tag) && (x.desc || '').length && x.link && x.link.includes('/partner/'));
    expect(forPartner.href).toBe('/partner/requests?tab=dr');
    const page = await agents.partnerA.get(forPartner.href);
    expect(page.status).toBe(200);
    expect(page.text).toContain("get('tab') === 'dr'");
  });

  test('a calendar notification created by an event opens that event page for College Dean and Partner', async () => {
    const res = await agents.admin.post('/api/calendarevents').send({ title: 'jesttest routing meeting', start: '2026-12-01T09:00', allDay: false, className: 'bg-primary-subtle', recipients: [users.college.email, users.partnerA.email] });
    expect(res.status).toBe(200);
    const eventId = res.body.event.id;
    try {
      const c = (await agents.college.get('/api/notifications/mine')).body.find(x => x.title === 'New event: jesttest routing meeting');
      const p = (await agents.partnerA.get('/api/notifications/mine')).body.find(x => x.title === 'New event: jesttest routing meeting');
      expect(c.href).toBe(`/personnel/calendar?id=${eventId}`);
      expect(p.href).toBe(`/partner/calendar?id=${eventId}`);
      expect((await agents.college.get(c.href)).status).toBe(200);
      expect((await agents.partnerA.get(p.href)).status).toBe(200);
    } finally {
      await db.collection('calendarevents').deleteOne({ id: eventId });
    }
  });
});

describe('a notification can never be used to reach another user\'s data', () => {
  test('Partner B never receives, reads, changes or deletes Partner A\'s notifications', async () => {
    const id = await seedNotification('partnerA', { module: 'request', tag: 'Partnership Request', link: '/partner/monitoring?type=pr&id=99' });
    expect((await agents.partnerB.get('/api/notifications/mine')).body.some(n => n.id === id)).toBe(false);
    expect((await agents.partnerB.get('/api/notifications')).body.some(n => n.id === id)).toBe(false);
    expect((await agents.partnerB.patch('/api/notifications/' + id).send({ unread: false })).status).toBe(403);
    expect((await agents.partnerB.delete('/api/notifications/' + id)).status).toBe(403);
    expect((await agents.partnerB.get('/api/notifications/all')).status).toBe(302);   // the all-users audit feed is Administrator-only
    expect((await db.collection('notifications').findOne({ id })).unread).toBe(true);
  });

  test('following A\'s request link as Partner B opens the page but shows nothing of A\'s: the request feeds are owner-scoped', async () => {
    const created = await agents.partnerA.post('/api/requests').send({ institution: 'jesttest Private Org', country: 'Testland', type: 'MOU', nature: 'Research', notes: 'jesttest' });
    const id = created.body.request.id;
    createdRequestIds.push(id);
    const page = await agents.partnerB.get(`/partner/monitoring?type=pr&id=${id}`);
    expect(page.status).toBe(200);
    for (const url of ['/api/requests', '/api/requests/mine']) {
      const list = (await agents.partnerB.get(url)).body;
      expect(list.some(r => r.id === id)).toBe(false);
    }
    expect((await agents.partnerB.post(`/api/requests/${id}/documents`).field('note', 'x').attach('document', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'x.png')).status).toBe(403);
    expect((await agents.partnerB.post(`/api/requests/${id}/withdraw`)).status).toBe(403);
  });
});
