// E-mail copies of request notifications (2026-09-26). Sent through a Gmail / Google Workspace account with an App
// Password (Google Account → Security → 2-Step Verification → App passwords), configured in the environment:
//   MAIL_USER           the sending address, e.g. the CIRL office account
//   MAIL_APP_PASSWORD   its 16-character App Password (spaces are ignored)
//   MAIL_FROM_NAME      optional display name (default "CIPRMS — CSPC CIRL")
//   APP_BASE_URL        optional public address used for links in the e-mail (default http://localhost:<PORT>)
// E-mail is always best-effort: a missing configuration or a mail failure is logged and never blocks the request
// action that triggered it. Under Jest nothing leaves the machine — messages are captured in `sentForTests`.
const nodemailer = require('nodemailer');

const sentForTests = [];
let transporter = null;

function isConfigured() {
  return !!(process.env.MAIL_USER && process.env.MAIL_APP_PASSWORD);
}

function getTransporter() {
  if (process.env.JEST_WORKER_ID) {
    return { sendMail: async (msg) => { sentForTests.push(msg); return { messageId: 'jest-' + sentForTests.length }; } };
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.MAIL_USER, pass: String(process.env.MAIL_APP_PASSWORD || '').replace(/\s+/g, '') }
    });
  }
  return transporter;
}

function baseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Absolute link into CIPRMS for a notification's app-relative link ("/partnership-requests?open=12").
function absoluteLink(link) {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//')) return baseUrl();
  return baseUrl() + link;
}

function buildMessage(to, { title, desc, link, tag }) {
  const url = absoluteLink(link);
  const subject = `[CIPRMS] ${title || 'Notification'}`;
  const text = `${title || ''}\n\n${desc || ''}\n\nOpen in CIPRMS: ${url}\n\n— CIPRMS, Camarines Sur Polytechnic Colleges (CIRL)`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#212529;">
  <div style="background:#405189;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0;font-weight:bold;">CIPRMS${tag ? ' · ' + esc(tag) : ''}</div>
  <div style="border:1px solid #e9ebec;border-top:none;padding:20px;border-radius:0 0 6px 6px;">
    <h2 style="font-size:17px;margin:0 0 10px;">${esc(title)}</h2>
    <p style="font-size:14px;line-height:1.5;margin:0 0 18px;">${esc(desc)}</p>
    <a href="${esc(url)}" style="display:inline-block;background:#405189;color:#fff;text-decoration:none;padding:9px 16px;border-radius:4px;font-size:14px;">Open in CIPRMS</a>
    <p style="font-size:12px;color:#878a99;margin:20px 0 0;">You received this because you have a CIPRMS account at Camarines Sur Polytechnic Colleges (CIRL). The same notification is in your CIPRMS bell.</p>
  </div>
</div>`;
  return {
    from: { name: process.env.MAIL_FROM_NAME || 'CIPRMS — CSPC CIRL', address: process.env.MAIL_USER || 'ciprms@localhost' },
    to,
    subject,
    text,
    html
  };
}

// Sends one e-mail per recipient (so nobody sees the others' addresses). Never throws.
// Returns { sent: [emails], failed: [{ email, error }], skipped: reason|null }.
async function sendNotificationEmails(emails, payload) {
  const targets = [...new Set((emails || []).map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
  const result = { sent: [], failed: [], skipped: null };
  if (!targets.length) return result;
  if (!isConfigured() && !process.env.JEST_WORKER_ID) {
    result.skipped = 'not_configured';
    return result;
  }
  const t = getTransporter();
  for (const to of targets) {
    try {
      await t.sendMail(buildMessage(to, payload || {}));
      result.sent.push(to);
    } catch (err) {
      // Never log the password; nodemailer's auth errors do not include it.
      console.error(`E-mail notification to ${to} failed:`, err && err.message);
      result.failed.push({ email: to, error: err && err.message });
    }
  }
  return result;
}

// Confirms the SMTP login works (used by the startup log and the test script). Never throws.
async function verify() {
  if (!isConfigured()) return { ok: false, error: 'MAIL_USER / MAIL_APP_PASSWORD are not set.' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = { isConfigured, sendNotificationEmails, verify, buildMessage, sentForTests };
