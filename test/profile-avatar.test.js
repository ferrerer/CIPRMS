// Profile pictures: every account starts with the default picture; an upload from Settings is stored on the account
// and shows in the header of every page (and replaces the previous file on disk).
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
const DEFAULT_AVATAR = '/images/default-avatar.jpg';
const uploadedFiles = [];

beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  for (const url of uploadedFiles) fs.rmSync(path.join(__dirname, '..', url), { force: true });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}
const headerAvatar = html => (html.match(/header-profile-user js-user-avatar" src="([^"]+)"/) || [])[1];

describe('Profile picture', () => {
  test.each([
    ['Administrator', '/admin/settings', '/dashboard'],
    ['Staff', '/staff/settings', '/staff/dashboard'],
    ['Auth. Personnel', '/personnel/settings', '/personnel/monitoring'],
    ['potential_partner', '/partner/settings', '/partner/monitoring']
  ])('%s: starts with the default picture, and an upload shows in the header on every page', async (role, settings, home) => {
    const { agent } = await agentFor(role);
    expect(headerAvatar((await agent.get(settings)).text)).toBe(DEFAULT_AVATAR);

    const res = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    uploadedFiles.push(res.body.avatarUrl);
    expect(res.body.avatarUrl).toMatch(/^\/uploads\/avatars\/.+\.png$/);

    expect(headerAvatar((await agent.get(home)).text)).toBe(res.body.avatarUrl);
    expect(headerAvatar((await agent.get(settings)).text)).toBe(res.body.avatarUrl);
  });

  test('a new upload replaces the previous file; a file that is not really an image is refused', async () => {
    const { agent } = await agentFor('Staff');
    const first = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' });
    const second = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'b.png', contentType: 'image/png' });
    uploadedFiles.push(first.body.avatarUrl, second.body.avatarUrl);
    expect(second.status).toBe(200);
    await new Promise(r => setTimeout(r, 200)); // the old file is unlinked in the background
    expect(fs.existsSync(path.join(__dirname, '..', first.body.avatarUrl))).toBe(false);

    const fake = await agent.post('/api/profile/avatar').attach('avatar', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
  });

  test('a Partner photo survives saving the Partner profile, and User Management cannot set anyone\'s picture', async () => {
    const { agent: partner, user } = await agentFor('potential_partner');
    const up = await partner.post('/api/partner/avatar').attach('avatar', PNG, { filename: 'p.png', contentType: 'image/png' });
    uploadedFiles.push(up.body.avatarUrl);
    await partner.post('/api/partner/profile').send({ organization: 'jesttest Org', contactName: 'jesttest Partner' });
    expect((await partner.get('/api/partner/profile')).body.avatarUrl).toBe(up.body.avatarUrl);

    const { agent: admin } = await agentFor('Administrator');
    const stored = await getDb().collection('users').findOne({ email: user.email });
    expect((await admin.patch('/api/users/' + stored.id).send({ avatarUrl: 'javascript:alert(1)' })).status).toBe(200);
    expect((await getDb().collection('users').findOne({ email: user.email })).avatarUrl).toBe(up.body.avatarUrl);
    await getDb().collection('profiles').deleteMany({ email: user.email });
  });
});
