// E-mail copies of request notifications (2026-09-26). Originally sent via Gmail SMTP; switched to Resend's
// HTTPS API (2026-10-15) because Render's free web-service plan blocks all outbound traffic on SMTP ports
// 25/465/587 (https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)
// — Gmail SMTP never completed a connection from there, it just hung until the caller's own timeout fired.
// Resend is reached over HTTPS (port 443), which Render's free plan does not block. Configured in the
// environment:
//   RESEND_API_KEY      API key from the Resend dashboard (Settings → API Keys)
//   MAIL_USER           the "From" address shown on outgoing mail — must be on a domain verified in Resend
//                        (Resend dashboard → Domains); without a verified domain Resend rejects the send
//   MAIL_FROM_NAME      optional display name (default "CIPRMS — CSPC CIRL")
//   APP_BASE_URL        optional public address used for links in the e-mail (default http://localhost:<PORT>)
// E-mail is always best-effort: a missing configuration or a mail failure is logged and never blocks the request
// action that triggered it. Under Jest nothing leaves the machine — messages are captured in `sentForTests`.
const { Resend } = require('resend');

const sentForTests = [];
let resendClient = null;

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_USER);
}

function getClient() {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
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

function buildMessage(to, { title, desc, link, tag, time }) {
  const url = link ? absoluteLink(link) : baseUrl();
  const subject = `[CIPRMS] ${title || 'Notification'}`;
  const notifTime = time || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const text = `${title || 'Notification'}\nDate: ${notifTime}\n\n${desc || ''}\n\nOpen in CIPRMS: ${url}\n\n— CIPRMS, Camarines Sur Polytechnic Colleges (CIRL)\nThis is an automated system notification from CIPRMS.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#212529;">
  <div style="background:#405189;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0;font-weight:bold;">CIPRMS${tag ? ' · ' + esc(tag) : ''}</div>
  <div style="border:1px solid #e9ebec;border-top:none;padding:20px;border-radius:0 0 6px 6px;">
    <h2 style="font-size:17px;margin:0 0 8px;">${esc(title)}</h2>
    <p style="font-size:12px;color:#878a99;margin:0 0 14px;"><strong>Date:</strong> ${esc(notifTime)}</p>
    <p style="font-size:14px;line-height:1.5;margin:0 0 18px;">${esc(desc)}</p>
    ${link ? `<a href="${esc(url)}" style="display:inline-block;background:#405189;color:#fff;text-decoration:none;padding:9px 16px;border-radius:4px;font-size:14px;">Open in CIPRMS</a>` : ''}
    <p style="font-size:12px;color:#878a99;margin:20px 0 0;">You received this because you are a registered recipient in CIPRMS at Camarines Sur Polytechnic Colleges (CIRL). This notification is also recorded in your CIPRMS account bell.</p>
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
  for (const to of targets) {
    const msg = buildMessage(to, payload || {});
    try {
      if (process.env.JEST_WORKER_ID) {
        sentForTests.push(msg);
      } else {
        // buildMessage()'s `from` stays a plain {name, address} object (unchanged shape — existing tests
        // read msg.to/subject/text/html directly) — only converted to Resend's "Name <address>" string here,
        // at the one real call site, never inside buildMessage itself.
        const { error } = await getClient().emails.send({
          from: `${msg.from.name} <${msg.from.address}>`,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html
        });
        if (error) throw new Error(error.message || 'Resend API rejected the e-mail.');
      }
      result.sent.push(to);
    } catch (err) {
      // Never log the API key; Resend's errors do not include it.
      console.error(`E-mail notification to ${to} failed:`, err && err.message);
      result.failed.push({ email: to, error: err && err.message });
    }
  }
  return result;
}

// Confirms the Resend API key actually authenticates (used by the startup log and the System Status check).
// domains.list() is a read-only call — chosen specifically so this never sends a real e-mail just to verify
// the connection. Never throws.
async function verify() {
  if (!isConfigured()) return { ok: false, error: 'RESEND_API_KEY / MAIL_USER are not set.' };
  try {
    const { error } = await getClient().domains.list();
    if (error) return { ok: false, error: error.message || 'Resend rejected the API key.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = { isConfigured, sendNotificationEmails, verify, buildMessage, sentForTests };
