// Dashboard > Partnerships Geographical Map (Administrator / CIRL Staff).
//
// History: the map lost its background because Carto's legacy `rastertiles/voyager` endpoint now serves an
// "API KEY REQUIRED" watermark tile for every request (HTTP 200, so it looked like a working map). The plain
// OpenStreetMap raster tiles that replaced it print every country's own script (Japanese, Chinese, Korean, Cyrillic),
// so the base map is now OpenFreeMap (free, no key) drawn with MapLibre inside the existing Leaflet map, with every
// place label forced to its Latin/English form from the provider's own name fields.
//
// Source/rendered-page checks here (no external network in Jest). The tiles/style/glyphs loading, the label script at
// each zoom level, the markers, popups, zoom and pan were verified in a real browser.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'admin_dashboard.ejs'), 'utf8');

describe('Dashboard map — base map and Latin/English labels', () => {
  test('the base map is OpenFreeMap drawn with MapLibre inside the existing Leaflet map, added once', () => {
    expect(view).toContain("const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';");
    expect(view).toContain('L.maplibreGL({ style: style, attribution: BASEMAP_ATTRIBUTION }).addTo(map)');
    expect(view.match(/L\.maplibreGL\(/g).length).toBe(1);
    expect(view).toContain('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
    expect(view).toContain('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
    expect(view).toContain('https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js');
  });

  test('every text label uses one Latin-only expression built from the provider name fields, never a hardcoded name', () => {
    const expr = view.slice(view.indexOf('const LATIN_LABEL = ['), view.indexOf('const BASEMAP_ATTRIBUTION'));
    for (const f of ["'name:en'", "'name:latin'", "'name:nonlatin'", "'name_int'"]) expect(expr).toContain(f);
    expect(expr).not.toMatch(/'name:(ja|zh|ko|ru|ar|th)/);
    expect(view).toContain("l.layout['text-field'] = LATIN_LABEL;");
    // the stock style prints the Latin name and then the native-script name under it: those layers are replaced
    expect(view).toContain("l.type === 'symbol' && l.layout && l.layout['text-field'] && JSON.stringify(l.layout['text-field']).indexOf('name:latin') !== -1");
  });

  test('English is preferred first; a place that only has a native-script name gets no label (the expression ends in an empty string)', () => {
    const expr = view.slice(view.indexOf('const LATIN_LABEL = ['), view.indexOf('const BASEMAP_ATTRIBUTION'));
    expect(expr.indexOf("'name:en'")).toBeLessThan(expr.indexOf("'name:latin'"));
    expect(expr).toMatch(/\['get', 'name_int'\],\s*''\];/);
  });

  test('if the vector map cannot start (no WebGL, style fetch fails) the plain OpenStreetMap tiles are used so the map is never blank', () => {
    expect(view).toContain('function addFallbackBasemap()');
    expect(view).toContain("L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png'");
    expect(view).toContain('if (!(window.maplibregl && L.maplibreGL)) { addFallbackBasemap(); return; }');
    expect(view).toContain('.catch(function (err) {');
    expect(view.match(/addFallbackBasemap\(\)/g).length).toBeGreaterThanOrEqual(3);
  });

  test('nothing points at Carto (the provider that now demands an API key)', () => {
    expect(view).not.toMatch(/cartocdn/i);
    expect(view).not.toMatch(/rastertiles/i);
  });

  test('no API key, token or secret is written into the page', () => {
    expect(view).not.toMatch(/access_token|api[_-]?key\s*[:=]|apikey\s*[:=]|mapbox|YOUR_[A-Z_]*KEY/i);
  });

  test('attribution for OpenFreeMap, OpenMapTiles and OpenStreetMap is shown and linked, as those terms require', () => {
    const attr = view.slice(view.indexOf('const BASEMAP_ATTRIBUTION'), view.indexOf('// Only used when the vector base map'));
    for (const u of ['https://openfreemap.org', 'https://www.openmaptiles.org/', 'https://www.openstreetmap.org/copyright']) expect(attr).toContain(u);
    expect(attr).toContain('Data from');
  });
});

describe('Dashboard map — Leaflet setup and markers are unchanged', () => {
  test('Leaflet CSS and JS are both loaded, and the container has a fixed height', () => {
    expect(view).toContain('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    expect(view).toContain('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    expect(view).toContain('<div id="partnership-map" style="height:360px;">');
  });

  test('the map is created once, markers live in their own layer, and size is re-measured after every render', () => {
    expect(view.match(/L\.map\('partnership-map'/g).length).toBe(1);
    expect(view).toContain('const markerLayer = L.layerGroup().addTo(map);');
    expect(view).toContain('markerLayer.clearLayers();');
    expect(view).toContain('setTimeout(function () { map.invalidateSize(); }, 300);');
  });

  test('marker placement rules are untouched: only valid coordinates get a marker, approximate ones are marked, popups are escaped', () => {
    expect(view).toContain('function hasMapLocation(p)');
    expect(view).toContain("p.locationStatus !== 'unresolved'");
    expect(view).toContain('function isApproximate(p)');
    expect(view).toContain("${esc(p.inst || p.institution || 'Partner Institution')}");
    expect(view).toContain('not on map (location unresolved)');
    expect(view).toContain('renderMap(list);');
  });

  test('the continent buttons still fly the map', () => {
    expect(view).toContain('map.flyTo([lat, lng], zoom, { duration: 1.2 });');
    for (const c of ['Asia', 'Europe', 'Americas', 'Oceania', 'World']) expect(view).toContain('>' + c + '</button>');
  });
});

describe('Dashboard map — the rendered page for Administrator and CIRL Staff', () => {
  let admin, staff;
  beforeAll(async () => {
    await connectDB();
    admin = request.agent(app); await loginAs(admin, await createTestUser({ role: 'Administrator' }));
    staff = request.agent(app); await loginAs(staff, await createTestUser({ role: 'Staff' }));
  });
  afterAll(async () => { await cleanupAll(); await closeDB(); });

  test.each([['Administrator', '/dashboard', () => admin], ['CIRL Staff', '/staff/dashboard', () => staff]])('%s dashboard serves the OpenFreeMap basemap with the Latin label expression and no Carto URL', async (label, url, who) => {
    const res = await who().get(url);
    expect(res.status).toBe(200);
    expect(res.text).toContain('tiles.openfreemap.org/styles/liberty');
    expect(res.text).toContain("['has', 'name:en']");
    expect(res.text).toContain('id="partnership-map"');
    expect(res.text).not.toMatch(/cartocdn/i);
  });
});
