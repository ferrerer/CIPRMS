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
const crypto = require('crypto');
const { google } = require('googleapis');
const { encrypt, decrypt } = require('./tokenCrypto');
const { appTimeZone, parseEventInstant, eventDateOnly, addDaysToDateOnly, uniqueValidEmails, isValidEmail } = require('./meetingTime');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const CALENDAR_ID = 'primary';

// Every Calendar API write that has attendees asks Google to e-mail them
// ("sendUpdates: 'all'"): the invitation on create, the update on a change, the
// cancellation on delete. The mail is sent by Google Calendar itself, as the
// connected organizer account — CIPRMS never sends a separate Gmail message.
// Kept as one constant so "never silently 'none'" is checkable in one place.
const SEND_UPDATES = 'all';

// The org's single Google connection lives in one document. The collection
// name is overridable ONLY so the test suite can use a throw-away collection:
// the Jest suites used to deleteMany({}) the real one (they share the live
// database), which silently disconnected Google Calendar every time they ran.
const REAL_INTEGRATION_COLLECTION = 'googleCalendarIntegration';
function integrationCollection(db) {
  const name = process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION || REAL_INTEGRATION_COLLECTION;
  // Defence in depth: Jest sets JEST_WORKER_ID. A test run that somehow lost its
  // throw-away collection name (test/setup-env.js) must fail loudly here rather
  // than read, overwrite or delete the organization's real Google connection.
  if (process.env.JEST_WORKER_ID && name === REAL_INTEGRATION_COLLECTION) {
    throw new Error('Refusing to use the real googleCalendarIntegration collection from a test run — set GOOGLE_CALENDAR_INTEGRATION_COLLECTION (see test/setup-env.js).');
  }
  return db.collection(name);
}

// ── error text that is safe to log and to show ────────────────────────────────
// Google/gaxios error messages can echo request details. Nothing that looks like
// an access token, refresh token, authorization code or the client secret may reach
// the console, the database (lastSyncError) or the Settings page.
function redact(text) {
  let out = String(text);
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (secret) out = out.split(secret).join('[redacted]');
  return out
    .replace(/ya29\.[\w-]+/g, '[redacted]')
    .replace(/1\/\/[\w-]{20,}/g, '[redacted]')
    .replace(/((?:client_secret|refresh_token|access_token|id_token|code)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/("(?:refresh_token|access_token|id_token|client_secret|code)"\s*:\s*")[^"]+/gi, '$1[redacted]');
}

// Turns the handful of Google failures an Administrator can actually fix into a
// plain instruction; anything else is passed through (redacted).
function describeGoogleError(err) {
  const raw = redact((err && err.message) || err || 'Unknown error');
  if (/Unsupported state|unable to authenticate data|Malformed encrypted payload|Invalid authentication tag|Invalid initialization vector/i.test(raw)) {
    return 'The stored Google authorization cannot be decrypted with this server\'s GOOGLE_TOKEN_ENCRYPTION_KEY (it was connected with a different key). Reconnect Google Calendar, and use the same key everywhere this database is shared.';
  }
  if (/invalid_grant/i.test(raw)) {
    return 'Google no longer accepts the stored authorization (it was revoked or expired — Google Cloud apps in "Testing" mode only keep tokens for 7 days). Disconnect and reconnect Google Calendar.';
  }
  if (/accessNotConfigured|has not been used in project|API has not been enabled|Calendar API.*(disabled|not enabled)/i.test(raw)) {
    return 'The Google Calendar API is not enabled for the Google Cloud project behind this OAuth client. Enable "Google Calendar API" under APIs & Services, then try again.';
  }
  if (/redirect_uri_mismatch/i.test(raw)) {
    return 'Google rejected the redirect URI. Add the exact redirect URI shown on this page to the OAuth client\'s "Authorized redirect URIs" in Google Cloud.';
  }
  if (/invalid_client|unauthorized_client/i.test(raw)) {
    return 'Google rejected the OAuth client ID/secret configured for CIPRMS (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).';
  }
  if (/insufficient.*(scope|permission)/i.test(raw)) {
    return 'Google Calendar permission was not granted. Disconnect, reconnect, and allow the calendar access request.';
  }
  return raw;
}

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
  // Insert the new connection FIRST and only then remove any older one, so a
  // failure part-way can never leave the organization with no connection at all.
  const inserted = await integrationCollection(db).insertOne({
    connectedByEmail: connectedBy.email,
    connectedByName: connectedBy.name,
    encryptedRefreshToken: encrypt(tokens.refresh_token),
    calendarId: CALENDAR_ID,
    connectedAt: new Date().toISOString()
  });
  await integrationCollection(db).deleteMany({ _id: { $ne: inserted.insertedId } });
  // Prove the connection works right now (and learn which Google account it is)
  // instead of finding out on the first meeting.
  return { verification: await verifyConnection(db) };
}

// A read-only call that exercises the whole chain — decrypt the stored refresh
// token, exchange it for a fresh access token, call the Calendar API. The primary
// calendar's title is the Google account's own e-mail address, which is the
// organizer every invitation will come from; it is stored so the Settings page can
// show which account is actually connected (connectedByEmail is only the CIPRMS
// administrator who clicked Connect).
async function verifyConnection(db) {
  const { client, failure } = await clientOrFailure(db);
  if (failure) return failure;
  try {
    const res = await client.calendar.events.list({ calendarId: client.calendarId, maxResults: 1, singleEvents: true, timeMin: new Date().toISOString() });
    const summary = res && res.data && res.data.summary;
    const accountEmail = isValidEmail(summary) ? summary.trim().toLowerCase() : null;
    const calendarTimeZone = (res && res.data && res.data.timeZone) || null;
    await integrationCollection(db).updateOne({}, {
      $set: { calendarTimeZone, verifiedAt: new Date().toISOString(), ...(accountEmail ? { googleAccountEmail: accountEmail } : {}) }
    });
    await recordSyncResult(db, true, null);
    return { ok: true, accountEmail, calendarTimeZone };
  } catch (err) {
    const message = describeGoogleError(err);
    console.error('Google Calendar: connection check failed:', message);
    await recordSyncResult(db, false, message);
    return { ok: false, error: message };
  }
}

async function getIntegration(db) {
  return integrationCollection(db).findOne({});
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
      // Revoke the REFRESH token itself (revokeCredentials() only revokes an access
      // token, and only the refresh token is stored — so the grant used to stay
      // alive on Google's side after Disconnect).
      await client.revokeToken(decrypt(doc.encryptedRefreshToken));
    } catch (err) {
      // Best-effort — the token may already be invalid/revoked on Google's
      // side; either way we still remove our own stored copy below.
      console.error('Google Calendar: revoke during disconnect failed (continuing):', describeGoogleError(err));
    }
  }
  await integrationCollection(db).deleteMany({});
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
      integrationCollection(db)
        .updateOne({ _id: doc._id }, { $set: { encryptedRefreshToken: encrypt(tokens.refresh_token) } })
        .catch((err) => console.error('Google Calendar: failed to persist rotated refresh token:', describeGoogleError(err)));
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
    await integrationCollection(db).updateOne({}, {
      $set: { lastSyncOk: ok, lastSyncAt: new Date().toISOString(), lastSyncError: ok ? null : (error || 'Unknown error') }
    });
  } catch (err) {
    console.error('Google Calendar: failed to record sync result:', describeGoogleError(err));
  }
}

// Google needs an explicit, self-consistent time range. A timed event is sent
// as an exact instant PLUS the application timezone (so the invitation reads
// in Philippine time whatever the server's own zone is); an all-day event is
// sent as dates, where Google's end date is EXCLUSIVE. An event saved with no
// end (or an end that is not after the start) gets a one-hour / one-day span
// so Google does not reject it as an empty range.
function googleTimeRange(cirlEvent, tz) {
  const zone = tz || appTimeZone();
  if (cirlEvent.allDay) {
    const startDate = eventDateOnly(cirlEvent.start, zone);
    if (!startDate) return null;
    let endDate = cirlEvent.end ? eventDateOnly(cirlEvent.end, zone) : null;
    if (!endDate || endDate <= startDate) endDate = addDaysToDateOnly(startDate, 1);
    return { start: { date: startDate }, end: { date: endDate } };
  }
  const startInstant = parseEventInstant(cirlEvent.start, zone);
  if (!startInstant) return null;
  let endInstant = cirlEvent.end ? parseEventInstant(cirlEvent.end, zone) : null;
  if (!endInstant || endInstant <= startInstant) endInstant = new Date(startInstant.getTime() + 60 * 60 * 1000);
  return {
    start: { dateTime: startInstant.toISOString(), timeZone: zone },
    end: { dateTime: endInstant.toISOString(), timeZone: zone }
  };
}

// recipientEmails is filtered to valid, lower-cased, de-duplicated addresses
// here as a last line of defence (cirl.js already validates and reports the
// rejected ones to the Administrator) — Google rejects an entire event
// request if one attendee address is malformed.
function buildGoogleEventBody(cirlEvent, recipientEmails, options) {
  const range = googleTimeRange(cirlEvent, options && options.timeZone);
  const body = {
    summary: cirlEvent.title,
    location: cirlEvent.location || undefined,
    description: cirlEvent.description || undefined,
    start: range ? range.start : undefined,
    end: range ? range.end : undefined,
    attendees: uniqueValidEmails(recipientEmails).map((email) => ({ email }))
  };
  // A caller-chosen, stable id makes the insert idempotent: a retried request
  // for the same CIPRMS event hits Google's "identifier already exists" (409)
  // instead of creating a second event.
  if (options && options.insert && cirlEvent.googleEventKey) body.id = cirlEvent.googleEventKey;
  // Ask Google to attach a Google Meet room to the event. The requestId makes the request idempotent: a retry
  // with the same id gets the same room instead of a second one. The caller must also pass
  // conferenceDataVersion: 1 on the API call, or Google ignores this block.
  if (options && options.meetRequestId) {
    body.conferenceData = { createRequest: { requestId: options.meetRequestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  return body;
}

// The Google Meet address of an event as Google returns it. Only a real meet.google.com link is ever accepted, so
// nothing else can end up behind the Join button.
const MEET_LINK_RE = /^https:\/\/meet\.google\.com\/[A-Za-z0-9-]+(?:\?[\w=&%-]*)?$/;
function meetLinkOf(data) {
  if (!data) return null;
  const candidates = [data.hangoutLink];
  const points = data.conferenceData && Array.isArray(data.conferenceData.entryPoints) ? data.conferenceData.entryPoints : [];
  for (const p of points) if (p && p.entryPointType === 'video') candidates.push(p.uri);
  return candidates.find((u) => typeof u === 'string' && MEET_LINK_RE.test(u)) || null;
}

function newMeetRequestId(cirlEvent) {
  return cirlEvent.googleEventKey || ('ciprms' + crypto.randomBytes(12).toString('hex'));
}

function errorStatus(err) {
  return Number(err && (err.code || err.status || (err.response && err.response.status))) || 0;
}

function organizerOf(data) {
  return (data && data.organizer && data.organizer.email) || (data && data.creator && data.creator.email) || null;
}

async function clientOrFailure(db) {
  try {
    const client = await getAuthorizedCalendarClient(db);
    return client ? { client } : { failure: { ok: false, error: 'not_connected' } };
  } catch (err) {
    const message = describeGoogleError(err);
    console.error('Google Calendar: failed to build authorized client:', message);
    await recordSyncResult(db, false, message);
    return { failure: { ok: false, error: message } };
  }
}

// Every function below returns { ok, ... } rather than throwing, so callers
// in cirl.js never need try/catch around them — a Google API hiccup must
// never block the underlying CIPRMS event's own create/update/delete.
// recordSyncResult() is only called once we've established there IS a real
// connection to attempt against (not for not_connected/no_recipients/
// no_google_event, which are normal, expected states — not a broken
// connection).
async function createGoogleEvent(db, cirlEvent, recipientEmails) {
  const { client, failure } = await clientOrFailure(db);
  if (failure) return failure;
  const attendees = uniqueValidEmails(recipientEmails);
  if (!attendees.length) return { ok: false, error: 'no_recipients' };
  const body = buildGoogleEventBody(cirlEvent, attendees, { insert: true, meetRequestId: newMeetRequestId(cirlEvent) });
  if (!body.start) return { ok: false, error: 'invalid_start' };
  try {
    const res = await client.calendar.events.insert({
      calendarId: client.calendarId,
      requestBody: body,
      conferenceDataVersion: 1,
      sendUpdates: SEND_UPDATES
    });
    await recordSyncResult(db, true, null);
    return { ok: true, googleEventId: res.data.id, organizerEmail: organizerOf(res.data), htmlLink: res.data.htmlLink || null, meetLink: meetLinkOf(res.data) };
  } catch (err) {
    if (errorStatus(err) === 409 && body.id) {
      // The stable id already exists on Google — an earlier attempt for this
      // same CIPRMS event got through (or the event was deleted there).
      // Converge on that one event rather than creating a second.
      try {
        const patchBody = { ...body, status: 'confirmed' };
        delete patchBody.id;
        const res = await client.calendar.events.patch({
          calendarId: client.calendarId, eventId: body.id, requestBody: patchBody, conferenceDataVersion: 1, sendUpdates: SEND_UPDATES
        });
        await recordSyncResult(db, true, null);
        return { ok: true, googleEventId: (res.data && res.data.id) || body.id, organizerEmail: organizerOf(res.data), htmlLink: (res.data && res.data.htmlLink) || null, meetLink: meetLinkOf(res.data), recovered: true };
      } catch (recoverErr) {
        err = recoverErr;
      }
    }
    const message = describeGoogleError(err);
    console.error('Google Calendar: createGoogleEvent failed:', message);
    await recordSyncResult(db, false, message);
    return { ok: false, error: message };
  }
}

async function updateGoogleEvent(db, cirlEvent, recipientEmails) {
  if (!cirlEvent.googleEventId) return { ok: false, error: 'no_google_event' };
  const { client, failure } = await clientOrFailure(db);
  if (failure) return failure;
  // An edit never asks Google for a Meet room: meetings created before Meet was added stay as they are (no link is
  // added to them), and one that already has a room keeps the same link.
  try {
    const res = await client.calendar.events.patch({
      calendarId: client.calendarId,
      eventId: cirlEvent.googleEventId,
      // recipientEmails here should be the event's STABLE attendee list
      // (cirl.js passes googleAttendeeEmails, captured once at creation) —
      // never the visibility-driving recipientEmails, which is absent
      // entirely for "all users" events and would otherwise silently wipe
      // every attendee off the Google event on the very first edit.
      requestBody: buildGoogleEventBody(cirlEvent, recipientEmails),
      sendUpdates: SEND_UPDATES
    });
    await recordSyncResult(db, true, null);
    return { ok: true, organizerEmail: organizerOf(res && res.data), meetLink: meetLinkOf(res && res.data) };
  } catch (err) {
    const message = describeGoogleError(err);
    console.error('Google Calendar: updateGoogleEvent failed:', message);
    await recordSyncResult(db, false, message);
    return { ok: false, error: message };
  }
}

// One entry point for "make Google match this CIPRMS event": patches the
// existing Google event, or — only for an event that was assigned a stable
// googleEventKey but never reached Google (not connected yet, or a transient
// failure) — creates it, so a later edit repairs the sync instead of leaving
// the event permanently un-invited. Events that predate the key are never
// created retroactively (that would e-mail invitations for old events).
async function syncGoogleEvent(db, cirlEvent, recipientEmails) {
  if (cirlEvent.googleEventId) return updateGoogleEvent(db, cirlEvent, recipientEmails);
  if (cirlEvent.googleEventKey) return createGoogleEvent(db, cirlEvent, recipientEmails);
  return { ok: false, error: 'no_google_event' };
}

// Reads the Meet address of an existing Google event. Google sometimes attaches the room a moment after the event
// is created, so the insert response may not carry it yet. Best-effort and quiet: a failure just means "no link
// yet" — it must never fail a Join, and it is not a sign the connection is broken.
async function getGoogleMeetLink(db, googleEventId) {
  if (!googleEventId) return null;
  try {
    const { client } = await clientOrFailure(db);
    if (!client) return null;
    const res = await client.calendar.events.get({ calendarId: client.calendarId, eventId: googleEventId });
    return meetLinkOf(res && res.data);
  } catch (err) {
    return null;
  }
}

async function deleteGoogleEvent(db, googleEventId) {
  if (!googleEventId) return { ok: false, error: 'no_google_event' };
  const { client, failure } = await clientOrFailure(db);
  if (failure) return failure;
  try {
    await client.calendar.events.delete({ calendarId: client.calendarId, eventId: googleEventId, sendUpdates: SEND_UPDATES });
    await recordSyncResult(db, true, null);
    return { ok: true };
  } catch (err) {
    // A 404/410 here just means the event is already gone on Google's side
    // (e.g. a recipient deleted it, or it was already removed) — not a real
    // failure from CIPRMS's point of view, but still recorded so a genuinely
    // broken connection (e.g. revoked grant) doesn't look identical to that
    // benign case in the logs.
    const message = describeGoogleError(err);
    console.error('Google Calendar: deleteGoogleEvent failed (continuing):', message);
    await recordSyncResult(db, false, message);
    return { ok: false, error: message };
  }
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  isConnected,
  disconnect,
  verifyConnection,
  getIntegration,
  describeGoogleError,
  redact,
  createGoogleEvent,
  updateGoogleEvent,
  syncGoogleEvent,
  deleteGoogleEvent,
  getGoogleMeetLink,
  SEND_UPDATES,
  buildGoogleEventBody // exported for unit testing the mapping logic in isolation
};
