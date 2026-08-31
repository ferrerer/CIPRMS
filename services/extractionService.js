// Regex/keyword-based field extraction and document-type classification for
// OCR'd partnership documents (MOA / MOU / Contract / Partnership Proposal /
// Letter of Intent). Deliberately conservative: a field is only populated when
// the text actually contains a matching pattern — otherwise it stays null so
// the Registry form never gets silently populated with a guess.

const MONTHS = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const DATE_WORD_RE = new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi');
const DATE_NUM_RE = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g;

const OUR_INSTITUTION_RE = /camarines sur polytechnic colleges|\bcspc\b|center for international relations|\bcirl\b/i;

// ── Document type classification ─────────────────────────────────────────────
const DOC_TYPE_PATTERNS = [
  { type: 'Memorandum of Agreement (MOA)', patterns: [/memorandum of agreement/gi, /\bmoa\b/gi] },
  { type: 'Memorandum of Understanding (MOU)', patterns: [/memorandum of understanding/gi, /\bmou\b/gi] },
  { type: 'Letter of Intent', patterns: [/letter of intent/gi, /\bloi\b/gi] },
  { type: 'Partnership Proposal', patterns: [/partnership proposal/gi, /proposal for partnership/gi] },
  { type: 'Contract', patterns: [/this contract/gi, /\bcontract\b/gi, /entered into by and between/gi] },
  {
    type: 'Accreditation/Certification',
    patterns: [
      /certificate of accreditation/gi, /certificate of registration/gi, /accreditation status/gi,
      /accredited (?:program|institution)/gi, /re-?accredited/gi, /certification/gi,
      /\baaccup\b/gi, /\balcucoa\b/gi, /\bpacucoa\b/gi, /\bpaascu\b/gi, /\biso\s?9001\b/gi
    ]
  },
  // ── IDP upgrade (2026-07-28): additional agreement types the Registry/
  // Requests dropdowns already offer but the classifier previously had no
  // dedicated pattern for (they'd fall through to Contract/MOA/null).
  { type: 'Research Agreement', patterns: [/research agreement/gi, /research collaboration agreement/gi, /joint research agreement/gi] },
  { type: 'Student Exchange Agreement', patterns: [/student exchange agreement/gi, /exchange of students agreement/gi] },
  { type: 'Faculty Exchange Agreement', patterns: [/faculty exchange agreement/gi, /exchange of faculty agreement/gi] },
  { type: 'Training Agreement', patterns: [/training agreement/gi, /agreement for training/gi] }
];

function classifyDocumentType(rawText) {
  const head = rawText.slice(0, 800); // heading/title area — weighted higher
  let best = { type: null, score: 0 };

  for (const candidate of DOC_TYPE_PATTERNS) {
    let score = 0;
    for (const re of candidate.patterns) {
      const bodyMatches = (rawText.match(re) || []).length;
      const headMatches = (head.match(re) || []).length;
      score += bodyMatches + headMatches * 3; // heading mentions count more
    }
    if (score > best.score) best = { type: candidate.type, score };
  }

  if (!best.type) return { type: null, confidence: 0 };
  const confidence = Math.min(99, 45 + best.score * 12);
  return { type: best.type, confidence };
}

// ── IDP upgrade (2026-07-28): country / category / region / nature / unit ───
// inference for the Partnership Request and Add-Partnership forms. Same
// conservative philosophy as the rest of this file — a value is only reported
// when the text actually contains a recognizable signal for it.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const COUNTRIES = [
  'Philippines', 'United States', 'United Kingdom', 'South Korea', 'North Korea', 'Japan', 'China', 'Taiwan',
  'Hong Kong', 'Vietnam', 'Thailand', 'Malaysia', 'Singapore', 'Indonesia', 'Cambodia', 'Laos', 'Myanmar', 'Brunei',
  'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Australia', 'New Zealand', 'Canada', 'Mexico', 'Brazil',
  'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Belgium', 'Switzerland', 'Sweden', 'Norway', 'Denmark',
  'Finland', 'Poland', 'Russia', 'Turkey', 'Israel', 'Saudi Arabia', 'United Arab Emirates', 'Qatar', 'Egypt',
  'South Africa', 'Nigeria', 'Kenya'
].sort((a, b) => b.length - a.length); // longest-first so multi-word names aren't shadowed by a shorter substring

const REGION_BY_COUNTRY = {
  'United States': 'Americas', 'Canada': 'Americas', 'Mexico': 'Americas', 'Brazil': 'Americas',
  'United Kingdom': 'Europe', 'Germany': 'Europe', 'France': 'Europe', 'Spain': 'Europe', 'Italy': 'Europe',
  'Netherlands': 'Europe', 'Belgium': 'Europe', 'Switzerland': 'Europe', 'Sweden': 'Europe', 'Norway': 'Europe',
  'Denmark': 'Europe', 'Finland': 'Europe', 'Poland': 'Europe', 'Russia': 'Europe',
  'Japan': 'Asia', 'China': 'Asia', 'Taiwan': 'Asia', 'Hong Kong': 'Asia', 'South Korea': 'Asia', 'North Korea': 'Asia',
  'Vietnam': 'Asia', 'Thailand': 'Asia', 'Malaysia': 'Asia', 'Singapore': 'Asia', 'Indonesia': 'Asia', 'Cambodia': 'Asia',
  'Laos': 'Asia', 'Myanmar': 'Asia', 'Brunei': 'Asia', 'India': 'Asia', 'Pakistan': 'Asia', 'Bangladesh': 'Asia',
  'Sri Lanka': 'Asia', 'Nepal': 'Asia', 'Turkey': 'Asia', 'Israel': 'Asia', 'Saudi Arabia': 'Asia',
  'United Arab Emirates': 'Asia', 'Qatar': 'Asia',
  'Australia': 'Oceania', 'New Zealand': 'Oceania',
  'Egypt': 'Africa', 'South Africa': 'Africa', 'Nigeria': 'Africa', 'Kenya': 'Africa'
};

// Detects every country name mentioned in the document, then picks the most
// likely "partner's country": if exactly one non-Philippines country is
// found, that's it (high confidence); if several are found, prefer whichever
// appears nearest the partner institution's name; if only "Philippines" is
// mentioned, this is a domestic partnership.
function extractCountry(rawText, partnerName) {
  const found = [];
  for (const name of COUNTRIES) {
    const matches = rawText.match(new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'));
    if (matches) found.push({ name, count: matches.length });
  }
  if (found.length === 0) return { value: null, confidence: 0 };

  const nonPH = found.filter(f => f.name !== 'Philippines');
  if (nonPH.length === 1) return { value: nonPH[0].name, confidence: 90 };
  if (nonPH.length > 1) {
    if (partnerName) {
      const idx = rawText.toLowerCase().indexOf(partnerName.toLowerCase());
      if (idx !== -1) {
        const windowText = rawText.slice(Math.max(0, idx - 150), idx + 150);
        const near = nonPH.find(f => new RegExp(`\\b${escapeRegex(f.name)}\\b`, 'i').test(windowText));
        if (near) return { value: near.name, confidence: 75 };
      }
    }
    nonPH.sort((a, b) => b.count - a.count);
    return { value: nonPH[0].name, confidence: 55 };
  }
  return { value: 'Philippines', confidence: 65 }; // only Philippines mentioned — domestic partnership
}

function inferRegion(country) {
  if (!country) return { value: null, confidence: 0 };
  if (country === 'Philippines') return { value: 'Local', confidence: 70 };
  const region = REGION_BY_COUNTRY[country];
  return region ? { value: region, confidence: 80 } : { value: null, confidence: 0 };
}

function inferCategory(country) {
  if (!country) return { value: null, confidence: 0 };
  return country === 'Philippines' ? { value: 'Local', confidence: 70 } : { value: 'International', confidence: 85 };
}

const NATURE_PATTERNS = [
  { value: 'Student Exchange', patterns: [/student exchange/gi, /exchange of students/gi, /exchange program(?:me)? for students/gi] },
  { value: 'Faculty Development', patterns: [/faculty (?:exchange|development)/gi, /exchange of faculty/gi, /staff development/gi] },
  { value: 'Technology Transfer', patterns: [/technology transfer/gi, /knowledge transfer/gi] },
  { value: 'Community Outreach', patterns: [/community (?:outreach|extension|service)/gi, /extension program(?:me)?/gi] },
  { value: 'Joint Program', patterns: [/joint (?:degree )?program(?:me)?/gi, /dual degree/gi, /twinning program(?:me)?/gi] },
  { value: 'Research', patterns: [/joint research/gi, /research collaboration/gi, /research cooperation/gi, /\bresearch\b/gi] }
];

function inferNature(rawText) {
  let best = { value: null, score: 0 };
  for (const candidate of NATURE_PATTERNS) {
    let score = 0;
    for (const re of candidate.patterns) score += (rawText.match(re) || []).length;
    if (score > best.score) best = { value: candidate.value, score };
  }
  if (!best.value) return { value: null, confidence: 0 };
  return { value: best.value, confidence: Math.min(90, 40 + best.score * 15) };
}

// Deliberately conservative — only the literal CSPC unit acronym itself is
// matched (no guessed department-name synonyms), so this is a weak signal
// (an acronym mention doesn't necessarily mean "responsible unit"), hence
// the low confidence ceiling.
const UNIT_CODES = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];
function inferUnit(rawText) {
  for (const code of UNIT_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(rawText)) return { value: code, confidence: 55 };
  }
  return { value: null, confidence: 0 };
}

// ── One-paragraph human-readable summary of the extraction ──────────────────
function buildSummary(f) {
  if (!f.documentType && !f.institution && !f.partner) return null;
  const docType = f.documentType || 'document';
  const partner = f.partner || f.institution || 'the partner institution';
  let sentence = `This document appears to be a ${docType} between CSPC and ${partner}`;
  sentence += f.nature ? ` for ${f.nature.toLowerCase()}.` : '.';
  if (f.startDate && f.endDate) sentence += ` The agreement begins on ${f.startDate} and expires on ${f.endDate}.`;
  else if (f.endDate) sentence += ` It expires on ${f.endDate}.`;
  else if (f.duration) sentence += ` It is valid for a period of ${f.duration}.`;
  if (f.expirationLabel === 'Expired') sentence += ' This agreement has already expired.';
  else if (f.expirationLabel === 'Expiring Soon' && f.remainingDays != null) {
    sentence += ` It is expiring soon (${f.remainingDays} day${f.remainingDays === 1 ? '' : 's'} remaining).`;
  }
  return sentence;
}

// ── Search keywords, so scanned documents become full-text searchable in ────
// the Document Library even for words that only ever appear inside the file.
const KEYWORD_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Agreement', 'Between', 'Memorandum', 'Understanding',
  'Republic', 'Article', 'Section', 'Whereas', 'Party', 'Parties', 'Witnesseth', 'Now', 'Therefore', 'Signed'
]);
function buildSearchKeywords(rawText, f) {
  const keywords = new Set();
  [f.institution, f.partner, f.country, f.documentType, f.nature, f.unit, f.issuingBody]
    .forEach(v => { if (v) keywords.add(String(v)); });

  // [ \t]+ (not \s+) between words — a bare \s would let a phrase span a
  // newline and glue together unrelated words from adjacent lines/paragraphs.
  const properNounRe = /\b[A-Z][a-zA-Z]{2,}(?:[ \t]+[A-Z][a-zA-Z]{2,}){0,3}\b/g;
  const counts = new Map();
  let m;
  while ((m = properNounRe.exec(rawText)) && counts.size < 300) {
    const phrase = m[0].trim();
    if (KEYWORD_STOPWORDS.has(phrase.split(' ')[0]) || phrase.length < 3) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([phrase]) => keywords.add(phrase));

  return [...keywords].slice(0, 25);
}

// ── Generic section extractor (PURPOSE / OBJECTIVES / SCOPE style headers) ───
function extractSection(rawText, headerNames) {
  const headerAlt = headerNames.join('|');
  const re = new RegExp(`\\b(${headerAlt})\\s*[:\\-]?\\s*\\n+`, 'i');
  const match = re.exec(rawText);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = rawText.slice(start);

  // A section ends at whichever comes first: the next ALL-CAPS header line,
  // or the next blank-line paragraph break — most documents have no header
  // after the final section, so the paragraph break is the more reliable stop.
  const nextHeaderMatch = /\n[A-Z][A-Z \t]{4,40}\n/.exec(rest);
  const paragraphBreakMatch = /\n\s*\n/.exec(rest);

  let end = 700;
  if (paragraphBreakMatch) end = Math.min(end, paragraphBreakMatch.index);
  if (nextHeaderMatch) end = Math.min(end, nextHeaderMatch.index);

  const section = rest.slice(0, end).replace(/\s+/g, ' ').trim();
  return section.length > 5 ? section : null;
}

// Word-wrapped OCR text breaks a single line into several — collapse single
// newlines (word-wrap) to spaces while keeping blank-line paragraph breaks
// intact, so patterns like "between X and Y" can match across a wrapped name.
function flattenWrappedLines(rawText) {
  return rawText.replace(/([^\n])\n(?!\n)/g, '$1 ');
}

// ── Institution / partner names ──────────────────────────────────────────────
function extractInstitutions(rawText) {
  const btwRe = /between\s+([A-Z][A-Za-z.,&()'\- ]{3,90}?)\s+(?:,?\s*represented by[^,]*,\s*)?and\s+([A-Z][A-Za-z.,&()'\- ]{3,90}?)[,.\n]/i;
  const match = btwRe.exec(rawText);
  if (!match) return { institution: null, partner: null };

  const a = match[1].trim();
  const b = match[2].trim();
  if (OUR_INSTITUTION_RE.test(a) && !OUR_INSTITUTION_RE.test(b)) return { institution: a, partner: b };
  if (OUR_INSTITUTION_RE.test(b) && !OUR_INSTITUTION_RE.test(a)) return { institution: b, partner: a };
  // Can't tell which side is "us" — report both, institution defaults to the first named party
  return { institution: a, partner: b };
}

// ── Title ─────────────────────────────────────────────────────────────────────
function extractTitle(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (/^(MEMORANDUM OF (AGREEMENT|UNDERSTANDING)|PARTNERSHIP PROPOSAL|LETTER OF INTENT|CONTRACT|CERTIFICATE OF (ACCREDITATION|REGISTRATION))\b/i.test(line)) {
      return line.replace(/\s{2,}/g, ' ');
    }
  }
  return null;
}

// ── Accreditation / certification specifics ──────────────────────────────────
const ACCREDITING_BODIES = [
  'AACCUP', 'ALCUCOA', 'PACUCOA', 'PAASCU', 'ACSCU-AAI',
  'ISO 9001', 'ISO 21001', 'ISO 14001', 'CHED', 'TESDA'
];

function extractIssuingBody(rawText) {
  for (const body of ACCREDITING_BODIES) {
    const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped, 'i').test(rawText)) return body;
  }
  return null;
}

function extractAccreditationLevel(rawText) {
  const levelMatch = /\bLevel\s+(?:I{1,3}V?|IV|[1-4])\b/i.exec(rawText);
  if (levelMatch) return levelMatch[0].trim();
  const statusMatch = /\b(Candidate\s+Status|Institutional\s+Accreditation|Re-?accredited)\b/i.exec(rawText);
  return statusMatch ? statusMatch[1].trim() : null;
}

function extractCertificateNumber(rawText) {
  const m = /(?:certificate|reference|control)\s*(?:no\.?|number)\s*[:\-]?\s*([A-Za-z0-9\-\/]{3,25})/i.exec(rawText);
  return m ? m[1].trim() : null;
}

function extractAccreditedProgram(rawText) {
  const m = /accredited program\s*[:\-]?\s*([^\n]{5,100})/i.exec(rawText)
    || /program\s+of\s+([^\n]{5,100})/i.exec(rawText)
    || /\b((?:Bachelor|Master|Doctor) of [A-Za-z ]{3,60})/i.exec(rawText);
  return m ? m[1].trim().replace(/\s{2,}/g, ' ') : null;
}

// ── Dates / duration ──────────────────────────────────────────────────────────
// IDP upgrade (2026-07-28): recognizes more label variants for the start/end
// date (Effective Date, Signing Date, Date Signed, Valid Until, Expiry Date)
// and computes a remaining-duration/expiration preview so the OCR result can
// show what will happen once this is saved to the Registry — the actual
// renewal reminders and expiry monitoring are the existing hourly lifecycle
// check (recomputePartnershipStatuses in cirl.js), reused unchanged; this
// only extracts/labels the dates it already needs.
const LIFECYCLE_EXPIRING_WINDOW_DAYS = 90; // mirrors the same constant in cirl.js

function extractDates(rawText) {
  const allDates = [...(rawText.match(DATE_WORD_RE) || []), ...(rawText.match(DATE_NUM_RE) || [])];
  if (allDates.length === 0) {
    return {
      startDate: null, endDate: null, duration: null,
      startDateConfidence: 0, endDateConfidence: 0,
      remainingDays: null, expirationLabel: null
    };
  }

  const startCtx = /(?:effective date|effective|commencing|starting|signing date|date signed|signed on|commencement date|from)[^.\n]{0,40}?(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)[^.\n]{0,15}\d{4})/i.exec(rawText);
  const endCtx = /(?:until|through|ending|expiring|shall expire|valid until|end date|expiration date|expiry date)[^.\n]{0,40}?(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)[^.\n]{0,15}\d{4})/i.exec(rawText);

  const durationMatch = /\bfor a period of\s+([a-zA-Z0-9\- ]{2,20}?\s+(?:years?|months?|days?))\b/i.exec(rawText);

  const startDate = startCtx ? startCtx[1].trim() : (allDates[0] || null);
  const endDate = endCtx ? endCtx[1].trim() : (allDates.length > 1 ? allDates[allDates.length - 1] : null);

  let remainingDays = null, expirationLabel = null;
  if (endDate) {
    const parsed = new Date(endDate);
    if (!isNaN(parsed.getTime())) {
      remainingDays = Math.ceil((parsed - new Date()) / 86400000);
      expirationLabel = remainingDays < 0 ? 'Expired' : remainingDays <= LIFECYCLE_EXPIRING_WINDOW_DAYS ? 'Expiring Soon' : 'Active';
    }
  }

  return {
    startDate, endDate,
    duration: durationMatch ? durationMatch[1].trim() : null,
    startDateConfidence: startCtx ? 85 : (allDates[0] ? 55 : 0),
    endDateConfidence: endCtx ? 90 : (allDates.length > 1 ? 55 : 0),
    remainingDays, expirationLabel
  };
}

// ── Contact info ──────────────────────────────────────────────────────────────
function extractEmail(rawText) {
  const m = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.exec(rawText);
  return m ? m[0] : null;
}

function extractContactNumber(rawText) {
  const ph = /(?:\+63|0)9\d{2}[-.\s]?\d{3}[-.\s]?\d{4}\b/.exec(rawText);
  if (ph) return ph[0];
  const generic = /\(?\d{2,4}\)?[-.\s]\d{3,4}[-.\s]\d{3,4}\b/.exec(rawText);
  return generic ? generic[0] : null;
}

function extractAddress(rawText) {
  const labeled = /address\s*[:\-]\s*([^\n]{5,120})/i.exec(rawText);
  if (labeled) return labeled[1].trim();
  const streetLine = /\b(\d{1,5}\s+[A-Za-z0-9.,\- ]{5,80}\b(?:Street|St\.|Avenue|Ave\.|Brgy\.|Barangay|Road|Rd\.)[A-Za-z0-9.,\- ]{0,60})/i.exec(rawText);
  return streetLine ? streetLine[1].trim() : null;
}

// ── Signatories ───────────────────────────────────────────────────────────────
function extractSignatories(rawText) {
  const results = [];
  const roleRe = /([A-Z][A-Za-z.\- ]{3,40}?)\s*\n\s*(President|Director|Dean|Chairperson|Coordinator|Head|Officer|Vice[- ]President|Chancellor|Provost)\b/g;
  let m;
  while ((m = roleRe.exec(rawText)) && results.length < 6) {
    results.push(`${m[1].trim()}, ${m[2].trim()}`);
  }
  return results;
}

// ── Status keyword (only if explicitly stated in the document) ──────────────
function extractStatus(rawText) {
  if (/\bterminated\b/i.test(rawText)) return 'Terminated';
  if (/\brenewed\b/i.test(rawText)) return 'Renewed';
  if (/\bexpired\b/i.test(rawText)) return 'Expired';
  return null;
}

function extractFields(rawText) {
  const text = rawText || '';
  const flat = flattenWrappedLines(text); // used for patterns that expect a single logical line

  const { institution, partner } = extractInstitutions(flat);
  const dateInfo = extractDates(flat);
  const docType = classifyDocumentType(text);
  const countryInfo = extractCountry(flat, partner || institution);
  const categoryInfo = inferCategory(countryInfo.value);
  const regionInfo = inferRegion(countryInfo.value);
  const natureInfo = inferNature(text);
  const unitInfo = inferUnit(flat);

  const fields = {
    institution,
    partner,
    institutionConfidence: institution ? 88 : 0,
    title: extractTitle(text),
    documentType: docType.type,
    documentTypeConfidence: docType.confidence,
    country: countryInfo.value,
    countryConfidence: countryInfo.confidence,
    category: categoryInfo.value,
    categoryConfidence: categoryInfo.confidence,
    region: regionInfo.value,
    regionConfidence: regionInfo.confidence,
    nature: natureInfo.value,
    natureConfidence: natureInfo.confidence,
    unit: unitInfo.value,
    unitConfidence: unitInfo.confidence,
    startDate: dateInfo.startDate,
    startDateConfidence: dateInfo.startDateConfidence,
    endDate: dateInfo.endDate,
    endDateConfidence: dateInfo.endDateConfidence,
    duration: dateInfo.duration,
    remainingDays: dateInfo.remainingDays,
    expirationLabel: dateInfo.expirationLabel,
    address: extractAddress(flat),
    email: extractEmail(flat),
    contactNumber: extractContactNumber(flat),
    signatories: extractSignatories(text),
    purpose: extractSection(text, ['PURPOSE']),
    objectives: extractSection(text, ['OBJECTIVES?']),
    scope: extractSection(text, ['SCOPE(?: OF (?:WORK|AGREEMENT))?']),
    status: extractStatus(text),
    issuingBody: extractIssuingBody(flat),
    accreditationLevel: extractAccreditationLevel(flat),
    certificateNumber: extractCertificateNumber(flat),
    // Uses the original (non-flattened) text — "program of X" is expected to
    // end at a real line break; flattening would let it run past a title into
    // whatever line comes next.
    accreditedProgram: extractAccreditedProgram(text),
    remarks: null
  };

  fields.summary = buildSummary(fields);
  fields.searchKeywords = buildSearchKeywords(text, fields);
  return fields;
}

module.exports = {
  extractFields, classifyDocumentType,
  extractCountry, inferCategory, inferRegion, inferNature, inferUnit,
  buildSummary, buildSearchKeywords
};
