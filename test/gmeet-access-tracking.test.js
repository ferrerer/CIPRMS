// Google Meet access tracking investigation (2026-10-08).
//
// Finding: the ONLY join event CIPRMS can ever observe is a click on its own in-app Join button
// (POST /api/calendarevents/:id/join) — the raw Meet link is never sent to the browser any other way
// (calendarEventView() always `delete`s googleMeetLink; see cirl.js). A participant who opens the meeting
// from the Google Calendar invitation e-mail's own "Join with Google Meet" button, or from the raw
// meet.google.com link directly, never reaches this server and cannot be recorded here. Real Google Meet
// participation data (who was actually in the call) would require the separate Google Meet REST API —
// a different OAuth scope than the calendar.events scope this integration requests (see
// services/googleCalendarService.js), and a feature only available on certain Google Workspace editions —
// so it is NOT implemented here; claiming it would be dishonest. See the chat response for the full writeup.
//
// This suite locks in the one thing that WAS fixed on top of the already-solid, duplicate-proof Join
// endpoint: a repeat click/reopen by the same person is recorded as a distinct "last access" without ever
// moving their original join time or creating a second attendance entry, and every attendance entry now
// carries a `source` field recording how it was observed (today, always the in-app button).
const mockGoogle = { calls: [] };
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), revokeCredentials: jest.fn(), generateAuthUrl: jest.fn() })) },
    calendar: jest.fn(() => ({
      events: {
        insert: jest.fn(async (args) => { mockGoogle.calls.push({ op: 'insert', args }); return { data: { id: args.requestBody.id || 'mock-id', organizer: { email: 'organizer@example.org', self: true }, htmlLink: 'https://calendar.google.com/mock' } }; }),
        patch: jest.fn(async (args) => ({ data: { id: args.eventId, organizer: { email: 'organizer@example.org' } } })),
        get: jest.fn(async (args) => ({ data: { id: args.eventId } })),
        delete: jest.fn(async () => ({}))
      }
    }))
  }
}));

const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');
const { encrypt } = require('../services/tokenCrypto');

let db;
const agents = {};
const users = {};
const createdEventIds = [];
const integration = () => db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION);

function manilaWall(ms) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const HOUR = 3600 * 1000;
const title = (label) => `${TEST_TAG} GMeetAccess ${label}`;

async function createEvent(agent, body) {
  const res = await agent.post('/api/calendarevents').send({ allDay: false, className: 'bg-primary-subtle', ...body });
  if (res.body && res.body.event) createdEventIds.push(res.body.event.id);
  return res;
}

// Same technique as test/calendar-invitations.test.js: create through the real route with a future time
// (the route refuses a past one), then rewrite the stored start/end to put the meeting in progress right now.
async function seedInProgressEvent(agent, body) {
  const res = await createEvent(agent, { ...body, start: manilaWall(Date.now() + 48 * HOUR) });
  const ev = res.body.event;
  const start = new Date(Date.now() - 5 * 60 * 1000), end = new Date(Date.now() + 55 * 60 * 1000);
  await db.collection('calendarevents').updateOne({ id: ev.id }, { $set: { start: start.toISOString(), end: end.toISOString() } });
  return ev;
}

beforeAll(async () => {
  db = await connectDB();
  await integration().deleteMany({});
  await integration().insertOne({ connectedByEmail: 'jesttest-admin@example.com', encryptedRefreshToken: encrypt('jesttest-fake-refresh-token'), calendarId: 'primary', connectedAt: new Date().toISOString() });
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['collegeA', 'Auth. Personnel', 'CCS']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await integration().deleteMany({});
  await cleanupAll();
  await closeDB();
});

describe('Join endpoint records a source and a separate last-access time', () => {
  test('the first join records joinedAt, lastAccessAt (equal to joinedAt) and source "cirl-button"', async () => {
    const ev = await seedInProgressEvent(agents.admin, { title: title('First Join'), recipients: [users.collegeA.email] });
    const res = await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const doc = await db.collection('calendarevents').findOne({ id: ev.id });
    const record = doc.attendance.find(a => a.email === users.collegeA.email);
    expect(record.source).toBe('cirl-button');
    expect(record.lastAccessAt.getTime()).toBe(record.joinedAt.getTime());
    expect(res.body.myInvite.lastAccessAt).toBe(record.joinedAt.toISOString());
  });

  test('a second click (reopening the meeting) advances lastAccessAt but leaves joinedAt and the attendance count untouched', async () => {
    const ev = await seedInProgressEvent(agents.admin, { title: title('Reopen'), recipients: [users.collegeA.email] });
    const first = await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();
    const firstJoinedAt = first.body.myInvite.joinedAt;
    const firstLastAccess = first.body.myInvite.lastAccessAt;

    await new Promise(r => setTimeout(r, 30));
    const second = await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();
    expect(second.status).toBe(200);
    expect(second.body.alreadyJoined).toBe(true);
    expect(second.body.myInvite.joinedAt).toBe(firstJoinedAt); // original join time never moves
    expect(Date.parse(second.body.myInvite.lastAccessAt)).toBeGreaterThan(Date.parse(firstLastAccess)); // but last access does

    const doc = await db.collection('calendarevents').findOne({ id: ev.id });
    expect(doc.attendance.filter(a => a.email === users.collegeA.email)).toHaveLength(1); // still exactly one entry
  });

  test('many simultaneous re-clicks still leave exactly one attendance entry with the original join time', async () => {
    const ev = await seedInProgressEvent(agents.admin, { title: title('Concurrent Reopen'), recipients: [users.collegeA.email] });
    await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();
    const before = (await db.collection('calendarevents').findOne({ id: ev.id })).attendance.find(a => a.email === users.collegeA.email).joinedAt.getTime();

    await Promise.all(Array.from({ length: 5 }, () => agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send()));

    const doc = await db.collection('calendarevents').findOne({ id: ev.id });
    const records = doc.attendance.filter(a => a.email === users.collegeA.email);
    expect(records).toHaveLength(1);
    expect(records[0].joinedAt.getTime()).toBe(before);
  });
});

describe('Administrator attendance view exposes the new fields without changing the existing ones', () => {
  test('a joined participant\'s source and lastAccessDisplay are included; lastAccessDisplay is null until a reopen actually happens', async () => {
    const ev = await seedInProgressEvent(agents.admin, { title: title('Attendance View'), recipients: [users.collegeA.email] });
    await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();

    const res = await agents.admin.get(`/api/calendarevents/${ev.id}/attendance`);
    expect(res.status).toBe(200);
    const row = res.body.participants.find(p => p.email === users.collegeA.email);
    expect(row.status).toBe('Joined');
    expect(row.source).toBe('cirl-button');
    expect(row.lastAccessDisplay).toBeNull(); // only one access so far — nothing new to show yet

    await new Promise(r => setTimeout(r, 30));
    await agents.collegeA.post(`/api/calendarevents/${ev.id}/join`).send();
    const res2 = await agents.admin.get(`/api/calendarevents/${ev.id}/attendance`);
    const row2 = res2.body.participants.find(p => p.email === users.collegeA.email);
    expect(row2.lastAccessDisplay).not.toBeNull(); // now there is a second access to report
  });

  test('a never-joined invitee still reports status "Not Joined" with source null (existing behavior preserved)', async () => {
    const ev = await seedInProgressEvent(agents.admin, { title: title('Never Joined'), recipients: [users.collegeA.email] });
    const res = await agents.admin.get(`/api/calendarevents/${ev.id}/attendance`);
    const row = res.body.participants.find(p => p.email === users.collegeA.email);
    expect(row.status).toBe('Not Joined');
    expect(row.source).toBeNull();
    expect(row.joinedAt).toBeNull();
  });
});

describe('The attendance modal is honest about what it can and cannot see', () => {
  test('explains that only its own Join button is tracked, not a direct Google Meet / Calendar-invite join', () => {
    const fs = require('fs');
    const path = require('path');
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'calendar.ejs'), 'utf8');
    expect(view).toMatch(/CIPRMS can only see joins through that button/);
    expect(view).not.toMatch(/overlaps the dates/i); // sanity: didn't accidentally paste in the Reports help-text fix
    expect(view).toContain("joined via CIPRMS.");
  });
});
