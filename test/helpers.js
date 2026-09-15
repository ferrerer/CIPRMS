// Shared test utilities. Tests run against the real MONGO_URI (there is no
// separate test database in this project), so every helper here is built
// around leaving zero trace: create with a unique, clearly-marked identity,
// and always clean up in the calling test's afterAll.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bcrypt = require('bcrypt');
const { connectDB, getDb } = require('../db');

const TEST_TAG = 'jesttest';

function uniqueEmail(label) {
  return `${TEST_TAG}.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * Inserts a user directly into the DB (bypassing the signup form) so tests
 * can get a ready-to-login account of any role without exercising signup.
 */
async function createTestUser({ role = 'Staff', unit = '', password = 'TestPass123' } = {}) {
  const db = await connectDB();
  const email = uniqueEmail(role.toLowerCase().replace(/[^a-z]/g, ''));
  const last = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
  const nextId = last.length ? last[0].id + 1 : 1;
  const hash = await bcrypt.hash(password, 10);
  await db.collection('users').insertOne({
    id: nextId,
    name: `${TEST_TAG} ${role}`,
    email,
    role,
    unit,
    login: 'Never',
    status: 'Active',
    password: hash,
    createdAt: TEST_TAG
  });
  return { id: nextId, email, password, role };
}

/** Logs a supertest agent in as the given user; the agent then carries the session cookie for subsequent requests. */
async function loginAs(agent, user) {
  const res = await agent.post('/login').type('form').send({ username: user.email, password: user.password });
  return res;
}

/**
 * Deletes every test-created user, and any partnerships/requests/activitylogs/
 * documents/notifications tagged with the jest test marker.
 *
 * documents and notifications were missing here entirely until this health-
 * check audit (2026-09-12) found ~295 orphaned `documents` records (101 with
 * a real file still on disk in uploads/documents/, plus 335 further orphaned
 * files with no DB record at all — a separate leak from tests that delete
 * their own document record but never unlink the underlying file) and ~800+
 * stray `notifications`, both accumulated silently across every previous test
 * run in this project's history since neither collection was ever swept by
 * this shared helper. Every OCR/document-library test creates its documents
 * through a real `uploadedByEmail` matching TEST_TAG (see createTestUser()'s
 * uniqueEmail()), so that field is a safe, reliable filter — and deleting the
 * physical file before the DB record (mirroring archiveToDocumentLibrary's
 * own directory) closes the second leak at its root for every caller of this
 * helper, regardless of whether that test's own cleanup already tried.
 *
 * The file deletions below are explicitly awaited (fs.promises.unlink, via
 * Promise.all) rather than the fire-and-forget fs.unlink(path, callback)
 * style used elsewhere in this codebase (e.g. ocrService.js) — that pattern
 * is fine in a long-running server process, but in a short-lived Jest
 * process this async function's caller (a test's afterAll) typically calls
 * closeDB() and returns immediately after, and the Node process can exit
 * before an un-awaited unlink's callback ever fires. Found live: 4 files
 * from a single test run stayed orphaned even though cleanupAll() logged
 * that it "deleted" them, because the unlink callbacks simply never got a
 * chance to run before the process terminated.
 */
async function cleanupAll() {
  const db = await connectDB();
  await db.collection('users').deleteMany({ createdAt: TEST_TAG });
  await db.collection('partnerships').deleteMany({ remarks: { $regex: TEST_TAG } });
  await db.collection('requests').deleteMany({ notes: { $regex: TEST_TAG } });
  // `record` alone misses logs whose actor was a jesttest user but whose
  // record text describes a differently-named fixture (e.g. "Partnership
  // added: Jest Report Filter University" — no literal "jesttest" substring
  // in the record text itself, only in `by`/`email`) — found via this same
  // health-check audit leaving 177 such logs behind after a full clean run.
  await db.collection('activitylogs').deleteMany({
    $or: [{ record: { $regex: TEST_TAG, $options: 'i' } }, { by: { $regex: TEST_TAG, $options: 'i' } }, { email: { $regex: TEST_TAG, $options: 'i' } }]
  });

  const testDocs = await db.collection('documents').find({ uploadedByEmail: { $regex: TEST_TAG, $options: 'i' } }).toArray();
  const documentsDir = path.join(__dirname, '..', 'uploads', 'documents');
  await Promise.all(testDocs.map((doc) => {
    if (!doc.fileLink || !doc.fileLink.startsWith('/uploads/documents/')) return null;
    const filePath = path.join(documentsDir, path.basename(doc.fileLink));
    return fsp.unlink(filePath).catch(() => {}); // best-effort — a missing file is not an error here
  }));
  await db.collection('documents').deleteMany({ uploadedByEmail: { $regex: TEST_TAG, $options: 'i' } });

  await db.collection('notifications').deleteMany({
    $or: [{ title: { $regex: TEST_TAG, $options: 'i' } }, { desc: { $regex: TEST_TAG, $options: 'i' } }, { targetEmail: { $regex: TEST_TAG, $options: 'i' } }]
  });
}

module.exports = { TEST_TAG, uniqueEmail, createTestUser, loginAs, cleanupAll, getDb, connectDB };
