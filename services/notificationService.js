/**
 * ── CENTRALIZED NOTIFICATION SERVICE FOR CIPRMS ──────────────────────────────
 *
 * Guarantees Two-Channel Delivery for EVERY notification generated in CIPRMS:
 *   Channel 1: In-System Notification (persisted in MongoDB `notifications` collection)
 *   Channel 2: Email Notification (sent to each recipient's registered email address)
 *
 * Key Architectural Guarantees:
 *   - Universal: Covers all current notification types and future triggers automatically.
 *   - Recipient Isolation: Each recipient receives a dedicated in-system record and
 *     isolated individual email (addresses are never co-mingled or exposed).
 *   - Non-Blocking & Resilient: Email failures are logged and handled gracefully;
 *     an email failure NEVER crashes, blocks, or rolls back the originating database action.
 *   - Realtime Integration: Automatically broadcasts in-app updates via Server-Sent Events (SSE).
 *   - Offline Delivery: Emails reach users even when signed out, away, or on mobile.
 */

const emailService = require('./emailService');

const VALID_ROLES = ['Administrator', 'Staff', 'Auth. Personnel', 'potential_partner'];

let publishNotificationsHandler = null;

/**
 * Registers the realtime SSE publisher from cirl.js
 * @param {Function} fn
 */
function setPublishNotificationsHandler(fn) {
  publishNotificationsHandler = fn;
}

/**
 * Resolves registered email addresses from diverse recipient inputs:
 *   - string email ("user@cspc.edu.ph")
 *   - array of emails (["a@b.com", "c@d.com"])
 *   - role name ("Staff", "Administrator") → resolves all active users of that role
 *   - user objects ({ email: "..." })
 * Deduplicates and filters for valid email syntax.
 *
 * @param {import('mongodb').Db} db
 * @param {string|string[]|object|object[]} recipients
 * @returns {Promise<string[]>}
 */
async function resolveRecipientEmails(db, recipients) {
  if (!recipients) return [];
  const rawList = Array.isArray(recipients) ? recipients : [recipients];
  const resolved = [];

  for (const item of rawList) {
    if (!item) continue;

    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        resolved.push(trimmed.toLowerCase());
      } else if (VALID_ROLES.includes(trimmed)) {
        try {
          const users = await db.collection('users').find({
            role: trimmed,
            status: { $ne: 'Inactive' }
          }, { projection: { email: 1 } }).toArray();
          for (const u of users) {
            if (u.email && typeof u.email === 'string') {
              resolved.push(u.email.trim().toLowerCase());
            }
          }
        } catch (err) {
          console.error(`Failed to resolve role recipients for '${trimmed}':`, err && err.message);
        }
      }
    } else if (typeof item === 'object' && item.email && typeof item.email === 'string') {
      const email = item.email.trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        resolved.push(email);
      }
    }
  }

  return [...new Set(resolved.filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
}

/**
 * Creates and dispatches notifications through both channels:
 * In-system notification + Email delivery.
 *
 * @param {import('mongodb').Db} db
 * @param {object} options
 * @param {string|string[]|object[]} [options.recipients] - Target email(s), role(s), or user object(s)
 * @param {boolean} [options.allowUnaddressed=false] - If true, permits system alert without targetEmail
 * @param {string} [options.module='system'] - 'request' | 'calendar' | 'lifecycle' | 'document' | 'user' | 'system'
 * @param {string} [options.tag='Notification'] - UI badge tag
 * @param {string} [options.icon='ri-notification-3-line'] - RemixIcon class
 * @param {string} [options.color='info'] - Bootstrap color variant ('primary', 'success', 'warning', 'danger', 'info')
 * @param {string} options.title - Notification headline
 * @param {string} options.desc - Detailed message text
 * @param {string} [options.link] - Internal CIPRMS destination link
 * @param {string} [options.downloadLink] - Optional direct download attachment link
 * @param {string} [options.time] - Custom formatted display date (defaults to current date)
 * @returns {Promise<{success: boolean, insertedCount: number, docs: object[], emailsSent: Promise<object>}>}
 */
async function createNotification(db, {
  recipients,
  allowUnaddressed = false,
  module = 'system',
  tag = 'Notification',
  icon = 'ri-notification-3-line',
  color = 'info',
  title,
  desc,
  link = null,
  downloadLink = null,
  time = null,
  ...extraFields
}) {
  const targetEmails = await resolveRecipientEmails(db, recipients);

  if (!targetEmails.length && !allowUnaddressed) {
    return {
      success: false,
      reason: 'no_valid_recipients',
      insertedCount: 0,
      docs: []
    };
  }

  const notifTime = time || new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const payload = {
    module,
    tag,
    icon,
    color,
    title: title || 'Notification',
    desc: desc || '',
    link: link || null,
    downloadLink: downloadLink || null,
    ...extraFields
  };

  // 1. Channel 1: In-System Notification (Database Insertion)
  let docs = [];
  try {
    const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = last.length ? (last[0].id || 0) + 1 : 1;

    if (targetEmails.length) {
      docs = targetEmails.map(targetEmail => ({
        id: nextId++,
        targetEmail,
        unread: true,
        time: notifTime,
        ...payload
      }));
    } else if (allowUnaddressed) {
      docs = [{
        id: nextId++,
        unread: true,
        time: notifTime,
        ...payload
      }];
    }

    if (docs.length) {
      await db.collection('notifications').insertMany(docs);
    }

    // Realtime in-app broadcast via SSE (non-blocking)
    if (typeof publishNotificationsHandler === 'function' && docs.length) {
      publishNotificationsHandler(db, docs).catch(err => {
        console.error('Realtime notification publish failed:', err && err.message);
      });
    }
  } catch (dbErr) {
    console.error('Failed to insert in-system notifications:', dbErr && dbErr.message);
    throw dbErr;
  }

  // 2. Channel 2: Email Notification (to each recipient's registered email)
  // Sent in the background; failure never disrupts the original system action
  let emailPromise = Promise.resolve({ sent: [], failed: [], skipped: 'no_recipients' });
  if (targetEmails.length) {
    emailPromise = emailService.sendNotificationEmails(targetEmails, {
      ...payload,
      time: notifTime
    }).then(res => {
      if (res && res.failed && res.failed.length) {
        console.warn(`[NotificationService] Email delivery failed for ${res.failed.length} recipient(s):`, res.failed);
      }
      return res;
    }).catch(err => {
      console.error('[NotificationService] Automated email dispatch failed:', err && err.message);
      return { sent: [], failed: targetEmails.map(e => ({ email: e, error: err.message })), skipped: null };
    });
  }

  return {
    success: true,
    insertedCount: docs.length,
    docs,
    targetEmails,
    emailPromise
  };
}

module.exports = {
  createNotification,
  resolveRecipientEmails,
  setPublishNotificationsHandler
};
