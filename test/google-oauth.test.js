// Google Calendar OAuth connection (Settings → Integrations): how the connection is
// made, stored, reused after a restart, refreshed, verified, disconnected — and that
// no credential ever reaches a page, a JSON response, the database in clear text or
// the log. googleapis is mocked (a real consent screen needs a human), and every
// database write goes to the throw-away collection from test/setup-env.js — never
// the real `googleCalendarIntegration`.
const mockG = {
  tokens: null, getTokenError: null, listError: null, listSummary: 'organizer.account@example.org',
  codes: [], credentialsSet: [], tokenListeners: [], revoked: [], insertError: null
};
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn((c) => { mockG.credentialsSet.push(JSON.parse(JSON.stringify(c))); }),
        on: jest.fn((event, fn) => { if (event === 'tokens') mockG.tokenListeners.push(fn); }),
        generateAuthUrl: jest.fn((o) => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ access_type: o.access_type, prompt: o.prompt, scope: o.scope.join(' '), state: o.state, client_id: 'mock-client' })),
        getToken: jest.fn(async (code) => { mockG.codes.push(code); if (mockG.getTokenError) throw mockG.getTokenError; return { tokens: mockG.tokens }; }),
        revokeToken: jest.fn(async (token) => { mockG.revoked.push(token); return {}; })
      }))
    },
    calendar: jest.fn(() => ({
      events: {
        list: jest.fn(async () => { if (mockG.listError) throw mockG.listError; return { data: { summary: mockG.listSummary, timeZone: 'Asia/Manila', items: [] } }; }),
        insert: jest.fn(async (args) => { if (mockG.insertError) throw mockG.insertError; return { data: { id: args.requestBody.id, organizer: { email: 'organizer.account@example.org' } } }; }),
        patch: jest.fn(async (args) => ({ data: { id: args.eventId } })),
        delete: jest.fn(async () => ({}))
      }
    }))
  }
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { encrypt, decrypt } = require('../services/tokenCrypto');
const googleCalendarService = require('../services/googleCalendarService');

const REFRESH = 'jesttest-REFRESH-TOKEN-1//0gAbCdEfGhIjKlMnOpQrStUvWxYz';
const ACCESS = 'ya29.jesttest-ACCESS-TOKEN-a0AbCdEfGhIjKlMn';
let db, adminAgent, personnelAgent;
const integration = () => db.collection(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION);

async function startConnect(agent = adminAgent) {
  const res = await agent.get('/api/google-calendar/connect');
  const url = new URL(res.headers.location);
  return { res, state: url.searchParams.get('state'), url };
}
const callback = (agent, query) => agent.get('/api/google-calendar/callback').query(query);

beforeAll(async () => {
  db = await connectDB();
  await integration().deleteMany({});
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
});
afterAll(async () => {
  await integration().deleteMany({});
  await cleanupAll();
  await closeDB();
});
beforeEach(async () => {
  await integration().deleteMany({});
  Object.assign(mockG, { tokens: { refresh_token: REFRESH, access_token: ACCESS }, getTokenError: null, listError: null, listSummary: 'organizer.account@example.org', insertError: null });
  mockG.codes.length = 0; mockG.credentialsSet.length = 0; mockG.tokenListeners.length = 0; mockG.revoked.length = 0;
});

describe('tests can never reach the real connection', () => {
  test('the test process uses a throw-away collection, and the service refuses the real one under Jest', async () => {
    expect(process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION).toBe('jesttest_googleCalendarIntegration');
    const saved = process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION;
    delete process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION;
    try {
      await expect(googleCalendarService.isConnected(db)).rejects.toThrow(/Refusing to use the real googleCalendarIntegration collection/);
      await expect(googleCalendarService.disconnect(db)).rejects.toThrow(/Refusing/);
    } finally {
      process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION = saved;
    }
  });

  test('no test file writes to the real collection by name', () => {
    const dir = __dirname;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'setup-env.js' && f !== 'google-oauth.test.js')) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect({ file, usesRealName: /collection\(\s*['"]googleCalendarIntegration['"]\s*\)/.test(text) }).toEqual({ file, usesRealName: false });
    }
  });
});

describe('connect', () => {
  test('sends an Administrator to Google with offline access, consent, calendar.events scope and a random state — and no client secret', async () => {
    const { res, state, url } = await startConnect();
    expect(res.status).toBe(302);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.location).not.toContain(process.env.GOOGLE_CLIENT_SECRET);
    expect(res.headers.location).not.toMatch(/client_secret/);
  });

  test('every connect attempt gets a fresh state', async () => {
    expect((await startConnect()).state).not.toBe((await startConnect()).state);
  });

  test('only an Administrator can start, finish, check or disconnect the connection', async () => {
    for (const [method, url] of [['get', '/api/google-calendar/connect'], ['get', '/api/google-calendar/callback?code=x&state=y'], ['post', '/api/google-calendar/verify'], ['post', '/api/google-calendar/disconnect'], ['get', '/api/google-calendar/status']]) {
      expect((await personnelAgent[method](url)).status).toBe(302);
      expect((await request(app)[method](url)).status).toBe(302);
    }
  });
});

describe('callback', () => {
  test('a valid callback stores the refresh token ENCRYPTED, keeps no access token, records the real Google account, and reports connected', async () => {
    const { state } = await startConnect();
    const res = await callback(adminAgent, { code: 'jesttest-auth-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/settings?googleCalendar=connected');
    expect(mockG.codes).toEqual(['jesttest-auth-code']);

    const docs = await integration().find({}).toArray();
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.encryptedRefreshToken).not.toContain(REFRESH);
    expect(decrypt(doc.encryptedRefreshToken)).toBe(REFRESH);
    expect(JSON.stringify(doc)).not.toContain(ACCESS);
    expect(JSON.stringify(doc)).not.toContain('access_token');
    expect(doc.googleAccountEmail).toBe('organizer.account@example.org');
    expect(doc.calendarTimeZone).toBe('Asia/Manila');
    expect(doc.lastSyncOk).toBe(true);
  });

  test('the state is single-use and must match: a wrong, missing or replayed state stores nothing and never calls Google', async () => {
    const first = await startConnect();
    const wrong = await callback(adminAgent, { code: 'x', state: 'f'.repeat(32) });
    expect(wrong.headers.location).toBe('/admin/settings?googleCalendar=error&reason=state');

    // the failed attempt consumed the stored state, so even the "right" value is now dead
    const replay = await callback(adminAgent, { code: 'x', state: first.state });
    expect(replay.headers.location).toBe('/admin/settings?googleCalendar=error&reason=state');

    const noConnect = await callback(adminAgent, { code: 'x' });
    expect(noConnect.headers.location).toBe('/admin/settings?googleCalendar=error&reason=state');

    const second = await startConnect();
    expect((await callback(adminAgent, { code: 'x', state: second.state })).headers.location).toContain('googleCalendar=connected');
    expect((await callback(adminAgent, { code: 'x', state: second.state })).headers.location).toContain('reason=state');
    expect(mockG.codes).toEqual(['x']); // exchanged exactly once — only for the one valid attempt
  });

  test('declining on the Google screen is handled cleanly', async () => {
    const { state } = await startConnect();
    const res = await callback(adminAgent, { error: 'access_denied', state });
    expect(res.headers.location).toBe('/admin/settings?googleCalendar=error&reason=denied');
    expect(await integration().countDocuments()).toBe(0);
    expect(mockG.codes).toHaveLength(0);
  });

  test('a token-exchange failure reports a reason and does not touch an existing connection', async () => {
    await integration().insertOne({ connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-existing-token'), calendarId: 'primary', connectedAt: 'before' });
    mockG.getTokenError = new Error('redirect_uri_mismatch');
    const { state } = await startConnect();
    const res = await callback(adminAgent, { code: 'x', state });
    expect(res.headers.location).toBe('/admin/settings?googleCalendar=error&reason=redirect_uri');
    const docs = await integration().find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(decrypt(docs[0].encryptedRefreshToken)).toBe('jesttest-existing-token');
  });

  test('Google returning no refresh token is a clear error and stores nothing', async () => {
    mockG.tokens = { access_token: ACCESS };
    const { state } = await startConnect();
    const res = await callback(adminAgent, { code: 'x', state });
    expect(res.headers.location).toBe('/admin/settings?googleCalendar=error&reason=no_refresh_token');
    expect(await integration().countDocuments()).toBe(0);
  });

  test('a connection whose first check fails (e.g. Calendar API not enabled) is stored but flagged, with a plain instruction', async () => {
    mockG.listError = new Error('Google Calendar API has not been used in project 123456 before or it is disabled.');
    const { state } = await startConnect();
    const res = await callback(adminAgent, { code: 'x', state });
    expect(res.headers.location).toBe('/admin/settings?googleCalendar=connected_unverified');
    const doc = await integration().findOne({});
    expect(doc).toBeTruthy();
    expect(doc.lastSyncOk).toBe(false);
    expect(doc.lastSyncError).toMatch(/Google Calendar API is not enabled/);
  });

  test('reconnecting replaces the old connection rather than adding a second', async () => {
    for (const token of ['jesttest-first', 'jesttest-second']) {
      mockG.tokens = { refresh_token: token };
      const { state } = await startConnect();
      await callback(adminAgent, { code: 'x', state });
    }
    const docs = await integration().find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(decrypt(docs[0].encryptedRefreshToken)).toBe('jesttest-second');
  });
});

describe('status and Settings page never expose credentials', () => {
  test('status (connected and not connected) contains no token, secret or encrypted payload', async () => {
    const before = await adminAgent.get('/api/google-calendar/status');
    expect(before.body).toMatchObject({ connected: false, configured: true, timeZone: 'Asia/Manila' });
    expect(before.body.redirectUri).toMatch(/\/api\/google-calendar\/callback$/);

    const { state } = await startConnect();
    await callback(adminAgent, { code: 'x', state });
    const after = await adminAgent.get('/api/google-calendar/status');
    expect(after.body).toMatchObject({ connected: true, googleAccountEmail: 'organizer.account@example.org', calendarTimeZone: 'Asia/Manila', lastSyncOk: true });

    const doc = await integration().findOne({});
    for (const body of [JSON.stringify(before.body), JSON.stringify(after.body)]) {
      expect(body).not.toContain(REFRESH);
      expect(body).not.toContain(ACCESS);
      expect(body).not.toContain(process.env.GOOGLE_CLIENT_SECRET);
      expect(body).not.toContain(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
      expect(body).not.toMatch(/encryptedRefreshToken|refresh_token|access_token/);
      if (doc) expect(body).not.toContain(doc.encryptedRefreshToken);
    }
  });

  test('the Settings page and every served front-end file are free of the Google client secret and the encryption key', async () => {
    const page = await adminAgent.get('/admin/settings');
    expect(page.status).toBe(200);
    for (const secret of [process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_TOKEN_ENCRYPTION_KEY]) {
      expect(page.text).not.toContain(secret);
    }
    const root = path.join(__dirname, '..');
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!['node_modules', 'libs', 'uploads'].includes(entry.name)) walk(full, out); }
        else if (/\.(ejs|html|js|css|json|txt|map)$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const served = [...walk(path.join(root, 'views')), ...walk(path.join(root, 'public')), ...walk(path.join(root, 'assets'))];
    expect(served.length).toBeGreaterThan(20);
    const leaks = served.filter(f => { const t = fs.readFileSync(f, 'utf8'); return t.includes(process.env.GOOGLE_CLIENT_SECRET) || t.includes(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY); });
    expect(leaks).toEqual([]);
    expect((await request(app).get('/.env')).status).not.toBe(200);
  });
});

describe('after a restart, refresh and rotation', () => {
  async function connect() {
    const { state } = await startConnect();
    await callback(adminAgent, { code: 'x', state });
    mockG.credentialsSet.length = 0;
  }

  test('a fresh process (new module instance) works from the database alone, using ONLY the stored refresh token', async () => {
    await connect();
    let restarted;
    jest.isolateModules(() => { restarted = require('../services/googleCalendarService'); }); // "restart": nothing carried over in memory
    const result = await restarted.createGoogleEvent(db, { title: 'jesttest', start: '2026-12-01T09:00', end: '2026-12-01T10:00', googleEventKey: 'ciprmsabc123def456ghi789' }, ['a@example.com']);
    expect(result.ok).toBe(true);
    expect(result.organizerEmail).toBe('organizer.account@example.org');
    // Only the refresh token is handed to Google's client; googleapis exchanges it for a fresh
    // access token on demand (so an expired access token is never reused).
    expect(mockG.credentialsSet).toEqual([{ refresh_token: REFRESH }]);
  });

  test('a refresh token Google rotates is persisted (encrypted); the short-lived access token is not', async () => {
    await connect();
    await googleCalendarService.createGoogleEvent(db, { title: 'jesttest', start: '2026-12-01T09:00', googleEventKey: 'ciprmsabc123def456ghi789' }, ['a@example.com']);
    expect(mockG.tokenListeners.length).toBeGreaterThan(0);
    mockG.tokenListeners[mockG.tokenListeners.length - 1]({ access_token: 'ya29.jesttest-new-access', refresh_token: 'jesttest-ROTATED-refresh' });
    await new Promise(r => setTimeout(r, 300));
    const doc = await integration().findOne({});
    expect(decrypt(doc.encryptedRefreshToken)).toBe('jesttest-ROTATED-refresh');
    expect(JSON.stringify(doc)).not.toContain('ya29.jesttest-new-access');
  });

  test('"Check connection" verifies the whole chain and records the outcome; failure is reported, not thrown', async () => {
    await connect();
    const ok = await adminAgent.post('/api/google-calendar/verify');
    expect(ok.body).toMatchObject({ success: true, googleAccountEmail: 'organizer.account@example.org', calendarTimeZone: 'Asia/Manila' });

    mockG.listError = new Error('invalid_grant');
    const bad = await adminAgent.post('/api/google-calendar/verify');
    expect(bad.status).toBe(200);
    expect(bad.body.success).toBe(false);
    expect(bad.body.error).toMatch(/revoked or expired/);
    expect((await integration().findOne({})).lastSyncOk).toBe(false);
  });

  test('with nothing connected, Check connection says so and any sync fails gracefully', async () => {
    const res = await adminAgent.post('/api/google-calendar/verify');
    expect(res.body).toEqual({ success: false, error: 'Google Calendar is not connected.' });
    expect(await googleCalendarService.createGoogleEvent(db, { title: 'x', start: '2026-12-01T09:00' }, ['a@example.com'])).toEqual({ ok: false, error: 'not_connected' });
  });

  test('a token stored under a different encryption key gives an actionable message, not a crash', async () => {
    // a perfectly valid payload — but encrypted with some OTHER server's key
    const original = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const foreign = encrypt('jesttest-token-from-another-key');
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = original;
    await integration().insertOne({ connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: foreign, calendarId: 'primary', connectedAt: 'x' });
    const result = await googleCalendarService.createGoogleEvent(db, { title: 'x', start: '2026-12-01T09:00' }, ['a@example.com']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be decrypted with this server's GOOGLE_TOKEN_ENCRYPTION_KEY/);
  });

  test('Disconnect revokes the REFRESH token with Google and removes the stored connection', async () => {
    await connect();
    expect((await adminAgent.post('/api/google-calendar/disconnect')).body).toEqual({ success: true });
    expect(mockG.revoked).toEqual([REFRESH]);
    expect(await integration().countDocuments()).toBe(0);
  });
});

describe('no credential in logs, stored errors or returned errors', () => {
  test('an error that echoes tokens and the client secret is redacted everywhere it can land', async () => {
    const { state } = await startConnect();
    await callback(adminAgent, { code: 'x', state });
    const logged = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
    try {
      mockG.insertError = new Error(`Request failed access_token=${ACCESS}&refresh_token=${REFRESH} client_secret=${process.env.GOOGLE_CLIENT_SECRET} secret:${process.env.GOOGLE_CLIENT_SECRET} {"refresh_token":"${REFRESH}"} bearer ${ACCESS}`);
      const result = await googleCalendarService.createGoogleEvent(db, { title: 'jesttest', start: '2026-12-01T09:00', googleEventKey: 'ciprmsabc123def456ghi789' }, ['a@example.com']);
      expect(result.ok).toBe(false);
      const stored = (await integration().findOne({})).lastSyncError;
      const everywhere = [result.error, stored, ...logged].join('\n');
      for (const secret of [ACCESS, REFRESH, process.env.GOOGLE_CLIENT_SECRET]) expect(everywhere).not.toContain(secret);
      expect(everywhere).toContain('[redacted]');
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('a failed OAuth callback logs a redacted reason only', async () => {
    const logged = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
    try {
      mockG.getTokenError = new Error(`invalid_grant code=4/0AbCdEf client_secret=${process.env.GOOGLE_CLIENT_SECRET}`);
      const { state } = await startConnect();
      await callback(adminAgent, { code: '4/0AbCdEf', state });
      const out = logged.join('\n');
      expect(out).not.toContain('4/0AbCdEf');
      expect(out).not.toContain(process.env.GOOGLE_CLIENT_SECRET);
    } finally {
      spy.mockRestore();
    }
  });

  test('describeGoogleError / redact leave ordinary messages alone', () => {
    expect(googleCalendarService.describeGoogleError(new Error('Invalid attendee email'))).toBe('Invalid attendee email');
    expect(googleCalendarService.redact('The requested identifier already exists.')).toBe('The requested identifier already exists.');
  });
});
