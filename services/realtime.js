// Server-Sent Events hub — the one place CIPRMS pushes "something changed" to browsers that are open right now.
//
//   database write succeeds  ->  publish(type, payload, audience)  ->  only the connections the audience matches
//
// Design rules (each is enforced here, not left to callers):
//   * SSE, not WebSockets: traffic is server -> browser only, it rides on the existing Express/session stack with no
//     new dependency, and EventSource reconnects on its own. The browser never sends anything over this channel, so it
//     cannot be used to write or to ask for data.
//   * An event is a small INVALIDATION HINT ({ id, status, ... } — never a full request/partnership/document record).
//     The page reacts by re-reading the affected data through the ordinary HTTP endpoints, so what it shows is decided
//     by the same RBAC checks as any other page load. The channel cannot widen what a role is allowed to see. The one
//     exception is notification.created, whose audience is exactly its single recipient.
//   * Every event names its audience ({ emails, roles } or { all }) and is delivered only to connections that match. A
//     connection is bound to the user that opened it (id, e-mail and role captured from the session at connect time).
//   * Connections are re-validated on a timer: a user who is deactivated, deleted, has a different role, or whose session
//     has ended stops receiving events and is disconnected. The stream is not an authorization bypass.
const crypto = require('crypto');

const HEARTBEAT_MS = 25 * 1000;
const REVALIDATE_MS = 60 * 1000;
const MAX_CONNECTIONS_PER_USER = 6;
const MAX_PAYLOAD_BYTES = 8 * 1024;

const bootId = crypto.randomBytes(4).toString('hex');
const clients = new Set();
let seq = 0;
let timers = null;
let revalidateUser = null;   // async (client) => boolean — installed by cirl.js (needs the DB and the session store)

const emailKey = (e) => String(e || '').trim().toLowerCase();

/** Audience builders. An event with no audience goes to nobody. */
const audience = {
  emails: (list) => ({ emails: [...new Set((list || []).map(emailKey).filter(Boolean))] }),
  roles: (list) => ({ roles: [...new Set(list || [])] }),
  all: () => ({ all: true }),
  merge: (...parts) => {
    const out = { emails: [], roles: [], all: false };
    for (const p of parts) {
      if (!p) continue;
      if (p.all) out.all = true;
      if (p.emails) out.emails.push(...p.emails);
      if (p.roles) out.roles.push(...p.roles);
    }
    out.emails = [...new Set(out.emails)]; out.roles = [...new Set(out.roles)];
    return out;
  }
};

function matches(aud, client) {
  if (!aud) return false;
  if (aud.all) return true;
  if (aud.roles && aud.roles.includes(client.user.role)) return true;
  if (aud.emails && aud.emails.includes(emailKey(client.user.email))) return true;
  return false;
}

function write(client, chunk) {
  try { return client.res.write(chunk); } catch (_) { drop(client); return false; }
}

function drop(client) {
  if (!clients.delete(client)) return;
  try { client.res.end(); } catch (_) { /* already closed */ }
  if (!clients.size) stopTimers();
}

function startTimers() {
  if (timers) return;
  timers = {
    beat: setInterval(() => { for (const c of [...clients]) write(c, ': ping\n\n'); }, HEARTBEAT_MS),
    check: setInterval(revalidateAll, REVALIDATE_MS)
  };
  timers.beat.unref(); timers.check.unref();     // never keep the process (or a Jest run) alive
}
function stopTimers() {
  if (!timers) return;
  clearInterval(timers.beat); clearInterval(timers.check); timers = null;
}

async function revalidateAll() {
  if (!revalidateUser) return;
  for (const c of [...clients]) {
    let ok = false;
    try { ok = await revalidateUser(c); } catch (_) { ok = true; /* a transient DB error must not log everybody out */ }
    if (!ok) { write(c, 'event: session.ended\ndata: {}\n\n'); drop(c); }
  }
}

/**
 * Express handler for GET /api/realtime/stream (mounted behind the session check). `user` is the session user; the
 * connection keeps a snapshot of who it was opened for.
 */
function connect(req, res, user) {
  // one user, a bounded number of connections — the oldest goes first
  const mine = [...clients].filter(c => c.user.id === user.id);
  while (mine.length >= MAX_CONNECTIONS_PER_USER) drop(mine.shift());

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'     // tell a reverse proxy (nginx / Render) not to buffer the stream
  });
  if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); }
  res.flushHeaders();

  const client = { res, user: { id: user.id, email: user.email, role: user.role }, sessionID: req.sessionID, since: Date.now() };
  // express-session (resave: true) would re-save this request's session object when the long-lived response finally ends
  // — which would bring back a session that was logged out in the meantime. The cookie header is already written, so
  // detach the session from this request: the stream never reads or writes it again.
  req.session = null;
  clients.add(client);
  startTimers();
  // `retry` = how long the browser waits before reconnecting; `hello` lets the page tell a first connect from a reconnect
  res.write(`retry: 4000\nevent: hello\ndata: ${JSON.stringify({ boot: bootId })}\n\n`);
  const cleanup = () => drop(client);
  req.on('close', cleanup); res.on('error', cleanup);
  return client;
}

/**
 * Deliver an event to every open connection the audience matches. Never throws — a realtime failure must not fail the
 * request whose database change already succeeded.
 * @returns {number} how many connections received it
 */
function publish(type, payload, aud) {
  try {
    if (!clients.size || !aud) return 0;
    const data = JSON.stringify(payload || {});
    if (Buffer.byteLength(data) > MAX_PAYLOAD_BYTES) { console.error('realtime: payload too large for', type); return 0; }
    const frame = `id: ${bootId}-${++seq}\nevent: ${type}\ndata: ${data}\n\n`;
    let n = 0;
    for (const c of [...clients]) if (matches(aud, c)) { write(c, frame); if (clients.has(c)) n++; }
    return n;
  } catch (err) {
    console.error('realtime publish failed:', err.message);
    return 0;
  }
}

/** Close every connection that belongs to one login session (used by logout). */
function disconnectSession(sessionID) {
  for (const c of [...clients]) if (c.sessionID === sessionID) drop(c);
}

/** Close every connection of one user (used when an account is deactivated, deleted or its role changes). */
function disconnectUser(userId) {
  for (const c of [...clients]) if (c.user.id === userId) { write(c, 'event: session.ended\ndata: {}\n\n'); drop(c); }
}

function setRevalidator(fn) { revalidateUser = fn; }
function hasClients() { return clients.size > 0; }
function stats() { return { connections: clients.size, users: new Set([...clients].map(c => c.user.id)).size, boot: bootId }; }
function closeAll() { for (const c of [...clients]) drop(c); stopTimers(); }

module.exports = { connect, publish, audience, disconnectUser, disconnectSession, hasClients, setRevalidator, revalidateAll, stats, closeAll, matches, bootId };
