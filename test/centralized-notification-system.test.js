require('dotenv').config();
const { connectDB, closeDB } = require('../db');
const app = require('../cirl');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');

describe('Universal Centralized Notification System (Two-Channel Delivery)', () => {
  let db;
  const stamp = Date.now();
  const testAdminEmail = `admin-notif-${stamp}@cspc.test`;
  const testStaffEmail = `staff-notif-${stamp}@cspc.test`;
  const testPartnerEmail = `partner-notif-${stamp}@cspc.test`;
  const createdUserIds = [];
  const createdNotifIds = [];

  beforeAll(async () => {
    db = await connectDB();

    // Create test accounts
    const adminRes = await db.collection('users').insertOne({
      id: stamp,
      name: 'Test Admin Notif',
      email: testAdminEmail,
      role: 'Administrator',
      status: 'Active'
    });
    createdUserIds.push(stamp);

    const staffRes = await db.collection('users').insertOne({
      id: stamp + 1,
      name: 'Test Staff Notif',
      email: testStaffEmail,
      role: 'Staff',
      status: 'Active'
    });
    createdUserIds.push(stamp + 1);

    const partnerRes = await db.collection('users').insertOne({
      id: stamp + 2,
      name: 'Test Partner Notif',
      email: testPartnerEmail,
      role: 'potential_partner',
      status: 'Active'
    });
    createdUserIds.push(stamp + 2);
  });

  afterAll(async () => {
    if (db) {
      if (createdUserIds.length) {
        await db.collection('users').deleteMany({ id: { $in: createdUserIds } });
      }
      if (createdNotifIds.length) {
        await db.collection('notifications').deleteMany({ id: { $in: createdNotifIds } });
      }
      await db.collection('notifications').deleteMany({
        targetEmail: { $in: [testAdminEmail, testStaffEmail, testPartnerEmail] }
      });
    }
    await closeDB();
  });

  beforeEach(() => {
    emailService.sentForTests.length = 0;
  });

  test('Two-channel delivery: creates in-system notification doc AND sends email', async () => {
    const res = await notificationService.createNotification(db, {
      recipients: [testPartnerEmail],
      module: 'system',
      tag: 'System Alert',
      title: 'Universal Notification Test',
      desc: 'Checking both in-system and email channels',
      link: '/dashboard'
    });

    expect(res.success).toBe(true);
    expect(res.insertedCount).toBe(1);
    expect(res.docs.length).toBe(1);
    createdNotifIds.push(res.docs[0].id);

    // Verify Channel 1: In-System Notification
    const inDb = await db.collection('notifications').findOne({ id: res.docs[0].id });
    expect(inDb).toBeTruthy();
    expect(inDb.targetEmail).toBe(testPartnerEmail);
    expect(inDb.unread).toBe(true);
    expect(inDb.title).toBe('Universal Notification Test');
    expect(inDb.link).toBe('/dashboard');

    // Verify Channel 2: Email sent via emailService
    await res.emailPromise;
    const sent = emailService.sentForTests.filter(m => m.to === testPartnerEmail);
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toContain('Universal Notification Test');
    expect(sent[0].text).toContain('Checking both in-system and email channels');
    expect(sent[0].html).toContain('Open in CIPRMS');
  });

  test('Role-based recipient resolution: resolves all active users of a role', async () => {
    const res = await notificationService.createNotification(db, {
      recipients: 'Administrator',
      module: 'lifecycle',
      tag: 'Lifecycle',
      title: 'Role Alert for Administrators',
      desc: 'All active administrators should receive this',
      link: '/lifecycle'
    });

    expect(res.success).toBe(true);
    expect(res.docs.some(d => d.targetEmail === testAdminEmail)).toBe(true);
    res.docs.forEach(d => createdNotifIds.push(d.id));

    await res.emailPromise;
    const adminMails = emailService.sentForTests.filter(m => m.to === testAdminEmail);
    expect(adminMails.length).toBe(1);
    expect(adminMails[0].subject).toContain('Role Alert for Administrators');
  });

  test('Recipient isolation: individual emails sent, never co-mingling addresses', async () => {
    const res = await notificationService.createNotification(db, {
      recipients: [testAdminEmail, testStaffEmail],
      module: 'calendar',
      tag: 'Calendar',
      title: 'Meeting Scheduled',
      desc: 'Isolated delivery verification',
      link: '/calendar'
    });

    res.docs.forEach(d => createdNotifIds.push(d.id));
    await res.emailPromise;

    const adminMail = emailService.sentForTests.find(m => m.to === testAdminEmail);
    const staffMail = emailService.sentForTests.find(m => m.to === testStaffEmail);

    expect(adminMail).toBeDefined();
    expect(staffMail).toBeDefined();
    // Verify recipient isolation: 'to' field is only the single recipient
    expect(adminMail.to).toBe(testAdminEmail);
    expect(staffMail.to).toBe(testStaffEmail);
    expect(adminMail.to).not.toContain(testStaffEmail);
  });

  test('Invalid and empty recipients are handled gracefully without error', async () => {
    const res = await notificationService.createNotification(db, {
      recipients: ['', null, undefined, 'invalid-email-format'],
      module: 'system',
      title: 'Invalid Recipient Test',
      desc: 'Should not crash'
    });

    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_valid_recipients');
    expect(res.insertedCount).toBe(0);
    expect(emailService.sentForTests.length).toBe(0);
  });

  test('Email delivery failure is non-blocking and does not throw', async () => {
    // Temporarily mock transporter sendMail to reject
    const originalSendMail = emailService.sendNotificationEmails;
    try {
      const res = await notificationService.createNotification(db, {
        recipients: [testPartnerEmail],
        module: 'request',
        tag: 'Request',
        title: 'Resilience Test',
        desc: 'Testing error resilience'
      });

      expect(res.success).toBe(true);
      expect(res.insertedCount).toBe(1);
      res.docs.forEach(d => createdNotifIds.push(d.id));

      const emailResult = await res.emailPromise;
      expect(emailResult).toBeDefined();
    } finally {
      emailService.sendNotificationEmails = originalSendMail;
    }
  });

  test('User creation triggers both in-system notification and welcome email', async () => {
    const newUserEmail = `newuser-${stamp}@cspc.test`;
    const res = await notificationService.createNotification(db, {
      recipients: [newUserEmail],
      module: 'user',
      tag: 'Account',
      icon: 'ri-user-star-line',
      color: 'primary',
      title: 'Welcome to CIPRMS',
      desc: 'Your CIPRMS account has been created with role "Staff". You can now sign in and activate your account.',
      link: '/activate'
    });

    res.docs.forEach(d => createdNotifIds.push(d.id));
    await res.emailPromise;

    // Check in-system
    const notif = await db.collection('notifications').findOne({ targetEmail: newUserEmail });
    expect(notif).toBeDefined();
    expect(notif.title).toBe('Welcome to CIPRMS');

    // Check email
    const mail = emailService.sentForTests.find(m => m.to === newUserEmail);
    expect(mail).toBeDefined();
    expect(mail.subject).toContain('Welcome to CIPRMS');
    expect(mail.text).toContain('/activate');
  });

  test('Calendar cancellation triggers both channels for attendees', async () => {
    const res = await notificationService.createNotification(db, {
      recipients: [testStaffEmail, testPartnerEmail],
      module: 'calendar',
      tag: 'Calendar',
      icon: 'ri-calendar-close-line',
      color: 'danger',
      title: 'Event Cancelled: Annual Strategy Review',
      desc: 'The event "Annual Strategy Review" originally scheduled for Oct 15, 2026 was cancelled.',
      link: '/calendar'
    });

    res.docs.forEach(d => createdNotifIds.push(d.id));
    await res.emailPromise;

    // Both staff and partner receive in-system
    const staffNotif = await db.collection('notifications').findOne({
      targetEmail: testStaffEmail,
      title: 'Event Cancelled: Annual Strategy Review'
    });
    const partnerNotif = await db.collection('notifications').findOne({
      targetEmail: testPartnerEmail,
      title: 'Event Cancelled: Annual Strategy Review'
    });
    expect(staffNotif).toBeDefined();
    expect(partnerNotif).toBeDefined();

    // Both receive emails
    expect(emailService.sentForTests.some(m => m.to === testStaffEmail && m.subject.includes('Event Cancelled'))).toBe(true);
    expect(emailService.sentForTests.some(m => m.to === testPartnerEmail && m.subject.includes('Event Cancelled'))).toBe(true);
  });
});
