// Automatic map location for partnership records.
//
// Resolution ladder (first that applies wins — nothing is ever guessed):
//   1. institution (the PARTNER, never CSPC itself) + country, geocoded by the
//      configured provider AND validated: the result must be in the entered
//      country and its name must actually match the institution. -> "resolved"
//   2. country-level fallback: a representative point for the entered country
//      (countryData.js). Used whenever step 1 can't be done or isn't confident
//      (provider unavailable/slow/disabled, no confident match, CSPC's own
//      name). -> "approximate"
//   3. otherwise (no country, or a country string that isn't recognized) ->
//      "unresolved": no coordinates are produced at all.
//
// Nothing here can block or fail a save: every provider problem degrades to
// step 2, and the whole lookup is bounded by a wall-clock budget.
//
// Provider: OpenStreetMap Nominatim by default — no API key. Its public usage
// policy (https://operations.osmfoundation.org/policies/nominatim/) requires:
// max 1 request/second (enforced by the queue below), an identifying
// User-Agent (config.userAgent), cached results (geocodecache collection),
// no autocomplete-style querying (callers look up on commit, not per
// keystroke), and OSM attribution (the dashboard map already displays it).
// GEOCODER_PROVIDER=none disables lookups entirely (country fallback only);
// GEOCODER_BASE_URL points at a self-hosted/compatible instance.
//
// Automated tests never reach the network: under NODE_ENV=test the provider
// defaults to "none" unless a test injects a mock via setProvider().

const { getDb } = require('../db');
const { resolveCountry, suggestCountry, normalizeKey } = require('./countryData');
const { OUR_INSTITUTION_RE } = require('./extractionService');

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  baseUrl: (process.env.GEOCODER_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
  userAgent: process.env.GEOCODER_USER_AGENT || 'CIPRMS-CSPC-CIRL/1.0 (institutional partnership registry; low-volume institution geocoding)',
  requestTimeoutMs: 4000,   // one provider HTTP request
  minIntervalMs: 1100,      // >= 1 request/second to the provider
  budgetMs: 6000,           // total wall-clock a caller ever waits for a lookup
  maxQueue: 20,             // beyond this, skip the provider and fall back
  positiveTtlMs: 180 * DAY_MS,
  negativeTtlMs: 7 * DAY_MS
};
let config = { ...DEFAULT_CONFIG };

function configure(overrides) { config = { ...config, ...overrides }; }

// ── Provider selection ───────────────────────────────────────────────────────
const UNSET = Symbol('unset');
let providerOverride = UNSET; // tests: a mock object, or null to force "disabled"

function createNominatimProvider() {
  return {
    name: 'nominatim',
    async search({ institution, countryCode, signal }) {
      const url = new URL(config.baseUrl + '/search');
      url.searchParams.set('q', institution);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '5');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('namedetails', '1');
      url.searchParams.set('accept-language', 'en');
      url.searchParams.set('countrycodes', countryCode.toLowerCase());
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent, 'Accept': 'application/json' },
        signal
      });
      if (!res.ok) throw new Error('geocoder HTTP ' + res.status);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('geocoder returned an unexpected payload');
      return rows.map(r => ({
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        name: r.name || '',
        names: Object.values(r.namedetails || {}).filter(v => typeof v === 'string'),
        displayName: r.display_name || '',
        countryCode: r.address && r.address.country_code ? String(r.address.country_code) : '',
        class: r.category || r.class || '',
        type: r.type || ''
      }));
    }
  };
}
let nominatimProvider = null;

function activeProvider() {
  if (providerOverride !== UNSET) return providerOverride;
  const want = (process.env.GEOCODER_PROVIDER || (process.env.NODE_ENV === 'test' ? 'none' : 'nominatim')).toLowerCase();
  if (want === 'nominatim') {
    if (!nominatimProvider) nominatimProvider = createNominatimProvider();
    return nominatimProvider;
  }
  return null;
}

// Test hook. setProvider(mock) / setProvider(null) = disabled / setProvider() = back to env-driven.
function setProvider(p) { providerOverride = p === undefined ? UNSET : p; }

// ── Validation helpers ───────────────────────────────────────────────────────
function isValidCoordinate(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

const STOP_TOKENS = new Set(['the', 'of', 'and', 'de', 'del', 'la', 'at', 'for', 'in', 'a', 'an']);
function tokens(s) {
  return normalizeKey(s).split(/[^a-z0-9]+/).filter(t => t && !STOP_TOKENS.has(t));
}
const EDUCATION_TYPES = new Set(['university', 'college', 'school']);
const NON_INSTITUTION_CLASSES = new Set(['boundary', 'place']); // cities/regions/countries, never an institution
const MIN_NAME_SCORE = 0.8;

// Returns the best candidate that is (a) in the entered country and (b) a
// confident name match for the institution — or null. This is the "never
// guess" gate: a wrong-country hit, a city-name collision, or a loosely
// similar name is rejected, which sends the caller to the country fallback.
function pickConfidentCandidate(institution, countryCode, candidates) {
  const queryTokens = [...new Set(tokens(institution))];
  if (!queryTokens.length || !Array.isArray(candidates)) return null;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (!c || !isValidCoordinate(c.lat, c.lng)) continue;
    if (String(c.countryCode || '').toLowerCase() !== countryCode.toLowerCase()) continue;
    if (NON_INSTITUTION_CLASSES.has(c.class)) continue;
    if (queryTokens.length < 2 && !(c.class === 'amenity' && EDUCATION_TYPES.has(c.type))) continue;
    const firstSegment = String(c.displayName || '').split(',')[0];
    const candTokens = new Set(tokens([c.name, firstSegment, ...(c.names || [])].join(' ')));
    const score = queryTokens.filter(t => candTokens.has(t)).length / queryTokens.length;
    if (score >= MIN_NAME_SCORE && score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// ── Timeout / queue / cache ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error('geocoder-timeout')); }, ms);
  });
  return Promise.race([fn(ctrl.signal), timeout]).finally(() => clearTimeout(timer));
}

function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('geocoder-budget')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let chain = Promise.resolve();
let lastStart = 0;
let pending = 0;
const inflight = new Map();

// Serializes provider calls and spaces them >= minIntervalMs apart. A job
// whose caller has already given up (deadline passed) is dropped unrun.
function schedule(job, deadline) {
  if (pending >= config.maxQueue) return Promise.reject(new Error('geocoder-queue-full'));
  pending++;
  const run = chain.then(async () => {
    try {
      const wait = lastStart + config.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() >= deadline) throw new Error('geocoder-budget-exhausted');
      lastStart = Date.now();
      return await job();
    } finally {
      pending--;
    }
  });
  chain = run.catch(() => { });
  return run;
}

function cacheKey(institution, countryCode) {
  return `${normalizeKey(institution)}|${countryCode}`;
}

async function cacheGet(key) {
  try {
    const doc = await getDb().collection('geocodecache').findOne({ key });
    if (doc && doc.expiresAt > Date.now()) return doc;
  } catch (e) { /* cache is best-effort */ }
  return null;
}

async function cachePut(key, countryCode, best, providerName) {
  try {
    const now = Date.now();
    await getDb().collection('geocodecache').updateOne(
      { key },
      {
        $set: {
          key, countryCode, provider: providerName, hit: !!best,
          result: best ? { lat: best.lat, lng: best.lng, name: best.name || '', displayName: best.displayName || '' } : null,
          cachedAt: now,
          expiresAt: now + (best ? config.positiveTtlMs : config.negativeTtlMs)
        }
      },
      { upsert: true }
    );
  } catch (e) { /* cache is best-effort */ }
}

// One provider-backed lookup for (institution, country): cache first, then the
// rate-limited provider. Only a definitive answer (a confident match, or a
// confident "no match") is cached — timeouts/errors never are.
async function lookupInstitution(provider, institution, country, deadline) {
  const key = cacheKey(institution, country.code);
  const cached = await cacheGet(key);
  if (cached) return cached.hit ? cached.result : null;

  const candidates = await schedule(
    () => withTimeout(signal => provider.search({ institution, countryCode: country.code, countryName: country.name, signal }), config.requestTimeoutMs),
    deadline
  );
  const best = pickConfidentCandidate(institution, country.code, candidates);
  await cachePut(key, country.code, best, provider.name);
  return best ? { lat: best.lat, lng: best.lng, name: best.name || '', displayName: best.displayName || '' } : null;
}

// ── Public API ───────────────────────────────────────────────────────────────
function isBlankCountry(raw) { return !raw || /^[—–\-\s]*$/.test(raw); }

// Never throws. Returns:
//   { status: 'resolved'|'approximate'|'unresolved', source, precision, lat, lng,
//     countryCode, resolvedName, resolvedAt, reason, suggestion? }
async function resolveLocation({ institution, country } = {}) {
  const instName = typeof institution === 'string' ? institution.trim() : '';
  const countryRaw = typeof country === 'string' ? country.trim() : '';
  const resolvedAt = new Date().toISOString();
  try {
    const c = resolveCountry(countryRaw);
    if (!c) {
      const out = {
        status: 'unresolved', source: null, precision: null, lat: null, lng: null,
        countryCode: null, resolvedName: null, resolvedAt,
        reason: isBlankCountry(countryRaw) ? 'no-country' : 'country-unrecognized'
      };
      const suggestion = isBlankCountry(countryRaw) ? null : suggestCountry(countryRaw);
      if (suggestion) out.suggestion = suggestion;
      return out;
    }

    const approximate = reason => ({
      status: 'approximate', source: 'country-centroid', precision: 'country',
      lat: c.lat, lng: c.lng, countryCode: c.code, resolvedName: c.name, resolvedAt, reason
    });

    if (!instName) return approximate('no-institution');
    if (OUR_INSTITUTION_RE.test(instName)) return approximate('own-institution');
    const provider = activeProvider();
    if (!provider) return approximate('geocoder-disabled');

    const key = cacheKey(instName, c.code);
    let pendingLookup = inflight.get(key);
    if (!pendingLookup) {
      const deadline = Date.now() + config.budgetMs;
      pendingLookup = lookupInstitution(provider, instName, c, deadline);
      inflight.set(key, pendingLookup);
      const clear = () => { if (inflight.get(key) === pendingLookup) inflight.delete(key); };
      pendingLookup.then(clear, clear);
    }
    try {
      const hit = await withBudget(pendingLookup, config.budgetMs);
      if (!hit) return approximate('no-confident-match');
      return {
        status: 'resolved', source: 'geocoded', precision: 'institution',
        lat: hit.lat, lng: hit.lng, countryCode: c.code,
        resolvedName: hit.displayName || hit.name || instName, resolvedAt, reason: 'institution-match'
      };
    } catch (e) {
      return approximate('provider-unavailable');
    }
  } catch (e) {
    return {
      status: 'unresolved', source: null, precision: null, lat: null, lng: null,
      countryCode: null, resolvedName: null, resolvedAt, reason: 'error'
    };
  }
}

const LOCATION_FIELDS = ['lat', 'lng', 'locationSource', 'locationPrecision', 'locationStatus', 'countryCode', 'locationResolvedName', 'locationResolvedAt'];

// Turns a resolveLocation() result into the server-controlled fields to store.
// `unset` lists fields that must be REMOVED on update (so no stale coordinates
// from a previous institution/country survive an unresolved re-evaluation).
function buildLocationUpdate(loc) {
  if (loc.status === 'unresolved') {
    return {
      set: { locationStatus: 'unresolved', locationResolvedAt: loc.resolvedAt },
      unset: ['lat', 'lng', 'locationSource', 'locationPrecision', 'countryCode', 'locationResolvedName']
    };
  }
  return {
    set: {
      lat: loc.lat, lng: loc.lng,
      locationSource: loc.source, locationPrecision: loc.precision, locationStatus: loc.status,
      countryCode: loc.countryCode, locationResolvedName: loc.resolvedName, locationResolvedAt: loc.resolvedAt
    },
    unset: []
  };
}

// For PATCH: only re-evaluate when the institution or country actually
// changed (compared after trim/case/punctuation normalization). An edit that
// leaves both alone — including the Edit form re-sending the same values —
// keeps whatever location the record already has, valid legacy coordinates
// included. Returns null (no location change) or { set, unset }.
async function resolveForUpdate(existing, fields) {
  if (!existing) return null;
  const nextInst = fields.inst !== undefined ? fields.inst : existing.inst;
  const nextCountry = fields.country !== undefined ? fields.country : existing.country;
  const unchanged = normalizeKey(nextInst) === normalizeKey(existing.inst)
    && normalizeKey(nextCountry) === normalizeKey(existing.country);
  if (unchanged) return null;
  return buildLocationUpdate(await resolveLocation({ institution: nextInst, country: nextCountry }));
}

// What the preview endpoint / UI are allowed to see.
function toPublicLocation(loc) {
  const out = {
    status: loc.status, source: loc.source, precision: loc.precision, reason: loc.reason,
    lat: loc.lat, lng: loc.lng, countryCode: loc.countryCode, resolvedName: loc.resolvedName
  };
  if (loc.suggestion) out.suggestion = loc.suggestion;
  return out;
}

function resetForTests() {
  config = { ...DEFAULT_CONFIG };
  providerOverride = UNSET;
  chain = Promise.resolve();
  lastStart = 0;
  pending = 0;
  inflight.clear();
}

module.exports = {
  resolveLocation, resolveForUpdate, buildLocationUpdate, toPublicLocation,
  isValidCoordinate, configure, setProvider, resetForTests,
  LOCATION_FIELDS,
  _internals: { pickConfidentCandidate, tokens, getConfig: () => config }
};
