// Brute-force protection investigation (2026-10-28).
//
// Root cause of the pre-existing weakness: POST /login already had a rate limiter (loginLimiter,
// express-rate-limit — an already-maintained dependency, reused rather than hand-rolled), but it was keyed
// ONLY by IP. That protects a network from an attacker working from inside it, but does nothing for one
// targeted ACCOUNT being brute-forced from many different IPs, and (the inverse problem the task also named)
// a shared office/NAT IP fully protects strangers from outside it but not two users on that SAME IP, one of
// whom is attacking the other. Separately, because /login answered every outcome — success AND every kind of
// failure — with res.render(...)'s default 200 status, express-rate-limit's skipSuccessfulRequests option
// (which decides "successful" purely by statusCode < 400) could never have worked correctly against this
// route even if someone had already turned it on: it would have skipped counting every FAILED attempt too,
// not just real successes, silently neutering the limiter's own counting instead of fixing the "don't punish
// success" problem it's meant to solve.
//
// What Jest in this process CANNOT verify: makeRateLimiter() (cirl.js) is an intentional no-op under
// NODE_ENV=test — the only way this whole suite's many independent per-test logins don't spuriously trip a
// shared, in-memory limiter. The actual trip-after-N-attempts behavior, the 429 status, the cooldown window,
// and the IP-scope vs account-scope distinction are verified live, against a real (non-test-mode) server —
// see the chat response for that result; this file verifies the parts a test-mode bypass doesn't hide: the
// real status codes every login outcome now returns (the actual fix needed for skipSuccessfulRequests to
// work at all), and that the configuration in the source is what it claims to be.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, cleanupAll, TEST_TAG } = require('./helpers');

const src = fs.readFileSync(path.join(__dirname, '..', 'cirl.js'), 'utf8');

afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Every login outcome now answers a real, distinguishable status code (not always 200)', () => {
  let user;
  beforeAll(async () => { await connectDB(); user = await createTestUser({ role: 'Staff' }); });

  test('success → 302 (unchanged — a real redirect, already < 400, already correctly "successful")', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.status).toBe(302);
  });

  test('wrong password → 401, not 200', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: 'Wrong1' });
    expect(res.status).toBe(401);
  });

  test('unknown account → 401, identical status to wrong password (still no enumeration signal)', async () => {
    const res = await request(app).post('/login').type('form').send({ username: `${TEST_TAG}.bfp.nouser.${Date.now()}@example.com`, password: 'Whatever1' });
    expect(res.status).toBe(401);
  });

  test('disabled account → 401', async () => {
    const db = await connectDB();
    const disabled = await createTestUser();
    await db.collection('users').updateOne({ id: disabled.id }, { $set: { status: 'Inactive' } });
    const res = await request(app).post('/login').type('form').send({ username: disabled.email, password: disabled.password });
    expect(res.status).toBe(401);
  });

  test('Google-only account attempting a password login → 401', async () => {
    const db = await connectDB();
    const googleOnly = await createTestUser();
    await db.collection('users').updateOne({ id: googleOnly.id }, { $unset: { password: '' } });
    const res = await request(app).post('/login').type('form').send({ username: googleOnly.email, password: 'anything' });
    expect(res.status).toBe(401);
  });

  test('malformed request (missing password) → 400, not 401 — it never reached any account', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email });
    expect(res.status).toBe(400);
  });
});

describe('Source-level: both limiters are wired onto POST /login with the configuration the report describes', () => {
  test('both an IP-keyed and an account-keyed limiter are attached, in that order', () => {
    expect(src).toContain("app.post('/login', loginLimiter, loginIdentifierLimiter, async (req, res) => {");
  });

  test('both limiters reuse the existing 10-attempts/15-minute window (makeRateLimiter\'s default) — no new, uninspected number was invented', () => {
    const factory = src.slice(src.indexOf('function makeRateLimiter'), src.indexOf('function makeRateLimiter') + 700);
    expect(factory).toContain('windowMs: 15 * 60 * 1000');
    expect(factory).toContain('limit: 10');
    // loginLimiter/loginIdentifierLimiter only ever pass extra options (skipSuccessfulRequests/keyGenerator/
    // skip) through the 3rd argument to the shared factory above — neither one's own call site mentions
    // windowMs/limit at all, so both inherit the factory's one real number instead of a second, separately
    // maintained one that could silently drift from it.
    const loginCall = src.slice(src.indexOf('const loginLimiter ='), src.indexOf('const loginLimiter =') + 400);
    const identifierCall = src.slice(src.indexOf('const loginIdentifierLimiter ='), src.indexOf('const loginIdentifierLimiter =') + 700);
    expect(loginCall).not.toMatch(/windowMs|limit:\s*\d/);
    expect(identifierCall).not.toMatch(/windowMs|limit:\s*\d/);
  });

  test('both limiters skip a request that actually succeeded, so a real login does not eat into the budget', () => {
    const loginBlock = src.slice(src.indexOf('const loginLimiter ='), src.indexOf('const loginIdentifierLimiter ='));
    const identifierBlock = src.slice(src.indexOf('const loginIdentifierLimiter ='), src.indexOf('app.post(\'/login\''));
    expect(loginBlock).toContain('skipSuccessfulRequests: true');
    expect(identifierBlock).toContain('skipSuccessfulRequests: true');
  });

  test('the account-keyed limiter is keyed by the submitted identifier (normalized the same way the real lookup is), never by IP', () => {
    const identifierBlock = src.slice(src.indexOf('const loginIdentifierLimiter ='), src.indexOf('app.post(\'/login\''));
    expect(identifierBlock).toContain("req.body.username.trim().toLowerCase()");
    expect(identifierBlock).not.toContain('req.ip');
  });

  test('the account-keyed limiter is skipped only for a request with no usable identifier at all — it is not disabled wholesale', () => {
    const identifierBlock = src.slice(src.indexOf('const loginIdentifierLimiter ='), src.indexOf('app.post(\'/login\''));
    expect(identifierBlock).toMatch(/skip:\s*\(req\)\s*=>\s*!\(req\.body/);
  });

  test('the IP limiter keeps using express-rate-limit\'s own default keyGenerator (req.ip, trust-proxy-aware) — not re-implemented by hand', () => {
    const loginBlock = src.slice(src.indexOf('const loginLimiter ='), src.indexOf('const loginIdentifierLimiter ='));
    expect(loginBlock).not.toContain('keyGenerator');
  });

  test('a blocked request of either kind writes one LOGIN_BLOCKED row and never a password/token', () => {
    expect(src).toContain("function makeLoginBlockedHandler(scope)");
    const handlerBlock = src.slice(src.indexOf('function makeLoginBlockedHandler'), src.indexOf('function makeLoginBlockedHandler') + 900);
    expect(handlerBlock).toContain("'LOGIN_BLOCKED'");
    expect(handlerBlock).toContain("status: 'blocked'");
    expect(handlerBlock).toContain("reason: 'rate_limited'");
    expect(handlerBlock).not.toMatch(/password|token/i);
  });

  test('the client-facing blocked message never names a limit, a window or which limiter tripped', () => {
    const start = src.indexOf('function makeLoginBlockedHandler');
    const fnEnd = src.indexOf('\n}', start); // this function's own closing brace, not a fixed character count
    const handlerBlock = src.slice(start, fnEnd);
    const clientText = handlerBlock.slice(handlerBlock.indexOf('res.status(429)'));
    expect(clientText).toContain('Too many login attempts. Please wait 15 minutes and try again.');
    expect(clientText).not.toMatch(/\b10\b|ip-based|account-based|\bscope\b/i); // the text shown to the client names neither axis nor the attempt count
  });
});

describe('The existing centralized Express error handler is unchanged and still the single fallback', () => {
  test('/login\'s own try/catch still answers safely, and the one global error handler is still the last-resort path (both untouched)', () => {
    expect(src).toContain("app.use((err, req, res, next) => {");
    expect(src.match(/app\.use\(\(err, req, res, next\) => \{/g)).toHaveLength(1); // still exactly one centralized handler, no duplicate added
    expect(src).toContain("'An unexpected server error occurred.'");
  });
});
