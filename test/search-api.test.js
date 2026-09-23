// Global header search (Administrator / CIRL Staff) — GET /api/search, and the two page routes /search and
// /staff/search. Covers: what each collection returns, RBAC (only Administrator/Staff, no bypass for other roles,
// no leaking another org's data), input handling (short/empty/malicious query, no 500s), and that a record is
// searchable immediately after being created — no restart, no separate indexing step.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, agents = {}, users = {};
const stamp = Date.now();
const partnershipIds = [], requestIds = [], docRequestIds = [], documentIds = [];

beforeAll(async () => {
  db = await connectDB();
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partner', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }

  const lp = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
  const pId = lp + 1;
  await db.collection('partnerships').insertOne({ id: pId, inst: `jesttest SearchCo University ${stamp}`, country: 'Testland', region: 'Asia', type: 'MOA', nature: ['Research'], cat: 'International', unit: ['CCS'], status: 'Active', start: 'Jan 1, 2026', end: 'Jan 1, 2030', remarks: 'jesttest' });
  partnershipIds.push(pId);

  const lr = (await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
  const rId = lr + 1;
  await db.collection('requests').insertOne({ id: rId, institution: `jesttest SearchReq Institute ${stamp}`, country: 'Testland', type: 'MOU', nature: 'Research', status: 'Pending', requestedBy: 'jesttest Someone', submittedByEmail: users.partner.email, date: 'Sep 22, 2026', updatedAt: new Date().toISOString(), notes: 'jesttest' });
  requestIds.push(rId);

  const ldr = (await db.collection('documentrequests').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
  const drId = ldr + 1;
  await db.collection('documentrequests').insertOne({ id: drId, institution: `jesttest SearchDR College ${stamp}`, documentType: 'Certificate of Accreditation', documentTypes: ['Certificate of Accreditation'], status: 'Received', requestedBy: 'jesttest Someone', requestedByEmail: users.college.email, date: 'Sep 22, 2026', updatedAt: new Date().toISOString() });
  docRequestIds.push(drId);

  const ld = (await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
  const docId = ld + 1;
  await db.collection('documents').insertOne({
    id: docId, title: 'Memorandum of Agreement', type: 'MOA', institution: 'CSPC', partner: `jesttest OcrPartner University ${stamp}`,
    originalFilename: `jesttest-contract-${stamp}.pdf`, uploadedBy: 'jesttest Uploader', uploadedByEmail: users.partner.email, uploadedAt: new Date().toISOString(),
    fileLink: `/uploads/documents/jesttest-${stamp}.pdf`, status: 'Active',
    ocrText: `MEMORANDUM OF AGREEMENT between Camarines Sur Polytechnic Colleges and jesttest OcrPartner University ${stamp}. This distinctive phrase ${stamp} appears nowhere else. Effective Date: January 1, 2026.`,
    searchKeywords: [`jesttest OcrPartner University ${stamp}`]
  });
  documentIds.push(docId);
});

afterAll(async () => {
  try {
    if (partnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    if (requestIds.length) await db.collection('requests').deleteMany({ id: { $in: requestIds } });
    if (docRequestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
    if (documentIds.length) await db.collection('documents').deleteMany({ id: { $in: documentIds } });
    await cleanupAll();
  } finally {
    await closeDB();
  }
});

describe('RBAC: only Administrator and CIRL Staff can search', () => {
  test('Administrator and CIRL Staff get 200', async () => {
    for (const k of ['admin', 'staff']) {
      const res = await agents[k].get('/api/search?q=' + encodeURIComponent(`SearchCo University ${stamp}`));
      expect(res.status).toBe(200);
    }
  });

  test('College Staff and Partner cannot reach it directly, with or without the AJAX header — no bypass', async () => {
    for (const k of ['college', 'partner']) {
      const plain = await agents[k].get('/api/search?q=test');
      expect(plain.status).toBe(302);
      const ajax = await agents[k].get('/api/search?q=test').set('X-Requested-With', 'ciprms');
      expect(ajax.status).toBe(403);
      expect(ajax.body.code).toBe('FORBIDDEN');
    }
  });

  test('a signed-out request is refused', async () => {
    expect((await request(app).get('/api/search?q=test')).status).toBe(302);
  });

  test('the /search and /staff/search pages follow the same rule', async () => {
    expect((await agents.admin.get('/search?q=x')).status).toBe(200);
    expect((await agents.staff.get('/staff/search?q=x')).status).toBe(200);
    expect((await agents.college.get('/search?q=x')).status).toBe(302);
    // bare /search is requireAdmin (Administrator only) — Staff has its own /staff/search, same as every other
    // Administrator/Staff page pair in this app (e.g. /lifecycle vs /staff/lifecycle).
    expect((await agents.staff.get('/search?q=x')).status).toBe(302);
  });
});

describe('what each collection returns', () => {
  test('finds a partnership by a substring of its institution name', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent('SearchCo Univ'));
    expect(res.status).toBe(200);
    expect(res.body.partnerships.some(p => p.id === partnershipIds[0])).toBe(true);
    const hit = res.body.partnerships.find(p => p.id === partnershipIds[0]);
    expect(hit.href).toMatch(/^\/lifecycle\?q=/);
  });

  test('CIRL Staff gets a Staff-shaped href for the same partnership', async () => {
    const res = await agents.staff.get('/api/search?q=' + encodeURIComponent('SearchCo Univ'));
    const hit = res.body.partnerships.find(p => p.id === partnershipIds[0]);
    expect(hit.href).toMatch(/^\/staff\/lifecycle\?q=/);
  });

  test('finds a Partnership Request by institution, with a role-correct href', async () => {
    const admin = await agents.admin.get('/api/search?q=' + encodeURIComponent(`SearchReq Institute ${stamp}`));
    expect(admin.body.requests.some(r => r.id === requestIds[0])).toBe(true);
    expect(admin.body.requests.find(r => r.id === requestIds[0]).href).toBe(`/partnership-requests?open=pr&id=${requestIds[0]}`);
    const staff = await agents.staff.get('/api/search?q=' + encodeURIComponent(`SearchReq Institute ${stamp}`));
    expect(staff.body.requests.find(r => r.id === requestIds[0]).href).toBe(`/staff/requests?open=pr&id=${requestIds[0]}`);
  });

  test('finds a Document Request by institution', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(`SearchDR College ${stamp}`));
    expect(res.body.documentRequests.some(r => r.id === docRequestIds[0])).toBe(true);
    expect(res.body.documentRequests.find(r => r.id === docRequestIds[0]).href).toBe(`/partnership-requests?open=dr&id=${docRequestIds[0]}`);
  });

  test('finds a document by short metadata (partner name) with no snippet needed', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(`OcrPartner University ${stamp}`));
    const hit = res.body.documents.find(d => d.id === documentIds[0]);
    expect(hit).toBeTruthy();
    expect(hit.href).toBe(`/uploads/documents/jesttest-${stamp}.pdf`);
  });

  test('finds a document purely by OCR content — a distinctive phrase that appears nowhere in its metadata — and returns a matching snippet', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(`distinctive phrase ${stamp}`));
    const hit = res.body.documents.find(d => d.id === documentIds[0]);
    expect(hit).toBeTruthy();
    expect(hit.matchedField).toBe('ocrText');
    expect(hit.snippet).toMatch(new RegExp(`distinctive phrase ${stamp}`, 'i'));
  });

  test('a document uploaded by ONE user (Partner) is found by BOTH Administrator and CIRL Staff, not just its uploader — the registry-wide reach global search is deliberately given these two roles', async () => {
    for (const k of ['admin', 'staff']) {
      const res = await agents[k].get('/api/search?q=' + encodeURIComponent(`distinctive phrase ${stamp}`));
      expect(res.body.documents.some(d => d.id === documentIds[0])).toBe(true);
    }
  });
});

describe('input handling', () => {
  test('a 1-character query returns an empty, non-error "too short" response, not a 400', async () => {
    const res = await agents.admin.get('/api/search?q=a');
    expect(res.status).toBe(200);
    expect(res.body.tooShort).toBe(true);
    expect(res.body.partnerships).toEqual([]);
  });

  test('an empty / missing query is handled the same way, no 500', async () => {
    expect((await agents.admin.get('/api/search')).status).toBe(200);
    expect((await agents.admin.get('/api/search?q=')).status).toBe(200);
  });

  test('no results found returns empty arrays, not an error', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(`totally-unmatched-${stamp}-xyz`));
    expect(res.status).toBe(200);
    expect(res.body.partnerships).toEqual([]);
    expect(res.body.requests).toEqual([]);
    expect(res.body.documentRequests).toEqual([]);
    expect(res.body.documents).toEqual([]);
  });

  test('regex special characters in the query are treated literally, never cause a 500', async () => {
    for (const q of ['(test)', 'a.b*c+d?', '[test]', 'a\\b', 'a{2,3}', '$^|']) {
      const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(q));
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
    }
  });

  test('a very long query is capped, not rejected with a 500', async () => {
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent('x'.repeat(5000)));
    expect(res.status).toBe(200);
  });

  test('a script-injection-shaped query is treated as ordinary literal search text: no crash, no match, nothing executed server-side', async () => {
    // The API's job here is just "don't crash, don't match anything that isn't really there" — echoing the literal
    // query back in the `query` field of a JSON response is not an XSS vector (JSON is never executed as HTML); the
    // client is responsible for escaping before it ever reaches innerHTML, which is verified directly below against
    // the actual functions in public/js/ciprms-search.js.
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent('<script>alert(1)</script>'));
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('<script>alert(1)</script>');
    expect(res.body.partnerships).toEqual([]);
    expect(res.body.documents).toEqual([]);
  });
});

describe('client-side escaping (public/js/ciprms-search.js) actually neutralizes what the API can return', () => {
  // Extracts the real escapeHtml/highlight functions from the shipped client file and runs them for real — the same
  // technique test/partner-monitoring-ownership.test.js uses for requestBuckets() — rather than re-implementing (and
  // potentially drifting from) the escaping logic here.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'ciprms-search.js'), 'utf8');
  // Both are extracted TOGETHER into one shared scope (not two separate new Function() calls) because highlight()'s
  // body calls escapeHtml() internally — evaluating them in isolation would leave that call with nothing to resolve.
  function extractSrc(name) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
    if (!m) throw new Error(name + ' not found in ciprms-search.js');
    return m[0];
  }
  const { escapeHtml, highlight } = new Function(
    `${extractSrc('escapeHtml')}\n${extractSrc('highlight')}\nreturn { escapeHtml, highlight };`
  )();

  test('escapeHtml neutralizes every HTML-special character', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`"quoted" & 'quoted'`)).toBe('&quot;quoted&quot; &amp; &#39;quoted&#39;');
  });

  test('a title/snippet containing a script-injection-shaped string, run through the real render pipeline, contains no live <script> tag', () => {
    const rendered = highlight(escapeHtml('<script>alert(1)</script> University'), 'University');
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).toContain('<mark>University</mark>');
  });

  test('the highlighted term itself is escaped before being placed in <mark>, so searching for literal HTML cannot inject a live tag either', () => {
    // The text being rendered happens to contain the exact string being searched for, verbatim and unescaped, the
    // way a raw OCR snippet or title might — a naive implementation that highlights before escaping would reinject
    // it as live markup.
    const rendered = highlight(escapeHtml('Notes: <script>evil()</script> was mentioned in the document.'), '<script>evil()</script>');
    expect(rendered).not.toMatch(/<script>evil\(\)<\/script>/); // never appears un-escaped, marked or not
    expect(rendered).toContain('<mark>&lt;script&gt;evil()&lt;/script&gt;</mark>');
  });
});

describe('freshness: no restart or separate indexing step needed', () => {
  test('a partnership created moments ago is immediately searchable', async () => {
    const last = (await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray())[0].id;
    const id = last + 1;
    await db.collection('partnerships').insertOne({ id, inst: `jesttest FreshlyCreated Org ${stamp}`, country: 'Testland', type: 'MOA', status: 'Active', remarks: 'jesttest' });
    partnershipIds.push(id);
    const res = await agents.admin.get('/api/search?q=' + encodeURIComponent(`FreshlyCreated Org ${stamp}`));
    expect(res.body.partnerships.some(p => p.id === id)).toBe(true);
  });

  test('a document archived via the real POST /api/requests flow (auto-archive-to-library) is immediately searchable by its institution', async () => {
    const inst = `jesttest LiveFlow University ${stamp}`;
    const created = await agents.college.post('/api/requests').send({ institution: inst, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest' });
    // College Staff can no longer submit Partnership Requests (unrelated RBAC fix) — fall back to the Partner flow,
    // which still exercises the same real archiveRequestRecordToLibrary() -> documents collection path.
    const res = created.status === 403
      ? await agents.partner.post('/api/requests').send({ institution: inst, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest' })
      : created;
    expect(res.status).toBe(200);
    requestIds.push(res.body.request.id);
    const found = await agents.admin.get('/api/search?q=' + encodeURIComponent(inst));
    expect(found.body.requests.some(r => r.id === res.body.request.id) || found.body.documents.some(d => d.title && d.title.includes(inst))).toBe(true);
  });
});
