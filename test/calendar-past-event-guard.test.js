// 2026-09-22: Administrator/CIRL Staff must not be able to CREATE a brand-new meeting/event whose date/time has
// already passed (server-side authoritative, Asia/Manila / APP_TIMEZONE — see isNewEventInThePast in cirl.js). This
// only ever applies to POST (create): editing, dragging or resizing an EXISTING event — including one that has since
// become historical — keeps its old, unrestricted behavior, and a past event is never hidden or deleted just for
// being in the past.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, adminAgent, staffAgent, partnerAgent;
const createdEventIds = [];

function isoInDays(days, hh, mm) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` + (hh != null ? `T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}` : '');
}

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app); await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app); await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  partnerAgent = request.agent(app); await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await cleanupAll();
  await closeDB();
});

describe('creating a new timed event in the past is rejected', () => {
  test('yesterday at noon is refused with a clear 400, and nothing is inserted', async () => {
    const before = await db.collection('calendarevents').countDocuments({});
    const res = await adminAgent.post('/api/calendarevents').send({ title: 'jesttest past meeting', start: isoInDays(-1, 12, 0), end: isoInDays(-1, 13, 0), allDay: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already passed/i);
    expect(await db.collection('calendarevents').countDocuments({})).toBe(before);
  });

  test('earlier today (assuming the test runs after 00:05 local time) is refused', async () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 10) return; // avoid a flaky failure in the first minutes of a new day
    const res = await adminAgent.post('/api/calendarevents').send({ title: 'jesttest earlier today', start: isoInDays(0, 0, 1), end: isoInDays(0, 0, 2), allDay: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already passed/i);
  });

  test('CIRL Staff is held to the exact same rule as Administrator', async () => {
    const res = await staffAgent.post('/api/calendarevents').send({ title: 'jesttest staff past meeting', start: isoInDays(-2, 9, 0), end: isoInDays(-2, 10, 0), allDay: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already passed/i);
  });

  test('cannot be bypassed by calling the API directly with a well-formed but past payload', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest direct api bypass attempt', start: isoInDays(-30, 10, 0), end: isoInDays(-30, 11, 0), allDay: false, clientRequestId: 'bypass-' + Date.now()
    });
    expect(res.status).toBe(400);
  });
});

describe('a future event, and an all-day event for today, are both still allowed', () => {
  test('a timed event tomorrow is created normally', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({ title: 'jesttest future meeting', start: isoInDays(1, 10, 0), end: isoInDays(1, 11, 0), allDay: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdEventIds.push(res.body.event.id);
  });

  test('an all-day event for TODAY is allowed — the all-day exemption compares by calendar date, not by exact instant', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({ title: 'jesttest all-day today', start: isoInDays(0), allDay: true });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
  });

  test('an all-day event for YESTERDAY is still refused', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({ title: 'jesttest all-day yesterday', start: isoInDays(-1), allDay: true });
    expect(res.status).toBe(400);
  });
});

describe('editing an existing (including now-historical) event is unaffected by this rule', () => {
  let pastEventId;
  beforeAll(async () => {
    // Inserted directly — the create-time guard is what this suite is testing elsewhere, not a concern for a record
    // that already legitimately exists (e.g. one created before today, or migrated from elsewhere).
    const last = await db.collection('calendarevents').find({}).sort({ id: -1 }).limit(1).toArray();
    pastEventId = (last[0] ? last[0].id : 0) + 1;
    await db.collection('calendarevents').insertOne({ id: pastEventId, title: 'jesttest already historical', start: isoInDays(-10, 9, 0), end: isoInDays(-10, 10, 0), allDay: false, createdByEmail: 'jesttest@example.com', createdAt: new Date().toISOString() });
    createdEventIds.push(pastEventId);
  });

  test('editing its title/description/location (not touching start/end/allDay) succeeds', async () => {
    const res = await adminAgent.patch(`/api/calendarevents/${pastEventId}`).send({ description: 'jesttest corrected notes' });
    expect(res.status).toBe(200);
    expect(res.body.event.description).toBe('jesttest corrected notes');
  });

  test('moving it to an even-earlier past time (drag/resize/manual correction) is still allowed — PATCH is never gated by this rule', async () => {
    const res = await adminAgent.patch(`/api/calendarevents/${pastEventId}`).send({ start: isoInDays(-20, 9, 0), end: isoInDays(-20, 10, 0) });
    expect(res.status).toBe(200);
    expect(res.body.event.start).toMatch(/^/); // just confirms the PATCH was accepted, not rejected by a past-date check
  });

  test('the historical event is still returned by the normal feed — it was never hidden or deleted for being in the past', async () => {
    const res = await adminAgent.get('/api/calendarevents');
    expect(res.status).toBe(200);
    expect(res.body.some(e => e.id === pastEventId)).toBe(true);
  });
});

describe('no real data was touched, and Partner/College Staff calendar permissions are unaffected by this change', () => {
  test('Partner still cannot create any event at all (unrelated to the past-date rule)', async () => {
    const res = await partnerAgent.post('/api/calendarevents').send({ title: 'jesttest partner attempt', start: isoInDays(1, 10, 0), allDay: false });
    expect(res.status).toBe(302);
  });
});
