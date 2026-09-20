// Time, timezone and e-mail helpers shared by the calendar routes and the
// Google Calendar service (2026-09-20).
//
// CIPRMS is used in the Philippines, but the calendar UI has always saved a
// meeting's time as a "naive" wall-clock string ("2026-09-29T21:44" — exactly
// what <input type="date"> + <input type="time"> produce, with no offset). The
// server used to feed that string straight to `new Date()`, which reads a
// naive string in the SERVER's own timezone — right on a developer laptop in
// Manila, but 8 hours off on a UTC host (Render). Everything here interprets a
// naive string in ONE explicit application timezone instead, so the Google
// Calendar event, the server-side "has the meeting started?" check and the
// recorded join time all describe the same instant no matter where the
// server or the browser happens to be.
//
// APP_TIMEZONE can be overridden with an IANA name; it defaults to the
// Philippines (Asia/Manila, UTC+8, no daylight saving).

function appTimeZone() {
  return process.env.APP_TIMEZONE || 'Asia/Manila';
}

const dtfCache = new Map();
function partsFormatter(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  return dtfCache.get(tz);
}

function zonedParts(date, tz) {
  const p = {};
  for (const part of partsFormatter(tz).formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// Offset (ms) of `tz` from UTC at the given instant.
function tzOffsetMs(ms, tz) {
  const p = zonedParts(new Date(ms), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant at which a clock in `tz` reads y-mo-d h:mi:s.
function wallTimeToInstant(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMs(guess, tz);
  let ms = guess - off1;
  const off2 = tzOffsetMs(ms, tz); // corrects the guess across a DST change (none in Manila, but the helper is general)
  if (off2 !== off1) ms = guess - off2;
  return new Date(ms);
}

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function validCalendarDate(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Parses a stored/submitted event date into a real instant (Date), or null.
 * - "2026-09-29T21:44" / "2026-09-29"  → wall-clock in the application timezone
 * - "2026-09-29T13:44:00.000Z" / "…+08:00" → that exact instant (the UI's
 *   drag-and-drop used to save these; older events still carry them)
 */
function parseEventInstant(value, tz) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const m = NAIVE_RE.exec(v);
  if (m) {
    const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
    if (!validCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
    return wallTimeToInstant(y, mo, d, h, mi, s, tz || appTimeZone());
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v) && OFFSET_RE.test(v)) {
    const t = new Date(v);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** The calendar date (YYYY-MM-DD) an event value falls on, in the application timezone. */
function eventDateOnly(value, tz) {
  if (typeof value === 'string') {
    const m = NAIVE_RE.exec(value.trim());
    if (m) return `${m[1]}-${m[2]}-${m[3]}`; // already a wall-clock date — no conversion
  }
  const inst = parseEventInstant(value, tz);
  if (!inst) return null;
  const p = zonedParts(inst, tz || appTimeZone());
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function addDaysToDateOnly(dateOnly, days) {
  const [y, mo, d] = dateOnly.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The instant a calendar event starts. An all-day event starts at 00:00 on its
 * date in the application timezone.
 */
function eventStartInstant(ev, tz) {
  if (!ev) return null;
  const zone = tz || appTimeZone();
  if (ev.allDay) {
    const date = eventDateOnly(ev.start, zone);
    return date ? parseEventInstant(date, zone) : null;
  }
  return parseEventInstant(ev.start, zone);
}

function eventEndInstant(ev, tz) {
  if (!ev || !ev.end) return null;
  const zone = tz || appTimeZone();
  if (ev.allDay) {
    const date = eventDateOnly(ev.end, zone);
    return date ? parseEventInstant(date, zone) : null;
  }
  return parseEventInstant(ev.end, zone);
}

/** Server-side wall-clock formatting, so a displayed time never depends on the viewer's browser timezone. */
function formatTimeInTz(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz || appTimeZone(), hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}
function formatDateTimeInTz(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz || appTimeZone(), month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

// ── e-mail ────────────────────────────────────────────────────────────────────
// Google Calendar rejects the WHOLE event request when a single attendee
// address is malformed (one bad address used to silently lose the invitation
// for everyone), so only plain ASCII addresses are ever sent to it.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 254 || !EMAIL_RE.test(v)) return false;
  const local = v.slice(0, v.indexOf('@'));
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

function emailKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Valid, lower-cased, de-duplicated addresses (order preserved). */
function uniqueValidEmails(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isValidEmail(raw)) continue;
    const key = emailKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

module.exports = {
  appTimeZone,
  parseEventInstant,
  eventDateOnly,
  addDaysToDateOnly,
  eventStartInstant,
  eventEndInstant,
  formatTimeInTz,
  formatDateTimeInTz,
  isValidEmail,
  emailKey,
  uniqueValidEmails
};
