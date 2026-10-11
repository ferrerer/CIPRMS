// services/loginLockoutService.js — the progressive sign-in lockout behind POST /login and the Google
// OAuth routes (2026-11 Google-only sign-in / progressive rate limiting).
//
// cirl.js's own wiring (checkSignInLockout/recordSignInFailure/recordSignInSuccess) is bypassed entirely
// under NODE_ENV=test — the same reason the old flat limiters were (this suite's many independent logins,
// all sharing one supertest "IP", would otherwise trip a real, persisted lockout mid-suite and spuriously
// fail unrelated tests; see test/brute-force-protection.test.js's own header comment). That bypass means
// the real HTTP route can never be used to test the lockout's actual trip/escalate/expire/decay behavior
// inside this process. This file tests the SERVICE directly instead — no HTTP, no cirl.js, no NODE_ENV
// bypass — against the real test MongoDB, with time-sensitive states (an already-expired lockout, a
// decayed tier) created by writing the stored timestamps directly rather than waiting real wall-clock
// minutes. The real HTTP route wiring (5 wrong passwords → 429, Google routes also blocked, recovery after
// the real 60-second wait) was verified live against a real, non-test-mode server — see the chat response
// for that result, not claimed as Jest coverage here.
const { connectDB, closeDB, getDb } = require('../db');
const svc = require('../services/loginLockoutService');

const SCOPE = 'account';
let db;

function uniqueKey(label) {
  return `jesttest.lockout.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('loginLockouts').deleteMany({ key: { $regex: '^jesttest\\.lockout\\.' } });
  await closeDB();
});

describe('Reaching the limit triggers a lockout; staying under it never does', () => {
  test(`fewer than MAX_ATTEMPTS (${svc.MAX_ATTEMPTS}) failures never locks the key`, async () => {
    const key = uniqueKey('under-limit');
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS - 1; i++) {
      result = await svc.recordFailure(db, SCOPE, key);
      expect(result.locked).toBe(false);
    }
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(false);
  });

  test(`the MAX_ATTEMPTS-th (${svc.MAX_ATTEMPTS}th) consecutive failure locks the key for the first tier's duration (1 minute)`, async () => {
    const key = uniqueKey('fifth-fail');
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    const status = await svc.getLockoutStatus(db, SCOPE, key);
    expect(status.locked).toBe(true);
    expect(status.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe('A sixth attempt while locked is still blocked, and the lockout expires exactly when its duration ends', () => {
  test('getLockoutStatus keeps reporting locked for every check made before lockedUntil', async () => {
    const key = uniqueKey('still-locked');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true); // a second check, same still-locked answer — checking does not itself clear it
  });

  test('once lockedUntil has passed, the very next check reports unlocked — expiry is based on real elapsed time, not a client timer', async () => {
    const key = uniqueKey('expired');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true);
    // Simulates real time having passed, the same way a live 60-second wait would — no fake timer needed
    // since the service always re-reads the stored timestamp rather than caching anything in memory.
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(false);
  });
});

describe('Repeated lockouts escalate: 1 → 5 → 15 → 30 → 60 minutes, then capped', () => {
  async function expireCurrentLockout(key) {
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  }

  test('a second lockout for the same key is 5 minutes, not 1 — the escalation actually carries over', async () => {
    const key = uniqueKey('escalate-2');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    await expireCurrentLockout(key);
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(60);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(5 * 60);
  });

  test('the full brief-specified schedule — 1, 5, 15, 30, then 60 minutes and capped there for every lockout after', async () => {
    const key = uniqueKey('escalate-full');
    const expectedMinutes = [1, 5, 15, 30, 60, 60, 60]; // two extra rounds past the cap, to prove it never grows further
    const actualMinutes = [];
    for (const _ of expectedMinutes) {
      let result;
      for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
      expect(result.locked).toBe(true);
      actualMinutes.push(Math.round(result.retryAfterSeconds / 60));
      await expireCurrentLockout(key);
    }
    expect(actualMinutes).toEqual(expectedMinutes);
  });
});

describe('The escalation tier decays after a quiet period, but a lone success never launders it', () => {
  test('a success clears the current fail count and any lockout, but leaves the escalation tier exactly where it was', async () => {
    const key = uniqueKey('success-no-launder');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1, now locked
    await svc.recordSuccess(db, SCOPE, key);
    const docAfterSuccess = await db.collection('loginLockouts').findOne({ scope: SCOPE, key });
    expect(docAfterSuccess.failCount).toBe(0);
    expect(docAfterSuccess.lockedUntil).toBeNull();
    expect(docAfterSuccess.tier).toBe(1); // NOT reset by the success

    // Prove the tier really did carry over: the next lockout for this key is still the 2nd-tier duration
    // (5 minutes), not back down to the 1st (1 minute) — a success never "launders" the escalation.
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(Math.round(result.retryAfterSeconds / 60)).toBe(5);
  });

  test(`${svc.TIER_DECAY_MS / 3600000} hours with no failure resets the tier back to the start — a lone old incident can never compound forever`, async () => {
    const key = uniqueKey('decay');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, {
      $set: { lockedUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - svc.TIER_DECAY_MS - 1000) }
    });
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(Math.round(result.retryAfterSeconds / 60)).toBe(1); // back to the first tier's duration, not the 2nd
  });

  test('a quiet period just UNDER the decay window does NOT reset the tier', async () => {
    const key = uniqueKey('no-premature-decay');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, {
      $set: { lockedUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - svc.TIER_DECAY_MS + 60000) }
    });
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(Math.round(result.retryAfterSeconds / 60)).toBe(5); // still escalated, decay had not actually elapsed yet
  });
});

describe('IP scope and account scope are tracked completely independently', () => {
  test('locking one account does not touch a different account, and locking an account does not touch an IP', async () => {
    const accountA = uniqueKey('account-a');
    const accountB = uniqueKey('account-b');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, 'account', accountA);
    expect((await svc.getLockoutStatus(db, 'account', accountA)).locked).toBe(true);
    expect((await svc.getLockoutStatus(db, 'account', accountB)).locked).toBe(false);
    expect((await svc.getLockoutStatus(db, 'ip', accountA)).locked).toBe(false); // same string, different scope — never cross-read
  });
});

describe('normalizeAccountKey matches the real login lookup\'s own normalization exactly', () => {
  test('trims and lower-cases', () => {
    expect(svc.normalizeAccountKey('  Someone@Example.COM  ')).toBe('someone@example.com');
  });
  test('non-string input never throws — returns an empty, falsy key instead', () => {
    expect(svc.normalizeAccountKey(undefined)).toBe('');
    expect(svc.normalizeAccountKey(null)).toBe('');
    expect(svc.normalizeAccountKey({ $ne: null })).toBe('');
  });
});

describe('lockoutMessage never reveals the scope, the attempt threshold, or any account-existence signal', () => {
  test('a sub-minute remaining time reads naturally, not "0 minutes"', () => {
    expect(svc.lockoutMessage(30)).toBe('Too many sign-in attempts. Please try again in a minute.');
  });
  test('longer waits are rounded up to whole minutes so the stated time is never an underestimate', () => {
    expect(svc.lockoutMessage(61)).toBe('Too many sign-in attempts. Please try again in 2 minutes.');
    expect(svc.lockoutMessage(300)).toBe('Too many sign-in attempts. Please try again in 5 minutes.');
  });
  test('never mentions "account", "ip", a specific attempt count, or the word "scope"', () => {
    const msg = svc.lockoutMessage(900);
    expect(msg).not.toMatch(/account|\bip\b|scope|\b5\b/i);
  });
});

describe('A lookup/write failure fails open rather than becoming a second outage', () => {
  const brokenDb = { collection() { throw new Error('simulated DB failure'); } };
  test('getLockoutStatus reports not-locked rather than throwing', async () => {
    await expect(svc.getLockoutStatus(brokenDb, SCOPE, 'whoever')).resolves.toEqual({ locked: false });
  });
  test('recordFailure reports not-locked rather than throwing — a DB hiccup never itself blocks a real sign-in attempt', async () => {
    await expect(svc.recordFailure(brokenDb, SCOPE, 'whoever')).resolves.toEqual({ locked: false });
  });
  test('recordSuccess never throws either', async () => {
    await expect(svc.recordSuccess(brokenDb, SCOPE, 'whoever')).resolves.toBeUndefined();
  });
});
