// 2026-09-14: Staff gained full Calendar event create/edit/delete parity with
// Administrator (previously requireAdmin-only on POST/PATCH/DELETE
// /api/calendarevents — Staff was redirected like every other non-admin
// role). This suite proves: (a) the authorization change itself — exactly
// Administrator and Staff may mutate calendar events, everyone else is
// unaffected; (b) Staff reuses the *same* create/edit/delete route and the
// same shared, org-wide Google Calendar integration as Administrator — no
// second implementation, no per-user OAuth; and (c) a Staff-created event's
// actor identity is the real Staff user, never impersonating Administrator.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { encrypt } = require('../services/tokenCrypto');

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
let adminUser, staffUser;
let createdEventIds = [];

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app);
  await loginAs(adminAgent, adminUser);

  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);

  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));

  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION).deleteMany({});
  await cleanupAll();
  await closeDB();
});

describe('POST /api/calendarevents authorization (Administrator OR Staff, matching requireStaffAccess)', () => {
  test('Administrator can create an event', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Admin-created event', start: '2026-10-01T09:00', allDay: false, recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdEventIds.push(res.body.event.id);
  });

  test('Staff can create an event', async () => {
    const res = await staffAgent.post('/api/calendarevents').send({
      title: 'jesttest Staff-created event', start: '2026-10-02T09:00', allDay: false, recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdEventIds.push(res.body.event.id);
  });

  test('Auth. Personnel cannot create an event (redirected, unchanged from before this fix)', async () => {
    const res = await personnelAgent.post('/api/calendarevents').send({
      title: 'jesttest should not be created', start: '2026-10-03T09:00'
    });
    expect(res.status).toBe(302);
  });

  test('potential_partner cannot create an event (redirected, unchanged from before this fix)', async () => {
    const res = await partnerAgent.post('/api/calendarevents').send({
      title: 'jesttest should not be created', start: '2026-10-03T09:00'
    });
    expect(res.status).toBe(302);
  });

  test('Unauthenticated requests cannot create an event', async () => {
    const res = await request(app).post('/api/calendarevents').send({
      title: 'jesttest should not be created', start: '2026-10-03T09:00'
    });
    expect(res.status).toBe(302);
  });
});

describe('PATCH/DELETE /api/calendarevents/:id authorization (Administrator OR Staff)', () => {
  let eventId;
  beforeEach(async () => {
    const res = await staffAgent.post('/api/calendarevents').send({
      title: 'jesttest PATCH/DELETE target', start: '2026-10-04T09:00', allDay: false, recipients: []
    });
    eventId = res.body.event.id;
    createdEventIds.push(eventId);
  });

  test('Staff can edit an event it did not necessarily create itself (shared institutional calendar)', async () => {
    const res = await staffAgent.patch('/api/calendarevents/' + eventId).send({ title: 'jesttest edited by Staff' });
    expect(res.status).toBe(200);
    expect(res.body.event.title).toBe('jesttest edited by Staff');
  });

  test('Administrator can edit a Staff-created event', async () => {
    const res = await adminAgent.patch('/api/calendarevents/' + eventId).send({ title: 'jesttest edited by Administrator' });
    expect(res.status).toBe(200);
    expect(res.body.event.title).toBe('jesttest edited by Administrator');
  });

  test('Auth. Personnel cannot edit or delete', async () => {
    expect((await personnelAgent.patch('/api/calendarevents/' + eventId).send({ title: 'x' })).status).toBe(302);
    expect((await personnelAgent.delete('/api/calendarevents/' + eventId)).status).toBe(302);
  });

  test('potential_partner cannot edit or delete', async () => {
    expect((await partnerAgent.patch('/api/calendarevents/' + eventId).send({ title: 'x' })).status).toBe(302);
    expect((await partnerAgent.delete('/api/calendarevents/' + eventId)).status).toBe(302);
  });

  test('Staff can delete an event', async () => {
    const res = await staffAgent.delete('/api/calendarevents/' + eventId);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdEventIds = createdEventIds.filter(id => id !== eventId);
    expect(await db.collection('calendarevents').findOne({ id: eventId })).toBeNull();
  });
});

describe('Staff actor identity is preserved (never impersonates Administrator)', () => {
  test('a Staff-created event notifies its recipient with the real Staff name, not "Administrator"', async () => {
    const recipient = await createTestUser({ role: 'Auth. Personnel' });
    const res = await staffAgent.post('/api/calendarevents').send({
      title: 'jesttest Staff Actor Identity', start: '2026-10-05T09:00', allDay: false,
      location: 'Test Hall', recipients: [recipient.email]
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);

    const notif = await db.collection('notifications').findOne({
      targetEmail: recipient.email, title: 'New event: jesttest Staff Actor Identity'
    });
    expect(notif).toBeTruthy();
    // createTestUser() names accounts `${TEST_TAG} ${role}` (see helpers.js) —
    // it doesn't return `name` on the object it hands back, so re-derive it.
    expect(notif.desc).toContain(`jesttest ${staffUser.role}`);
    expect(notif.desc).not.toContain('Administrator');
  });
});

describe('Staff-created events go through the exact same shared Google Calendar integration as Administrator', () => {
  afterEach(async () => { await db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION).deleteMany({}); });

  test('with no Google connection, a Staff-created event still succeeds with no googleEventId (same as Administrator)', async () => {
    const res = await staffAgent.post('/api/calendarevents').send({
      title: 'jesttest Staff No-Google-Connection', start: '2026-10-06T09:00', allDay: false, recipients: []
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
    expect(res.body.event.googleEventId).toBeUndefined();
  });

  // Proves Staff's create path reaches the exact same
  // googleCalendarService.createGoogleEvent() call as Administrator's —
  // using deliberately-invalid credentials against the real Google network
  // (the same technique google-calendar.test.js uses for Administrator)
  // produces the identical best-effort failure handling for a Staff-created
  // event: the sync is attempted and recorded, never silently skipped or
  // routed through a different/duplicate implementation for Staff.
  test('a Staff-created event with a connected (but invalid) Google account attempts sync exactly like Administrator, and fails gracefully', async () => {
    await db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION).insertOne({
      connectedByEmail: adminUser.email, encryptedRefreshToken: encrypt('jesttest-not-a-real-refresh-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });
    const recipient = await createTestUser({ role: 'Staff' });
    const res = await staffAgent.post('/api/calendarevents').send({
      title: 'jesttest Staff Google Sync Attempt', start: '2026-10-07T09:00', allDay: false,
      recipients: [recipient.email]
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
    // Sync is best-effort and never blocks the CIRL event itself — the event
    // still saves successfully even though the fake credentials fail.
    expect(res.body.event.googleEventId).toBeUndefined();

    const integration = await db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION).findOne({});
    expect(integration.lastSyncOk).toBe(false);
    expect(integration.lastSyncError).toBeTruthy();
  }, 20000);
});

describe('Existing Administrator Calendar functionality still passes under the broadened middleware', () => {
  test('Administrator create/edit/delete round-trip still works end-to-end', async () => {
    const createRes = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Admin Round Trip', start: '2026-10-08T09:00', allDay: false, recipients: []
    });
    expect(createRes.status).toBe(200);
    const id = createRes.body.event.id;
    createdEventIds.push(id);

    const patchRes = await adminAgent.patch('/api/calendarevents/' + id).send({ title: 'jesttest Admin Round Trip (edited)' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.event.title).toBe('jesttest Admin Round Trip (edited)');

    const deleteRes = await adminAgent.delete('/api/calendarevents/' + id);
    expect(deleteRes.status).toBe(200);
    createdEventIds = createdEventIds.filter(eid => eid !== id);
  });

  test('GET /api/calendarevents visibility is unaffected: Administrator still sees every event', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Admin Visibility Check', start: '2026-10-09T09:00', allDay: false, recipients: []
    });
    createdEventIds.push(res.body.event.id);
    const list = await adminAgent.get('/api/calendarevents');
    expect(list.status).toBe(200);
    expect(list.body.some(e => e.id === res.body.event.id)).toBe(true);
  });
});
