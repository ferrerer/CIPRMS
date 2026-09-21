// AJAX + live-update wiring on the pages (the behaviour itself is covered by test/realtime.test.js and the live browser runs):
//   * every signed-in page loads the shared client exactly once, knowing who the user is;
//   * the signed-out pages do not;
//   * the pages that show request / partnership / notification / calendar data subscribe to live updates;
//   * the reload-the-whole-page patterns that were replaced stay gone, and the calls go through the shared helper.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let agents = {}, users = {};

beforeAll(async () => {
  await connectDB();
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partner', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app); await loginAs(agents[key], users[key]);
  }
});
afterAll(async () => { await cleanupAll(); await closeDB(); });

const PAGES = {
  admin: ['/dashboard', '/partnership-requests', '/lifecycle', '/calendar', '/notifications'],
  staff: ['/staff/dashboard', '/staff/requests', '/staff/lifecycle', '/staff/calendar', '/staff/notifications'],
  college: ['/personnel/monitoring', '/personnel/requests', '/personnel/calendar'],
  partner: ['/partner/monitoring', '/partner/requests', '/partner/calendar']
};

describe('the shared client is on every signed-in page, once', () => {
  for (const [key, urls] of Object.entries(PAGES)) {
    test.each(urls)(`${key}: %s`, async (url) => {
      const res = await agents[key].get(url);
      expect(res.status).toBe(200);
      expect(res.text.match(/<script src="\/js\/ciprms-rt\.js/g)).toHaveLength(1);
      const who = res.text.match(/window\.CIPRMS_USER = (\{[^}]*\})/);
      expect(who).toBeTruthy();
      expect(JSON.parse(who[1].replace(/(\w+):/g, '"$1":'))).toEqual({ id: users[key].id, role: users[key].role });
      const firstUse = res.text.search(/CIPRMS.(api|busy|live|on|toast)/);
      if (firstUse >= 0) expect(res.text.indexOf('ciprms-rt.js')).toBeLessThan(firstUse);   // helpers exist before any page script uses them
    });
  }

  test('the sign-in page does not load it (no session, no stream)', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toContain('ciprms-rt.js');
  });

  test('the script is served, is valid, and does not need a build step', async () => {
    const res = await request(app).get('/js/ciprms-rt.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(() => new Function(res.text)).not.toThrow();
    expect(res.text).toContain('window.CIPRMS.__ready');       // guards against initialising twice on one page
    expect(res.text).toContain("'pagehide'");                   // closes its connection when the page goes away
  });
});

describe('pages subscribe to live updates and use the shared helper', () => {
  test('Requests (Administrator + CIRL Staff): live refresh, server-confirmed status changes, Request More Information', () => {
    const src = read('views', 'administrator', 'partnership_requests.ejs');
    expect(src).toContain("CIPRMS.live(['request.updated', 'request.statusChanged', 'documentRequest.updated', 'documentRequest.statusChanged'], refreshLive");
    expect(src).toContain('async function applyPRStatus');
    expect(src).toContain('function requestMoreInfo');
    expect(src).toContain("{ status: 'Under Review', notes: text }");
    // the old code set r.status locally whether or not the server had accepted it
    expect(src).not.toMatch(/r\.status = decision;/);
    expect(src).not.toMatch(/await fetch\('\/api\/requests\/' \+ r\.id/);
    expect(src).toContain('drStatusInFlight');
  });

  test('Partner Monitoring / College Staff Monitoring: counters, rows and the renewal card re-read on live updates; no page reload', () => {
    const partner = read('views', 'potential_partner', 'partner_monitoring.ejs');
    const college = read('views', 'auth. personnel', 'personnel_monitoring.ejs');
    expect(partner).toContain("CIPRMS.live(['request.updated', 'request.statusChanged', 'documentRequest.updated', 'documentRequest.statusChanged', 'partnership.updated', 'partnership.statusChanged']");
    expect(college).toContain("CIPRMS.live(['documentRequest.updated', 'documentRequest.statusChanged'");
    expect(partner).not.toContain('location.reload');
    expect(college).not.toContain('location.reload');
    expect(partner).toContain('function loadRenewalStatus');
    for (const src of [partner, college]) {
      expect(src).not.toMatch(/new bootstrap\.Modal\(document\.getElementById\('(pr|dr)-draft-modal'\)\)/);   // one instance per modal
      expect(src).toContain('bootstrap.Modal.getOrCreateInstance');
    }
  });

  test('Partner Requests: a submit is one request at a time and a draft is only submitted once its edit was saved', () => {
    const src = read('views', 'potential_partner', 'partner_requests.ejs');
    expect(src).toContain('onclick="submitRequest(this)"');
    expect(src).toContain('return CIPRMS.busy(btn, function () {');
    expect(src).toContain("saved.ok ? CIPRMS.api('/api/requests/' + id + '/submit'");
  });

  test('Monitoring (registry): KPI cards re-read on partnership updates; add / edit / renew / delete are single-flight', () => {
    const src = read('assets', 'js', 'pages', 'registry-gridjs.init.js');
    expect(src).toContain("CIPRMS.live(['partnership.updated', 'partnership.statusChanged']");
    expect(src).toContain('function loadPartnerships(live)');
    for (const sel of ['#delete-record', '#edit-btn', '#renewPartnershipModal .btn-success', '#addPartnershipModal .btn-primary.ms-auto']) expect(src).toContain(`runOnce('${sel}'`);
    // failures are no longer silent
    expect(src).toContain("res.error||'Error saving partnership. Please try again.'");
  });

  test('Notifications: the bell and the page update live, and rendered text is escaped', () => {
    const header = read('views', 'partials', 'header.ejs');
    const page = read('views', 'administrator', 'notifications.ejs');
    for (const t of ['notification.created', 'notification.read', 'notification.deleted', 'rt.resync']) expect(header).toContain(`'${t}'`);
    expect(header).toContain('function paintNotifBadge');
    expect(header).toContain("badge.style.display = count > 0 ? '' : 'none'");
    expect(header).toContain('keepalive: true');
    expect(page).toContain("CIPRMS.live(['notification.created', 'notification.read', 'notification.deleted']");
    expect(page).toContain('${esc(n.title)}');
    expect(page).toContain('${esc(n.desc)}');
    expect(page).not.toMatch(/\$\{n\.(title|desc|tag)\}/);
  });

  test('Calendars: live refresh (waiting for this page\'s own writes), writes through the shared helper', () => {
    const layout = read('views', 'partials', 'calendar_layout.ejs');
    const admin = read('views', 'administrator', 'calendar.ejs');
    const partner = read('views', 'potential_partner', 'partner_calendar.ejs');
    expect(layout).toContain("CIPRMS.live(['calendar.updated', 'calendar.deleted']");
    expect(admin).toContain('calendarLive(cal, function(){ return calWrites; })');
    expect(partner).toContain('calendarLive(cal');
    expect(admin).toContain('function calApi(url, method, payload)');
    expect(admin).not.toMatch(/fetch\('\/api\/calendarevents',\{method:'POST'/);
    expect(admin).toContain('function reconcileOpenEvent');
  });
});

describe('the shared client', () => {
  const client = read('public', 'js', 'ciprms-rt.js');
  test('only a redirect to the sign-in page counts as an expired session — an HTML error page does not', () => {
    expect(client).toContain("new URL(res.url, window.location.href).pathname === '/'");
    expect(client).not.toMatch(/res\.redirected \|\| \/html\/i/);
  });
  test('failed refreshes are retried and a regained connection resyncs', () => {
    expect(client).toContain('var RETRY_AFTER = [3000, 10000, 30000]');
    expect(client).toContain("window.addEventListener('online'");
  });
  test('one connection per browser: a Web Lock elects the tab that owns it; the others follow over a BroadcastChannel', () => {
    expect(client).toContain("navigator.locks.request('ciprms-rt-' + USER.id");
    expect(client).toContain("new BroadcastChannel('ciprms-rt-' + USER.id)");
    expect(client).toContain("'/api/realtime/stream?uid='");
  });
});
