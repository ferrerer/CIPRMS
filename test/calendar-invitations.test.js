// Calendar meeting invitations + join control (2026-09-20), exercised through
// the real routes with a mocked Google Calendar client:
//   * what CIPRMS asks Google to do (attendees, sendUpdates, times, stable id),
//   * one event per create / edit / drag (no duplicates, even for repeated or
//     simultaneous requests),
//   * invalid / duplicate e-mail handling reported to the Administrator,
//   * the server-enforced Join rule (not before the start, once only, invited
//     users only, server-side timestamp), and
//   * the Administrator attendance view.
// googleapis is mocked, so NO real Google call is made and no e-mail is sent;
// see the final report for what that does and does not prove.
const mockGoogle = { calls: [], failInsert: null, failPatch: null };
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(), on: jest.fn(), revokeCredentials: jest.fn(), generateAuthUrl: jest.fn()
      }))
    },
    calendar: jest.fn(() => ({
      events: {
        insert: jest.fn(async (args) => {
          mockGoogle.calls.push({ op: 'insert', args: JSON.parse(JSON.stringify(args)) });
          if (mockGoogle.failInsert) throw mockGoogle.failInsert;
          return { data: { id: args.requestBody.id || 'mock-google-id', organizer: { email: 'organizer@example.org', self: true }, htmlLink: 'https://calendar.google.com/mock' } };
        }),
        patch: jest.fn(async (args) => {
          mockGoogle.calls.push({ op: 'patch', args: JSON.parse(JSON.stringify(args)) });
          if (mockGoogle.failPatch) throw mockGoogle.failPatch;
          return { data: { id: args.eventId, organizer: { email: 'organizer@example.org' } } };
        }),
        delete: jest.fn(async (args) => { mockGoogle.calls.push({ op: 'delete', args: JSON.parse(JSON.stringify(args)) }); return {}; })
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
const callsOf = (op) => mockGoogle.calls.filter(c => c.op === op);
const resetGoogle = () => { mockGoogle.calls.length = 0; mockGoogle.failInsert = null; mockGoogle.failPatch = null; };

// "YYYY-MM-DDTHH:mm" wall-clock in Asia/Manila for an instant — the format the calendar UI saves.
function manilaWall(ms) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const HOUR = 3600 * 1000;
const title = (label) => `${TEST_TAG} ${label}`;

async function createEvent(agent, body) {
  const res = await agent.post('/api/calendarevents').send({ allDay: false, className: 'bg-primary-subtle', ...body });
  if (res.body && res.body.event) createdEventIds.push(res.body.event.id);
  return res;
}

beforeAll(async () => {
  db = await connectDB();
  await integration().deleteMany({});
  await integration().insertOne({
    connectedByEmail: 'jesttest-admin@example.com', encryptedRefreshToken: encrypt('jesttest-fake-refresh-token'),
    calendarId: 'primary', connectedAt: new Date().toISOString()
  });

  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['collegeA', 'Auth. Personnel', 'CCS'], ['collegeB', 'Auth. Personnel', 'CCS'], ['partnerA', 'potential_partner', ''], ['partnerB', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }
  // A College Staff account whose e-mail address Google Calendar would reject (non-ASCII local part).
  const last = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
  users.badEmail = { id: last[0].id + 1, email: `${TEST_TAG}.ñ.${Date.now()}@example.com`, role: 'Auth. Personnel' };
  await db.collection('users').insertOne({ ...users.badEmail, name: `${TEST_TAG} Bad Email`, unit: 'CCS', login: 'Never', status: 'Active', password: 'x', createdAt: TEST_TAG });
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await integration().deleteMany({});
  await cleanupAll();
  await closeDB();
});

beforeEach(resetGoogle);

describe('Google Calendar invitation request', () => {
  test('one event, College Staff + Partner attendees, sendUpdates "all", correct details, stable id, stored ids', async () => {
    const start = '2026-11-10T09:00', end = '2026-11-10T10:30';
    const res = await createEvent(agents.admin, {
      title: title('Partnership Renewal Discussion'), start, end, location: 'Conference Room 2', description: 'Agenda: renewal terms',
      // the same person selected by role AND individually must appear once
      recipients: ['Auth. Personnel', 'potential_partner', users.collegeA.email, users.partnerA.email]
    });
    expect(res.status).toBe(200);

    expect(callsOf('insert')).toHaveLength(1);
    expect(callsOf('patch')).toHaveLength(0);
    const { args } = callsOf('insert')[0];
    expect(args.sendUpdates).toBe('all');
    expect(args.calendarId).toBe('primary');

    const attendees = args.requestBody.attendees.map(a => a.email);
    expect(attendees).toEqual(expect.arrayContaining([users.collegeA.email, users.collegeB.email, users.partnerA.email, users.partnerB.email]));
    expect(new Set(attendees).size).toBe(attendees.length); // no duplicate invitations
    expect(attendees).not.toContain(users.badEmail.email); // invalid address is never sent to Google
    expect(attendees).not.toContain(users.admin.email);

    expect(args.requestBody.summary).toBe(title('Partnership Renewal Discussion'));
    expect(args.requestBody.location).toBe('Conference Room 2');
    expect(args.requestBody.description).toBe('Agenda: renewal terms');
    expect(args.requestBody.start).toEqual({ dateTime: '2026-11-10T01:00:00.000Z', timeZone: 'Asia/Manila' });
    expect(args.requestBody.end).toEqual({ dateTime: '2026-11-10T02:30:00.000Z', timeZone: 'Asia/Manila' });

    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(args.requestBody.id).toMatch(/^ciprms[0-9a-f]{24}$/);
    expect(doc.googleEventKey).toBe(args.requestBody.id);
    expect(doc.googleEventId).toBe(args.requestBody.id);
    expect(doc.googleOrganizerEmail).toBe('organizer@example.org');
    expect(doc.googleSyncStatus).toBe('sent');
    expect(doc.start).toBe(start); // CIPRMS keeps the wall-clock value the UI saved
    expect(res.body.invitations).toMatchObject({ google: 'sent', googleAttendees: attendees.length });
  });

  test('a user with an unusable e-mail is reported to the Administrator, stays a CIPRMS participant, and does not block the others', async () => {
    const res = await createEvent(agents.admin, {
      title: title('Invalid Email Case'), start: '2026-11-11T09:00', end: '2026-11-11T10:00',
      recipients: [users.collegeA.email, users.badEmail.email]
    });
    expect(res.status).toBe(200);
    expect(callsOf('insert')[0].args.requestBody.attendees).toEqual([{ email: users.collegeA.email }]);
    expect(res.body.invitations.skipped).toHaveLength(1);
    expect(res.body.invitations.skipped[0]).toMatchObject({ email: users.badEmail.email, name: `${TEST_TAG} Bad Email` });
    expect(res.body.invitations.skipped[0].reason).toMatch(/not valid/i);
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(doc.participantEmails).toEqual(expect.arrayContaining([users.collegeA.email, users.badEmail.email]));
    expect(doc.googleAttendeeEmails).toEqual([users.collegeA.email]);
  });

  test('when nobody invited has a valid address, no Google request is made and the event still saves', async () => {
    const res = await createEvent(agents.admin, { title: title('Only Invalid'), start: '2026-11-11T11:00', recipients: [users.badEmail.email] });
    expect(res.status).toBe(200);
    expect(mockGoogle.calls).toHaveLength(0);
    expect(res.body.invitations.google).toBe('no_valid_attendees');
    expect(res.body.invitations.skipped).toHaveLength(1);
  });

  test('an address that is not a registered user is reported, not invited', async () => {
    const res = await createEvent(agents.admin, { title: title('Unknown Recipient'), start: '2026-11-11T13:00', recipients: [users.partnerA.email, 'someone-else@example.com'] });
    expect(res.status).toBe(200);
    expect(callsOf('insert')[0].args.requestBody.attendees).toEqual([{ email: users.partnerA.email }]);
    expect(res.body.invitations.skipped[0]).toMatchObject({ email: 'someone-else@example.com', reason: 'Not a registered CIPRMS user' });
  });

  test('with Google Calendar not connected the event is still created and the Administrator is told no e-mails went out', async () => {
    await integration().deleteMany({});
    try {
      const res = await createEvent(agents.admin, { title: title('Not Connected'), start: '2026-11-12T09:00', recipients: [users.collegeA.email] });
      expect(res.status).toBe(200);
      expect(mockGoogle.calls).toHaveLength(0);
      expect(res.body.invitations.google).toBe('not_connected');
      expect(res.body.invitations.error).toMatch(/not connected/i);
      expect(res.body.event.googleEventId).toBeUndefined();
    } finally {
      await integration().insertOne({ connectedByEmail: 'jesttest-admin@example.com', encryptedRefreshToken: encrypt('jesttest-fake-refresh-token'), calendarId: 'primary', connectedAt: new Date().toISOString() });
    }
  });

  test('a Google failure never blocks the event; it is reported, and a later edit retries with the SAME event id (self-heals, no second event)', async () => {
    mockGoogle.failInsert = Object.assign(new Error('Invalid attendee email'), { code: 400 });
    const res = await createEvent(agents.admin, { title: title('Google Fails'), start: '2026-11-12T11:00', end: '2026-11-12T12:00', recipients: [users.partnerA.email] });
    expect(res.status).toBe(200);
    expect(res.body.invitations).toMatchObject({ google: 'failed', error: 'Invalid attendee email' });
    const failed = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(failed.googleEventId).toBeUndefined();
    expect(failed.googleSyncStatus).toBe('failed');
    const key = failed.googleEventKey;

    resetGoogle();
    const patch = await agents.admin.patch('/api/calendarevents/' + res.body.event.id).send({ location: 'Hall B' });
    expect(patch.status).toBe(200);
    expect(callsOf('insert')).toHaveLength(1);
    expect(callsOf('insert')[0].args.requestBody.id).toBe(key);
    expect(callsOf('insert')[0].args.requestBody.location).toBe('Hall B');
    const healed = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(healed.googleEventId).toBe(key);
    expect(healed.googleSyncStatus).toBe('sent');
  });

  test('a 409 "identifier already exists" from Google converges on the existing event instead of creating another', async () => {
    mockGoogle.failInsert = Object.assign(new Error('The requested identifier already exists.'), { code: 409 });
    const res = await createEvent(agents.admin, { title: title('Retry Conflict'), start: '2026-11-13T09:00', recipients: [users.collegeA.email] });
    expect(res.status).toBe(200);
    expect(callsOf('insert')).toHaveLength(1);
    expect(callsOf('patch')).toHaveLength(1);
    const patch = callsOf('patch')[0].args;
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(patch.eventId).toBe(doc.googleEventKey);
    expect(patch.sendUpdates).toBe('all');
    expect(patch.requestBody.status).toBe('confirmed');
    expect(res.body.invitations.google).toBe('sent');
  });

  test('bad input is rejected with a clear error and creates nothing', async () => {
    const before = await db.collection('calendarevents').countDocuments();
    const cases = [
      [{ title: '', start: '2026-11-14T09:00' }, /title/i],
      [{ title: title('No Start') }, /start/i],
      [{ title: title('Bad Start'), start: 'soon' }, /start/i],
      [{ title: title('Backwards'), start: '2026-11-14T15:00', end: '2026-11-14T09:00' }, /end time/i]
    ];
    for (const [body, message] of cases) {
      const res = await agents.admin.post('/api/calendarevents').send({ allDay: false, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    }
    expect(await db.collection('calendarevents').countDocuments()).toBe(before);
    expect(mockGoogle.calls).toHaveLength(0);
  });
});

describe('No duplicate events', () => {
  test('the same Save sent twice in a row creates ONE event and ONE Google event', async () => {
    const clientRequestId = 'jesttest-' + Date.now() + '-seq';
    const body = { title: title('Double Click'), start: '2026-11-15T09:00', end: '2026-11-15T10:00', recipients: [users.collegeA.email], clientRequestId };
    const first = await createEvent(agents.admin, body);
    const second = await createEvent(agents.admin, body);
    expect(first.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.event.id).toBe(first.body.event.id);
    expect(await db.collection('calendarevents').countDocuments({ clientRequestId })).toBe(1);
    expect(callsOf('insert')).toHaveLength(1);
  });

  test('four SIMULTANEOUS identical requests still create exactly one event and one Google event', async () => {
    const clientRequestId = 'jesttest-' + Date.now() + '-par';
    const body = { title: title('Race'), start: '2026-11-15T13:00', allDay: false, className: 'bg-primary-subtle', recipients: [users.partnerA.email], clientRequestId };
    const results = await Promise.all([1, 2, 3, 4].map(() => agents.admin.post('/api/calendarevents').send(body)));
    results.forEach(r => { if (r.body && r.body.event) createdEventIds.push(r.body.event.id); });
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(results.map(r => r.body.event.id)).size).toBe(1);
    expect(await db.collection('calendarevents').countDocuments({ clientRequestId })).toBe(1);
    expect(callsOf('insert')).toHaveLength(1);
  });

  test('two DIFFERENT events created at the same instant get different ids (concurrent create cannot collide)', async () => {
    const mk = (n) => agents.admin.post('/api/calendarevents').send({ title: title('Parallel ' + n), start: '2026-11-16T09:00', allDay: false, className: 'bg-primary-subtle', recipients: [] });
    const results = await Promise.all([mk(1), mk(2), mk(3)]);
    results.forEach(r => { if (r.body && r.body.event) createdEventIds.push(r.body.event.id); });
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(results.map(r => r.body.event.id)).size).toBe(3);
  });

  test('dragging (a PATCH of start/end) updates the existing event once: one patch, zero inserts, count unchanged, attendees kept', async () => {
    const created = await createEvent(agents.admin, { title: title('Drag Me'), start: '2026-11-17T09:00', end: '2026-11-17T10:00', recipients: [users.collegeA.email, users.partnerA.email] });
    const googleId = created.body.event.googleEventId;
    const before = await db.collection('calendarevents').countDocuments();
    resetGoogle();

    const res = await agents.admin.patch('/api/calendarevents/' + created.body.event.id).send({ start: '2026-11-19T09:00', end: '2026-11-19T10:00', allDay: false });
    expect(res.status).toBe(200);
    expect(await db.collection('calendarevents').countDocuments()).toBe(before);
    expect(callsOf('insert')).toHaveLength(0);
    expect(callsOf('patch')).toHaveLength(1);
    const patch = callsOf('patch')[0].args;
    expect(patch.eventId).toBe(googleId);
    expect(patch.sendUpdates).toBe('all');
    expect(patch.requestBody.start).toEqual({ dateTime: '2026-11-19T01:00:00.000Z', timeZone: 'Asia/Manila' });
    expect(patch.requestBody.attendees.map(a => a.email).sort()).toEqual([users.collegeA.email, users.partnerA.email].sort());
    expect(res.body.event.googleEventId).toBe(googleId);
  });

  test('editing the title/location/description updates the same Google event (one patch, no insert)', async () => {
    const created = await createEvent(agents.admin, { title: title('Edit Me'), start: '2026-11-18T09:00', end: '2026-11-18T10:00', recipients: [users.partnerA.email] });
    resetGoogle();
    const res = await agents.admin.patch('/api/calendarevents/' + created.body.event.id).send({ title: title('Edited'), location: 'New Room', description: 'New notes' });
    expect(res.status).toBe(200);
    expect(callsOf('insert')).toHaveLength(0);
    expect(callsOf('patch')).toHaveLength(1);
    expect(callsOf('patch')[0].args.requestBody).toMatchObject({ summary: title('Edited'), location: 'New Room', description: 'New notes' });
    expect(callsOf('patch')[0].args.sendUpdates).toBe('all');
  });

  test('a change that does not concern Google (event colour only) sends nothing to Google', async () => {
    const created = await createEvent(agents.admin, { title: title('Colour'), start: '2026-11-18T13:00', recipients: [users.partnerA.email] });
    resetGoogle();
    const res = await agents.admin.patch('/api/calendarevents/' + created.body.event.id).send({ className: 'bg-success-subtle' });
    expect(res.status).toBe(200);
    expect(mockGoogle.calls).toHaveLength(0);
  });

  test('adding attendees to an existing meeting keeps the old ones, notifies only the new one, and patches the same Google event', async () => {
    const created = await createEvent(agents.admin, { title: title('Add People'), start: '2026-11-20T09:00', end: '2026-11-20T10:00', recipients: [users.collegeA.email] });
    resetGoogle();
    const res = await agents.admin.patch('/api/calendarevents/' + created.body.event.id).send({ recipients: [users.collegeA.email, users.partnerA.email] });
    expect(res.status).toBe(200);
    expect(callsOf('insert')).toHaveLength(0);
    expect(callsOf('patch')).toHaveLength(1);
    expect(callsOf('patch')[0].args.requestBody.attendees.map(a => a.email).sort()).toEqual([users.collegeA.email, users.partnerA.email].sort());
    const doc = await db.collection('calendarevents').findOne({ id: created.body.event.id });
    expect(doc.participantEmails.sort()).toEqual([users.collegeA.email, users.partnerA.email].sort());
    expect(doc.recipientEmails.sort()).toEqual([users.collegeA.email, users.partnerA.email].sort());
    expect(await db.collection('notifications').countDocuments({ targetEmail: users.partnerA.email, title: `New event: ${title('Add People')}` })).toBe(1);
    expect(await db.collection('notifications').countDocuments({ targetEmail: users.collegeA.email, title: `New event: ${title('Add People')}` })).toBe(1); // not re-notified
  });

  test('a PATCH for an unknown id is a 404 and a non-numeric id is a 400 (nothing is created)', async () => {
    const before = await db.collection('calendarevents').countDocuments();
    expect((await agents.admin.patch('/api/calendarevents/99999999').send({ title: 'x' })).status).toBe(404);
    expect((await agents.admin.patch('/api/calendarevents/undefined').send({ title: 'x' })).status).toBe(400);
    expect(await db.collection('calendarevents').countDocuments()).toBe(before);
  });

  test('deleting an event deletes its Google event with sendUpdates "all"', async () => {
    const created = await createEvent(agents.admin, { title: title('Delete Me'), start: '2026-11-21T09:00', recipients: [users.partnerA.email] });
    const googleId = created.body.event.googleEventId;
    resetGoogle();
    const res = await agents.admin.delete('/api/calendarevents/' + created.body.event.id);
    expect(res.status).toBe(200);
    expect(callsOf('delete')).toHaveLength(1);
    expect(callsOf('delete')[0].args).toMatchObject({ eventId: googleId, sendUpdates: 'all' });
    expect(await db.collection('calendarevents').findOne({ id: created.body.event.id })).toBeNull();
  });
});

describe('Join control — College Staff and Partner', () => {
  let futureMeeting, startedMeeting, partnerOnly, collegeOnly, renewalWithGuests;

  beforeAll(async () => {
    const now = Date.now();
    futureMeeting = (await createEvent(agents.admin, { title: title('Future Meeting'), start: manilaWall(now + 24 * HOUR), end: manilaWall(now + 25 * HOUR), recipients: [users.collegeA.email, users.partnerA.email] })).body.event;
    startedMeeting = (await createEvent(agents.admin, { title: title('Started Meeting'), start: manilaWall(now - 30 * 60 * 1000), end: manilaWall(now + HOUR), recipients: [users.collegeA.email, users.partnerA.email, users.collegeB.email] })).body.event;
    partnerOnly = (await createEvent(agents.admin, { title: title('Partner Only'), start: manilaWall(now - HOUR), end: manilaWall(now + HOUR), recipients: [users.partnerA.email] })).body.event;
    collegeOnly = (await createEvent(agents.admin, { title: title('College Only'), start: manilaWall(now - HOUR), end: manilaWall(now + HOUR), recipients: [users.collegeA.email] })).body.event;
    renewalWithGuests = (await createEvent(agents.admin, { title: title('Renewal Reminder'), className: 'bg-success-subtle', start: manilaWall(now - HOUR), recipients: [users.collegeA.email] })).body.event;
  });

  const feedEvent = async (agent, id) => (await agent.get('/api/calendarevents')).body.find(e => e.id === id);

  test.each([['collegeA', 'College Staff'], ['partnerA', 'Partner']])('%s (%s): before the start the meeting is visible with "invited" state, Join is not available, and joining is refused with no attendance recorded', async (who) => {
    const ev = await feedEvent(agents[who], futureMeeting.id);
    expect(ev).toBeTruthy();
    expect(ev.title).toBe(title('Future Meeting'));
    expect(ev.myInvite).toMatchObject({ invited: true, joined: false, canJoinNow: false });

    const res = await agents[who].post(`/api/calendarevents/${futureMeeting.id}/join`).send();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEETING_NOT_STARTED');
    expect(res.body.startsAt).toBe(ev.myInvite.startsAt);
    const doc = await db.collection('calendarevents').findOne({ id: futureMeeting.id });
    expect(doc.attendance || []).toHaveLength(0);
  });

  test('a client-supplied timestamp / time / user / role cannot bypass the start check', async () => {
    const res = await agents.collegeA.post(`/api/calendarevents/${futureMeeting.id}/join`)
      .send({ joinedAt: '2000-01-01T00:00:00Z', start: '2000-01-01T00:00', now: Date.now() + 999999999, email: users.partnerA.email, role: 'Administrator', userId: 1 });
    expect(res.status).toBe(403);
    expect((await db.collection('calendarevents').findOne({ id: futureMeeting.id })).attendance || []).toHaveLength(0);
  });

  test.each([['collegeA', 'College Staff'], ['partnerA', 'Partner']])('%s (%s): once the meeting has started Join is available, records the SERVER time and the real identity, and ignores anything the client sends', async (who) => {
    const ev = await feedEvent(agents[who], startedMeeting.id);
    expect(ev.myInvite).toMatchObject({ invited: true, joined: false, canJoinNow: true });

    const before = Date.now();
    const res = await agents[who].post(`/api/calendarevents/${startedMeeting.id}/join`)
      .send({ joinedAt: '2000-01-01T00:00:00.000Z', email: 'someone.else@example.com', role: 'Administrator', name: 'Forged', userId: 1 });
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, alreadyJoined: false });
    expect(res.body.myInvite).toMatchObject({ invited: true, joined: true });

    const doc = await db.collection('calendarevents').findOne({ id: startedMeeting.id });
    const record = doc.attendance.find(a => a.email === users[who].email);
    expect(record).toBeTruthy();
    expect(record.joinedAt.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(record.joinedAt.getTime()).toBeLessThanOrEqual(after + 5);
    expect(record.role).toBe(users[who].role);
    expect(record.userId).toBe(users[who].id);
    expect(record.name).toBe(`${TEST_TAG} ${users[who].role}`);
    expect(doc.attendance.some(a => a.email === 'someone.else@example.com')).toBe(false);
  });

  test('joining again — sequentially or many times at once — never creates a second attendance record', async () => {
    const again = await agents.collegeA.post(`/api/calendarevents/${startedMeeting.id}/join`).send();
    expect(again.status).toBe(200);
    expect(again.body.alreadyJoined).toBe(true);

    // collegeB has not joined yet: fire five simultaneous joins
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => agents.collegeB.post(`/api/calendarevents/${startedMeeting.id}/join`).send()));
    expect(burst.every(r => r.status === 200)).toBe(true);
    expect(burst.filter(r => r.body.alreadyJoined === false)).toHaveLength(1);

    const doc = await db.collection('calendarevents').findOne({ id: startedMeeting.id });
    expect(doc.attendance).toHaveLength(3);
    expect(new Set(doc.attendance.map(a => a.emailKey)).size).toBe(3);
    const firstJoin = doc.attendance.find(a => a.email === users.collegeA.email).joinedAt.getTime();
    expect((await agents.collegeA.post(`/api/calendarevents/${startedMeeting.id}/join`).send()).body.myInvite.joinedAt).toBe(new Date(firstJoin).toISOString()); // the original time is kept
  });

  test('only invited users can join: a Partner cannot join a College-Staff-only meeting and vice versa; an uninvited user is refused', async () => {
    const partnerOnCollege = await agents.partnerA.post(`/api/calendarevents/${collegeOnly.id}/join`).send();
    const collegeOnPartner = await agents.collegeA.post(`/api/calendarevents/${partnerOnly.id}/join`).send();
    const uninvited = await agents.collegeB.post(`/api/calendarevents/${collegeOnly.id}/join`).send();
    for (const res of [partnerOnCollege, collegeOnPartner, uninvited]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not an invited participant/i);
    }
    expect((await db.collection('calendarevents').findOne({ id: collegeOnly.id })).attendance || []).toHaveLength(0);
    expect((await db.collection('calendarevents').findOne({ id: partnerOnly.id })).attendance || []).toHaveLength(0);
  });

  test('a College-Staff-only meeting is not even visible to a Partner (existing visibility rule preserved)', async () => {
    expect(await feedEvent(agents.partnerA, collegeOnly.id)).toBeUndefined();
    expect(await feedEvent(agents.partnerB, startedMeeting.id)).toBeUndefined();
  });

  test('joining requires a session, an existing event, and a Meeting-type event', async () => {
    expect((await request(app).post(`/api/calendarevents/${startedMeeting.id}/join`).send()).status).toBe(302);
    expect((await agents.collegeA.post('/api/calendarevents/99999999/join').send()).status).toBe(404);
    expect((await agents.collegeA.post('/api/calendarevents/abc/join').send()).status).toBe(400);
    const renewal = await agents.collegeA.post(`/api/calendarevents/${renewalWithGuests.id}/join`).send();
    expect(renewal.status).toBe(404); // a Renewal/Deadline marker is not a meeting
    expect((await feedEvent(agents.collegeA, renewalWithGuests.id)).myInvite).toBeNull();
  });

  test('a Partner / College Staff feed never exposes other invitees\' e-mail addresses or the attendance list', async () => {
    for (const who of ['collegeA', 'partnerA']) {
      const ev = await feedEvent(agents[who], startedMeeting.id);
      for (const field of ['recipientEmails', 'googleAttendeeEmails', 'participantEmails', 'attendance', 'inviteSkipped', 'googleEventKey', 'clientRequestId', 'createdByEmail']) {
        expect(ev[field]).toBeUndefined();
      }
      const raw = JSON.stringify(ev);
      expect(raw).not.toContain(users.collegeB.email);
    }
  });

  test('Administrator still gets the full event (invitees, counts) in the feed', async () => {
    // (CIRL Staff manage events too, but — as before this change — the feed only shows Staff the events
    // that are public or name them, so a scoped meeting is checked through the Administrator.)
    const ev = await feedEvent(agents.admin, startedMeeting.id);
    expect(ev.participantEmails).toEqual(expect.arrayContaining([users.collegeA.email, users.partnerA.email]));
    expect(ev.participantCount).toBe(3);
    expect(ev.joinedCount).toBe(3);
    expect(ev.attendance).toBeUndefined();
  });
});

describe('Administrator attendance view', () => {
  test('lists every invited participant with role, e-mail, invitation status, Joined / Not Joined and the server-recorded time', async () => {
    const now = Date.now();
    const created = await createEvent(agents.admin, { title: title('Attendance Roster'), start: manilaWall(now - HOUR), end: manilaWall(now + HOUR), recipients: [users.collegeA.email, users.collegeB.email, users.partnerA.email, users.badEmail.email] });
    await agents.collegeA.post(`/api/calendarevents/${created.body.event.id}/join`).send();
    await agents.partnerA.post(`/api/calendarevents/${created.body.event.id}/join`).send();

    const res = await agents.admin.get(`/api/calendarevents/${created.body.event.id}/attendance`);
    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBe('Asia/Manila');
    expect(res.body.summary).toEqual({ invited: 4, joined: 2 });
    expect(res.body.google).toMatchObject({ status: 'sent', organizerEmail: 'organizer@example.org' });
    expect(res.body.skipped.map(s => s.email)).toEqual([users.badEmail.email]);

    const by = Object.fromEntries(res.body.participants.map(p => [p.email, p]));
    expect(by[users.collegeA.email]).toMatchObject({ name: `${TEST_TAG} Auth. Personnel`, role: 'College Staff', status: 'Joined', invitation: 'Emailed via Google Calendar' });
    expect(by[users.partnerA.email]).toMatchObject({ role: 'Partner', status: 'Joined' });
    expect(by[users.collegeB.email]).toMatchObject({ role: 'College Staff', status: 'Not Joined', joinedAt: null, joinedAtDisplay: null, invitation: 'Emailed via Google Calendar' });
    expect(by[users.badEmail.email]).toMatchObject({ status: 'Not Joined', invitation: 'In-app only' });

    // the displayed time is the stored server time formatted in Manila time
    const record = (await db.collection('calendarevents').findOne({ id: created.body.event.id })).attendance.find(a => a.email === users.collegeA.email);
    const expected = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true }).format(record.joinedAt);
    expect(by[users.collegeA.email].joinedAtDisplay).toBe(expected);
    expect(by[users.collegeA.email].joinedAt).toBe(record.joinedAt.toISOString());
  });

  test('is limited to Administrator / CIRL Staff; College Staff and Partner cannot read who attended', async () => {
    const id = createdEventIds[createdEventIds.length - 1];
    expect((await agents.staff.get(`/api/calendarevents/${id}/attendance`)).status).toBe(200);
    for (const who of ['collegeA', 'partnerA']) expect((await agents[who].get(`/api/calendarevents/${id}/attendance`)).status).toBe(302);
    expect((await request(app).get(`/api/calendarevents/${id}/attendance`)).status).toBe(302);
    expect((await agents.admin.get('/api/calendarevents/99999999/attendance')).status).toBe(404);
  });
});

describe('Calendar pages render for every role that can reach them', () => {
  test('Administrator, CIRL Staff, College Staff and Partner calendar pages load and include the Join control', async () => {
    const pages = [['admin', '/calendar'], ['staff', '/staff/calendar'], ['collegeA', '/personnel/calendar'], ['partnerA', '/partner/calendar']];
    for (const [who, url] of pages) {
      const res = await agents[who].get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('id="mj-block"');
      expect(res.text).toContain('MeetingJoin.render(');
    }
    const adminPage = await agents.admin.get('/calendar');
    expect(adminPage.text).toContain('id="attendance-modal"');
    expect(adminPage.text).toContain('create: false'); // palette drop must not auto-add a phantom event
  });
});
