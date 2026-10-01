require('dotenv').config();
const { connectDB, closeDB } = require('../db');
const app = require('../cirl');
const emailService = require('../services/emailService');

describe('TASK 2 — Partnership Expiration Email Notifications', () => {
  let db;
  const stamp = Date.now();
  const testPartnershipId = stamp;
  const renewalPartnershipId = stamp + 1;

  beforeAll(async () => {
    db = await connectDB();

    // Create test active reviewer accounts
    await db.collection('users').updateOne(
      { email: 'admin-expire-test@cirl.test' },
      { $set: { name: 'Admin Expire Test', role: 'Administrator', status: 'Active' } },
      { upsert: true }
    );
    await db.collection('users').updateOne(
      { email: 'staff-expire-test@cirl.test' },
      { $set: { name: 'Staff Expire Test', role: 'Staff', status: 'Active' } },
      { upsert: true }
    );
    await db.collection('users').updateOne(
      { email: 'inactive-expire-test@cirl.test' },
      { $set: { name: 'Inactive User', role: 'Staff', status: 'Inactive' } },
      { upsert: true }
    );
  });

  afterAll(async () => {
    if (db) {
      await db.collection('users').deleteMany({
        email: { $in: ['admin-expire-test@cirl.test', 'staff-expire-test@cirl.test', 'inactive-expire-test@cirl.test'] }
      });
      await db.collection('partnerships').deleteMany({
        id: { $in: [testPartnershipId, renewalPartnershipId] }
      });
      await db.collection('partnership_expiration_notifications').deleteMany({
        partnershipId: { $in: [testPartnershipId, renewalPartnershipId] }
      });
    }
    await closeDB();
  });

  beforeEach(() => {
    emailService.sentForTests.length = 0;
  });

  describe('Date Calculation & Milestone Rules', () => {
    test('calculateDaysRemaining accurately counts local calendar days', () => {
      const today = new Date(2026, 9, 1); // Oct 1, 2026

      expect(app.calculateDaysRemaining('2026-10-01', today)).toBe(0);
      expect(app.calculateDaysRemaining('2026-10-02', today)).toBe(1);
      expect(app.calculateDaysRemaining('2026-10-16', today)).toBe(15);
      expect(app.calculateDaysRemaining('2026-10-31', today)).toBe(30);
      expect(app.calculateDaysRemaining('2026-11-30', today)).toBe(60);
      expect(app.calculateDaysRemaining('2026-12-30', today)).toBe(90);
      expect(app.calculateDaysRemaining('2026-09-30', today)).toBe(-1);
      expect(app.calculateDaysRemaining('', today)).toBeNull();
      expect(app.calculateDaysRemaining('invalid-date', today)).toBeNull();
    });

    test('isExpirationNotificationDay matches milestones (90, 60, 30, 15) and daily countdown (14..0)', () => {
      // Milestones
      expect(app.isExpirationNotificationDay(90)).toBe(true);
      expect(app.isExpirationNotificationDay(60)).toBe(true);
      expect(app.isExpirationNotificationDay(30)).toBe(true);
      expect(app.isExpirationNotificationDay(15)).toBe(true);

      // Daily countdown
      for (let d = 14; d >= 0; d--) {
        expect(app.isExpirationNotificationDay(d)).toBe(true);
      }

      // Non-notification days
      expect(app.isExpirationNotificationDay(91)).toBe(false);
      expect(app.isExpirationNotificationDay(89)).toBe(false);
      expect(app.isExpirationNotificationDay(61)).toBe(false);
      expect(app.isExpirationNotificationDay(45)).toBe(false);
      expect(app.isExpirationNotificationDay(16)).toBe(false);
      expect(app.isExpirationNotificationDay(-1)).toBe(false);
      expect(app.isExpirationNotificationDay(null)).toBe(false);
    });
  });

  describe('Recipient Aggregation', () => {
    test('aggregates Administrator, CIRL Staff, partnerEmail, coordinator email, and approved requester', async () => {
      const partnership = {
        id: testPartnershipId,
        inst: `Test Expire Recipient Inst ${stamp}`,
        type: 'MOA',
        partnerEmail: 'partner-stakeholder@partner.test',
        coordinator: 'coordinator@cspc.edu.ph',
        end: '2026-10-16'
      };

      await db.collection('requests').insertOne({
        id: stamp + 50,
        institution: partnership.inst,
        status: 'Approved',
        submittedByEmail: 'original-requester@cspc.edu.ph'
      });

      const recipients = await app.getPartnershipEmailRecipients(db, partnership);

      await db.collection('requests').deleteOne({ id: stamp + 50 });

      expect(recipients).toContain('admin-expire-test@cirl.test');
      expect(recipients).toContain('staff-expire-test@cirl.test');
      expect(recipients).not.toContain('inactive-expire-test@cirl.test'); // Inactive user excluded
      expect(recipients).toContain('partner-stakeholder@partner.test');
      expect(recipients).toContain('coordinator@cspc.edu.ph');
      expect(recipients).toContain('original-requester@cspc.edu.ph');
    });
  });

  describe('Email Content Formatting', () => {
    test('formats payload with institution, type, nature, expiration date, days remaining, and link', () => {
      const p = {
        id: testPartnershipId,
        inst: 'Tokyo University',
        country: 'Japan',
        type: 'MOA',
        nature: ['Research', 'Student Exchange'],
        end: 'Oct 15, 2026'
      };

      // Milestone
      const milestonePayload = app.formatExpirationEmailPayload(p, 90);
      expect(milestonePayload.title).toContain('90 Days Remaining');
      expect(milestonePayload.desc).toContain('Tokyo University');
      expect(milestonePayload.desc).toContain('Oct 15, 2026');
      expect(milestonePayload.desc).toContain('Research, Student Exchange');
      expect(milestonePayload.link).toContain('/lifecycle?q=Tokyo%20University');

      // Daily reminder (e.g. 15d, 7d)
      const dailyPayload = app.formatExpirationEmailPayload(p, 7);
      expect(dailyPayload.title).toContain('7 Days Remaining');
      expect(dailyPayload.desc).toContain('Tokyo University');
      expect(dailyPayload.tag).toContain('Daily Reminder');

      // Final Notice (0 days remaining)
      const finalPayload = app.formatExpirationEmailPayload(p, 0);
      expect(finalPayload.title).toContain('Expires Today');
      expect(finalPayload.tag).toContain('Final Notice');
    });
  });

  describe('Automated Notification Execution and Deduplication', () => {
    const fixedNow = new Date(2026, 9, 1); // 2026-10-01

    beforeEach(async () => {
      await db.collection('partnership_expiration_notifications').deleteMany({
        partnershipId: { $in: [testPartnershipId, renewalPartnershipId] }
      });
      await db.collection('partnerships').deleteMany({
        id: { $in: [testPartnershipId, renewalPartnershipId] }
      });
    });

    test('sends email notification on 90-day milestone and prevents duplicates on repeat runs', async () => {
      // 90 days after Oct 1, 2026 is Dec 30, 2026
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Milestone Inst ${stamp}`,
        type: 'MOU',
        nature: ['Research'],
        status: 'Expiring Soon',
        start: '2023-12-30',
        end: '2026-12-30'
      });

      // First run: should send notification
      const sent1 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent1).toBe(1);
      expect(emailService.sentForTests.length).toBeGreaterThan(0);
      const firstBatchSize = emailService.sentForTests.length;

      // Check audit record in DB
      const audit = await db.collection('partnership_expiration_notifications').findOne({
        partnershipId: testPartnershipId,
        milestone: 90
      });
      expect(audit).toBeDefined();
      expect(audit.endKey).toBe('2026-12-30');

      // Second run on the same day: should NOT duplicate
      const sent2 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent2).toBe(0);
      expect(emailService.sentForTests.length).toBe(firstBatchSize); // No extra emails sent
    });

    test('handles 15-day mark once and daily countdown (14 down to 0) without duplicate on 15d', async () => {
      // 15 days after Oct 1, 2026 is Oct 16, 2026
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Daily Inst ${stamp}`,
        type: 'MOA',
        nature: ['Academic'],
        status: 'Expiring Soon',
        start: '2023-10-16',
        end: '2026-10-16'
      });

      // Day 15 check
      const sent15 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent15).toBe(1);

      // Re-run on day 15 (e.g. hourly job): deduplicated
      const rerun15 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(rerun15).toBe(0);

      // Next day: 14 days remaining (2026-10-02)
      const day14 = new Date(2026, 9, 2);
      const sent14 = await app.checkPartnershipExpirationNotifications(db, day14, { id: testPartnershipId });
      expect(sent14).toBe(1);

      // Final day: 0 days remaining (2026-10-16)
      const day0 = new Date(2026, 9, 16);
      const sent0 = await app.checkPartnershipExpirationNotifications(db, day0, { id: testPartnershipId });
      expect(sent0).toBe(1);

      const finalAudit = await db.collection('partnership_expiration_notifications').findOne({
        partnershipId: testPartnershipId,
        milestone: 0
      });
      expect(finalAudit).toBeDefined();
      expect(finalAudit.payload.title).toContain('Expires Today');
    });

    test('renewal/extension with new expiration date triggers fresh notification cycle', async () => {
      // Partnership expiring in 30 days (2026-10-31)
      await db.collection('partnerships').insertOne({
        id: renewalPartnershipId,
        inst: `Jest Renewal Inst ${stamp}`,
        type: 'MOA',
        nature: ['Research'],
        status: 'Expiring Soon',
        start: '2023-10-31',
        end: '2026-10-31'
      });

      // 30 days remaining on 2026-10-01
      const sent30 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: renewalPartnershipId });
      expect(sent30).toBe(1);

      // Partnership is now renewed/extended with new end date: 2029-10-31
      await db.collection('partnerships').updateOne(
        { id: renewalPartnershipId },
        { $set: { end: '2029-10-31', status: 'Active' } }
      );

      // Simulate time jumping to 30 days before the new expiration date (2029-10-01)
      const newNow = new Date(2029, 9, 1);
      const sentNew30 = await app.checkPartnershipExpirationNotifications(db, newNow, { id: renewalPartnershipId });
      expect(sentNew30).toBe(1);

      const audits = await db.collection('partnership_expiration_notifications').find({
        partnershipId: renewalPartnershipId
      }).toArray();
      expect(audits.length).toBe(2);
      expect(audits.map(a => a.endKey)).toContain('2026-10-31');
      expect(audits.map(a => a.endKey)).toContain('2029-10-31');
    });

    test('skips partnerships with invalid dates or already expired (< 0 days)', async () => {
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Expired Inst ${stamp}`,
        type: 'MOA',
        status: 'Expired',
        end: '2025-01-01'
      });

      const sent = await app.checkPartnershipExpirationNotifications(db, fixedNow);
      expect(sent).toBe(0);
    });
  });
});
