// Covers the 2026-07-28 Intelligent Document Processing (IDP) upgrade to the
// OCR pipeline: country/category/region/nature/unit inference, expanded
// document-type classification, confidence scoring, expiration/remaining-
// duration calculation, summary generation, and search-keyword extraction.
// Pure unit tests against services/extractionService.js — no server/DB
// needed, since extractFields() is a synchronous function over plain text.
// Real scanned documents were not available in this environment, so these
// use synthetic OCR-like text blocks standing in for the actual document
// types called out in the request (MOA, MOU, LOI, Partnership Proposal,
// Research Agreement) — see docs/SYSTEM_AUDIT_2026-07-16.md for the caveat
// this implies for true end-to-end (real scan -> Tesseract -> extraction)
// verification.
const { extractFields } = require('../services/extractionService');

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

describe('IDP extraction — international MOA (Research)', () => {
  const text = `
MEMORANDUM OF AGREEMENT

This Memorandum of Agreement is entered into by and between Camarines Sur Polytechnic Colleges
and Kyushu University, a research university in Japan, hereinafter referred to as the Parties.

WHEREAS, the Parties desire to engage in research collaboration and joint research
in the field of environmental science;

This agreement is effective on ${futureDate(-10)} and shall remain valid until ${futureDate(400)}.

PURPOSE
To promote joint research and academic collaboration between CSPC and Kyushu University.
`;
  const f = extractFields(text);

  test('classifies document type with high confidence', () => {
    expect(f.documentType).toBe('Memorandum of Agreement (MOA)');
    expect(f.documentTypeConfidence).toBeGreaterThanOrEqual(80);
  });

  test('detects the partner institution and country', () => {
    expect(f.partner).toMatch(/Kyushu University/);
    expect(f.country).toBe('Japan');
    expect(f.countryConfidence).toBeGreaterThan(0);
  });

  test('infers region and category from the detected country', () => {
    expect(f.region).toBe('Asia');
    expect(f.category).toBe('International');
  });

  test('infers nature of partnership from keywords', () => {
    expect(f.nature).toBe('Research');
    expect(f.natureConfidence).toBeGreaterThan(0);
  });

  test('extracts start/end dates with a remaining-duration label of Active', () => {
    expect(f.startDate).toBeTruthy();
    expect(f.endDate).toBeTruthy();
    expect(f.expirationLabel).toBe('Active');
    expect(f.remainingDays).toBeGreaterThan(90);
  });

  test('builds a human-readable summary mentioning the partner and dates', () => {
    expect(f.summary).toMatch(/Kyushu University/);
    expect(f.summary).toMatch(/expires on/);
  });

  test('builds search keywords including institution/country/nature', () => {
    expect(f.searchKeywords).toEqual(expect.arrayContaining(['Kyushu University', 'Japan', 'Research']));
  });
});

describe('IDP extraction — domestic MOU (expiring soon)', () => {
  const text = `
MEMORANDUM OF UNDERSTANDING

This Memorandum of Understanding is entered into between CSPC and Naga City State University,
Philippines, for a student exchange program.

Signing date: ${futureDate(-300)}
Valid until: ${futureDate(30)}
`;
  const f = extractFields(text);

  test('classifies as MOU', () => {
    expect(f.documentType).toBe('Memorandum of Understanding (MOU)');
  });

  test('domestic-only country mention resolves to Philippines / Local', () => {
    expect(f.country).toBe('Philippines');
    expect(f.category).toBe('Local');
    expect(f.region).toBe('Local');
  });

  test('infers Student Exchange nature', () => {
    expect(f.nature).toBe('Student Exchange');
  });

  test('flags expiration as Expiring Soon within the 90-day window', () => {
    expect(f.expirationLabel).toBe('Expiring Soon');
    expect(f.remainingDays).toBeLessThanOrEqual(90);
    expect(f.remainingDays).toBeGreaterThanOrEqual(0);
  });

  test('summary reflects the expiring-soon status', () => {
    expect(f.summary).toMatch(/expiring soon/i);
  });
});

describe('IDP extraction — already-expired agreement', () => {
  const text = `LETTER OF INTENT\n\nBetween CSPC and University of Melbourne, Australia.\nValid until ${futureDate(-5)}.`;
  const f = extractFields(text);

  test('classifies as Letter of Intent', () => {
    expect(f.documentType).toBe('Letter of Intent');
  });
  test('detects Australia -> Oceania / International', () => {
    expect(f.country).toBe('Australia');
    expect(f.region).toBe('Oceania');
    expect(f.category).toBe('International');
  });
  test('flags expiration as Expired with negative remaining days', () => {
    expect(f.expirationLabel).toBe('Expired');
    expect(f.remainingDays).toBeLessThan(0);
  });
});

describe('IDP extraction — new agreement-type classifications', () => {
  test('Partnership Proposal', () => {
    const f = extractFields('This is a Partnership Proposal between CSPC and Test University for community outreach.');
    expect(f.documentType).toBe('Partnership Proposal');
    expect(f.nature).toBe('Community Outreach');
  });
  test('Research Agreement', () => {
    const f = extractFields('RESEARCH AGREEMENT\n\nThis Research Agreement is made between CSPC and Test University.');
    expect(f.documentType).toBe('Research Agreement');
  });
  test('Student Exchange Agreement', () => {
    const f = extractFields('STUDENT EXCHANGE AGREEMENT between CSPC and Test University for exchange of students.');
    expect(f.documentType).toBe('Student Exchange Agreement');
  });
  test('Faculty Exchange Agreement', () => {
    const f = extractFields('FACULTY EXCHANGE AGREEMENT between CSPC and Test University.');
    expect(f.documentType).toBe('Faculty Exchange Agreement');
  });
  test('Training Agreement', () => {
    const f = extractFields('TRAINING AGREEMENT between CSPC and Test University for staff training.');
    expect(f.documentType).toBe('Training Agreement');
  });
});

describe('IDP extraction — conservative fallback when nothing matches', () => {
  const f = extractFields('A short unrelated memo with no recognizable agreement content.');

  test('does not guess a country/category/region/nature/unit', () => {
    expect(f.country).toBeNull();
    expect(f.category).toBeNull();
    expect(f.region).toBeNull();
    expect(f.nature).toBeNull();
    expect(f.unit).toBeNull();
  });
  test('confidence scores are 0 for undetected fields', () => {
    expect(f.countryConfidence).toBe(0);
    expect(f.natureConfidence).toBe(0);
    expect(f.unitConfidence).toBe(0);
  });
  test('no expiration data and no summary when nothing was recognized', () => {
    expect(f.remainingDays).toBeNull();
    expect(f.expirationLabel).toBeNull();
    expect(f.summary).toBeNull();
  });
});

describe('IDP extraction — responsible CSPC unit (conservative acronym-only match)', () => {
  test('matches a literal unit code mention', () => {
    const f = extractFields('This MOA was coordinated through CCS for a joint research program.');
    expect(f.unit).toBe('CCS');
    expect(f.unitConfidence).toBeGreaterThan(0);
    expect(f.unitConfidence).toBeLessThan(80); // deliberately a weak signal
  });
});
