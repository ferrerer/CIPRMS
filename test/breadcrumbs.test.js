// The "CIPRMS" breadcrumb at the top of every page takes the person to THEIR home page. Several templates are shared
// between roles (the Administrator's own views also render for CIRL Staff and College Dean), and used to carry a
// hard-coded "/dashboard" — an Administrator-only route, so for anyone else the click only reached their home by
// being bounced through a redirect. Every page of every role now links straight to the role's own home.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

const ROLES = [
  ['Administrator', 'Administrator', '/dashboard',
    ['/dashboard', '/lifecycle', '/notifications', '/documents', '/calendar', '/reports', '/users', '/partnership-requests', '/admin/settings']],
  ['CIRL Staff', 'Staff', '/staff/dashboard',
    ['/staff/dashboard', '/staff/lifecycle', '/staff/notifications', '/staff/documents', '/staff/calendar', '/staff/reports', '/staff/users', '/staff/requests', '/staff/settings']],
  ['College Dean', 'Auth. Personnel', '/personnel/monitoring',
    ['/personnel/monitoring', '/personnel/requests', '/personnel/lifecycle', '/personnel/calendar', '/personnel/settings']],
  ['Partner', 'potential_partner', '/partner/monitoring',
    ['/partner/monitoring', '/partner/requests', '/partner/calendar', '/partner/settings']]
];

describe('the "CIPRMS" breadcrumb goes straight to the signed-in role\'s own home', () => {
  test.each(ROLES)('%s: every page links its breadcrumb to that role\'s own home, and that link opens without a redirect', async (_label, role, home, pages) => {
    const agent = await agentFor(role);
    for (const path of pages) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      const crumb = res.text.match(/<li class="breadcrumb-item"><a href="([^"]*)">CIPRMS<\/a>/);
      expect([path, crumb && crumb[1]]).toEqual([path, home]);
    }
    // the destination is a real page for this role — clicking lands there directly, not via a bounce
    expect((await agent.get(home)).status).toBe(200);
  });

  test('a role never gets a breadcrumb into another role\'s area', async () => {
    const own = { 'Staff': '/staff/dashboard', 'Auth. Personnel': '/personnel/monitoring', 'potential_partner': '/partner/monitoring' };
    for (const [, role, , pages] of ROLES.filter(r => r[1] !== 'Administrator')) {
      const agent = await agentFor(role);
      for (const path of pages) {
        const html = (await agent.get(path)).text;
        // (the Administrator's "/dashboard" must not appear as a breadcrumb target for anyone else)
        expect(html).not.toContain('<li class="breadcrumb-item"><a href="/dashboard">');
        expect(html).toContain(`<li class="breadcrumb-item"><a href="${own[role]}">CIPRMS</a>`);
      }
    }
  });
});
