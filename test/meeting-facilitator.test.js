// Administrator and CIRL Staff facilitate the meetings: they can join any Meeting event even when they were not
// invited. Everyone else still needs an invitation. A facilitator's join is recorded, listed in the attendance as
// "Facilitator (not invited)", and not counted against the invite list.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

const manila = ms => new Date(ms + 8 * 3600e3).toISOString().replace('Z', '+08:00');
const agents = {};
const users = {};
let meetingId, renewalId;

async function agentFor(key, role) {
  users[key] = await createTestUser({ role });
  agents[key] = request.agent(app);
  await loginAs(agents[key], users[key]);
}

async function insertEvent(fields) {
  const db = getDb();
  const last = await db.collection('calendarevents').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last[0]?.id || 0) + 1;
  await db.collection('calendarevents').insertOne({
    id, title: 'jesttest facilitator meeting', allDay: false, location: 'CSPC', description: 'jesttest',
    start: manila(Date.now() - 10 * 60e3), end: manila(Date.now() + 60 * 60e3), createdAt: new Date().toISOString(), ...fields
  });
  return id;
}

beforeAll(async () => {
  await connectDB();
  await agentFor('admin', 'Administrator');
  await agentFor('staff', 'Staff');
  await agentFor('dean', 'Auth. Personnel');
  await agentFor('otherDean', 'Auth. Personnel');
  await agentFor('partner', 'potential_partner');
  const invited = [users.dean.email];
  meetingId = await insertEvent({ className: 'bg-primary-subtle', recipientEmails: invited, participantEmails: invited });
  renewalId = await insertEvent({ className: 'bg-success-subtle', recipientEmails: invited, participantEmails: invited });
});
afterAll(async () => {
  await getDb().collection('calendarevents').deleteMany({ id: { $in: [meetingId, renewalId] } });
  await cleanupAll();
  await closeDB();
});

const myInvite = async (agent, id) => ((await agent.get('/api/calendarevents')).body.find(e => e.id === id) || {}).myInvite;

describe('Meeting facilitators (Administrator / CIRL Staff)', () => {
  test.each(['admin', 'staff'])('%s is not invited but gets the Join control as a facilitator, and can join', async (key) => {
    const invite = await myInvite(agents[key], meetingId);
    expect(invite).toMatchObject({ invited: true, facilitator: true, canJoinNow: true });
    const res = await agents[key].post(`/api/calendarevents/${meetingId}/join`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('the invited College Dean is a normal invitee, not a facilitator', async () => {
    expect(await myInvite(agents.dean, meetingId)).toMatchObject({ invited: true, facilitator: false });
  });

  test('College Dean and Partner still need an invitation', async () => {
    for (const key of ['otherDean', 'partner']) {
      const res = await agents[key].post(`/api/calendarevents/${meetingId}/join`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not an invited participant/i);
    }
  });

  test('facilitator joins are listed in the attendance but not counted against the invite list', async () => {
    const res = await agents.admin.get(`/api/calendarevents/${meetingId}/attendance`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ invited: 1, joined: 0 });
    const facilitators = res.body.participants.filter(p => p.facilitator);
    expect(facilitators.map(p => p.email).sort()).toEqual([users.admin.email, users.staff.email].sort());
    for (const p of facilitators) expect(p).toMatchObject({ invitation: 'Facilitator (not invited)', status: 'Joined' });
    const feed = (await agents.admin.get('/api/calendarevents')).body.find(e => e.id === meetingId);
    expect(feed).toMatchObject({ participantCount: 1, joinedCount: 0 });
  });

  test('only Meeting events have a Join: a Renewal event gives no Join control, even to a facilitator', async () => {
    expect(await myInvite(agents.admin, renewalId)).toBeNull();
    expect((await agents.admin.post(`/api/calendarevents/${renewalId}/join`)).status).toBe(404);
  });
});
