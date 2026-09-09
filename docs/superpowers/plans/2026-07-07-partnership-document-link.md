# Partnership Document Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the link between an OCR-archived source document (`documents` collection) and the Partnership Registry record it was used to create/update, and surface that link in both the Registry and Document Library UIs.

**Architecture:** The Registry's "Auto-fill from Document (OCR)" panel already uploads a file, runs OCR, archives it to the `documents` collection, and pre-fills the Add Partnership form — but the returned `documentId`/`fileLink` are currently discarded once the user clicks "Apply to Form". This plan wires those two already-existing IDs (`partnerships.id` and `documents.id`) together with a pair of foreign-key-style fields (`partnerships.documentId` / `documents.partnershipId`), maintained server-side on create/update/delete, and displayed client-side wherever a partnership or document is already rendered.

**Tech Stack:** Node.js/Express 5, MongoDB native driver (schemaless — no migrations needed), EJS views, vanilla JS (no framework/build step), Jest + Supertest against a real local MongoDB (`mongodb://127.0.0.1:27017/ciprms`).

## Global Constraints

- No database migrations exist or are needed — MongoDB is schemaless; new fields simply appear on documents that set them and are `undefined`/absent on older ones. Always code defensively for the absent case (`p.documentId || null`, `doc.partnershipId` truthy check).
- Backend tests run against the real dev MongoDB with `jest --runInBand` (see `package.json`'s `test` script) and must leave zero trace — every record a test creates must be deleted in that test file's `afterAll`, following the exact pattern in `test/partnerships.test.js` and `test/helpers.js`.
- There is no frontend/browser test runner in this project (`jest.config.js` uses `testEnvironment: 'node'`). Frontend changes are verified manually in a running browser session, not with automated tests — follow the manual verification steps in each frontend task exactly.
- Do not change the existing `docLink` field (the manually-typed Google Drive URL) — it is a separate, independent field from the new OCR-sourced `documentId`/`documentFileLink` pair.
- `/registry` and `/personnel/registry` are both gated by `requirePersonnel` (Admin or Auth. Personnel) and share the same `/api/partnerships` backend — only `View-Only` is excluded.

---

### Task 1: Backend — maintain the partnership↔document link

**Files:**
- Modify: `cirl.js:644-683` (the three `/api/partnerships` write routes: POST, PATCH, DELETE)
- Test: `test/partnership-document-link.test.js` (new)

**Interfaces:**
- Consumes: existing `db.collection('partnerships')` and `db.collection('documents')` collections (no schema declared — MongoDB native driver).
- Produces: `partnerships` documents may now carry `documentId` (Number|null) and `documentFileLink` (String). `documents` documents may now carry `partnershipId` (Number, unset when unlinked). Later tasks (2-5) read/write these exact field names — do not rename them.

- [ ] **Step 1: Write the failing test**

Create `test/partnership-document-link.test.js`:

```js
// Covers linking OCR-archived documents (the `documents` collection) to
// Partnership Registry records via `partnerships.documentId` /
// `documents.partnershipId` (the "Partnership Document Link" enhancement).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let personnelAgent, docAId, docBId, partnershipId;

async function insertTestDocument(title) {
  const db = await connectDB();
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  await db.collection('documents').insertOne({
    id, title, type: 'MOA', fileLink: `/uploads/documents/${title}.pdf`,
    uploadedAt: new Date().toISOString(), tags: ['jesttest']
  });
  return id;
}

beforeAll(async () => {
  await connectDB();
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  docAId = await insertTestDocument('jesttest-doc-a');
  docBId = await insertTestDocument('jesttest-doc-b');
});

afterAll(async () => {
  const db = await connectDB();
  if (partnershipId) await db.collection('partnerships').deleteOne({ id: partnershipId });
  await db.collection('documents').deleteMany({ id: { $in: [docAId, docBId] } });
  await cleanupAll();
  await closeDB();
});

test('Create Partnership with documentId links the document back to it', async () => {
  const res = await personnelAgent.post('/api/partnerships').send({
    inst: 'Jest Doc-Link University', country: 'Testland', region: 'Asia', type: 'MOA',
    nature: 'Research', cat: 'International', unit: 'CCS',
    start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active',
    remarks: 'jesttest', documentId: docAId, documentFileLink: '/uploads/documents/jesttest-doc-a.pdf'
  });
  expect(res.status).toBe(200);
  expect(res.body.partnership.documentId).toBe(docAId);
  partnershipId = res.body.partnership.id;

  const db = await connectDB();
  const doc = await db.collection('documents').findOne({ id: docAId });
  expect(doc.partnershipId).toBe(partnershipId);
});

test('Re-linking to a different document unlinks the old one and links the new one', async () => {
  const res = await personnelAgent.patch(`/api/partnerships/${partnershipId}`).send({
    documentId: docBId, documentFileLink: '/uploads/documents/jesttest-doc-b.pdf'
  });
  expect(res.status).toBe(200);
  expect(res.body.partnership.documentId).toBe(docBId);

  const db = await connectDB();
  const oldDoc = await db.collection('documents').findOne({ id: docAId });
  const newDoc = await db.collection('documents').findOne({ id: docBId });
  expect(oldDoc.partnershipId).toBeUndefined();
  expect(newDoc.partnershipId).toBe(partnershipId);
});

test('Clearing documentId (set to null) unlinks the document', async () => {
  const res = await personnelAgent.patch(`/api/partnerships/${partnershipId}`).send({ documentId: null });
  expect(res.status).toBe(200);
  expect(res.body.partnership.documentId).toBeNull();

  const db = await connectDB();
  const doc = await db.collection('documents').findOne({ id: docBId });
  expect(doc.partnershipId).toBeUndefined();
});

test('A PATCH that never mentions documentId leaves the existing link untouched', async () => {
  await personnelAgent.patch(`/api/partnerships/${partnershipId}`).send({
    documentId: docAId, documentFileLink: '/uploads/documents/jesttest-doc-a.pdf'
  });
  const res = await personnelAgent.patch(`/api/partnerships/${partnershipId}`).send({ remarks: 'jesttest renewed' });
  expect(res.status).toBe(200);
  expect(res.body.partnership.documentId).toBe(docAId);

  const db = await connectDB();
  const doc = await db.collection('documents').findOne({ id: docAId });
  expect(doc.partnershipId).toBe(partnershipId);
});

test('Deleting a partnership with a linked document unlinks the document', async () => {
  const res = await personnelAgent.delete(`/api/partnerships/${partnershipId}`);
  expect(res.status).toBe(200);
  partnershipId = null;

  const db = await connectDB();
  const doc = await db.collection('documents').findOne({ id: docAId });
  expect(doc.partnershipId).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/partnership-document-link.test.js --runInBand`
Expected: The first test FAILS at `expect(doc.partnershipId).toBe(partnershipId)` (received `undefined`) — the POST route currently stores `documentId` on the partnership (MongoDB is schemaless, so that part already "works") but never writes back to the `documents` collection.

- [ ] **Step 3: Implement the minimal backend changes**

In `cirl.js`, replace the three existing route handlers (currently at lines 644-683) with:

```js
app.post('/api/partnerships', requirePersonnel, async (req, res) => {
  try {
    const db = getDb();
    const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? last[0].id + 1 : 1;
    const entry = { id: nextId, ...req.body };
    await db.collection('partnerships').insertOne(entry);
    if (entry.documentId) {
      await db.collection('documents').updateOne({ id: Number(entry.documentId) }, { $set: { partnershipId: nextId } });
    }
    await logActivity(db, req.session.user, 'ADD', `Partnership added: ${entry.inst || entry.institution || entry.partner || 'Record #' + nextId} (${entry.type || ''})`);
    res.json({ success: true, partnership: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/partnerships/:id', requirePersonnel, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const existing = await db.collection('partnerships').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    // Only touch the document link when the request explicitly mentions
    // documentId — most PATCHes (renew, field edits) never send it, and must
    // leave whatever link already exists untouched.
    if (Object.prototype.hasOwnProperty.call(req.body, 'documentId') && req.body.documentId !== existing.documentId) {
      if (existing.documentId) {
        await db.collection('documents').updateOne({ id: Number(existing.documentId) }, { $unset: { partnershipId: '' } });
      }
      if (req.body.documentId) {
        await db.collection('documents').updateOne({ id: Number(req.body.documentId) }, { $set: { partnershipId: id } });
      }
    }

    await db.collection('partnerships').updateOne({ id }, { $set: req.body });
    const updated = await db.collection('partnerships').findOne({ id });
    await logActivity(db, req.session.user, 'EDIT', `Partnership updated: ${updated.inst || updated.institution || updated.partner || 'Record #' + id} (${updated.type || ''})`);
    res.json({ success: true, partnership: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/partnerships/:id', requirePersonnel, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('partnerships').findOne({ id });
    if (target && target.documentId) {
      await db.collection('documents').updateOne({ id: Number(target.documentId) }, { $unset: { partnershipId: '' } });
    }
    await db.collection('partnerships').deleteOne({ id });
    await logActivity(db, req.session.user, 'DELETE', `Partnership deleted: ${target ? (target.inst || target.institution || target.partner || 'Record #' + id) : 'Record #' + id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/partnership-document-link.test.js --runInBand`
Expected: All 5 tests PASS.

- [ ] **Step 5: Run the full existing suite to confirm no regressions**

Run: `npm test`
Expected: All existing suites (`test/partnerships.test.js`, `test/requests.test.js`, `test/reports.test.js`) still PASS — the PATCH route's behavior change (checking `existing` before updating, instead of after) is backward-compatible since every existing test PATCHes a record it just created.

- [ ] **Step 6: Commit**

```bash
git add cirl.js test/partnership-document-link.test.js
git commit -m "feat: link OCR-archived documents to partnership records"
```

---

### Task 2: Registry (Admin) — carry the OCR document link into new partnerships

**Files:**
- Modify: `views/administrator/registry.ejs:336-354` (the `#ocr-result-box` panel)
- Modify: `assets/js/pages/registry-gridjs.init.js:392-571` (OCR auto-fill + `submitPartnership`)

**Interfaces:**
- Consumes: `app.post('/api/partnerships', ...)` from Task 1, which now accepts `documentId`/`documentFileLink` in the request body. Also consumes the existing `/api/ocr/extract` + `/api/ocr/status/:jobId` responses, whose `result.documentId` / `result.fileLink` were already being returned by `services/ocrService.js` but previously ignored by this file.
- Produces: nothing new consumed by later tasks (Task 3 reads `documentId`/`documentFileLink` back off the *server* response, not off these client variables).

- [ ] **Step 1: Add the "will be linked" chip to the OCR result panel**

In `views/administrator/registry.ejs`, inside `<div id="ocr-result-box" ...>` (currently lines 336-354), insert a new chip `<div>` immediately after the badges block and before the "View extracted text" button:

```html
            <div id="ocr-result-box" class="mt-3" style="display:none">
              <div class="d-flex flex-wrap gap-2 mb-2">
                <span class="badge bg-success-subtle text-success" id="ocr-confidence-badge">Confidence: —</span>
                <span class="badge bg-info-subtle text-info" id="ocr-doctype-badge">Document type: —</span>
                <span class="badge bg-warning-subtle text-warning" id="ocr-warning-badge" style="display:none">Low confidence — verify carefully</span>
              </div>
              <div id="ocr-link-chip" class="alert alert-success py-2 mb-2 fs-13" style="display:none">
                <i class="ri-link me-1"></i>This document will be linked to the new partnership record: <strong id="ocr-link-chip-name">—</strong>
              </div>
              <button type="button" class="btn btn-sm btn-light" data-bs-toggle="collapse" data-bs-target="#ocr-text-preview">
```

(The rest of the panel — the `#ocr-text-preview` collapse and Apply/Dismiss buttons — is unchanged.)

- [ ] **Step 2: Track the document link alongside the OCR result**

In `assets/js/pages/registry-gridjs.init.js`, near the existing OCR state declarations (currently lines 392-396):

```js
// ── OCR auto-fill (Extract using OCR button in the Add Partnership modal) ────
var ocrExtractedResult = null;
var ocrPollTimer = null;
var OCR_MAX_FILE_SIZE = 10 * 1024 * 1024;
var OCR_ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
var ocrPendingFileName = null;
var ocrLinkedDocumentId = null;
var ocrLinkedDocumentFileLink = null;
```

In `startOcrExtraction()`, capture the file name right after validating the file (immediately before `ocrShow('ocr-error-box', false);`):

```js
  ocrPendingFileName = file.name;
  ocrShow('ocr-error-box', false);
```

Replace `ocrSucceed(result)` with a version that captures and displays the link:

```js
function ocrSucceed(result) {
  ocrExtractedResult = result;
  ocrLinkedDocumentId = result.documentId || null;
  ocrLinkedDocumentFileLink = result.fileLink || null;
  document.getElementById('ocr-extract-btn').disabled = false;
  ocrShow('ocr-progress-wrap', false);
  ocrShow('ocr-result-box', true);
  document.getElementById('ocr-confidence-badge').textContent = 'Confidence: ' + Math.round(result.confidence) + '%';
  document.getElementById('ocr-doctype-badge').textContent = 'Document type: ' + (result.documentType || 'Unrecognized');
  document.getElementById('ocr-raw-text').textContent = result.rawText;
  ocrShow('ocr-warning-badge', !!result.warning);
  renderOcrLinkChip();
  showToast('OCR extraction complete — review the suggested values, then apply them to the form.');
}

function renderOcrLinkChip() {
  var chip = document.getElementById('ocr-link-chip');
  if (!chip) return;
  if (ocrLinkedDocumentId) {
    document.getElementById('ocr-link-chip-name').textContent = ocrPendingFileName || ('Document #' + ocrLinkedDocumentId);
    chip.style.display = '';
  } else {
    chip.style.display = 'none';
  }
}
```

Replace `dismissOcrResult()` so it also clears the link state:

```js
function dismissOcrResult() {
  ocrExtractedResult = null;
  ocrLinkedDocumentId = null;
  ocrLinkedDocumentFileLink = null;
  ocrPendingFileName = null;
  ocrShow('ocr-result-box', false);
  ocrShow('ocr-error-box', false);
  document.getElementById('ocr-file-input').value = '';
  renderOcrLinkChip();
}
```

- [ ] **Step 3: Send the link when saving the partnership**

In `submitPartnership()`, add `documentId` and `documentFileLink` to the `payload` object (which currently ends with `remarks:...`):

```js
  var payload={inst:inst,country:document.getElementById('f-country').value.trim()||'—',
    region:region||'—',type:type,nature:document.getElementById('f-nature').value||'—',
    cat:document.getElementById('f-cat').value||'International',unit:unit,
    coordinator:document.getElementById('f-coordinator').value.trim(),
    partnerEmail:document.getElementById('f-partner-email').value.trim(),
    docLink:document.getElementById('f-doc-link').value.trim(),
    documentId:ocrLinkedDocumentId,documentFileLink:ocrLinkedDocumentFileLink,
    startYear:new Date(start).getFullYear(),endYear:new Date(end).getFullYear(),
    start:fmt(start),end:fmt(end),status:status,remarks:document.getElementById('f-remarks').value.trim()};
```

- [ ] **Step 4: Manually verify in the browser**

Run: `npm start` (or however this project's dev server is normally started — check `package.json`/`SETUP.md` if unsure) and ensure MongoDB is running locally.

1. Log in as an Admin or Auth. Personnel user and open `/registry`.
2. Click "Add Partnership", then in the "Auto-fill from Document (OCR)" panel upload any PDF or image and click "Extract using OCR".
3. Wait for extraction to finish, then click "Apply to Form".
   Expected: the green "This document will be linked to the new partnership record: `<your filename>`" chip appears above the extracted-text toggle.
4. Fill in any remaining required fields (Institution, Type, Start/End Date, Unit) and click "Save Partnership".
   Expected: success toast, modal closes, new row appears in the grid.
5. In the browser devtools Network tab (or via `curl` with the session cookie), call `GET /api/partnerships` and confirm the newly created record has non-null `documentId` and `documentFileLink` fields.
6. Call `GET /api/documents` and confirm the document you uploaded now has a `partnershipId` field matching the new partnership's `id`.

- [ ] **Step 5: Commit**

```bash
git add views/administrator/registry.ejs assets/js/pages/registry-gridjs.init.js
git commit -m "feat: carry OCR document link through to new partnership records"
```

---

### Task 3: Registry (Admin) — show and manage the link on existing partnerships

**Files:**
- Modify: `assets/js/pages/registry-gridjs.init.js` (partnership normalization, `openViewModal`, `openEditModal`, `saveEdit`, initial `fetch('/api/partnerships')` handler)
- Modify: `views/administrator/registry.ejs:616-628` (Edit modal body)

**Interfaces:**
- Consumes: `documentId`/`documentFileLink` fields on partnership objects returned by `GET /api/partnerships` (added implicitly once Task 2 starts sending them; also directly testable against Task 1's test fixtures).
- Produces: nothing new consumed elsewhere — this task is UI-only, reading fields already on the wire.

- [ ] **Step 1: Normalize the new fields**

In `assets/js/pages/registry-gridjs.init.js`, in the initial `fetch('/api/partnerships')` `.then()` mapping (currently around lines 130-150), add two lines after `docLink: p.docLink || '',`:

```js
        docLink:      p.docLink || '',
        documentId:      p.documentId || null,
        documentFileLink: p.documentFileLink || '',
```

- [ ] **Step 2: Show the linked document in the View modal**

In `openViewModal(id)`, add a row immediately after the existing "Document Link" row (the line ending `'— Not uploaded')+'</div></div>'`):

```js
    +'<div class="col-sm-12"><div class="text-muted fs-12">Document Link</div><div>'+(p.docLink?'<a href="'+p.docLink+'" target="_blank">'+p.docLink+'</a>':'— Not uploaded')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Source Document (OCR)</div><div>'+(p.documentId && p.documentFileLink?'<a href="'+p.documentFileLink+'" target="_blank" rel="noopener"><i class="ri-file-search-line me-1"></i>View Extracted Document</a>':'— None linked')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Remarks</div><div>'+(p.remarks||'—')+'</div></div>'
```

- [ ] **Step 3: Add a link-management row to the Edit modal**

In `views/administrator/registry.ejs`, inside the Edit modal's `.row` (currently ending around line 628 with the Remarks field), add a new row just before the Remarks field:

```html
          <div class="col-lg-12 mb-3" id="edit-doc-link-row" style="display:none">
            <label class="form-label">Linked Source Document (OCR)</label>
            <div class="d-flex align-items-center gap-2">
              <a href="#" target="_blank" rel="noopener" class="btn btn-sm btn-soft-primary" id="e-doc-view-link"><i class="ri-eye-line me-1"></i>View Document</a>
              <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeEditDocumentLink()"><i class="ri-link-unlink-m me-1"></i>Remove Link</button>
            </div>
          </div>
          <div class="col-lg-12 mb-3">
            <label class="form-label" for="e-remarks">Remarks</label>
            <textarea class="form-control" id="e-remarks" rows="2"></textarea>
          </div>
```

- [ ] **Step 4: Wire up the Edit modal's link display and removal**

In `assets/js/pages/registry-gridjs.init.js`, add module-level state near `var editingId=null;`:

```js
var editingId=null;
var editDocumentId=null, editDocumentFileLink=null, editDocumentRemoved=false;
```

Extend `openEditModal(id)` to populate the new row (add before the final `new bootstrap.Modal(...).show();` line):

```js
function openEditModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; editingId=id;
  var toISO=function(s){var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);};
  document.getElementById('e-inst').value=p.inst; document.getElementById('e-country').value=p.country;
  document.getElementById('e-region').value=p.region; document.getElementById('e-partner-email').value=p.partnerEmail||'';
  document.getElementById('e-type').value=p.type; document.getElementById('e-nature').value=p.nature;
  document.getElementById('e-cat').value=p.cat; document.getElementById('e-start').value=toISO(p.start);
  document.getElementById('e-end').value=toISO(p.end); document.getElementById('e-status').value=p.status;
  document.getElementById('e-unit').value=p.unit; document.getElementById('e-coordinator').value=p.coordinator||'';
  document.getElementById('e-doclink').value=p.docLink||''; document.getElementById('e-remarks').value=p.remarks||'';

  editDocumentId = p.documentId || null;
  editDocumentFileLink = p.documentFileLink || '';
  editDocumentRemoved = false;
  var row = document.getElementById('edit-doc-link-row');
  if (editDocumentId && editDocumentFileLink) {
    document.getElementById('e-doc-view-link').href = editDocumentFileLink;
    row.style.display = '';
  } else {
    row.style.display = 'none';
  }

  new bootstrap.Modal(document.getElementById('editPartnershipModal')).show();
}

function removeEditDocumentLink() {
  editDocumentRemoved = true;
  editDocumentId = null;
  editDocumentFileLink = null;
  document.getElementById('edit-doc-link-row').style.display = 'none';
  showToast('Link removed — click Update to save this change.');
}
```

Extend `saveEdit()` to include the removal in the PATCH payload only when it happened (add right after the `updates={...}` assignment, before the `fetch(...)` call):

```js
  var updates={inst:inst,country:document.getElementById('e-country').value.trim(),region:document.getElementById('e-region').value,
    partnerEmail:document.getElementById('e-partner-email').value.trim(),type:document.getElementById('e-type').value,
    nature:document.getElementById('e-nature').value,cat:document.getElementById('e-cat').value,
    start:fmt(document.getElementById('e-start').value),end:fmt(end),endYear:new Date(end).getFullYear(),
    status:document.getElementById('e-status').value,unit:document.getElementById('e-unit').value,
    coordinator:document.getElementById('e-coordinator').value.trim(),docLink:document.getElementById('e-doclink').value.trim(),
    remarks:document.getElementById('e-remarks').value.trim()};
  if (editDocumentRemoved) { updates.documentId = null; updates.documentFileLink = ''; }
```

- [ ] **Step 5: Add the `?highlight=` deep link**

In the initial `fetch('/api/partnerships')` handler, after `buildGrid(); initCounters();` (still inside the same `.then()`), add:

```js
    buildGrid();
    initCounters();
    var params = new URLSearchParams(window.location.search);
    var highlightId = parseInt(params.get('highlight'), 10);
    if (!isNaN(highlightId) && partnerships.some(function(p){ return p.id === highlightId; })) {
      openViewModal(highlightId);
    }
```

- [ ] **Step 6: Manually verify in the browser**

Using the partnership you created in Task 2's verification (which has a linked document):

1. Open `/registry`, click its "View" (eye) icon.
   Expected: a "Source Document (OCR)" row shows a "View Extracted Document" link that opens the archived file in a new tab.
2. Click its "Edit" (pencil) icon.
   Expected: a "Linked Source Document (OCR)" row appears with "View Document" and "Remove Link" buttons; "View Document" opens the same file.
3. Click "Remove Link", then "Update".
   Expected: success toast; reopening "Edit" no longer shows the link row; reopening "View" now shows "— None linked" under Source Document.
4. Visit `/registry?highlight=<id>` directly in the address bar, substituting a real partnership id.
   Expected: the page loads and the View Detail modal for that partnership opens automatically.

- [ ] **Step 7: Commit**

```bash
git add views/administrator/registry.ejs assets/js/pages/registry-gridjs.init.js
git commit -m "feat: view and remove the linked OCR document from the Registry"
```

---

### Task 4: Personnel Registry — show the linked document (read-only)

**Files:**
- Modify: `views/auth. personnel/personnel_registry.ejs` (View Detail Modal HTML around line 347, `normalize()` around line 478-493, `openView()` around line 795-808)

**Interfaces:**
- Consumes: `documentId`/`documentFileLink` fields from `GET /api/partnerships` (same as Task 3 — no new backend interface).
- Produces: nothing consumed elsewhere.

**Note:** this page has no OCR upload panel (only the shared administrator Registry page does), so this task is display-only — there is no equivalent "Remove Link" control here.

- [ ] **Step 1: Add a Source Document section to the View Detail Modal**

In `views/auth. personnel/personnel_registry.ejs`, insert a new section immediately after the "Agreement Period" `<div class="mb-4">...</div>` block and before the "Remarks" `<div class="mb-4">` block (currently around line 347):

```html
                <div class="mb-4" id="v-doc-section" style="display:none">
                    <div class="modal-section-header">Source Document (OCR)</div>
                    <a href="#" target="_blank" rel="noopener" class="btn btn-sm btn-soft-primary" id="v-doc-link">
                        <i class="ri-file-search-line me-1"></i> View Extracted Document
                    </a>
                </div>
                <div class="mb-4">
                    <div class="modal-section-header">Remarks</div>
                    <div class="text-muted fs-12" id="v-remarks">—</div>
                </div>
```

- [ ] **Step 2: Normalize the new fields**

In the `normalize(p)` function (currently ending around line 493), add two properties:

```js
            end: p.end || '',
            status: p.status || '',
            remarks: p.remarks || '',
            documentId: p.documentId || null,
            documentFileLink: p.documentFileLink || ''
        };
    }
```

- [ ] **Step 3: Show/hide the section in `openView`**

In `openView(id)` (currently lines 795-808), add before the final `new bootstrap.Modal(...).show();` line:

```js
    function openView(id) {
        const r = partnerships.find(x => x.id === id);
        if(!r) return;
        document.getElementById('v-name').textContent = r.name;
        document.getElementById('v-country').textContent = r.country;
        document.getElementById('v-type').textContent = r.type;
        document.getElementById('v-nature').textContent = r.nature || '—';
        document.getElementById('v-cat').textContent = r.cat;
        document.getElementById('v-status').innerHTML = statusBadge(r.status);
        document.getElementById('v-start').textContent = r.start;
        document.getElementById('v-end').textContent = r.end;
        document.getElementById('v-remarks').textContent = r.remarks || '—';

        const docSection = document.getElementById('v-doc-section');
        if (r.documentId && r.documentFileLink) {
            document.getElementById('v-doc-link').href = r.documentFileLink;
            docSection.style.display = '';
        } else {
            docSection.style.display = 'none';
        }

        new bootstrap.Modal(document.getElementById('view-modal')).show();
    }
```

- [ ] **Step 4: Manually verify in the browser**

1. Log in as Auth. Personnel and open `/personnel/registry`.
2. Click "View" on the partnership with a linked document (created in Task 2).
   Expected: a "Source Document (OCR)" section appears with a working "View Extracted Document" link.
3. Click "View" on any partnership without a linked document.
   Expected: no "Source Document" section is shown.

- [ ] **Step 5: Commit**

```bash
git add "views/auth. personnel/personnel_registry.ejs"
git commit -m "feat: show linked OCR document in Personnel Registry view"
```

---

### Task 5: Document Library — show which partnership a document is linked to

**Files:**
- Modify: `views/administrator/documents.ejs:409-519` (`renderGrid` and `renderList`)

**Interfaces:**
- Consumes: `partnershipId` field on document objects from `GET /api/documents` (set by Task 1's backend changes; populated by Tasks 2-3's UI flows).
- Produces: a link to `/registry?highlight=<partnershipId>`, consumed by Task 3 Step 5's deep-link handling.

- [ ] **Step 1: Add the badge to the grid (card) view**

In `renderGrid(filtered)` (currently lines 409-477), add a `linkedBadge` computation alongside the existing `accredExtra` computation, and render it in the card body. Change:

```js
            const accredExtra = isAccred && (doc.accreditationLevel || doc.certificateNumber)
                ? `<div class="mb-2 fs-11 text-muted">${doc.accreditationLevel ? 'Level: ' + doc.accreditationLevel : ''}${doc.accreditationLevel && doc.certificateNumber ? ' &middot; ' : ''}${doc.certificateNumber ? 'Cert No: ' + doc.certificateNumber : ''}</div>`
                : '';
            const linkedBadge = doc.partnershipId
                ? `<div class="mb-2"><a href="/registry?highlight=${doc.partnershipId}" class="badge bg-primary-subtle text-primary text-decoration-none"><i class="ri-link me-1"></i>Linked to Partnership Registry</a></div>`
                : '';
```

and in the returned template literal, add `${linkedBadge}` immediately after `${accredExtra}`:

```js
                            ${accredExtra}
                            ${linkedBadge}
                            <div class="d-flex gap-2 mb-2">
```

- [ ] **Step 2: Add the badge to the list (table) view**

In `renderList(filtered)` (currently lines 481-519), add the same `linkedBadge` computation and fold it into the title cell:

```js
            const statusBadge = doc.status === 'Needs Review' ? 'bg-warning-subtle text-warning' : 'bg-success-subtle text-success';
            const linkedBadge = doc.partnershipId
                ? `<div><a href="/registry?highlight=${doc.partnershipId}" class="badge bg-primary-subtle text-primary text-decoration-none"><i class="ri-link me-1"></i>Linked</a></div>`
                : '';

            return `
                <tr>
                    <td><span class="avatar-title bg-light rounded fs-4" style="width:36px;height:36px;display:inline-flex"><i class="${icon}"></i></span></td>
                    <td style="max-width:240px">
                        <div class="text-truncate" title="${doc.title}">${doc.title}</div>
                        ${linkedBadge}
                    </td>
                    <td class="text-truncate" style="max-width:180px">${doc.institution || doc.partner || '—'}</td>
```

(Leave every other `<td>` in that row unchanged.)

- [ ] **Step 3: Manually verify in the browser**

1. Open `/documents` (or `/personnel/documents` — same template).
2. Find the document you linked in Task 2's verification.
   Expected: in both Grid view and List view, a "Linked to Partnership Registry" / "Linked" badge appears on that document.
3. Click the badge.
   Expected: navigates to `/registry?highlight=<id>` and the matching partnership's View Detail modal opens automatically (per Task 3 Step 5).
4. Check a document with no linked partnership.
   Expected: no badge is shown.

- [ ] **Step 4: Commit**

```bash
git add views/administrator/documents.ejs
git commit -m "feat: show linked partnership badge in Document Library"
```

---

## Out of Scope (for a future plan, not this one)

- Adding the OCR auto-fill panel to `personnel_registry.ejs` itself (it currently has no OCR upload UI at all — only the shared Administrator Registry page does).
- Letting a user attach an *already-archived* library document to an *existing* partnership (a searchable "pick from library" control) — this plan only persists the link that the OCR-at-creation-time flow already produces, plus removal.
- Renewal/expiration notifications and audit-trail/version history (the other two enhancement options considered and declined for this plan).
