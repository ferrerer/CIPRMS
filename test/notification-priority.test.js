// Very important notifications are flagged (priority: true) for every role; routine ones are not. The header bell and
// the Notifications page draw a red flag from that field, and the bell has no "Alerts" tab any more.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

const CASES = [
  // [title, module, color, expected priority]
  ['jesttest Partnership Expired', 'lifecycle', 'danger', true],
  ['jesttest Partnership Expiring Soon', 'lifecycle', 'warning', true],
  ['jesttest Document Request Rejected', 'request', 'danger', true],
  ['jesttest Event Cancelled', 'calendar', 'danger', true],
  ['jesttest Awaiting for Approval', 'request', 'warning', false],
  ['jesttest New request submitted', 'request', 'primary', false],
  ['jesttest Approved', 'request', 'success', false]
];
const insertedIds = [];

beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  await getDb().collection('notifications').deleteMany({ id: { $in: insertedIds } });
  await cleanupAll();
  await closeDB();
});

async function seedFor(email) {
  const col = getDb().collection('notifications');
  const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
  let id = (last[0]?.id || 0) + 1;
  const docs = CASES.map(([title, module, color]) => ({ id: id++, targetEmail: email, unread: true, time: 'Sep 25, 2026', module, color, icon: 'ri-notification-3-line', tag: 'Test', title, desc: 'jesttest' }));
  await col.insertMany(docs);
  insertedIds.push(...docs.map(d => d.id));
}

describe('Priority (flagged) notifications', () => {
  test.each([
    ['Administrator', '/dashboard'], ['Staff', '/staff/dashboard'],
    ['Auth. Personnel', '/personnel/monitoring'], ['potential_partner', '/partner/monitoring']
  ])('%s: important notifications carry priority, routine ones do not, and the bell has no Alerts tab', async (role, home) => {
    const user = await createTestUser({ role });
    const agent = request.agent(app);
    await loginAs(agent, user);
    await seedFor(user.email);

    const mine = (await agent.get('/api/notifications/mine')).body;
    for (const [title, , , expected] of CASES) {
      expect({ title, priority: mine.find(n => n.title === title).priority }).toEqual({ title, priority: expected });
    }

    const html = (await agent.get(home)).text;
    expect(html).not.toContain('>Alerts<');
    expect(html).not.toContain('id="notif-alerts-list"');
    expect(html).toContain('ri-flag-fill text-danger me-1 notif-flag'); // the flag the bell draws for priority items
  });

  test('the Administrator Notifications page no longer has the Alert Config panel, and draws the flag', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    const html = (await agent.get('/notifications')).text;
    expect(html).not.toContain('alertConfigOffcanvas');
    expect(html).not.toContain('Alert Config');
    expect(html).toContain("n.priority ? '<i class=\"ri-flag-fill text-danger me-1 notif-flag\"");
  });
});
