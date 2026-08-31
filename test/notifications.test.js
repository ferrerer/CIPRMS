// Covers the 2026-07-27 notification security pass: every notification must
// be private to its intended recipient, filtered server-side by session
// identity, with Administrator retaining a separate audit-only "view all"
// capability. Notification docs are seeded directly (mirroring notifyUsers'
// shape) since there is deliberately no API for creating arbitrary
// notifications — see cirl.js's own comment on that removed route.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, personnelAgent, partnerAgent, staffAgent;
let adminUser, personnelUser, partnerUser, staffUser;
let notifIds = [];

async function seedNotif(db, fields) {
  const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  await db.collection('notifications').insertOne({
    id, unread: true, time: 'Jul 27, 2026', module: 'request', tag: 'Test',
    icon: 'ri-notification-3-line', color: 'info', title: 'jesttest notif', desc: 'jesttest notif',
    ...fields
  });
  notifIds.push(id);
  return id;
}

beforeAll(async () => {
  const db = await connectDB();
  adminAgent = request.agent(app);
  adminUser = await createTestUser({ role: 'Administrator' });
  await loginAs(adminAgent, adminUser);
  personnelAgent = request.agent(app);
  personnelUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  await loginAs(personnelAgent, personnelUser);
  partnerAgent = request.agent(app);
  partnerUser = await createTestUser({ role: 'potential_partner' });
  await loginAs(partnerAgent, partnerUser);
  staffAgent = request.agent(app);
  staffUser = await createTestUser({ role: 'Staff' });
  await loginAs(staffAgent, staffUser);

  await seedNotif(db, { targetEmail: personnelUser.email, title: 'jesttest for personnel', desc: 'jesttest for personnel' });
  await seedNotif(db, { targetEmail: partnerUser.email, title: 'jesttest for partner', desc: 'jesttest for partner' });
  await seedNotif(db, { targetEmail: adminUser.email, title: 'jesttest for admin', desc: 'jesttest for admin' });
  await seedNotif(db, { targetEmail: staffUser.email, title: 'jesttest for staff', desc: 'jesttest for staff' });
  // A system-wide alert with no targetEmail at all, matching the real shape
  // the automatic lifecycle check produces — never matched by any per-user
  // query, only visible via the Administrator audit endpoint.
  await seedNotif(db, { title: 'jesttest unaddressed system alert', desc: 'jesttest unaddressed', module: 'lifecycle', tag: 'Lifecycle' });
});

afterAll(async () => {
  const db = await connectDB();
  if (notifIds.length) await db.collection('notifications').deleteMany({ id: { $in: notifIds } });
  await cleanupAll();
  await closeDB();
});

test('User-scoped list: each role sees only their own notification via /api/notifications/mine', async () => {
  const personnelRes = await personnelAgent.get('/api/notifications/mine');
  expect(personnelRes.status).toBe(200);
  expect(personnelRes.body.some(n => n.title === 'jesttest for personnel')).toBe(true);
  expect(personnelRes.body.some(n => n.title === 'jesttest for partner')).toBe(false);
  expect(personnelRes.body.some(n => n.title === 'jesttest for admin')).toBe(false);
  expect(personnelRes.body.some(n => n.title === 'jesttest unaddressed system alert')).toBe(false);

  const partnerRes = await partnerAgent.get('/api/notifications/mine');
  expect(partnerRes.status).toBe(200);
  expect(partnerRes.body.some(n => n.title === 'jesttest for partner')).toBe(true);
  expect(partnerRes.body.some(n => n.title === 'jesttest for personnel')).toBe(false);

  const staffRes = await staffAgent.get('/api/notifications/mine');
  expect(staffRes.status).toBe(200);
  expect(staffRes.body.some(n => n.title === 'jesttest for staff')).toBe(true);
  expect(staffRes.body.some(n => n.title === 'jesttest for personnel')).toBe(false);
});

test('User-scoped list: GET /api/notifications stays own-scoped for every role, not merged with everyone', async () => {
  const adminRes = await adminAgent.get('/api/notifications');
  expect(adminRes.status).toBe(200);
  expect(adminRes.body.some(n => n.title === 'jesttest for admin')).toBe(true);
  expect(adminRes.body.some(n => n.title === 'jesttest for personnel')).toBe(false);
  expect(adminRes.body.some(n => n.title === 'jesttest unaddressed system alert')).toBe(false);

  const personnelRes = await personnelAgent.get('/api/notifications');
  expect(personnelRes.status).toBe(200);
  expect(personnelRes.body.some(n => n.title === 'jesttest for personnel')).toBe(true);
  expect(personnelRes.body.some(n => n.title === 'jesttest for admin')).toBe(false);

  // 2026-08-27 full-parity revision: administrator/notifications.ejs is now
  // also Staff's Notifications page (/staff/notifications), so this route
  // opened to requireAuth — but the query itself is still strictly
  // own-scoped by targetEmail, so Staff sees only their own, never anyone
  // else's. potential_partner has its own page (/api/notifications/mine)
  // and never calls this route in the UI, but it's equally safe for them too.
  const staffRes = await staffAgent.get('/api/notifications');
  expect(staffRes.status).toBe(200);
  expect(staffRes.body.some(n => n.title === 'jesttest for staff')).toBe(true);
  expect(staffRes.body.some(n => n.title === 'jesttest for admin')).toBe(false);
  expect(staffRes.body.some(n => n.title === 'jesttest for personnel')).toBe(false);
  expect(staffRes.body.some(n => n.title === 'jesttest unaddressed system alert')).toBe(false);
});

test('Unread badge: Staff\'s count reflects only their own unread notifications, not everyone\'s (the bug this task fixes)', async () => {
  const db = await connectDB();
  // Confirm the DB actually has more unread notifications system-wide than
  // Staff owns, so a passing count here is a real assertion, not a
  // coincidence of there only being one unread notification in the whole DB.
  const totalUnread = await db.collection('notifications').countDocuments({ unread: true });
  const staffUnread = await db.collection('notifications').countDocuments({ targetEmail: staffUser.email, unread: true });
  expect(totalUnread).toBeGreaterThan(staffUnread);

  const res = await staffAgent.get('/api/notifications/unread-count');
  expect(res.status).toBe(200);
  expect(res.body.count).toBe(staffUnread);
  expect(res.body.count).toBe(1); // exactly the one jesttest notif addressed to this Staff account
});

test('Unread badge: every other role is also scoped to their own count', async () => {
  const adminRes = await adminAgent.get('/api/notifications/unread-count');
  expect(adminRes.body.count).toBe(1);
  const personnelRes = await personnelAgent.get('/api/notifications/unread-count');
  expect(personnelRes.body.count).toBe(1);
  const partnerRes = await partnerAgent.get('/api/notifications/unread-count');
  expect(partnerRes.body.count).toBe(1);
});

test('Administrator audit: GET /api/notifications/all returns every notification, including unaddressed system alerts', async () => {
  const res = await adminAgent.get('/api/notifications/all');
  expect(res.status).toBe(200);
  const titles = res.body.map(n => n.title);
  expect(titles).toContain('jesttest for personnel');
  expect(titles).toContain('jesttest for partner');
  expect(titles).toContain('jesttest for admin');
  expect(titles).toContain('jesttest for staff');
  expect(titles).toContain('jesttest unaddressed system alert');
});

test('Administrator audit is Administrator-only: every other role is redirected, not served data', async () => {
  expect((await personnelAgent.get('/api/notifications/all')).status).toBe(302);
  expect((await partnerAgent.get('/api/notifications/all')).status).toBe(302);
  expect((await staffAgent.get('/api/notifications/all')).status).toBe(302);
  expect((await request(app).get('/api/notifications/all')).status).toBe(302);
});

test('Ownership enforcement: a user cannot mark or delete another user\'s notification by guessing its id', async () => {
  const db = await connectDB();
  const personnelNotif = await db.collection('notifications').findOne({ targetEmail: personnelUser.email, title: 'jesttest for personnel' });

  const patchRes = await partnerAgent.patch('/api/notifications/' + personnelNotif.id).send({ unread: false });
  expect(patchRes.status).toBe(403);

  const deleteRes = await staffAgent.delete('/api/notifications/' + personnelNotif.id);
  expect(deleteRes.status).toBe(403);

  // Confirm neither forbidden call actually mutated the record.
  const stillThere = await db.collection('notifications').findOne({ id: personnelNotif.id });
  expect(stillThere).toBeTruthy();
  expect(stillThere.unread).toBe(true);

  // The real owner can still act on their own notification.
  const ownRes = await personnelAgent.patch('/api/notifications/' + personnelNotif.id).send({ unread: false });
  expect(ownRes.status).toBe(200);
});

test('No session: notification endpoints redirect rather than leak data', async () => {
  expect((await request(app).get('/api/notifications/mine')).status).toBe(302);
  expect((await request(app).get('/api/notifications/unread-count')).status).toBe(302);
});

// 2026-07-29 bug fix: submitting a Partnership Request used to broadcast an
// "FYI" notification to every Administrator AND every Auth. Personnel
// account org-wide — not "their own" notifications, since Auth. Personnel
// doesn't review these (only Administrator does) and has no relationship to
// most submitters. Only Administrator should be notified now.
test('Partnership Request submission notifies only Administrator, not every Auth. Personnel account (the reported bug)', async () => {
  const db = await connectDB();
  const res = await partnerAgent.post('/api/requests').send({
    institution: 'jesttest Notify Scoping University', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  expect(res.status).toBe(200);

  const created = await db.collection('notifications').find({ title: { $regex: 'jesttest Notify Scoping University' } }).toArray();
  created.forEach((n) => notifIds.push(n.id));

  expect(created.some((n) => n.targetEmail === adminUser.email)).toBe(true);
  expect(created.some((n) => n.targetEmail === personnelUser.email)).toBe(false);
  expect(created.some((n) => n.targetEmail === partnerUser.email)).toBe(false); // submitter never notifies themselves
});
