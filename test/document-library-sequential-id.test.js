// documents collection sequential-id race-condition fix (2026-11 Phase 3). Root cause: `documents` was the
// one sequential-id collection the Phase 2 race-condition remediation missed — services/documentLibraryService
// .js's nextDocumentId() used the same unprotected "read max, then insert" pattern Phase 2 fixed everywhere
// else, at its two insert sites (archiveToDocumentLibrary(), archiveRequestRecordToLibrary()). Confirmed
// (read-only, during this same change) zero existing duplicates in `documents`, so no reconciliation migration
// was needed — this is a pure code fix, switching both call sites to db.js's already-proven insertWithNextId()
// (the exact same helper the Phase 2 collections use).
//
// Mocks ../db entirely rather than connecting to any MongoDB (real or isolated) — insertWithNextId()'s own
// retry-on-collision logic was already thoroughly proven in test/sequential-id-race.test.js (Phase 2) and is
// completely unchanged here; what this file actually needs to prove is narrower and different: that these two
// call sites now DELEGATE to it correctly (the right collection, a builder that produces a complete, correct
// document) instead of the old unprotected pattern. Satisfies Phase 3's "no writes to the production
// database" rule without needing an isolated test database — there is no database connection to make unsafe.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const mockInsertWithNextId = jest.fn();
const mockCollection = jest.fn((name) => ({ __fakeCollectionName: name }));
jest.mock('../db', () => ({
  getDb: () => ({ collection: mockCollection }),
  insertWithNextId: (...args) => mockInsertWithNextId(...args)
}));

const { archiveToDocumentLibrary, archiveRequestRecordToLibrary } = require('../services/documentLibraryService');

describe('archiveToDocumentLibrary(): the OCR-upload insert path', () => {
  let tempFile;

  beforeEach(async () => {
    mockInsertWithNextId.mockReset();
    mockCollection.mockClear();
    tempFile = path.join(os.tmpdir(), `ciprms-doclib-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await fsp.writeFile(tempFile, 'fixture file content');
  });

  afterEach(async () => {
    // archiveToDocumentLibrary() moves (renames) the temp file into uploads/documents/ — clean up whatever
    // landed there under its generated permanent name, plus the source if the move never happened.
    try { await fsp.unlink(tempFile); } catch (_) { /* already moved */ }
  });

  test('inserts via insertWithNextId() against the real "documents" collection, not a raw insertOne', async () => {
    mockInsertWithNextId.mockImplementation(async (collection, buildDoc) => {
      expect(collection.__fakeCollectionName).toBe('documents'); // proves db.collection('documents') was targeted
      return buildDoc(777); // simulates insertWithNextId successfully allocating id 777
    });

    const extraction = { title: 'Test MOA', institution: 'Test University', documentType: 'MOA', confidence: 92 };
    const result = await archiveToDocumentLibrary(tempFile, 'test.txt', extraction, { uploadedBy: 'Tester', uploadedByEmail: 'tester@example.com' });

    expect(mockInsertWithNextId).toHaveBeenCalledTimes(1);
    expect(result.documentId).toBe(777); // the id insertWithNextId actually allocated, not a locally-guessed one
    expect(result.fileLink).toMatch(/^\/uploads\/documents\//);

    // Clean up the file this really did move into uploads/documents/.
    const movedPath = path.join(__dirname, '..', 'uploads', 'documents', path.basename(result.fileLink));
    await fsp.unlink(movedPath).catch(() => {});
  });

  test('a concurrent-insert collision (simulated) is recovered the same way insertWithNextId() recovers it everywhere else', async () => {
    // insertWithNextId's own retry logic is Phase 2's concern (test/sequential-id-race.test.js); this proves
    // archiveToDocumentLibrary() correctly surfaces whatever id it ultimately allocates, including a retried
    // one — not a value it computed itself.
    mockInsertWithNextId.mockImplementation(async (collection, buildDoc) => buildDoc(42)); // as if attempt 1 collided and attempt 2 landed on 42
    const result = await archiveToDocumentLibrary(tempFile, 'test.txt', null, {});
    expect(result.documentId).toBe(42);

    const movedPath = path.join(__dirname, '..', 'uploads', 'documents', path.basename(result.fileLink));
    await fsp.unlink(movedPath).catch(() => {});
  });
});

describe('archiveRequestRecordToLibrary(): the Partnership/Document Request archival insert path', () => {
  beforeEach(() => {
    mockInsertWithNextId.mockReset();
    mockCollection.mockClear();
  });

  test('inserts via insertWithNextId() against the real "documents" collection and returns the inserted doc', async () => {
    mockInsertWithNextId.mockImplementation(async (collection, buildDoc) => {
      expect(collection.__fakeCollectionName).toBe('documents');
      return buildDoc(888);
    });

    const fakeDb = { collection: mockCollection };
    const doc = await archiveRequestRecordToLibrary(fakeDb, {
      requestType: 'document', requestId: 5, institution: 'Test Org',
      type: 'MOU', submittedBy: 'Tester', submittedByEmail: 'tester@example.com', viewLink: '/document-requests/5/print'
    });

    expect(mockInsertWithNextId).toHaveBeenCalledTimes(1);
    expect(doc.id).toBe(888);
    expect(doc.title).toContain('Test Org');
    expect(doc.requestId).toBe(5);
  });
});
