// ── Progressive sign-in lockout (2026-11) ────────────────────────────────────────────────────────
// Shared by POST /login and the Google OAuth sign-in routes (GET /auth/google, GET /auth/google/callback)
// in cirl.js — one unified mechanism so an attacker cannot reset or bypass a lockout by switching between
// the password form and Google sign-in, or by restarting the OAuth flow, or by refreshing the page
// (nothing here is stored in the session/cookie — it is keyed by IP address or by the submitted/Google
// account e-mail and persisted in MongoDB, so it survives a page refresh, a new browser session, a new
// OAuth attempt, and a server restart, and is correct across multiple application instances since every
// instance reads/writes the same collection rather than an in-memory counter).
//
// Replaces the old flat, in-memory, 10-attempts/15-minute express-rate-limit pair that used to guard only
// POST /login (loginLimiter/loginIdentifierLimiter) — those never covered the Google routes at all, could
// not escalate, and reset on every process restart. This module is the single place attempts are counted;
// callers must call recordFailure()/recordSuccess() exactly once per real outcome (never from more than one
// place for the same request) to avoid double-counting one authentication event.
//
// Two independent scopes are tracked, each with its own document and its own escalation state:
//   'ip'      — keyed by the client's IP address (req's own getClientIp()). Always safe to escalate: the
//               only party ever punished by an IP's own lockout is whoever is actually making the requests.
//   'account' — keyed by the normalized e-mail that was attempted (trimmed, lower-cased), REGARDLESS of
//               whether that account exists — matching the already-existing pre-2026-11 account-scope
//               limiter's own behavior for /login. This is what stops a single account being brute-forced
//               from many different IPs, and what keeps a password-flow attempt and a Google-flow attempt
//               against the SAME account from each getting their own separate budget.
//
// Escalation policy (brief-specified): 5 failed attempts triggers a lockout. Each time a key is locked out
// again, the NEXT lockout is longer, up to a defined cap — never permanent and never unbounded:
//   1st lockout: 1 minute   2nd: 5 minutes   3rd: 15 minutes   4th: 30 minutes   5th and later: 60 minutes
// A key's escalation tier decays back to the start (next lockout is 1 minute again) once TIER_DECAY_MS has
// passed with no further failure — "a clearly defined period without further failed attempts" per the
// brief — so a single stale old incident can never compound into a permanent-feeling block.
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATIONS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
const TIER_DECAY_MS = 24 * 60 * 60 * 1000; // 24 hours of no failures resets the escalation tier to 0
const COLLECTION = 'loginLockouts';

function lockoutDurationForTier(tier) {
  const idx = Math.max(0, Math.min(tier, LOCKOUT_DURATIONS_MS.length - 1));
  return LOCKOUT_DURATIONS_MS[idx];
}

function normalizeAccountKey(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Never throws — a lockout check must never itself become the reason sign-in breaks for everyone if the
// DB has a hiccup; callers get "not locked" on any read error (fails open, same spirit as every other
// best-effort check elsewhere in this app), and the real sign-in attempt that follows still goes through
// its own normal validation.
async function getLockoutStatus(db, scope, key) {
  if (!key) return { locked: false };
  try {
    const doc = await db.collection(COLLECTION).findOne({ scope, key });
    if (!doc || !doc.lockedUntil) return { locked: false };
    const lockedUntil = new Date(doc.lockedUntil);
    const remainingMs = lockedUntil.getTime() - Date.now();
    if (remainingMs <= 0) return { locked: false };
    return { locked: true, lockedUntil, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  } catch (err) {
    console.error('❌ getLockoutStatus error (failing open):', err.message);
    return { locked: false };
  }
}

/**
 * Records one failed sign-in attempt for the given scope/key. If this is the MAX_ATTEMPTS-th consecutive
 * failure since the tier last decayed, locks the key out for the current tier's duration and advances the
 * tier for next time.
 *
 * MUST be a single atomic MongoDB operation, never a separate findOne() followed by updateOne() — a 2026-11
 * live-testing report (5 different Google accounts from one IP "continued past the expected five-attempt
 * limit") traced to exactly that read-then-write gap: two concurrent failures (e.g. the account-not-found
 * rejection for account #3 arriving while account #2's own rejection was still being written) could both
 * read the SAME pre-increment failCount and each write back count+1, silently losing one of the two real
 * failures — under concurrent load this can lose enough increments that the threshold is never reached at
 * all. Reproduced directly: 5 truly concurrent recordFailure() calls against the old read-then-write
 * version left failCount at 1, not 5, and none of them reported locked. Fixed by doing the entire read-
 * decide-write as one aggregation-pipeline findOneAndUpdate() — MongoDB applies a single update operation
 * to a document as one atomic unit regardless of how many concurrent callers target the same document, so
 * concurrent requests serialize into the document one at a time with no lost increments, no double
 * lockouts, and no risk of an attacker exploiting the gap by firing attempts in quick succession.
 * @returns {Promise<{locked:boolean, lockedUntil?:Date, retryAfterSeconds?:number}>}
 */
async function recordFailure(db, scope, key) {
  if (!key) return { locked: false };
  try {
    const now = new Date();
    // Stage 1: decide whether the PREVIOUS cycle decayed (purely from the document's existing
    // lastFailureAt — never from a value read in a separate round trip), then increment failCount either
    // from 0 (decayed / first-ever failure) or from its current stored value.
    // Stage 2: having just computed the post-increment failCount, decide in the SAME operation whether
    // this failure is the one that crosses MAX_ATTEMPTS — if so, set lockedUntil from the tier the
    // document already had (BEFORE this operation bumps it), advance the tier, and reset failCount to 0
    // for the next cycle. Everything here reads/writes only fields on the one document being updated, so
    // there is nothing for a concurrent call on the SAME key to race against — each call sees the result
    // of whichever earlier calls MongoDB has already applied, never a stale snapshot.
    const durationsExpr = { $arrayElemAt: [LOCKOUT_DURATIONS_MS, { $min: ['$tier', LOCKOUT_DURATIONS_MS.length - 1] }] };
    const pipeline = [
      { $set: {
          _decayed: { $or: [
            { $eq: [{ $ifNull: ['$lastFailureAt', null] }, null] },
            { $gt: [{ $subtract: [now, '$lastFailureAt'] }, TIER_DECAY_MS] }
          ] }
      } },
      { $set: {
          failCount: { $add: [{ $cond: ['$_decayed', 0, { $ifNull: ['$failCount', 0] }] }, 1] },
          tier: { $cond: ['$_decayed', 0, { $ifNull: ['$tier', 0] }] }
      } },
      { $set: { _justLocked: { $gte: ['$failCount', MAX_ATTEMPTS] } } },
      { $set: {
          lockedUntil: { $cond: ['$_justLocked', { $add: [now, durationsExpr] }, { $ifNull: ['$lockedUntil', null] }] },
          tier: { $cond: ['$_justLocked', { $add: ['$tier', 1] }, '$tier'] },
          failCount: { $cond: ['$_justLocked', 0, '$failCount'] },
          lastFailureAt: now
      } },
      { $unset: ['_decayed', '_justLocked'] }
    ];
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { scope, key },
      pipeline,
      { upsert: true, returnDocument: 'after' }
    );
    const result = doc && doc.value !== undefined ? doc.value : doc; // driver-version-proofs: some return {value}, some return the doc directly
    if (result && result.lockedUntil && new Date(result.lockedUntil).getTime() > now.getTime()) {
      const lockedUntil = new Date(result.lockedUntil);
      return { locked: true, lockedUntil, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) };
    }
    return { locked: false };
  } catch (err) {
    console.error('❌ recordFailure error (failing open):', err.message);
    return { locked: false };
  }
}

/**
 * Records a successful sign-in: clears the CURRENT attempt cycle (so one slip-up right after a success
 * doesn't carry over a near-miss count) and clears any lockout that may have just expired. Deliberately
 * does NOT reset `tier` — a key's escalation history only decays through TIER_DECAY_MS of no failures,
 * never through a single success, so an attacker cannot "launder" their escalation level by occasionally
 * succeeding against an unrelated account from the same IP.
 */
async function recordSuccess(db, scope, key) {
  if (!key) return;
  try {
    await db.collection(COLLECTION).updateOne(
      { scope, key },
      { $set: { failCount: 0, lockedUntil: null } }
    );
  } catch (err) {
    console.error('❌ recordSuccess error (non-fatal):', err.message);
  }
}

// Human-readable, never exposes the scope (ip vs account), the attempt threshold, or any account-existence
// signal — matches the plain-language, information-minimal style every other client-facing auth message in
// this file already uses.
function lockoutMessage(retryAfterSeconds) {
  if (retryAfterSeconds <= 60) return 'Too many sign-in attempts. Please try again in a minute.';
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATIONS_MS,
  TIER_DECAY_MS,
  lockoutDurationForTier,
  normalizeAccountKey,
  getLockoutStatus,
  recordFailure,
  recordSuccess,
  lockoutMessage
};
