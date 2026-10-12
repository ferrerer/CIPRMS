// Sequential-id race-condition remediation (2026-11 Phase 2). Root cause: every "get next id" write path in
// cirl.js (and services/notificationService.js) read the collection's current max id and inserted right
// after — nothing stopped two near-simultaneous requests from both reading the same max and both inserting
// the same id. Confirmed not hypothetical: a direct query of the live database during this change found a
// genuine duplicate `id` already sitting in `requests` (a real "Pili" institution request, not test data),
// plus duplicates in `activitylogs` and `notifications` — left exactly as found (see db.js's comment);
// nothing here renumbers or deletes any of them.
//
// The fix is two pieces working together: a unique index on `id` (db.js, skipped for a collection found to
// already have duplicates) and insertWithNextId()'s retry-on-conflict loop (db.js) at every insert site. This
// file proves both pieces directly — the shared helper against throwaway collections it fully controls (so
// the proof doesn't depend on which real collections happen to be clean today), plus real concurrent HTTP
// requests against two of the now-protected routes.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb, insertWithNextId, findDuplicateIds } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const THROWAWAY_PREFIX = 'jesttest_seqid_';

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection(`${THROWAWAY_PREFIX}core`).drop().catch(() => {});
  await db.collection(`${THROWAWAY_PREFIX}other`).drop().catch(() => {});
  await db.collection(`${THROWAWAY_PREFIX}dupecheck`).drop().catch(() => {});
  await db.collection(`${THROWAWAY_PREFIX}clean`).drop().catch(() => {});
  await db.collection('documentfolders').deleteMany({ name: { $regex: `^${TEST_TAG}` } }); // not swept by cleanupAll()
  await db.collection('responsibleunits').deleteMany({ name: { $regex: `^${TEST_TAG}` } }); // not swept by cleanupAll()
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('insertWithNextId() — the core retry-on-conflict mechanism, against throwaway collections it fully controls', () => {
  test('30 truly concurrent inserts into the same collection all land with distinct, gap-free sequential ids', async () => {
    const coll = db.collection(`${THROWAWAY_PREFIX}core`);
    await coll.createIndex({ id: 1 }, { unique: true, name: 'id_unique' });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => insertWithNextId(coll, (id) => ({ id, label: `row-${i}` })))
    );

    const ids = results.map(r => r.id).sort((a, b) => a - b);
    expect(new Set(ids).size).toBe(30); // no two calls ever landed on the same id
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => i + 1)); // exactly 1..30, no gaps, nothing skipped

    const stored = await coll.find({}).toArray();
    expect(stored.length).toBe(30); // the retry loop never double-inserted on a conflict it recovered from
  });

  test('a conflict on a DIFFERENT unique index (not id) is rethrown as-is, never silently retried', async () => {
    const coll = db.collection(`${THROWAWAY_PREFIX}other`);
    await coll.createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
    await coll.createIndex({ name: 1 }, { unique: true, name: 'name_unique' });

    const first = await insertWithNextId(coll, (id) => ({ id, name: 'duplicate-name' }));
    expect(first.id).toBe(1);

    // Same name again — a real violation insertWithNextId() must NOT treat as "pick a new id and retry" (that
    // would just burn through ids forever since the name conflict never goes away).
    await expect(insertWithNextId(coll, (id) => ({ id, name: 'duplicate-name' })))
      .rejects.toMatchObject({ code: 11000, keyPattern: { name: 1 } });

    expect(await coll.countDocuments({})).toBe(1); // the second attempt never got inserted under a fresh id either
  });
});

describe('findDuplicateIds() — the check-before-indexing guard db.js runs for every sequential-id collection', () => {
  test('reports an existing duplicate id with its count', async () => {
    const coll = db.collection(`${THROWAWAY_PREFIX}dupecheck`);
    await coll.insertMany([{ id: 1, tag: 'a' }, { id: 1, tag: 'b' }, { id: 2, tag: 'c' }]);
    const dupes = await findDuplicateIds(db, `${THROWAWAY_PREFIX}dupecheck`);
    expect(dupes).toEqual([{ _id: 1, count: 2 }]);
  });

  test('reports nothing for a collection with no duplicate ids', async () => {
    const coll = db.collection(`${THROWAWAY_PREFIX}clean`);
    await coll.insertMany([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const dupes = await findDuplicateIds(db, `${THROWAWAY_PREFIX}clean`);
    expect(dupes).toEqual([]);
  });
});

describe('Real concurrent HTTP requests against now-protected routes', () => {
  test('POST /api/document-folders: 10 concurrent creates all succeed with 10 distinct ids', async () => {
    const { agent } = await agentFor('Staff');
    const names = Array.from({ length: 10 }, (_, i) => `${TEST_TAG} Concurrent Folder ${i}-${Date.now()}`);
    const responses = await Promise.all(names.map(name => agent.post('/api/document-folders').send({ name })));

    for (const res of responses) expect(res.status).toBe(200);
    const ids = responses.map(r => r.body.folder.id);
    expect(new Set(ids).size).toBe(10);

    const stored = await db.collection('documentfolders').find({ name: { $in: names } }).toArray();
    expect(stored.length).toBe(10); // every one actually persisted, none lost to a retry mishap
  });

  test('POST /api/responsible-units: 8 concurrent creates with distinct names all succeed with 8 distinct ids', async () => {
    const { agent } = await agentFor('Administrator');
    const names = Array.from({ length: 8 }, (_, i) => `${TEST_TAG} Concurrent Unit ${i}-${Date.now()}`);
    const responses = await Promise.all(names.map(name => agent.post('/api/responsible-units').send({ name })));

    for (const res of responses) expect(res.status).toBe(200);
    const ids = responses.map(r => r.body.unit.id);
    expect(new Set(ids).size).toBe(8);
  });

  test('POST /api/responsible-units: a genuine duplicate-name race still yields exactly one success and one 409 (pre-existing protection, unweakened by the id fix)', async () => {
    const { agent } = await agentFor('Administrator');
    const name = `${TEST_TAG} Race Unit ${Date.now()}`;
    const [a, b] = await Promise.all([
      agent.post('/api/responsible-units').send({ name }),
      agent.post('/api/responsible-units').send({ name })
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
