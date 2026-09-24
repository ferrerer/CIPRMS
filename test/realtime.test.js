// Live updates (Server-Sent Events): what is pushed, to whom, and only after the database change succeeded.
// Every stream below is a real HTTP connection to a real listening server, opened with a real login cookie.
const http = require('http');
const request = require('supertest');
const app = require('../cirl');
const realtime = require('../services/realtime');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let server, base, db;
const users = {}, agents = {}, cookies = {}, streams = {};
const requestIds = [], docRequestIds = [], eventIds = [], partnershipIds = [];

function openStream(cookie, query = '') {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(base + '/api/realtime/stream' + query, { headers: { Cookie: cookie, Accept: 'text/event-stream' } }, res => {
      const stream = { status: res.statusCode, headers: res.headers, events, ended: false, raw: '', close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', chunk => {
        stream.raw += chunk;
        let i;
        while ((i = stream.raw.indexOf('\n\n')) >= 0) {
          const frame = stream.raw.slice(0, i); stream.raw = stream.raw.slice(i + 2);
          const ev = { type: 'message', data: null, id: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.type = line.slice(7);
            else if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)); } catch (_) { ev.data = line.slice(6); } }
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
          }
          if (frame.trim() && !frame.startsWith(':')) events.push(ev);
        }
      });
      res.on('end', () => { stream.ended = true; }); res.on('close', () => { stream.ended = true; });
      if (res.statusCode !== 200) { let body = ''; res.on('data', d => body += d); res.on('end', () => { stream.body = body; resolve(stream); }); return; }
      const t = setInterval(() => { if (events.some(e => e.type === 'hello')) { clearInterval(t); resolve(stream); } }, 15);
      setTimeout(() => { clearInterval(t); resolve(stream); }, 4000);
    });
    req.on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(stream, pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const hit = stream.events.find(pred); if (hit) return hit; await sleep(25); }
  return null;
}
const ofType = (s, ...types) => s.events.filter(e => types.includes(e.type));
const mark = () => { const m = {}; for (const k of Object.keys(streams)) m[k] = streams[k].events.length; return m; };
// a live view of one stream from a marked position, so waitFor() sees events that arrive later
const after = (k, m) => ({ get events() { return streams[k].events.slice(m[k]); } });
const since = (m, k, ...types) => streams[k].events.slice(m[k]).filter(e => types.includes(e.type));

async function cookieFor(user) {
  const res = await request(server).post('/login').type('form').send({ username: user.email, password: user.password });
  return res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  db = await connectDB();
  server = http.createServer(app); await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partnerA', 'potential_partner', ''], ['partnerB', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(server); await loginAs(agents[key], users[key]);
    cookies[key] = await cookieFor(users[key]);
    streams[key] = await openStream(cookies[key], '?uid=' + users[key].id);
  }
});

afterAll(async () => {
  try {
    for (const s of Object.values(streams)) s.close();
    realtime.closeAll();
    if (requestIds.length) await db.collection('requests').deleteMany({ id: { $in: requestIds } });
    if (docRequestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
    if (eventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: eventIds } });
    if (partnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    await db.collection('requests').deleteMany({ submittedByEmail: { $in: Object.values(users).map(u => u.email) } });
    await cleanupAll();
  } finally {
    await new Promise(r => server.close(r));
    await closeDB();
  }
});

describe('the stream itself', () => {
  test('a signed-out caller gets 401, and a page that belongs to another login gets 409 — no stream in either case', async () => {
    const anon = await openStream('');
    expect(anon.status).toBe(401); expect(anon.body).toMatch(/UNAUTHENTICATED/); anon.close();
    const wrong = await openStream(cookies.partnerA, '?uid=' + users.admin.id);
    expect(wrong.status).toBe(409); expect(wrong.body).toMatch(/USER_MISMATCH/); wrong.close();
  });

  test('every role can open one; it is an event stream that opens with a hello', () => {
    for (const k of Object.keys(users)) {
      expect(streams[k].status).toBe(200);
      expect(streams[k].headers['content-type']).toMatch(/text\/event-stream/);
      expect(streams[k].headers['cache-control']).toMatch(/no-cache/);
      expect(streams[k].events[0].type).toBe('hello');
    }
  });

  test('the channel only receives: it has no write route (POST/PUT/PATCH/DELETE are refused)', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await agents.admin[method]('/api/realtime/stream').send({});
      expect([404, 405]).toContain(res.status);
    }
  });

  test('a user is capped at a handful of connections — the oldest is closed first', async () => {
    const extra = [];
    for (let i = 0; i < 7; i++) extra.push(await openStream(cookies.college, '?uid=' + users.college.id));
    await sleep(200);
    const live = [streams.college, ...extra].filter(s => !s.ended).length;
    expect(live).toBeLessThanOrEqual(6);
    expect(streams.college.ended).toBe(true);
    extra.forEach(s => s.close());
    streams.college = await openStream(cookies.college, '?uid=' + users.college.id);   // back to one for the rest
  });
});

describe('Partnership Request status changes reach only the people allowed to see that request', () => {
  let reqId, m;

  test('Partner A submits: Administrator, CIRL Staff and A are told; Partner B and College Dean are not', async () => {
    m = mark();
    const res = await agents.partnerA.post('/api/requests').send({ institution: 'jesttest Realtime Org ' + Date.now(), country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest secret note' });
    expect(res.status).toBe(200); reqId = res.body.request.id; requestIds.push(reqId);
    for (const k of ['admin', 'staff', 'partnerA']) {
      const ev = await waitFor(after(k, m), e => e.type === 'request.statusChanged' && e.data.id === reqId);
      expect({ k, got: !!ev }).toEqual({ k, got: true });
      expect(ev.data).toMatchObject({ id: reqId, status: 'Pending', action: 'created' });
    }
    await sleep(500);
    for (const k of ['partnerB', 'college']) expect(since(m, k, 'request.statusChanged', 'request.updated')).toEqual([]);
  });

  test('the event is a hint: no institution, notes or contact details travel in it', async () => {
    const ev = streams.admin.events.find(e => e.type === 'request.statusChanged' && e.data.id === reqId);
    expect(Object.keys(ev.data).sort()).toEqual(['action', 'id', 'renewal', 'status']);
    expect(JSON.stringify(streams.partnerB.events)).not.toMatch(/jesttest|Realtime Org|secret note/);
  });

  test('Administrator moves it Pending -> Under Review: the database changes first, then A, Administrator and CIRL Staff are told', async () => {
    m = mark();
    const res = await agents.admin.patch(`/api/requests/${reqId}`).send({ status: 'Under Review', notes: 'need more' });
    expect(res.status).toBe(200);
    expect((await db.collection('requests').findOne({ id: reqId })).status).toBe('Under Review');   // already committed when the event went out
    for (const k of ['admin', 'staff', 'partnerA']) {
      const ev = await waitFor(after(k, m), e => e.type === 'request.statusChanged' && e.data.status === 'Under Review');
      expect({ k, got: !!ev }).toEqual({ k, got: true });
      expect(ev.data.action).toBe('reviewed');
    }
    await sleep(500);
    for (const k of ['partnerB', 'college']) expect(since(m, k, 'request.statusChanged', 'request.updated', 'notification.created')).toEqual([]);
  });

  test('the notification that change generated is pushed to A alone, in the shape /api/notifications/mine returns it', async () => {
    const ev = await waitFor(streams.partnerA, e => e.type === 'notification.created' && /Additional documents requested/.test(e.data.notification.title));
    expect(ev).toBeTruthy();
    const n = ev.data.notification;
    expect(n.targetEmail).toBe(users.partnerA.email); expect(n.unread).toBe(true);
    expect(n.href).toMatch(/^\/partner\//);                             // role-aware destination, same as the API
    const mine = (await agents.partnerA.get('/api/notifications/mine')).body.find(x => x.id === n.id);
    expect(mine).toBeTruthy(); expect(mine.href).toBe(n.href);
    for (const k of ['admin', 'staff', 'partnerB', 'college']) {
      expect(streams[k].events.filter(e => e.type === 'notification.created' && e.data.notification.id === n.id)).toEqual([]);
    }
    // marking it read syncs A's other tabs — and nobody else hears of it
    m = mark();
    expect((await agents.partnerA.patch('/api/notifications/' + n.id).send({ unread: false })).status).toBe(200);
    expect(await waitFor(after('partnerA', m), e => e.type === 'notification.read' && e.data.id === n.id)).toBeTruthy();
    await sleep(400);
    for (const k of ['admin', 'staff', 'partnerB', 'college']) expect(since(m, k, 'notification.read')).toEqual([]);
  });

  test('Partner B cannot pick up A\'s request by asking: its stream carried nothing, and the API refuses it', async () => {
    expect((await agents.partnerB.patch(`/api/requests/${reqId}`).send({ status: 'Approved' })).status).toBe(302);
    expect((await agents.partnerB.post(`/api/requests/${reqId}/withdraw`)).status).toBe(403);
    expect(ofType(streams.partnerB, 'request.statusChanged', 'request.updated')).toEqual([]);
  });

  test('a change that FAILS publishes nothing (rejected by validation, by RBAC, by state)', async () => {
    m = mark();
    expect((await agents.admin.patch(`/api/requests/${reqId}`).send({ status: 'Bogus' })).status).toBe(400);
    expect((await agents.college.post('/api/requests').send({ institution: 'jesttest x', country: 'T', type: 'MOA', nature: 'R' })).status).toBe(403);
    expect((await agents.partnerB.post(`/api/requests/${reqId}/withdraw`)).status).toBe(403);
    await sleep(600);
    for (const k of Object.keys(streams)) expect(since(m, k, 'request.statusChanged', 'request.updated')).toEqual([]);
  });

  test('withdrawing / draft delete: owner action is announced to reviewers and the owner', async () => {
    m = mark();
    expect((await agents.partnerA.post(`/api/requests/${reqId}/withdraw`)).status).toBe(200);
    for (const k of ['admin', 'staff', 'partnerA']) expect(await waitFor(after(k, m), e => e.type === 'request.statusChanged' && e.data.status === 'Withdrawn')).toBeTruthy();
    const draft = await agents.partnerA.post('/api/requests').send({ isDraft: true, institution: 'jesttest Draft Org ' + Date.now(), type: 'MOU', notes: 'jesttest' });
    requestIds.push(draft.body.request.id); m = mark();
    expect((await agents.partnerA.delete('/api/requests/' + draft.body.request.id)).status).toBe(200);
    for (const k of ['admin', 'staff', 'partnerA']) expect(await waitFor(after(k, m), e => e.type === 'request.updated' && e.data.action === 'draftDeleted')).toBeTruthy();
    expect(since(m, 'partnerB', 'request.updated')).toEqual([]);
  });
});

describe('Document Requests', () => {
  test('a College Dean submission goes to the reviewers and to that College Dean account only', async () => {
    const m = mark();
    const res = await agents.college.post('/api/document-requests').send({ institution: 'jesttest DR Realtime', documentTypes: ['Certificate'], notes: 'jesttest' });
    expect(res.status).toBe(200); const id = res.body.request.id; docRequestIds.push(id);
    for (const k of ['admin', 'staff', 'college']) expect(await waitFor(after(k, m), e => e.type === 'documentRequest.statusChanged' && e.data.id === id)).toBeTruthy();
    await sleep(500);
    for (const k of ['partnerA', 'partnerB']) expect(since(m, k, 'documentRequest.statusChanged', 'documentRequest.updated')).toEqual([]);

    const m2 = mark();
    expect((await agents.admin.patch('/api/document-requests/' + id).send({ status: 'Preparing', receivedBy: 'jesttest' })).status).toBe(200);
    for (const k of ['admin', 'staff', 'college']) expect(await waitFor(after(k, m2), e => e.type === 'documentRequest.statusChanged' && e.data.status === 'Preparing')).toBeTruthy();
    await sleep(400);
    for (const k of ['partnerA', 'partnerB']) expect(since(m2, k, 'documentRequest.statusChanged')).toEqual([]);
  });
});

describe('Partnership registry changes', () => {
  test('reach Administrator, CIRL Staff and the Partner whose approved request is tied to it — not another Partner or College Dean', async () => {
    const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    const pid = last[0].id + 1, inst = 'jesttest Live Registry ' + Date.now();
    await db.collection('partnerships').insertOne({ id: pid, inst, country: 'Testland', type: 'MOA', start: '2026-01-01', end: '2031-01-01', status: 'Active', remarks: 'jesttest' }); partnershipIds.push(pid);
    const lr = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
    const rid = lr[0].id + 1;
    await db.collection('requests').insertOne({ id: rid, institution: inst, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest', requestedBy: 'jesttest', submittedByEmail: users.partnerA.email, status: 'Approved', date: 'Sep 21, 2026', updatedAt: new Date().toISOString() }); requestIds.push(rid);
    const m = mark();
    const res = await agents.admin.patch('/api/partnerships/' + pid).send({ remarks: 'jesttest edited' });
    expect(res.status).toBe(200);
    for (const k of ['admin', 'staff', 'partnerA']) expect(await waitFor(after(k, m), e => e.type === 'partnership.updated' && e.data.id === pid)).toBeTruthy();
    await sleep(500);
    for (const k of ['partnerB', 'college']) expect(since(m, k, 'partnership.updated', 'partnership.statusChanged')).toEqual([]);
    const m2 = mark();
    expect((await agents.admin.delete('/api/partnerships/' + pid)).status).toBe(200);
    for (const k of ['admin', 'staff', 'partnerA']) expect(await waitFor(after(k, m2), e => e.type === 'partnership.updated' && e.data.action === 'deleted')).toBeTruthy();
    expect(since(m2, 'partnerB', 'partnership.updated')).toEqual([]);
  });
});

describe('Calendar', () => {
  test('an "All Users" event reaches everyone; one with no recipient list only Administrator and CIRL Staff; a scoped one only Administrator, its creator and the people it names; deleting reaches the same people', async () => {
    // Since the team's "College Dean and Partners only see events meant for them" change, an event with no recipient list
    // is no longer public to every role — only one created for "All Users" (recipients: ['all'] -> forEveryone) is.
    let m = mark();
    const everyone = await agents.admin.post('/api/calendarevents').send({ title: 'jesttest all-users ' + Date.now(), start: '2031-03-03T10:00', end: '2031-03-03T11:00', allDay: false, recipients: ['all'] });
    expect(everyone.status).toBe(200); eventIds.push(everyone.body.event.id);
    for (const k of Object.keys(streams)) expect(await waitFor(after(k, m), e => e.type === 'calendar.updated' && e.data.id === everyone.body.event.id)).toBeTruthy();

    m = mark();
    const pub = await agents.admin.post('/api/calendarevents').send({ title: 'jesttest public ' + Date.now(), start: '2031-03-04T10:00', end: '2031-03-04T11:00', allDay: false });
    expect(pub.status).toBe(200); eventIds.push(pub.body.event.id);
    for (const k of ['admin', 'staff']) expect(await waitFor(after(k, m), e => e.type === 'calendar.updated' && e.data.id === pub.body.event.id)).toBeTruthy();
    await sleep(500);
    for (const k of ['partnerA', 'partnerB', 'college']) expect(since(m, k, 'calendar.updated')).toEqual([]);

    m = mark();
    const scoped = await agents.admin.post('/api/calendarevents').send({ title: 'jesttest scoped ' + Date.now(), start: '2031-03-05T10:00', end: '2031-03-05T11:00', allDay: false, recipients: [users.partnerA.email] });
    expect(scoped.status).toBe(200); const sid = scoped.body.event.id; eventIds.push(sid);
    for (const k of ['admin', 'partnerA']) expect(await waitFor(after(k, m), e => e.type === 'calendar.updated' && e.data.id === sid)).toBeTruthy();
    await sleep(500);
    for (const k of ['staff', 'partnerB', 'college']) expect(since(m, k, 'calendar.updated')).toEqual([]);

    m = mark();
    const drag = await agents.admin.patch('/api/calendarevents/' + sid).send({ start: '2031-03-06T10:00', end: '2031-03-06T11:00' });
    expect(drag.status).toBe(200);
    expect(await waitFor(after('partnerA', m), e => e.type === 'calendar.updated' && e.data.id === sid && e.data.action === 'updated')).toBeTruthy();
    await sleep(300);
    expect(since(m, 'partnerA', 'calendar.updated').length).toBe(1);        // one drag = one event

    m = mark();
    expect((await agents.admin.delete('/api/calendarevents/' + sid)).status).toBe(200);
    for (const k of ['admin', 'partnerA']) expect(await waitFor(after(k, m), e => e.type === 'calendar.deleted' && e.data.id === sid)).toBeTruthy();
    await sleep(400);
    for (const k of ['staff', 'partnerB', 'college']) expect(since(m, k, 'calendar.deleted')).toEqual([]);
    expect(await db.collection('calendarevents').countDocuments({ id: sid })).toBe(0);
  });
});

describe('the stream is not an authorization bypass', () => {
  test('AJAX callers get JSON 401/403; everyone else keeps the redirects', async () => {
    const anon = request(server);
    expect((await anon.get('/api/requests').set('X-Requested-With', 'ciprms')).status).toBe(401);
    expect((await anon.get('/api/requests')).status).toBe(302);
    const denied = await agents.partnerA.patch('/api/requests/1').set('X-Requested-With', 'ciprms').send({ status: 'Approved' });
    expect(denied.status).toBe(403); expect(denied.headers['content-type']).toMatch(/json/); expect(denied.body.code).toBe('FORBIDDEN');
    expect((await agents.partnerA.patch('/api/requests/1').send({ status: 'Approved' })).status).toBe(302);
  });

  test('a deactivated account stops receiving events and its stream is closed at the next check', async () => {
    const victim = await createTestUser({ role: 'potential_partner' });
    const ck = await cookieFor(victim);
    const st = await openStream(ck, '?uid=' + victim.id);
    expect(st.status).toBe(200);
    await db.collection('users').updateOne({ id: victim.id }, { $set: { status: 'Inactive' } });
    await realtime.revalidateAll();
    await waitFor(st, e => e.type === 'session.ended', 2000);
    expect(st.events.some(e => e.type === 'session.ended')).toBe(true);
    await sleep(100); expect(st.ended).toBe(true);
    st.close();
  });

  test('logging out closes the stream at once and does not bring the session back', async () => {
    const u = await createTestUser({ role: 'potential_partner' });
    const ag = request.agent(server); await loginAs(ag, u);
    const ck = await cookieFor(u);
    const st = await openStream(ck, '?uid=' + u.id);
    expect(st.status).toBe(200);
    const out = request(server);
    expect((await out.post('/logout').set('Cookie', ck)).status).toBe(200);
    await sleep(300);
    expect(st.ended).toBe(true);
    await sleep(300);
    // the old cookie must not work again (a detached stream must not re-save the session)
    expect((await request(server).get('/api/me').set('Cookie', ck)).status).toBe(302);
    st.close();
  });

  test('an event with no matching audience reaches nobody', () => {
    expect(realtime.publish('request.updated', { id: 1 }, realtime.audience.emails(['nobody@example.com']))).toBe(0);
    expect(realtime.publish('request.updated', { id: 1 }, null)).toBe(0);
  });
});

// 2026-09-22: Document Library (Administrator/CIRL Staff) live updates — lets the Nature-of-Partnership filter pills
// (and the grid/list itself) refresh without a manual reload when a document this user uploaded is archived (a
// fresh OCR upload) or organized/edited. Scoped to the uploader's own email — the exact same own-uploads-only
// boundary GET /api/documents already enforces (see cirl.js's OWN_SCOPE_ROLES) — so this never broadens who is told
// about a document beyond who could already see it.
describe('Documents (Administrator/CIRL Staff Document Library)', () => {
  test('a metadata edit publishes document.updated to the uploader only, after the database write succeeded', async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const docId = (last[0] ? last[0].id : 0) + 1;
    await db.collection('documents').insertOne({ id: docId, title: 'jesttest realtime doc', type: 'MOA', nature: 'Research', uploadedByEmail: users.admin.email, uploadedAt: new Date().toISOString() });
    const m = mark();
    const res = await agents.admin.patch('/api/documents/' + docId).send({ title: 'jesttest realtime doc renamed' });
    expect(res.status).toBe(200);
    expect((await db.collection('documents').findOne({ id: docId })).title).toBe('jesttest realtime doc renamed'); // already committed when the event went out
    const ev = await waitFor(after('admin', m), e => e.type === 'document.updated' && e.data.id === docId);
    expect(ev).toBeTruthy();
    expect(ev.data.action).toBe('updated');
    await sleep(400);
    for (const k of ['staff', 'partnerA', 'partnerB', 'college']) expect(since(m, k, 'document.updated')).toEqual([]);
    await db.collection('documents').deleteOne({ id: docId });
  });

  test('organizing (archive/unarchive, move to a folder) also publishes document.updated to the uploader only', async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const docId = (last[0] ? last[0].id : 0) + 1;
    await db.collection('documents').insertOne({ id: docId, title: 'jesttest realtime doc 2', type: 'MOU', nature: 'Student Exchange', uploadedByEmail: users.staff.email, uploadedAt: new Date().toISOString() });
    const m = mark();
    const res = await agents.staff.patch('/api/documents/' + docId + '/organize').send({ archived: true });
    expect(res.status).toBe(200);
    const ev = await waitFor(after('staff', m), e => e.type === 'document.updated' && e.data.id === docId);
    expect(ev).toBeTruthy();
    await sleep(400);
    for (const k of ['admin', 'partnerA', 'partnerB', 'college']) expect(since(m, k, 'document.updated')).toEqual([]);
    await db.collection('documents').deleteOne({ id: docId });
  });

  test('a failed edit (not the uploader, or a bad request) publishes nothing', async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const docId = (last[0] ? last[0].id : 0) + 1;
    await db.collection('documents').insertOne({ id: docId, title: 'jesttest realtime doc 3', type: 'MOA', uploadedByEmail: users.partnerA.email, uploadedAt: new Date().toISOString() });
    const m = mark();
    // /organize is gated by requireUploader (admits College Staff) plus its own explicit ownership check — College
    // Staff here is not the uploader of this particular document, so the request is refused regardless of role.
    expect((await agents.college.patch('/api/documents/' + docId + '/organize').send({ archived: true })).status).toBe(403);
    await sleep(500);
    for (const k of Object.keys(streams)) expect(since(m, k, 'document.updated')).toEqual([]);
    await db.collection('documents').deleteOne({ id: docId });
  });
});
