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
    // 2026-09-19 automatic map location: cache of institution+country
    // geocoding answers (services/geocodingService.js), keyed so a repeated
    // lookup never hits the external provider twice. A brand-new collection —
    // this touches no existing record. Non-fatal on failure, same precedent as
    // above: without the unique index the cache still works (upserts by key),
    // it just can't guard against a duplicate-key race.
    try {
      await db.collection('geocodecache').createIndex({ key: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on geocodecache.key:', indexErr.message);
    }
    // 2026-09-17 performance fix: every "get next sequential id" write path
    // in this app (partnerships, users, requests, documentrequests,
    // documentfolders, activitylogs, notifications, calendarevents, targets —
    // every `.find({}).sort({ id: -1 }).limit(1)` call in cirl.js) relied on
    // an unindexed full collection scan + in-memory sort to find the current
    // max id. Harmless while these collections were tiny, but activitylogs
    // (752 docs) and notifications (522 docs) have grown enough that this
    // was measurably slow over Atlas's network round-trip — reproduced as a
    // 15s Jest timeout on a test doing nothing more than 3 sequential
    // partnership inserts, each triggering a logActivity() call that
    // re-scanned the entire activitylogs collection. Same non-fatal
    // try/catch precedent as the indexes above: these are plain (non-unique)
    // indexes that only speed up the existing sort, so a failure to create
    // one just leaves that collection's writes at their current speed — it
    // never changes the nextId logic itself.
    for (const coll of ['partnerships', 'users', 'requests', 'documentrequests', 'documentfolders', 'activitylogs', 'notifications', 'calendarevents', 'targets']) {
      try {
        await db.collection(coll).createIndex({ id: -1 });
      } catch (indexErr) {
        console.error(`⚠️  Could not create id index on ${coll} — nextId lookups on this collection remain unindexed:`, indexErr.message);
      }
    }
    // 2026-09-20 calendar duplicate-event protection. Two writes that race
    // each other (a double-clicked Save, a retried request, two Administrators
    // creating an event in the same instant) used to be able to insert two
    // calendar events — the "next id" lookup above is read-then-insert, so both
    // saw the same max id. A unique `id` makes the second insert fail (the
    // route retries with a fresh id), and a unique `clientRequestId` (a token
    // the browser generates once per Save/drop) makes a repeated request for
    // the SAME action return the event it already created instead of a second
    // one. The clientRequestId index is partial: pre-existing events carry no
    // token and are not indexed. Verified free of duplicate ids beforehand;
    // same non-fatal precedent as the indexes above.
    try {
      await db.collection('calendarevents').createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on calendarevents.id — concurrent-create duplicate protection is NOT active:', indexErr.message);
    }
    try {
      await db.collection('calendarevents').createIndex(
        { clientRequestId: 1 },
        { unique: true, name: 'clientRequestId_unique', partialFilterExpression: { clientRequestId: { $type: 'string' } } }
      );
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on calendarevents.clientRequestId — repeated-request duplicate protection is NOT active:', indexErr.message);
    }
    // 2026-09-22 Administrator/CIRL Staff global search (services/searchService.js). `documents.ocrText` can run to
    // tens of thousands of characters per record (a whole scanned MOA/MOU) — a text index is what lets a keyword
    // search of that content use an actual index instead of a full collection scan of every stored document. The
    // short metadata fields are folded into the same index so a single $text query can also match on them; the
    // search service additionally runs a plain regex over those same short fields for substrings a stemmed word
    // index wouldn't catch ("Univ" -> "University") — the two result sets are merged, so this index only needs to
    // carry the "search the actual document content" half of the feature. Non-fatal on failure, same precedent as
    // every index above: without it, searchDocuments() falls back to its regex-only metadata match.
    try {
      await db.collection('documents').createIndex(
        { ocrText: 'text', title: 'text', originalFilename: 'text', institution: 'text', partner: 'text', type: 'text', country: 'text', nature: 'text', searchKeywords: 'text' },
        { name: 'documents_search_text', weights: { title: 5, originalFilename: 4, institution: 4, partner: 4, searchKeywords: 3, type: 2, country: 2, nature: 2, ocrText: 1 } }
      );
    } catch (indexErr) {
      console.error('⚠️  Could not create text index on documents — OCR-content search will fall back to metadata-only matching:', indexErr.message);
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
    await client.close();
    client = undefined;
    db = undefined;
  }
}

module.exports = { connectDB, getDb, closeDB };
