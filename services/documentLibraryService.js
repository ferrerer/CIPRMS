const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../db');

const DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

// Maps the free-form OCR document-type guess down to the short codes the
// Document Library UI filters by (All / MOA / MOU / Accreditation / Other).
function shortDocType(documentType) {
  if (!documentType) return 'Other';
  if (/agreement/i.test(documentType)) return 'MOA';
  if (/understanding/i.test(documentType)) return 'MOU';
  if (/accreditation|certification/i.test(documentType)) return 'Accreditation';
  if (/proposal/i.test(documentType)) return 'Proposal';
  if (/letter of intent/i.test(documentType)) return 'LOI';
  if (/contract/i.test(documentType)) return 'Contract';
  return 'Other';
}

async function nextDocumentId(db) {
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  return last.length ? last[0].id + 1 : 1;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// IDP upgrade (2026-07-28): warns about likely-duplicate partnership
// documents already in the Library. Never blocks the upload — the caller
// (ocrService) always archives the file regardless; this only surfaces a
// warning + candidate matches for the user to review (Continue / Cancel /
// View Existing, handled client-side by archiving the new entry via the
// existing PATCH /api/documents/:id/organize route if the user cancels).
async function findPossibleDuplicates(db, extraction, meta = {}) {
  if (!extraction) return { found: false, matches: [] };

  const orClauses = [];
  if (extraction.institution) orClauses.push({ institution: { $regex: escapeRegex(extraction.institution), $options: 'i' } });
  if (extraction.partner) orClauses.push({ partner: { $regex: escapeRegex(extraction.partner), $options: 'i' } });
  if (meta.originalName) orClauses.push({ originalFilename: meta.originalName });
  if (orClauses.length === 0) return { found: false, matches: [] };

  const candidates = await db.collection('documents').find({ $or: orClauses }).limit(20).toArray();
  const type = shortDocType(extraction.documentType);

  const scored = candidates.map((c) => {
    let score = 0;
    const reasons = [];
    const instMatch = extraction.institution && c.institution
      && c.institution.toLowerCase() === extraction.institution.toLowerCase();
    const partnerMatch = extraction.partner && c.partner
      && c.partner.toLowerCase() === extraction.partner.toLowerCase();
    if (instMatch || partnerMatch) { score += 2; reasons.push('same institution'); }
    if (type && c.type === type) { score += 1; reasons.push('same document type'); }
    if (extraction.endDate && c.validity && c.validity.includes(extraction.endDate)) { score += 1; reasons.push('overlapping validity'); }
    if (meta.originalName && c.originalFilename === meta.originalName) { score += 1; reasons.push('same filename'); }
    return { c, score, reasons };
  })
    .filter((x) => x.score >= 2) // institution match alone already meets this — filename match alone does not (secondary signal, per spec)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    found: scored.length > 0,
    matches: scored.map(({ c, reasons }) => ({
      id: c.id, title: c.title, institution: c.institution, fileLink: c.fileLink,
      uploadedAt: c.uploadedAt, reason: reasons.join(', ')
    }))
  };
}

// Every file uploaded through the OCR pipeline is archived here automatically
// — regardless of whether OCR extraction itself succeeded — so nothing a user
// uploads is ever silently discarded. `extraction` is null when OCR failed.
async function archiveToDocumentLibrary(tempFilePath, originalName, extraction, meta = {}) {
  const ext = path.extname(originalName || tempFilePath) || '.bin';
  const permanentName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const permanentPath = path.join(DOCUMENTS_DIR, permanentName);

  try {
    await fsp.rename(tempFilePath, permanentPath);
  } catch {
    // Cross-device fallback (rename can fail across filesystems/mounts)
    await fsp.copyFile(tempFilePath, permanentPath);
    await fsp.unlink(tempFilePath).catch(() => {});
  }

  const db = getDb();
  const id = await nextDocumentId(db);
  const type = shortDocType(extraction && extraction.documentType);
  const institution = (extraction && extraction.institution) || null;
  const partner = (extraction && (extraction.partner || extraction.institution)) || null;
  const issuingBody = (extraction && extraction.issuingBody) || null;
  const accreditationLevel = (extraction && extraction.accreditationLevel) || null;
  const certificateNumber = (extraction && extraction.certificateNumber) || null;
  const accreditedProgram = (extraction && extraction.accreditedProgram) || null;

  let title;
  if (extraction && extraction.title) {
    title = extraction.title;
  } else if (type === 'Accreditation') {
    const body = issuingBody || 'Accreditation';
    const subject = accreditedProgram || institution || partner || 'Program Unspecified';
    title = `${body} Accreditation – ${subject}${accreditationLevel ? ` (${accreditationLevel})` : ''}`;
  } else {
    title = `${type} – ${partner || institution || originalName || 'Uploaded Document'}`;
  }

  const validity = extraction && (extraction.startDate || extraction.endDate)
    ? `${extraction.startDate || '?'} – ${extraction.endDate || '?'}`
    : null;

  const doc = {
    id,
    title,
    type,
    institution,
    partner: partner || 'Unknown',
    validity,
    issuingBody,
    accreditationLevel,
    certificateNumber,
    accreditedProgram,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: extraction ? 'Active' : 'Needs Review',
    fileLink: `/uploads/documents/${permanentName}`,
    tags: [type, extraction ? 'OCR Extracted' : 'OCR Failed'].concat(issuingBody ? [issuingBody] : []),
    uploadedBy: meta.uploadedBy || 'Unknown',
    uploadedByEmail: meta.uploadedByEmail || null,
    uploadedAt: new Date().toISOString(),
    ocrConfidence: extraction ? extraction.confidence : null,
    originalFilename: originalName || null,
    // ── IDP upgrade (2026-07-28) ──────────────────────────────────────────
    ocrText: extraction ? (extraction.rawText || null) : null,
    searchKeywords: extraction ? (extraction.searchKeywords || []) : [],
    summary: extraction ? (extraction.summary || null) : null,
    country: extraction ? (extraction.country || null) : null,
    category: extraction ? (extraction.category || null) : null,
    region: extraction ? (extraction.region || null) : null,
    nature: extraction ? (extraction.nature || null) : null,
    unit: extraction ? (extraction.unit || null) : null,
    fieldConfidence: extraction ? {
      institution: extraction.institutionConfidence || 0,
      country: extraction.countryConfidence || 0,
      documentType: extraction.documentTypeConfidence || 0,
      category: extraction.categoryConfidence || 0,
      region: extraction.regionConfidence || 0,
      nature: extraction.natureConfidence || 0,
      unit: extraction.unitConfidence || 0,
      startDate: extraction.startDateConfidence || 0,
      endDate: extraction.endDateConfidence || 0
    } : null,
    expiration: extraction ? {
      startDate: extraction.startDate || null,
      endDate: extraction.endDate || null,
      duration: extraction.duration || null,
      remainingDays: extraction.remainingDays != null ? extraction.remainingDays : null,
      expirationLabel: extraction.expirationLabel || null
    } : null,
    imageQualityWarnings: (extraction && extraction.imageQuality && extraction.imageQuality.warnings)
      ? extraction.imageQuality.warnings.map((w) => w.message) : [],
    possibleDuplicateIds: (extraction && extraction.duplicateWarning && extraction.duplicateWarning.found)
      ? extraction.duplicateWarning.matches.map((m) => m.id) : [],
    // Links a document back to the Partnership/Document Request it was
    // uploaded during review of, when applicable (undefined for the OCR
    // registry-upload path, which doesn't set these).
    ...(meta.requestId != null ? { requestId: meta.requestId } : {}),
    ...(meta.requestType ? { requestType: meta.requestType } : {})
  };

  await db.collection('documents').insertOne(doc);
  return { documentId: id, fileLink: doc.fileLink };
}

async function updateDocument(id, updates) {
  const db = getDb();
  const allowed = ['title', 'type', 'institution', 'partner', 'validity', 'status', 'issuingBody', 'accreditationLevel', 'certificateNumber', 'accreditedProgram'];
  const patch = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) patch[key] = updates[key];
  }
  await db.collection('documents').updateOne({ id: Number(id) }, { $set: patch });
  return db.collection('documents').findOne({ id: Number(id) });
}

// Gives a submitter their own record of a Partnership/Document Request in the
// Document Library even when no file was uploaded with it (Document Requests
// never have an upload step, and a Partnership Request without OCR auto-fill
// has no attachment either) — there is no physical file to archive here, just
// a metadata entry in the same `documents` collection everything else in the
// library already reads from. `type` is expected to already be a short code
// (both requests collections store one — MOA/MOU/LOI/JVA/Accreditation/Other —
// so no OCR-style free-text mapping is needed here).
async function archiveRequestRecordToLibrary(db, meta) {
  const id = await nextDocumentId(db);
  const label = meta.requestType === 'document' ? 'Document Request' : 'Partnership Request';
  const doc = {
    id,
    title: `${label} – ${meta.institution || 'Untitled'} (#${meta.requestId})`,
    type: meta.type || 'Other',
    institution: meta.institution || null,
    partner: meta.institution || 'Unknown',
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: 'Active',
    fileLink: meta.viewLink || '',
    tags: [label],
    uploadedBy: meta.submittedBy || 'Unknown',
    uploadedByEmail: meta.submittedByEmail || null,
    uploadedAt: new Date().toISOString(),
    originalFilename: null,
    requestId: meta.requestId,
    requestType: meta.requestType
  };
  await db.collection('documents').insertOne(doc);
  return doc;
}

module.exports = { archiveToDocumentLibrary, updateDocument, archiveRequestRecordToLibrary, findPossibleDuplicates, DOCUMENTS_DIR };
