const { MongoClient } = require('mongodb');

// 2026-09-06 security hardening (quick win): a missing MONGO_URI used to
// silently fall back to an unauthenticated local Mongo instance — a
// misconfigured deploy (env var never set, or NODE_ENV left unset/wrong)
// would fail open rather than fail loudly, potentially connecting to (or
// creating) the wrong database with no one noticing. The localhost fallback
// now requires an EXPLICIT local-dev/test declaration (NODE_ENV
// 'development' or 'test') — anything else, including NODE_ENV left unset
// entirely, refuses to start instead of guessing.
const NODE_ENV = process.env.NODE_ENV;
const LOCAL_FALLBACK_URI = 'mongodb://127.0.0.1:27017/ciprms';
let uri = process.env.MONGO_URI;
if (!uri) {
  if (NODE_ENV !== 'development' && NODE_ENV !== 'test') {
    throw new Error('MONGO_URI is not set. Refusing to start without an explicit database URI (set NODE_ENV=development locally to allow the localhost fallback).');
  }
  uri = LOCAL_FALLBACK_URI;
  console.warn(`⚠️  MONGO_URI is not set — using the local development fallback (${LOCAL_FALLBACK_URI}) because NODE_ENV=${NODE_ENV}.`);
}
let client;
let db;

async function connectDB() {
  if (db) return db;
  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
    console.log('✓ Connected to MongoDB successfully');
    // 2026-09-06 security hardening (Finding #4): every write path already
    // normalizes email to trim+lowercase before storing (login, signup,
    // /api/users), so a plain unique index is enough to close the
    // check-then-insert race between two near-simultaneous account
    // creations for the same email — confirmed clean against production
    // data before adding this (0 duplicates across existing users).
    // Non-fatal on failure (e.g. a transient disk-space/replica-set issue on
    // the MongoDB server) — the app must still start and serve traffic; the
    // findOne-based check in POST /api/users still catches the non-race
    // case either way. A failure here is logged loudly because it means
    // the race-condition guard from POST /api/users' duplicate-key handler
    // is not actually backed by an index until this succeeds.
    try {
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on users.email — duplicate-email race protection is NOT active:', indexErr.message);
    }
    // 2026-09-06 Monthly/Yearly Target Tracker: one target per (type, year,
    // month) — month is always explicitly null for a yearly target, so this
    // also enforces at most one yearly target per year. Same non-fatal
    // try/catch precedent as the users.email index above — the POST
    // /api/targets duplicate-key handler is the fallback if this can't be
    // created (e.g. the same disk-space constraint).
    try {
      await db.collection('targets').createIndex({ type: 1, year: 1, month: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on targets — duplicate-target race protection is NOT active:', indexErr.message);
    }
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();1
    client = undefined;
    db = undefined;
  }
}

module.exports = { connectDB, getDb, closeDB };
