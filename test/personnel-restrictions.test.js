// College Dean (backend role "Auth. Personnel") has a deliberately
// reduced UI: Monitoring, Requests (Document Requests only), Calendar and
// Settings/Profile, with the header Notifications bell and user menu but NO
// Search bar. Dashboard, Document Library, the Notifications PAGE and
// Partnership Requests are closed. These tests pin that down AND pin down
// that no other role inherited any of it.
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

describe('College Dean (Auth. Personnel) — closed pages bounce to Monitoring', () => {
  let agent;
  beforeAll(async () => { agent = await agentFor('Auth. Personnel'); });

  test.each([
    ['Dashboard', '/personnel/dashboard'],
    ['Document Library', '/personnel/documents'],
    ['Notifications page (the header bell stays)', '/personnel/notifications']
  ])('%s (%s) redirects to /personnel/monitoring', async (_label, path) => {
    const res = await agent.get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/personnel/monitoring');
  });

  test('Administrator-only pages (Dashboard, Partnership Requests) still bounce away from this role', async () => {
    for (const path of ['/dashboard', '/partnership-requests', '/lifecycle', '/documents', '/notifications']) {
      const res = await agent.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/personnel/monitoring');
    }
  });

  test('the pages this role keeps still render (Monitoring, Requests, Calendar, Settings/Profile)', async () => {
    for (const path of ['/personnel/monitoring', '/personnel/requests', '/personnel/calendar', '/personnel/settings']) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
    }
  });

  test('Settings page is the real Profile/Settings page (personal info + password tabs) and its breadcrumb no longer points at the closed Dashboard', async () => {
    const html = (await agent.get('/personnel/settings')).text;
    expect(html).toContain('id="tab-personal"');
    expect(html).toContain('id="tab-password"');
    expect(html).toContain('/api/personnel/profile');
    expect(html).not.toContain('href="/personnel/dashboard"');
  });

  test('every kept page has the standard header — Notifications bell + user menu, but NO Search bar', async () => {
    for (const path of ['/personnel/monitoring', '/personnel/requests', '/personnel/calendar', '/personnel/settings']) {
      const html = (await agent.get(path)).text;
      // no search (desktop or mobile)
      expect(html).not.toContain('id="search-options"');
      expect(html).not.toContain('page-header-search-dropdown');
      // header bell is present and wired to the shared notification feed
      expect(html).toContain('id="notificationDropdown"');
      expect(html).toContain('page-header-notifications-dropdown');
      expect(html).toContain('id="notif-badge"');
      expect(html).toContain('/api/notifications/unread-count');
      expect(html).toContain('/api/notifications/mine');
      // user menu (Profile / Settings / Logout) — and fullscreen + dark mode
      expect(html).toContain('page-header-user-dropdown');
      expect(html).toContain('data-toggle="fullscreen"');
      expect(html).toContain('light-dark-mode');
      // the header's own Logout-only fallback is gone (the standard menu has Logout)
      expect(html).not.toContain('dept-logout-btn');
      // Velzon's global app.js dereferences #removeNotificationModal with no null
      // check. Exactly one must exist (the real modal from the standard header);
      // a duplicate id or its absence would break Velzon's init.
      expect(html.split('id="removeNotificationModal"').length - 1).toBe(1);
      expect(html).toContain('id="delete-notification"');
    }
  });

  test('the Notifications PAGE stays closed — no header link, "View All" button or menu item leads to it', async () => {
    for (const path of ['/personnel/monitoring', '/personnel/settings']) {
      const html = (await agent.get(path)).text;
      expect(html).not.toContain('/personnel/notifications');
      expect(html).not.toMatch(/class="[^"]*view-all[^"]*"/);
      expect(html).not.toMatch(/class="align-middle">Notifications</);
    }
  });

  test('user menu offers Profile, Settings and Logout (Profile/Settings both open the Settings page)', async () => {
    const html = (await agent.get('/personnel/monitoring')).text;
    const menu = html.slice(html.indexOf('page-header-user-dropdown'), html.indexOf('</header>'));
    expect(menu).toMatch(/href="\/personnel\/settings"[^>]*>[\s\S]*?Profile/);
    expect(menu).toMatch(/href="\/personnel\/settings"[^>]*>[\s\S]*?Settings/);
    expect(menu).toContain('Logout');
  });

  test('sidebar shows Monitoring, Requests, Calendar, Settings and Logout, plus the "College Dean" role label', async () => {
    const html = (await agent.get('/personnel/monitoring')).text;
    const navHrefs = [...html.matchAll(/<a class="nav-link menu-link[^"]*"\s+href="([^"]+)"/g)].map(m => m[1]);
    expect(navHrefs).toEqual(['/personnel/monitoring', '/personnel/requests', '/personnel/calendar', '/personnel/settings', '#']); // '#' = Logout
    expect(html).toContain('College Dean');
    for (const gone of ['/personnel/dashboard', '/personnel/documents', '/personnel/notifications']) {
      expect(html).not.toContain('href="' + gone + '"');
    }
  });

  test('Requests page offers Document Requests only — the Partnership Request form is gone', async () => {
    const html = (await agent.get('/personnel/requests')).text;
    expect(html).toContain('id="docRequestForm"');
    expect(html).not.toContain('id="panel-pr"');
    expect(html).not.toContain('New Partnership Request');
    expect(html).not.toContain('pr-f-inst');
  });

  test('Monitoring drops "My Partnership Requests" but keeps Total Document Requests, My Document Requests and Renewal Status', async () => {
    const html = (await agent.get('/personnel/monitoring')).text;
    expect(html).not.toContain('My Partnership Requests');
    expect(html).not.toContain('id="pr-monitor-body"');
    expect(html).toContain('Total Document Requests');
    expect(html).toContain('My Document Requests');
    expect(html).toContain('Renewal Status');
  });

  test('the shared APIs the closed pages used are NOT removed (other roles depend on them)', async () => {
    expect((await agent.get('/api/notifications/mine')).status).toBe(200);
    expect((await agent.get('/api/requests/mine')).status).toBe(200);
    expect((await agent.get('/api/document-requests/mine')).status).toBe(200);
  });
});

describe('College Dean restrictions are NOT inherited by other roles', () => {
  test('Administrator keeps the full header (search, notifications, user menu) and its own pages', async () => {
    const agent = await agentFor('Administrator');
    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    for (const marker of ['id="search-options"', 'notificationDropdown', 'page-header-user-dropdown']) expect(dash.text).toContain(marker);
    expect(dash.text).not.toContain('dept-logout-btn');
    expect((await agent.get('/notifications')).status).toBe(200);
    expect((await agent.get('/partnership-requests')).status).toBe(200);
  });

  test('Staff keeps the full header and its own Notifications / Settings / Document Library pages', async () => {
    const agent = await agentFor('Staff');
    const dash = await agent.get('/staff/dashboard');
    expect(dash.status).toBe(200);
    for (const marker of ['id="search-options"', 'notificationDropdown', 'page-header-user-dropdown']) expect(dash.text).toContain(marker);
    expect(dash.text).not.toContain('dept-logout-btn');
    for (const path of ['/staff/notifications', '/staff/settings', '/staff/documents', '/staff/requests', '/staff/lifecycle', '/staff/calendar']) {
      expect((await agent.get(path)).status).toBe(200);
    }
  });

  test('Potential Partner keeps My Partnership Requests on Monitoring (College Dean\' Monitoring change is not inherited) and its Requests / Calendar / Settings pages', async () => {
    const agent = await agentFor('potential_partner');
    const mon = await agent.get('/partner/monitoring');
    expect(mon.status).toBe(200);
    for (const marker of ['notificationDropdown', 'page-header-user-dropdown']) expect(mon.text).toContain(marker);
    expect(mon.text).not.toContain('dept-logout-btn');
    // Partner keeps "My Partnership Requests" (College Dean's removal of it is not inherited). Its own
    // "My Document Requests" section was removed separately — see partner-requests-cleanup.test.js.
    expect(mon.text).toContain('My Partnership Requests');
    expect(mon.text).not.toContain('My Document Requests');
    for (const path of ['/partner/settings', '/partner/requests', '/partner/calendar']) {
      expect((await agent.get(path)).status).toBe(200);
    }
    // (Partner's own removed pages — Dashboard, Document Library, Notifications — are covered in partner-ui-cleanup.test.js.)
  });
});

describe('College Dean has NO Dashboard — /personnel/dashboard is a safe redirect, never a 500', () => {
  test('Auth. Personnel is redirected to Monitoring, which then renders', async () => {
    const agent = await agentFor('Auth. Personnel');
    const res = await agent.get('/personnel/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/personnel/monitoring');
    expect((await agent.get(res.headers.location)).status).toBe(200);
  });

  test('nobody who requests the URL gets a 500 — each role is sent to its own home, a logged-out visitor to login', async () => {
    const cases = [['Administrator', '/dashboard'], ['Staff', '/staff/dashboard'], ['potential_partner', '/partner/monitoring']];
    for (const [role, home] of cases) {
      const agent = await agentFor(role);
      const res = await agent.get('/personnel/dashboard');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(home);
    }
    const anon = await request(app).get('/personnel/dashboard');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/');
  });

  test('no College Dean page links to any Dashboard (sidebar, header logo, breadcrumbs)', async () => {
    const agent = await agentFor('Auth. Personnel');
    for (const path of ['/personnel/monitoring', '/personnel/requests', '/personnel/settings', '/personnel/calendar']) {
      const html = (await agent.get(path)).text;
      expect(html).not.toContain('href="/personnel/dashboard"');
      expect(html).not.toContain('href="/dashboard"');
      expect(html).not.toMatch(/ri-dashboard-2-line/); // the sidebar's Dashboard icon
    }
    // the shared Calendar page's "CIPRMS" breadcrumb now points at Monitoring for this role
    const cal = (await agent.get('/personnel/calendar')).text;
    expect(cal).toContain('breadcrumb-item"><a href="/personnel/monitoring">CIPRMS</a>');
  });

  test('the shared Calendar page keeps its Dashboard breadcrumb for Administrator (unchanged)', async () => {
    const agent = await agentFor('Administrator');
    const cal = (await agent.get('/calendar')).text;
    expect(cal).toContain('breadcrumb-item"><a href="/dashboard">CIPRMS</a>');
  });
});

describe('College Dean can hide the sidebar to give the page the full width', () => {
  test('every College Dean page carries the hide / show sidebar control, wired to Velzon\'s "hidden" sidebar mode', async () => {
    const agent = await agentFor('Auth. Personnel');
    for (const path of ['/personnel/monitoring', '/personnel/requests', '/personnel/settings', '/personnel/calendar', '/personnel/lifecycle']) {
      const html = (await agent.get(path)).text;
      expect(html).toContain('id="topnav-hamburger-icon"');
      expect(html).toContain("root.setAttribute('data-sidebar-visibility', 'hidden')");
      expect(html).toContain('e.stopImmediatePropagation()');                          // takes over the ☰ button on desktop widths
      expect(html).toContain('DESKTOP_MIN = 768');                                    // phones keep Velzon's own slide-in menu
      expect(html).toContain('sidebarHidden');                                        // remembered per user
      expect(html).toContain('html[data-sidebar-visibility="hidden"] .horizontal-logo .logo-dark'); // wordmark stays readable
    }
  });

  test('the other roles are untouched: Administrator, CIRL Staff and Partner keep the standard ☰ behaviour', async () => {
    for (const [role, path] of [['Administrator', '/dashboard'], ['Staff', '/staff/dashboard'], ['potential_partner', '/partner/monitoring']]) {
      const agent = await agentFor(role);
      const html = (await agent.get(path)).text;
      expect(html).toContain('id="topnav-hamburger-icon"');
      expect(html).not.toContain('data-sidebar-visibility');
      expect(html).not.toContain('sidebarHidden');
    }
  });
});
