// Shared test utilities. Tests run against the real MONGO_URI (there is no
// separate test database in this project), so every helper here is built
// around leaving zero trace: create with a unique, clearly-marked identity,
// and always clean up in the calling test's afterAll.
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

/** Deletes every test-created user, and any partnerships/requests/activitylogs tagged with the jest test marker. */
async function cleanupAll() {
  const db = await connectDB();
  await db.collection('users').deleteMany({ createdAt: TEST_TAG });
  await db.collection('partnerships').deleteMany({ remarks: { $regex: TEST_TAG } });
  await db.collection('requests').deleteMany({ notes: { $regex: TEST_TAG } });
  await db.collection('activitylogs').deleteMany({ record: { $regex: TEST_TAG } });
}

module.exports = { TEST_TAG, uniqueEmail, createTestUser, loginAs, cleanupAll, getDb, connectDB };
