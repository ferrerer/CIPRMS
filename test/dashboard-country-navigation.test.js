const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'admin_dashboard.ejs'), 'utf8');

describe('Dashboard Top Partner Countries: Flags, Clickable Navigation and Map Highlighting', () => {
  test('template contains dedicated styling for top-country-row, active state, and pulse-country-ring', () => {
    expect(view).toContain('.top-country-row');
    expect(view).toContain('.top-country-row.active-country-row');
    expect(view).toContain('.pulse-country-ring');
    expect(view).toContain('@keyframes mapHighlightPulse');
  });

  test('country row contains flag <img> with flagcdn, error fallback, role="button", and tabindex="0"', () => {
    expect(view).toContain('https://flagcdn.com/w40/');
    expect(view).toContain('country-flag-img');
    expect(view).toContain('country-flag-fallback');
    expect(view).toContain('role="button"');
    expect(view).toContain('tabindex="0"');
    expect(view).toContain('selectCountryForMap(');
  });

  test('map container includes country highlight layer and country alert container', () => {
    expect(view).toContain('const countryHighlightLayer = L.layerGroup().addTo(map);');
    expect(view).toContain('id="map-country-alert"');
    expect(view).toContain('<div id="partnership-map" style="height:360px;">');
  });

  test('selectCountryForMap and isCountryMatch functions are defined and handle marker focus and highlights', () => {
    expect(view).toContain('function isCountryMatch(');
    expect(view).toContain('function selectCountryForMap(countryName, countryCode)');
    expect(view).toContain('function clearCountrySelection(');
    expect(view).toContain('pulse-country-ring');
    expect(view).toContain('mapCard.scrollIntoView({ behavior: \'smooth\', block: \'nearest\' });');
  });

  test('no-location state is handled gracefully when a country has no coordinates', () => {
    expect(view).toContain('No geographic coordinates on file for');
    expect(view).toContain('Locations will appear once coordinates are added');
  });

  test('extracted functions correctly match country variations and generate appropriate flag markup', () => {
    const start = view.indexOf('const COUNTRY_CODE = {');
    const end = view.indexOf('function fmtDate(');
    const codeToEval = view.slice(start, end);
    const scope = new Function(`
      const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      ${codeToEval}
      return { countryCodeOf, countryToFlagEmoji, aggregateCountries, isCountryMatch };
    `)();

    // Verify country matching with real data variations
    expect(scope.countryCodeOf('Philippines')).toBe('ph');
    expect(scope.countryCodeOf('ph')).toBe('ph');
    expect(scope.countryCodeOf('Japan')).toBe('jp');
    expect(scope.countryCodeOf('South Korea')).toBe('kr');
    expect(scope.countryCodeOf('USA')).toBe('us');
    expect(scope.countryCodeOf('Germany')).toBe('de');
    expect(scope.countryCodeOf('Australia')).toBe('au');

    // Matching logic
    expect(scope.isCountryMatch('Philippines', 'Philippines', 'ph')).toBe(true);
    expect(scope.isCountryMatch('ph', 'Philippines', 'ph')).toBe(true);
    expect(scope.isCountryMatch('Japan', 'Japan', 'jp')).toBe(true);
    expect(scope.isCountryMatch('Japan', 'China', 'cn')).toBe(false);
  });
});

describe('Dashboard live route renders correctly for Admin and Staff with new elements', () => {
  let admin, staff;
  beforeAll(async () => {
    await connectDB();
    admin = request.agent(app); await loginAs(admin, await createTestUser({ role: 'Administrator' }));
    staff = request.agent(app); await loginAs(staff, await createTestUser({ role: 'Staff' }));
  }, 60000);

  afterAll(async () => {
    await cleanupAll();
    await closeDB();
  });

  test.each([['Administrator', '/dashboard', () => admin], ['Staff', '/staff/dashboard', () => staff]])(
    '%s dashboard HTML includes the flag markup and map alert elements',
    async (role, url, who) => {
      const res = await who().get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('id="top-countries-list"');
      expect(res.text).toContain('id="map-country-alert"');
      expect(res.text).toContain('selectCountryForMap');
      expect(res.text).toContain('top-country-row');
    }
  );
});
