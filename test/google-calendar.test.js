// Covers the 2026-08-02 Google Calendar integration: a single, org-wide
// Google account (connected once by an Administrator) is used to create/
// update/delete calendar events, with CIPRMS recipients added as Calendar
// API attendees. No real Google credentials/network calls are exercised
// here — that requires a live OAuth consent screen a human must complete
// (see docs/SYSTEM_AUDIT_2026-07-16.md for that manual verification step).
// What IS fully testable without Google: token encryption, the CIRL-event
// to Google-event payload mapping, the "not connected" short-circuit (zero
// network calls), RBAC on the new routes, and that the underlying calendar
// event feature keeps working exactly as before regardless of connection
// state (the core "never blocks the real feature" requirement).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { encrypt, decrypt } = require('../services/tokenCrypto');
const googleCalendarService = require('../services/googleCalendarService');

let adminAgent, personnelAgent, partnerAgent, staffAgent;
let db;
let createdEventIds = [];

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await db.collection('googleCalendarIntegration').deleteMany({});
  await cleanupAll();
  await closeDB();
});

describe('tokenCrypto', () => {
  test('encrypt/decrypt round-trips a refresh-token-shaped string', () => {
    const secret = '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-jesttest-refresh-token';
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(':').length).toBe(3);
    expect(decrypt(encrypted)).toBe(secret);
  });

  test('a tampered payload fails to decrypt (GCM auth tag catches it)', () => {
    const encrypted = encrypt('jesttest-secret');
    const [iv, tag, cipher] = encrypted.split(':');
    const tampered = [iv, tag, cipher.slice(0, -2) + '00'].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe('googleCalendarService payload mapping', () => {
  test('maps a timed event correctly', () => {
    const body = googleCalendarService.buildGoogleEventBody(
      { title: 'jesttest MOA Renewal', start: '2026-08-05T09:00', end: '2026-08-05T10:00', allDay: false, location: 'Osaka', description: 'desc' },
      ['a@example.com', 'b@example.com']
    );
    expect(body.summary).toBe('jesttest MOA Renewal');
    expect(body.location).toBe('Osaka');
    expect(body.start).toHaveProperty('dateTime');
    expect(body.end).toHaveProperty('dateTime');
    expect(body.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  });

  test('maps an all-day event using date (not dateTime) fields', () => {
    const body = googleCalendarService.buildGoogleEventBody(
      { title: 'jesttest Holiday', start: '2026-08-05T00:00', allDay: true },
      ['a@example.com']
    );
    expect(body.start).toEqual({ date: '2026-08-05' });
    expect(body.end).toEqual({ date: '2026-08-05' });
  });
});

describe('googleCalendarService "not connected" short-circuit (no network calls)', () => {
  beforeEach(async () => { await db.collection('googleCalendarIntegration').deleteMany({}); });

  test('isConnected is false with no integration doc', async () => {
    expect(await googleCalendarService.isConnected(db)).toBe(false);
  });

  test('isConnected is true once an integration doc exists', async () => {
    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });
    expect(await googleCalendarService.isConnected(db)).toBe(true);
  });

  test('createGoogleEvent short-circuits to not_connected', async () => {
    const result = await googleCalendarService.createGoogleEvent(db, { title: 'jesttest' }, ['a@example.com']);
    expect(result).toEqual({ ok: false, error: 'not_connected' });
  });

  test('updateGoogleEvent short-circuits to no_google_event when the CIRL event has none', async () => {
    const result = await googleCalendarService.updateGoogleEvent(db, { title: 'jesttest' }, ['a@example.com']);
    expect(result).toEqual({ ok: false, error: 'no_google_event' });
  });

  test('deleteGoogleEvent short-circuits to no_google_event when id is falsy', async () => {
    const result = await googleCalendarService.deleteGoogleEvent(db, null);
    expect(result).toEqual({ ok: false, error: 'no_google_event' });
  });
});

describe('New route RBAC (all requireAdmin)', () => {
  test('Administrator can reach /api/google-calendar/status', async () => {
    const res = await adminAgent.get('/api/google-calendar/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connected');
  });

  test('Auth. Personnel, potential_partner, and Staff are redirected from every google-calendar route', async () => {
    for (const agent of [personnelAgent, partnerAgent, staffAgent]) {
      expect((await agent.get('/api/google-calendar/status')).status).toBe(302);
      expect((await agent.get('/api/google-calendar/connect')).status).toBe(302);
      expect((await agent.post('/api/google-calendar/disconnect')).status).toBe(302);
    }
  });

  test('No session redirects rather than leaking status', async () => {
    expect((await request(app).get('/api/google-calendar/status')).status).toBe(302);
  });

  test('/api/google-calendar/connect redirects an Administrator to a real Google OAuth URL', async () => {
    const res = await adminAgent.get('/api/google-calendar/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2/);
    expect(res.headers.location).toContain('calendar.events');
  });
});

describe('Existing calendar-event feature is unaffected when Google Calendar is not connected', () => {
  beforeAll(async () => { await db.collection('googleCalendarIntegration').deleteMany({}); });

  test('creating an event still succeeds and still has no googleEventId', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Calendar Sync Regression', start: '2026-09-01T09:00', allDay: false,
      recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdEventIds.push(res.body.event.id);
    expect(res.body.event.googleEventId).toBeUndefined();
  });

  test('editing and deleting that event still succeed with no Google connection', async () => {
    const id = createdEventIds[createdEventIds.length - 1];
    const patchRes = await adminAgent.patch('/api/calendarevents/' + id).send({ title: 'jesttest Calendar Sync Regression (edited)' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.event.title).toBe('jesttest Calendar Sync Regression (edited)');

    const deleteRes = await adminAgent.delete('/api/calendarevents/' + id);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    createdEventIds.pop();
  });
});

// 2026-08-02 bug fix: an event with recipients=['all'] (isScoped=false) got a
// googleEventId at creation, but never had `recipientEmails` persisted (that
// field deliberately drives CIPRMS's own visibility filter, not Google sync)
// — so the very first edit passed `undefined` as the attendee list, which
// buildGoogleEventBody turned into `attendees: []`, silently wiping every
// attendee off the real Google event. Fixed by persisting a separate,
// always-populated `googleAttendeeEmails` field and having PATCH read that
// instead of `recipientEmails`.
describe('googleAttendeeEmails persistence (attendee-wipe-on-update bug fix)', () => {
  test('a scoped event (specific individual recipient) persists recipientEmails AND googleAttendeeEmails identically', async () => {
    const target = await createTestUser({ role: 'Auth. Personnel' });
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Attendee Persistence Scoped', start: '2026-09-02T09:00', allDay: false,
      recipients: [target.email]
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(doc.recipientEmails).toEqual([target.email]);
    expect(doc.googleAttendeeEmails).toEqual([target.email]);
  });

  test('an "all users" event persists googleAttendeeEmails but NOT recipientEmails (the exact bug scenario)', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Attendee Persistence All Users', start: '2026-09-03T09:00', allDay: false,
      recipients: ['all']
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(doc.recipientEmails).toBeUndefined(); // unchanged, intentional — drives public visibility
    expect(Array.isArray(doc.googleAttendeeEmails)).toBe(true);
    expect(doc.googleAttendeeEmails.length).toBeGreaterThan(0);
  });

  test('an event with no recipients gets neither field', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Attendee Persistence None', start: '2026-09-04T09:00', allDay: false, recipients: []
    });
    expect(res.status).toBe(200);
    createdEventIds.push(res.body.event.id);
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(doc.recipientEmails).toBeUndefined();
    expect(doc.googleAttendeeEmails).toBeUndefined();
  });
});

// Uses jest.isolateModules + jest.doMock to swap in a fake googleapis client
// for exactly one test at a time, without disturbing the real googleapis
// import already loaded at the top of this file (used by every other test,
// several of which deliberately hit Google's live network — see below).
describe('updateGoogleEvent regression test: sends the real attendee list, never an empty one', () => {
  afterEach(async () => {
    jest.dontMock('googleapis');
    await db.collection('googleCalendarIntegration').deleteMany({});
  });

  test('patch requestBody.attendees matches the passed recipientEmails exactly', async () => {
    let capturedBody = null;
    let isolatedService;
    jest.isolateModules(() => {
      jest.doMock('googleapis', () => ({
        google: {
          auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn() })) },
          calendar: jest.fn().mockReturnValue({
            events: {
              patch: jest.fn((args) => { capturedBody = args.requestBody; return Promise.resolve({ data: {} }); })
            }
          })
        }
      }));
      isolatedService = require('../services/googleCalendarService');
    });

    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-fake-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });

    const result = await isolatedService.updateGoogleEvent(
      db,
      { title: 'jesttest Update', start: '2026-09-05T09:00', googleEventId: 'jesttest-fake-google-id-123' },
      ['a@example.com', 'b@example.com']
    );

    expect(result.ok).toBe(true);
    expect(capturedBody.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  });

  test('missing/undefined recipientEmails would previously wipe attendees — confirms it no longer happens for a correctly-populated googleAttendeeEmails call', async () => {
    let capturedBody = null;
    let isolatedService;
    jest.isolateModules(() => {
      jest.doMock('googleapis', () => ({
        google: {
          auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn() })) },
          calendar: jest.fn().mockReturnValue({
            events: { patch: jest.fn((args) => { capturedBody = args.requestBody; return Promise.resolve({ data: {} }); }) }
          })
        }
      }));
      isolatedService = require('../services/googleCalendarService');
    });

    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-fake-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });

    // Simulates cirl.js's PATCH handler: passes updated.googleAttendeeEmails
    // (always populated when the event had any real recipients), not
    // updated.recipientEmails (absent for "all users" events).
    const cirlEvent = { title: 'jesttest', start: '2026-09-06T09:00', googleEventId: 'jesttest-fake-id', googleAttendeeEmails: ['c@example.com'] };
    await isolatedService.updateGoogleEvent(db, cirlEvent, cirlEvent.googleAttendeeEmails);
    expect(capturedBody.attendees).toEqual([{ email: 'c@example.com' }]);
  });
});

// These hit Google's real, live token-refresh endpoint over the network with
// deliberately-invalid credentials — genuine network access is available in
// this environment (confirmed separately), so this exercises the actual
// failure path a revoked grant or corrupted stored token would hit in
// production, not just a simulated one.
describe('Failure handling — invalid/expired credentials against the real Google network', () => {
  afterEach(async () => { await db.collection('googleCalendarIntegration').deleteMany({}); });

  test('createGoogleEvent fails gracefully with a garbage refresh token, and records the sync failure for the Integrations UI', async () => {
    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-not-a-real-refresh-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });

    const result = await googleCalendarService.createGoogleEvent(db, { title: 'jesttest' }, ['a@example.com']);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const integration = await db.collection('googleCalendarIntegration').findOne({});
    expect(integration.lastSyncOk).toBe(false);
    expect(integration.lastSyncError).toBeTruthy();
    expect(integration.lastSyncAt).toBeTruthy();
  }, 20000);

  test('deleteGoogleEvent fails gracefully (never throws) with a garbage refresh token', async () => {
    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-not-a-real-refresh-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });
    const result = await googleCalendarService.deleteGoogleEvent(db, 'jesttest-some-event-id');
    expect(result.ok).toBe(false);
  }, 20000);

  test('a corrupted encryptedRefreshToken value (fails to decrypt) is caught, not thrown', async () => {
    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: 'not-even-a-valid-encrypted-payload',
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });
    const result = await googleCalendarService.createGoogleEvent(db, { title: 'jesttest' }, ['a@example.com']);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('Disconnect lifecycle', () => {
  test('disconnect() removes the integration doc even when the stored token is garbage (best-effort revoke)', async () => {
    await db.collection('googleCalendarIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', encryptedRefreshToken: encrypt('jesttest-garbage-token'),
      calendarId: 'primary', connectedAt: new Date().toISOString()
    });
    await expect(googleCalendarService.disconnect(db)).resolves.not.toThrow();
    expect(await googleCalendarService.isConnected(db)).toBe(false);
  }, 20000);

  test('after disconnect, sync calls short-circuit to not_connected again', async () => {
    const result = await googleCalendarService.createGoogleEvent(db, { title: 'jesttest' }, ['a@example.com']);
    expect(result).toEqual({ ok: false, error: 'not_connected' });
  });
});

// Exercises handleOAuthCallback's own defensive check without needing a real
// one-time-use Google auth code (which only a live consent screen can
// produce) — mocks just the token exchange to return a response with no
// refresh_token, the one case Google itself can return legitimately (e.g. on
// a repeat authorization without prompt=consent, though this app always
// requests prompt=consent specifically to avoid it).
describe('handleOAuthCallback defensive check: missing refresh token', () => {
  afterEach(() => jest.dontMock('googleapis'));

  test('throws a clear error instead of silently storing a token-less connection', async () => {
    let isolatedService;
    jest.isolateModules(() => {
      jest.doMock('googleapis', () => ({
        google: {
          auth: { OAuth2: jest.fn().mockImplementation(() => ({
            getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'fake-access-token-no-refresh' } })
          })) },
          calendar: jest.fn()
        }
      }));
      isolatedService = require('../services/googleCalendarService');
    });

    await expect(
      isolatedService.handleOAuthCallback(db, 'jesttest-fake-code', 'http://localhost:3000/api/google-calendar/callback', { email: 'jesttest@example.com', name: 'Jest Admin' })
    ).rejects.toThrow(/refresh token/i);

    // Confirms nothing was persisted from the failed attempt.
    expect(await db.collection('googleCalendarIntegration').findOne({ connectedByEmail: 'jesttest@example.com' })).toBeNull();
  });
});
