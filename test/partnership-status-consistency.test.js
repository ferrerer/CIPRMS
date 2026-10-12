// Partnership expiry-status consistency (2026-11 Phase 2). Root cause: two independently-written copies of
// the same "days until expiry" rule existed — computeStatusFromEnd() (cirl.js), the one actually used by
// Reports & Analytics, the Dashboard widget and the hourly lifecycle job, and a second, older
// computePartnershipStatus() used only by the renewal-approval route (PATCH /api/requests/:id). They agreed
// everywhere except the expiry date itself (days === 0): computeStatusFromEnd treated it as still "Expiring
// Soon" (not yet past), computePartnershipStatus treated it as already "Expired". A partnership renewed to
// expire exactly "today" could show Expired the moment it was approved and Expiring Soon an hour later once
// the lifecycle job recomputed it — or the reverse, depending on which ran first. The fix removes the second
// function entirely; every computation in the app is now computeStatusFromEnd().
//
// Agreed rule (see computeStatusFromEnd()'s own doc comment in cirl.js for the authoritative statement):
//   days > 90 Active | 0 <= days <= 90 Expiring Soon | days < 0 Expired — the expiry date itself (day 0)
//   is still Expiring Soon, Expired begins the day after.
//
// This proves the rule holds, and holds IDENTICALLY, across the three independent places that compute it —
// via real HTTP routes, not by importing the function directly (cirl.js exports only the Express app).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

function dateOnly(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); // matches how `end` is stored everywhere else (e.g. POST /api/partnerships)
}

let nextTestId = Math.floor(Date.now() / 1000); // comfortably above any real partnership id, to avoid colliding with the collection's own sequence
async function insertTestPartnership({ inst, end, storedStatus }) {
  const id = nextTestId++;
  await db.collection('partnerships').insertOne({
    id, inst, country: 'Testland', type: 'MOA', cat: 'Local', region: 'Bicol', unit: ['CIRL'],
    start: dateOnly(-365), end, status: storedStatus, // storedStatus is deliberately wrong, to prove it gets recomputed, not just read through
    remarks: `${TEST_TAG} status consistency`
  });
  return id;
}

describe('computeStatusFromEnd\'s agreed day boundaries hold identically in the lifecycle job and the Reports engine', () => {
  const cases = [
    { label: 'day before expiry (1 day left)', days: 1, expected: 'Expiring Soon' },
    { label: 'the expiry date itself (0 days left)', days: 0, expected: 'Expiring Soon' },
    { label: 'the day after expiry (-1 day left)', days: -1, expected: 'Expired' },
    { label: 'exactly at the 90-day window edge', days: 90, expected: 'Expiring Soon' },
    { label: 'one day past the 90-day window (91 days left)', days: 91, expected: 'Active' }
  ];

  test.each(cases)('$label -> $expected, agreed by both the lifecycle recompute and the Reports preview', async ({ days, expected }) => {
    const inst = `${TEST_TAG} Boundary ${days}d ${Date.now()}`;
    // Seeded with the OPPOSITE status on purpose — both read paths below must actively recompute it from
    // `end`, not merely echo back whatever was already stored.
    const wrongOnPurpose = expected === 'Active' ? 'Expired' : 'Active';
    await insertTestPartnership({ inst, end: dateOnly(days), storedStatus: wrongOnPurpose });

    const { agent: adminAgent } = await agentFor('Administrator');
    const recomputeRes = await adminAgent.post('/api/lifecycle/recompute');
    expect(recomputeRes.status).toBe(200);
    const stored = await db.collection('partnerships').findOne({ inst });
    expect(stored.status).toBe(expected); // the hourly job's own authoritative recompute

    const { agent: staffAgent } = await agentFor('Staff');
    const previewRes = await staffAgent.get('/api/reports/custom/preview').query({ inst });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.records.length).toBe(1);
    expect(previewRes.body.records[0].status).toBe(expected); // the Reports & Analytics engine's own independent computation
  });
});

describe('Renewal approval (the one route that used to disagree) now agrees with the lifecycle job at the exact boundary that exposed the bug', () => {
  test('approving a renewal to expire exactly "today" leaves the partnership Expiring Soon, not Expired — and the lifecycle job agrees an instant later', async () => {
    const { agent: partnerAgent, user: partnerUser } = await agentFor('potential_partner');
    const inst = `${TEST_TAG} Renewal Boundary ${Date.now()}`;

    // The renewal route's ownership check requires an already-APPROVED request for this institution,
    // submitted by this same user — inserted directly, the same shape POST /api/partnerships' conversion
    // path produces, rather than running the whole approval flow just to get there.
    const partnershipId = await insertTestPartnership({ inst, end: dateOnly(30), storedStatus: 'Expiring Soon' });
    await db.collection('requests').insertOne({
      id: nextTestId++, institution: inst, country: 'Testland', type: 'MOA', nature: 'Research', unit: 'CIRL',
      status: 'Approved', submittedByEmail: partnerUser.email, notes: `${TEST_TAG} status consistency`,
      date: dateOnly(0)
    });

    const renewRes = await partnerAgent.post(`/api/partnerships/${partnershipId}/renew-request`)
      .send({ proposedEndDate: new Date().toISOString(), notes: `${TEST_TAG} status consistency renewal` });
    expect(renewRes.status).toBe(200);
    const renewalRequestId = renewRes.body.request.id;

    const { agent: staffAgent } = await agentFor('Staff');
    const approveRes = await staffAgent.patch(`/api/requests/${renewalRequestId}`).send({ status: 'Approved' });
    expect(approveRes.status).toBe(200);

    const renewedPartnership = await db.collection('partnerships').findOne({ id: partnershipId });
    expect(renewedPartnership.status).toBe('Expiring Soon'); // NOT 'Expired' — this is the exact regression the old computePartnershipStatus() produced

    // The lifecycle job, run right after, must not then flip it to something else — proving the approval
    // route and the hourly job are reading the same rule, not two that happen to agree only sometimes.
    const { agent: adminAgent } = await agentFor('Administrator'); // /api/lifecycle/recompute is Administrator-only
    const recomputeRes = await adminAgent.post('/api/lifecycle/recompute');
    expect(recomputeRes.status).toBe(200);
    const afterRecompute = await db.collection('partnerships').findOne({ id: partnershipId });
    expect(afterRecompute.status).toBe('Expiring Soon');
  });
});
