// Google Calendar integration (2026-08-02) — a single, org-wide Google
// account (connected once by an Administrator) is used to create/update/
// delete calendar events, with CIPRMS recipients added as Calendar API
// attendees so Google emails them an invite that syncs to their phone. This
// is deliberately NOT per-user OAuth — see docs/SYSTEM_AUDIT_2026-07-16.md
// for the architecture rationale. It reuses the existing GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET env vars (already present for the unrelated
// passport-google-oauth20 *login* flow) but is otherwise fully independent
// of passport — passport's login flow discards its OAuth tokens, whereas
// this needs to capture and persist a refresh token, so it talks to
// googleapis's own OAuth2Client directly.
const { google } = require('googleapis');
const { encrypt, decrypt } = require('./tokenCrypto');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const CALENDAR_ID = 'primary';

function buildOAuthClient(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function getAuthUrl(redirectUri, state) {
  const client = buildOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent',      // forces the consent screen every time, so a refresh_token is issued even on reconnect
    scope: SCOPES,
    state
  });
}

async function handleOAuthCallback(db, code, redirectUri, connectedBy) {
  const client = buildOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token — try disconnecting any prior grant for this app in your Google Account settings, then reconnect.');
  }
  await db.collection('googleCalendarIntegration').deleteMany({});
  await db.collection('googleCalendarIntegration').insertOne({
    connectedByEmail: connectedBy.email,
    connectedByName: connectedBy.name,
    encryptedRefreshToken: encrypt(tokens.refresh_token),
    calendarId: CALENDAR_ID,
    connectedAt: new Date().toISOString()
  });
}

async function getIntegration(db) {
  return db.collection('googleCalendarIntegration').findOne({});
}

async function isConnected(db) {
  const doc = await getIntegration(db);
  return !!doc;
}

async function disconnect(db) {
  const doc = await getIntegration(db);
  if (doc) {
    try {
      const client = buildOAuthClient();
      client.setCredentials({ refresh_token: decrypt(doc.encryptedRefreshToken) });
      await client.revokeCredentials();
    } catch (err) {
      // Best-effort — the token may already be invalid/revoked on Google's
      // side; either way we still remove our own stored copy below.
      console.error('Google Calendar: revoke during disconnect failed (continuing):', err.message);
    }
  }
  await db.collection('googleCalendarIntegration').deleteMany({});
}

// googleapis auto-refreshes the access token from the stored refresh token
// as needed for each API call — no separate refresh scheduling required.
// Google occasionally rotates the refresh token itself (rare, but documented
// behavior); the 'tokens' listener persists a new one if issued, so a later
// call never fails against a refresh token we've silently invalidated on our
// own end by not keeping up with a rotation.
async function getAuthorizedCalendarClient(db) {
  const doc = await getIntegration(db);
  if (!doc) return null;
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: decrypt(doc.encryptedRefreshToken) });
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      db.collection('googleCalendarIntegration')
        .updateOne({ _id: doc._id }, { $set: { encryptedRefreshToken: encrypt(tokens.refresh_token) } })
        .catch((err) => console.error('Google Calendar: failed to persist rotated refresh token:', err.message));
    }
  });
  return { calendar: google.calendar({ version: 'v3', auth: client }), calendarId: doc.calendarId || CALENDAR_ID };
}

// Tracks the health of the connection for the Settings > Integrations UI —
// without this, a revoked/expired grant would fail silently (event creation
// still succeeds in CIPRMS, per the "never block the real feature"
// contract) with no visible signal to the Administrator that Google sync
// has actually stopped working.
async function recordSyncResult(db, ok, error) {
  try {
    await db.collection('googleCalendarIntegration').updateOne({}, {
      $set: { lastSyncOk: ok, lastSyncAt: new Date().toISOString(), lastSyncError: ok ? null : (error || 'Unknown error') }
    });
  } catch (err) {
    console.error('Google Calendar: failed to record sync result:', err.message);
  }
}

function toGoogleDateField(value, allDay) {
  if (!value) return undefined;
  return allDay ? { date: String(value).slice(0, 10) } : { dateTime: new Date(value).toISOString() };
}

function buildGoogleEventBody(cirlEvent, recipientEmails) {
  return {
    summary: cirlEvent.title,
    location: cirlEvent.location || undefined,
    description: cirlEvent.description || undefined,
    start: toGoogleDateField(cirlEvent.start, cirlEvent.allDay),
    end: toGoogleDateField(cirlEvent.end || cirlEvent.start, cirlEvent.allDay),
    attendees: (recipientEmails || []).map((email) => ({ email }))
  };
}

// Every function below returns { ok, ... } rather than throwing, so callers
// in cirl.js never need try/catch around them — a Google API hiccup must
// never block the underlying CIPRMS event's own create/update/delete.
// recordSyncResult() is only called once we've established there IS a real
// connection to attempt against (not for not_connected/no_recipients/
// no_google_event, which are normal, expected states — not a broken
// connection).
async function createGoogleEvent(db, cirlEvent, recipientEmails) {
  let client;
  try {
    client = await getAuthorizedCalendarClient(db);
  } catch (err) {
    console.error('Google Calendar: failed to build authorized client:', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
  if (!client) return { ok: false, error: 'not_connected' };
  if (!recipientEmails || !recipientEmails.length) return { ok: false, error: 'no_recipients' };
  try {
    const res = await client.calendar.events.insert({
      calendarId: client.calendarId,
      requestBody: buildGoogleEventBody(cirlEvent, recipientEmails),
      sendUpdates: 'all'
    });
    await recordSyncResult(db, true, null);
    return { ok: true, googleEventId: res.data.id };
  } catch (err) {
    console.error('Google Calendar: createGoogleEvent failed:', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
}

async function updateGoogleEvent(db, cirlEvent, recipientEmails) {
  if (!cirlEvent.googleEventId) return { ok: false, error: 'no_google_event' };
  let client;
  try {
    client = await getAuthorizedCalendarClient(db);
  } catch (err) {
    console.error('Google Calendar: failed to build authorized client:', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    await client.calendar.events.patch({
      calendarId: client.calendarId,
      eventId: cirlEvent.googleEventId,
      // recipientEmails here should be the event's STABLE attendee list
      // (cirl.js passes googleAttendeeEmails, captured once at creation) —
      // never the visibility-driving recipientEmails, which is absent
      // entirely for "all users" events and would otherwise silently wipe
      // every attendee off the Google event on the very first edit.
      requestBody: buildGoogleEventBody(cirlEvent, recipientEmails),
      sendUpdates: 'all'
    });
    await recordSyncResult(db, true, null);
    return { ok: true };
  } catch (err) {
    console.error('Google Calendar: updateGoogleEvent failed:', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
}

async function deleteGoogleEvent(db, googleEventId) {
  if (!googleEventId) return { ok: false, error: 'no_google_event' };
  let client;
  try {
    client = await getAuthorizedCalendarClient(db);
  } catch (err) {
    console.error('Google Calendar: failed to build authorized client:', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    await client.calendar.events.delete({ calendarId: client.calendarId, eventId: googleEventId, sendUpdates: 'all' });
    await recordSyncResult(db, true, null);
    return { ok: true };
  } catch (err) {
    // A 404/410 here just means the event is already gone on Google's side
    // (e.g. a recipient deleted it, or it was already removed) — not a real
    // failure from CIPRMS's point of view, but still recorded so a genuinely
    // broken connection (e.g. revoked grant) doesn't look identical to that
    // benign case in the logs.
    console.error('Google Calendar: deleteGoogleEvent failed (continuing):', err.message);
    await recordSyncResult(db, false, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  isConnected,
  disconnect,
  getIntegration,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  buildGoogleEventBody // exported for unit testing the mapping logic in isolation
};
