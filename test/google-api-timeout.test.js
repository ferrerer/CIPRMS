// Google Calendar/Docs API timeout bound (2026-11 Phase 2). Root cause: every outbound call in
// services/googleCalendarService.js and services/googleDocsService.js (getToken, revokeToken, every
// calendar.events.*/drive.files.*/permissions.* call) had no timeout of its own — a stalled or unreachable
// Google endpoint could leave the Express request (and the Administrator's click) hanging indefinitely. The
// fix is `transporterOptions: { timeout: GOOGLE_API_TIMEOUT_MS }` on the one OAuth2Client both services build
// every other client/request from (buildOAuthClient()), which gaxios enforces via AbortSignal.timeout — and
// a new describeGoogleError() pattern in each service so the resulting abort reaches the client as a plain,
// safe sentence instead of a raw "operation was aborted" message.
//
// This proves the actual mechanism against a real local HTTP server that never responds — not a mock of
// gaxios or the Google client — using a short override timeout so the test itself stays fast; the exported
// GOOGLE_API_TIMEOUT_MS is checked separately to confirm the real production value these services configure.
const http = require('http');
const { google } = require('googleapis');
const googleCalendarService = require('../services/googleCalendarService');
const googleDocsService = require('../services/googleDocsService');

describe('Configured timeout bound', () => {
  test('both services configure the same, real (not accidentally huge or missing) timeout', () => {
    expect(googleCalendarService.GOOGLE_API_TIMEOUT_MS).toBe(15000);
    expect(googleDocsService.GOOGLE_API_TIMEOUT_MS).toBe(15000);
  });
});

describe('describeGoogleError() recognizes a timeout and never leaks the raw abort message', () => {
  // The real shape gaxios/AbortSignal.timeout produces — a DOMException named "TimeoutError" whose message is
  // exactly this sentence (see node_modules/gaxios's use of AbortSignal.timeout, confirmed during this fix).
  const timeoutError = new Error('This operation was aborted due to timeout');
  timeoutError.name = 'TimeoutError';

  test('googleCalendarService', () => {
    expect(googleCalendarService.describeGoogleError(timeoutError)).toBe('Google Calendar did not respond in time. Please try again.');
  });

  test('googleDocsService', () => {
    expect(googleDocsService.describeGoogleError(timeoutError)).toBe('Google Docs did not respond in time. Please try again.');
  });
});

describe('The transporterOptions.timeout mechanism itself, against a real server that never answers', () => {
  let server;
  let port;

  beforeAll(async () => {
    // Deliberately never calls res.end() — any client request against it hangs until ITS OWN timeout fires,
    // exactly the "stalled Google endpoint" scenario this fix exists for.
    server = http.createServer((req, res) => { /* never responds */ });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  test('a client built the same way buildOAuthClient() builds one aborts at its configured timeout instead of hanging for the server\'s delay', async () => {
    // Same two options the fix added to buildOAuthClient() in both services — transporterOptions.timeout —
    // plus an endpoint override (supported by OAuth2Client, see its `endpoints` constructor option) pointed
    // at the local stalled server above instead of Google's real token endpoint. A short override (300ms) so
    // this test doesn't need to wait out the real 15s production value to prove the mechanism works.
    const SHORT_TIMEOUT_MS = 300;
    const client = new google.auth.OAuth2({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://127.0.0.1/callback',
      transporterOptions: { timeout: SHORT_TIMEOUT_MS },
      endpoints: { oauth2TokenUrl: `http://127.0.0.1:${port}/token` }
    });

    const started = Date.now();
    await expect(client.getToken('fake-code')).rejects.toBeTruthy();
    const elapsed = Date.now() - started;

    // Generous upper bound (not a tight race against the exact configured value) — the point being proven is
    // "bounded, not indefinite": without the fix this would still be pending when the test itself times out.
    expect(elapsed).toBeLessThan(5000);
  });
});
