// Automatic map location for partnerships (2026-09-19): country lookup layer,
// the geocoding service (ladder, validation, cache, timeout, rate limiting),
// and the Add/Edit/preview API behavior for Administrator and Staff.
//
// The geocoding provider is ALWAYS a mock here — under NODE_ENV=test the real
// Nominatim provider is never selected, and no test performs a network call.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const geo = require('../services/geocodingService');
const { resolveCountry, suggestCountry } = require('../services/countryData');

const RUN = `JestGeo${Date.now()}`;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
const createdIds = [];

// A mock provider: records each call and answers via `handler`.
function makeProvider(handler) {
  const calls = [];
  return {
    name: 'mock', calls,
    async search(args) { calls.push({ institution: args.institution, countryCode: args.countryCode, at: Date.now() }); return handler(args); }
  };
}
const cand = (name, cc, lat, lng, extra = {}) => ({
  lat, lng, name, names: [name], displayName: `${name}, City`, countryCode: cc, class: 'amenity', type: 'university', ...extra
});

const basePartnership = (over = {}) => ({
  inst: `${RUN} Alpha University`, country: 'Japan', region: 'Asia', type: 'MOA',
  nature: ['Research'], cat: 'International', unit: ['CCS'],
  start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', remarks: 'jesttest', ...over
});

async function insertRaw(doc) {
  const db = await connectDB();
  const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  await db.collection('partnerships').insertOne({ id, ...doc });
  createdIds.push(id);
  return id;
}

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

beforeEach(() => {
  geo.resetForTests();
  geo.configure({ minIntervalMs: 15, budgetMs: 2500, requestTimeoutMs: 400 });
});

afterAll(async () => {
  geo.resetForTests();
  const db = await connectDB();
  await db.collection('partnerships').deleteMany({ id: { $in: createdIds } });
  await db.collection('partnerships').deleteMany({ inst: new RegExp('^' + RUN) });
  await db.collection('geocodecache').deleteMany({ key: new RegExp('^' + RUN.toLowerCase()) });
  await cleanupAll();
  await closeDB();
});

// ── Country lookup layer ─────────────────────────────────────────────────────
describe('country lookup layer (geographic resolution only)', () => {
  test('recognizes canonical names, unambiguous aliases and ISO codes', () => {
    expect(resolveCountry('Philippines').code).toBe('PH');
    expect(resolveCountry(' the philippines ').code).toBe('PH');
    expect(resolveCountry('USA').name).toBe('United States');
    expect(resolveCountry('U.S.A.').code).toBe('US');
    expect(resolveCountry('jp').name).toBe('Japan');
    expect(resolveCountry('Republic of Korea').name).toBe('South Korea');
  });

  test('junk, misspellings and ambiguous values are NOT resolved to a guessed country', () => {
    expect(resolveCountry('sadtoa')).toBeNull();
    expect(resolveCountry('san nicolas')).toBeNull();
    expect(resolveCountry('philipines')).toBeNull();
    expect(resolveCountry('Philipines')).toBeNull();
    expect(resolveCountry('Korea')).toBeNull(); // North or South — never guessed
    expect(resolveCountry('')).toBeNull();
    expect(resolveCountry('—')).toBeNull();
  });

  test('a misspelling can only produce a "did you mean" suggestion, never a resolution', () => {
    expect(suggestCountry('philipines')).toBe('Philippines');
    expect(suggestCountry('sadtoa')).toBeNull();
    expect(suggestCountry('sadi kaabay')).toBeNull();
  });
});

// ── Geocoding service ────────────────────────────────────────────────────────
describe('geocoding service', () => {
  test('resolves an exact institution location when the result is in the entered country and the name matches', async () => {
    const provider = makeProvider(() => [cand(`${RUN} Exact University`, 'jp', 35.71, 139.76)]);
    geo.setProvider(provider);
    const loc = await geo.resolveLocation({ institution: `${RUN} Exact University`, country: 'Japan' });
    expect(loc).toMatchObject({ status: 'resolved', source: 'geocoded', precision: 'institution', lat: 35.71, lng: 139.76, countryCode: 'JP', reason: 'institution-match' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].countryCode).toBe('JP');
  });

  test('a result in the WRONG country is rejected — falls back to the entered country\'s approximate point', async () => {
    geo.setProvider(makeProvider(() => [cand(`${RUN} Wrong University`, 'us', 42.36, -71.09)]));
    const loc = await geo.resolveLocation({ institution: `${RUN} Wrong University`, country: 'Japan' });
    expect(loc).toMatchObject({ status: 'approximate', source: 'country-centroid', precision: 'country', countryCode: 'JP', reason: 'no-confident-match' });
    expect(loc.lat).toBeCloseTo(36.20, 1);
  });

  test('a loosely-similar name and a city-level result are both rejected (never guess)', async () => {
    geo.setProvider(makeProvider(() => [
      cand('Tokyo Metropolitan Government', 'jp', 35.68, 139.69),
      cand(`${RUN} Place University`, 'jp', 1, 1, { class: 'place', type: 'city' })
    ]));
    const loc = await geo.resolveLocation({ institution: `${RUN} Place University`, country: 'Japan' });
    expect(loc.status).toBe('approximate');
    expect(loc.reason).toBe('no-confident-match');
  });

  test('provider error/timeout degrades to the country fallback, is bounded in time, and is never cached', async () => {
    let n = 0;
    const provider = makeProvider(async () => { n++; if (n === 1) throw new Error('boom'); return [cand(`${RUN} Retry University`, 'jp', 34, 135)]; });
    geo.setProvider(provider);
    const first = await geo.resolveLocation({ institution: `${RUN} Retry University`, country: 'Japan' });
    expect(first).toMatchObject({ status: 'approximate', reason: 'provider-unavailable' });
    // The failure was not cached, so a later attempt reaches the provider again and succeeds.
    const second = await geo.resolveLocation({ institution: `${RUN} Retry University`, country: 'Japan' });
    expect(second.status).toBe('resolved');
    expect(provider.calls).toHaveLength(2);

    geo.resetForTests();
    geo.configure({ minIntervalMs: 15, budgetMs: 2500, requestTimeoutMs: 100 });
    geo.setProvider(makeProvider(() => new Promise(r => setTimeout(() => r([]), 1500))));
    const t0 = Date.now();
    const slow = await geo.resolveLocation({ institution: `${RUN} Slow University`, country: 'Japan' });
    expect(slow).toMatchObject({ status: 'approximate', reason: 'provider-unavailable' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('definitive answers are cached: a repeat lookup (hit or confident miss) never calls the provider again', async () => {
    const provider = makeProvider(({ institution }) => institution.includes('Hit') ? [cand(institution, 'jp', 33, 130)] : []);
    geo.setProvider(provider);
    await geo.resolveLocation({ institution: `${RUN} Cache Hit University`, country: 'Japan' });
    await geo.resolveLocation({ institution: `${RUN} Cache Hit University`, country: 'JAPAN' });
    expect(provider.calls).toHaveLength(1);
    await geo.resolveLocation({ institution: `${RUN} Cache Miss University`, country: 'Japan' });
    const again = await geo.resolveLocation({ institution: `${RUN} Cache Miss University`, country: 'Japan' });
    expect(again.reason).toBe('no-confident-match');
    expect(provider.calls).toHaveLength(2);
  });

  test('concurrent identical lookups share one provider request', async () => {
    const provider = makeProvider(async ({ institution }) => { await new Promise(r => setTimeout(r, 50)); return [cand(institution, 'jp', 34, 135)]; });
    geo.setProvider(provider);
    const results = await Promise.all([1, 2, 3].map(() => geo.resolveLocation({ institution: `${RUN} Shared University`, country: 'Japan' })));
    expect(results.every(r => r.status === 'resolved')).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  test('provider requests are spaced by the configured minimum interval (rate limit)', async () => {
    geo.configure({ minIntervalMs: 150 });
    const provider = makeProvider(({ institution }) => [cand(institution, 'jp', 34, 135)]);
    geo.setProvider(provider);
    await Promise.all(['One', 'Two', 'Three'].map(n => geo.resolveLocation({ institution: `${RUN} Spaced ${n} University`, country: 'Japan' })));
    expect(provider.calls).toHaveLength(3);
    const gaps = provider.calls.slice(1).map((c, i) => c.at - provider.calls[i].at);
    gaps.forEach(g => expect(g).toBeGreaterThanOrEqual(140));
  });

  test('a country alias ("USA") is used for lookup only', async () => {
    const provider = makeProvider(({ institution }) => [cand(institution, 'us', 42.36, -71.09)]);
    geo.setProvider(provider);
    const loc = await geo.resolveLocation({ institution: `${RUN} Alias University`, country: 'USA' });
    expect(provider.calls[0].countryCode).toBe('US');
    expect(loc).toMatchObject({ status: 'resolved', countryCode: 'US' });
  });

  test('a junk / misspelled country is unresolved (no provider call, no guessed country), with a suggestion only', async () => {
    const provider = makeProvider(() => [cand('x', 'ph', 1, 1)]);
    geo.setProvider(provider);
    const junk = await geo.resolveLocation({ institution: `${RUN} Junk University`, country: 'sadtoa' });
    expect(junk).toMatchObject({ status: 'unresolved', lat: null, lng: null, reason: 'country-unrecognized' });
    const typo = await geo.resolveLocation({ institution: `${RUN} Typo University`, country: 'Philipines' });
    expect(typo).toMatchObject({ status: 'unresolved', lat: null, lng: null, suggestion: 'Philippines' });
    const none = await geo.resolveLocation({ institution: `${RUN} None University`, country: '—' });
    expect(none).toMatchObject({ status: 'unresolved', reason: 'no-country' });
    expect(provider.calls).toHaveLength(0);
  });

  test("CSPC's own name is never geolocated as a partner (country-level only, provider not called)", async () => {
    const provider = makeProvider(() => [cand('Camarines Sur Polytechnic Colleges', 'ph', 13.6, 123.2)]);
    geo.setProvider(provider);
    const loc = await geo.resolveLocation({ institution: 'Camarines Sur Polytechnic Colleges', country: 'Philippines' });
    expect(loc).toMatchObject({ status: 'approximate', precision: 'country', reason: 'own-institution' });
    expect(provider.calls).toHaveLength(0);
  });

  test('with no provider (disabled, or the test-environment default) it makes no network call and uses the country fallback', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      geo.setProvider(null);
      expect(await geo.resolveLocation({ institution: `${RUN} Off University`, country: 'Japan' })).toMatchObject({ status: 'approximate', reason: 'geocoder-disabled' });
      geo.setProvider(); // back to the env default, which is "none" under NODE_ENV=test
      expect(await geo.resolveLocation({ institution: `${RUN} Off University`, country: 'Japan' })).toMatchObject({ status: 'approximate', reason: 'geocoder-disabled' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── Add / Edit API ───────────────────────────────────────────────────────────
describe('Add / Edit Partnership — automatic map location', () => {
  test.each([['Administrator', () => adminAgent], ['Staff', () => staffAgent]])(
    '%s: creating a partnership resolves and stores the location (server-controlled fields)',
    async (role, agentOf) => {
      geo.setProvider(makeProvider(({ institution }) => [cand(institution, 'jp', 35.71, 139.76)]));
      const inst = `${RUN} Create ${role} University`;
      const res = await agentOf().post('/api/partnerships').send(basePartnership({ inst }));
      expect(res.status).toBe(200);
      createdIds.push(res.body.partnership.id);
      expect(res.body.partnership).toMatchObject({
        lat: 35.71, lng: 139.76, locationSource: 'geocoded', locationPrecision: 'institution',
        locationStatus: 'resolved', countryCode: 'JP'
      });
      expect(res.body.partnership.locationResolvedAt).toBeTruthy();
      const db = await connectDB();
      const stored = await db.collection('partnerships').findOne({ id: res.body.partnership.id });
      expect(stored.lat).toBe(35.71);
      expect(stored.country).toBe('Japan'); // the entered country is never rewritten
    });

  test('clients cannot supply coordinates or location metadata themselves', async () => {
    for (const extra of [{ lat: 1 }, { lng: 2 }, { locationStatus: 'resolved' }, { locationSource: 'manual' }, { countryCode: 'XX' }]) {
      const res = await adminAgent.post('/api/partnerships').send(basePartnership({ inst: `${RUN} Forged`, ...extra }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown field/);
    }
  });

  test('a geocoding failure never blocks creation — the partnership saves with a country-level location', async () => {
    geo.setProvider(makeProvider(() => { throw new Error('provider down'); }));
    const res = await adminAgent.post('/api/partnerships').send(basePartnership({ inst: `${RUN} Down University` }));
    expect(res.status).toBe(200);
    createdIds.push(res.body.partnership.id);
    expect(res.body.partnership).toMatchObject({ locationStatus: 'approximate', locationPrecision: 'country', locationSource: 'country-centroid', countryCode: 'JP' });
  });

  test('a junk country saves normally but stays unresolved with NO coordinates and the country untouched', async () => {
    geo.setProvider(makeProvider(() => [cand('x', 'jp', 1, 1)]));
    const res = await adminAgent.post('/api/partnerships').send(basePartnership({ inst: `${RUN} Nowhere University`, country: 'sadtoa' }));
    expect(res.status).toBe(200);
    createdIds.push(res.body.partnership.id);
    expect(res.body.partnership.locationStatus).toBe('unresolved');
    expect(res.body.partnership).not.toHaveProperty('lat');
    expect(res.body.partnership).not.toHaveProperty('lng');
    expect(res.body.partnership.country).toBe('sadtoa');
  });

  test('two partnerships that resolve to the same place get identical coordinates (grouped on the map)', async () => {
    geo.setProvider(makeProvider(() => [cand(`${RUN} Twin One University`, 'jp', 12.345, 67.89), cand(`${RUN} Twin Two University`, 'jp', 12.345, 67.89)]));
    const a = await adminAgent.post('/api/partnerships').send(basePartnership({ inst: `${RUN} Twin One University` }));
    const b = await staffAgent.post('/api/partnerships').send(basePartnership({ inst: `${RUN} Twin Two University` }));
    createdIds.push(a.body.partnership.id, b.body.partnership.id);
    expect([a.body.partnership.lat, a.body.partnership.lng]).toEqual([b.body.partnership.lat, b.body.partnership.lng]);
  });

  describe('editing', () => {
    test('an edit that leaves institution/country alone keeps existing (legacy) coordinates untouched and never calls the provider', async () => {
      const provider = makeProvider(() => [cand('anything', 'jp', 1, 1)]);
      geo.setProvider(provider);
      const id = await insertRaw({ inst: `${RUN} Legacy University`, country: 'Japan', region: 'Asia', type: 'MOA', nature: 'Research', cat: 'International', unit: ['CCS'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', lat: 10.5, lng: 20.25 });
      const remarks = await adminAgent.patch(`/api/partnerships/${id}`).send({ remarks: 'jesttest edit' });
      expect(remarks.status).toBe(200);
      // The Edit form re-sends the same institution/country on every save.
      const resent = await staffAgent.patch(`/api/partnerships/${id}`).send({ inst: `${RUN} Legacy University`, country: 'Japan', remarks: 'again' });
      expect(resent.status).toBe(200);
      const db = await connectDB();
      const doc = await db.collection('partnerships').findOne({ id });
      expect([doc.lat, doc.lng]).toEqual([10.5, 20.25]);
      expect(doc).not.toHaveProperty('locationStatus');
      expect(provider.calls).toHaveLength(0);
    });

    test('changing the institution re-evaluates the location — old coordinates are replaced, not left stale', async () => {
      const provider = makeProvider(({ institution }) => [cand(institution, 'jp', 40.1, 141.2)]);
      geo.setProvider(provider);
      const id = await insertRaw({ inst: `${RUN} Before University`, country: 'Japan', region: 'Asia', type: 'MOA', nature: 'Research', cat: 'International', unit: ['CCS'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', lat: 10.5, lng: 20.25 });
      const res = await adminAgent.patch(`/api/partnerships/${id}`).send({ inst: `${RUN} After University` });
      expect(res.status).toBe(200);
      expect(res.body.partnership).toMatchObject({ lat: 40.1, lng: 141.2, locationStatus: 'resolved' });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].institution).toBe(`${RUN} After University`);
    });

    test('changing the country to an unrecognized value REMOVES the stale coordinates and marks it unresolved', async () => {
      geo.setProvider(makeProvider(() => []));
      const id = await insertRaw({ inst: `${RUN} Moving University`, country: 'Japan', region: 'Asia', type: 'MOA', nature: 'Research', cat: 'International', unit: ['CCS'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', lat: 10.5, lng: 20.25 });
      const res = await staffAgent.patch(`/api/partnerships/${id}`).send({ country: 'sadtoa' });
      expect(res.status).toBe(200);
      expect(res.body.partnership.locationStatus).toBe('unresolved');
      expect(res.body.partnership).not.toHaveProperty('lat');
      expect(res.body.partnership).not.toHaveProperty('lng');
      expect(res.body.partnership.country).toBe('sadtoa'); // stored exactly as entered
    });

    test('a record that never had a location is not auto-backfilled by an unrelated edit', async () => {
      const provider = makeProvider(() => [cand('anything', 'jp', 1, 1)]);
      geo.setProvider(provider);
      const id = await insertRaw({ inst: `${RUN} Unlocated University`, country: 'Japan', region: 'Asia', type: 'MOA', nature: 'Research', cat: 'International', unit: ['CCS'], start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active' });
      const res = await adminAgent.patch(`/api/partnerships/${id}`).send({ remarks: 'jesttest edit' });
      expect(res.status).toBe(200);
      expect(res.body.partnership).not.toHaveProperty('lat');
      expect(res.body.partnership).not.toHaveProperty('locationStatus');
      expect(provider.calls).toHaveLength(0);
    });
  });
});

// ── Preview endpoint ─────────────────────────────────────────────────────────
describe('POST /api/geocode/preview', () => {
  test.each([['Administrator', () => adminAgent], ['Staff', () => staffAgent]])(
    '%s can preview; it reports the outcome and writes nothing', async (role, agentOf) => {
      geo.setProvider(makeProvider(({ institution }) => [cand(institution, 'jp', 35.71, 139.76)]));
      const db = await connectDB();
      const before = await db.collection('partnerships').countDocuments({});
      const inst = `${RUN} Preview ${role} University`;
      const res = await agentOf().post('/api/geocode/preview').send({ institution: inst, country: 'Japan' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'resolved', precision: 'institution', source: 'geocoded', countryCode: 'JP' });
      expect(await db.collection('partnerships').countDocuments({})).toBe(before);

      const junk = await agentOf().post('/api/geocode/preview').send({ institution: inst, country: 'Philipines' });
      expect(junk.body).toMatchObject({ status: 'unresolved', suggestion: 'Philippines' });
    });

  test('Auth. Personnel, potential_partner and anonymous callers are redirected, never served', async () => {
    const body = { institution: 'X University', country: 'Japan' };
    expect((await personnelAgent.post('/api/geocode/preview').send(body)).status).toBe(302);
    expect((await partnerAgent.post('/api/geocode/preview').send(body)).status).toBe(302);
    expect((await request(app).post('/api/geocode/preview').send(body)).status).toBe(302);
  });

  test('tolerates malformed input without erroring', async () => {
    const res = await adminAgent.post('/api/geocode/preview').send({ institution: { $ne: 1 }, country: ['Japan'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unresolved');
  });
});
