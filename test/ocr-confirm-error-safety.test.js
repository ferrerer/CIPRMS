// controllers/ocrController.js confirm() safe-error-response fix (2026-11 Phase 3) — split into its own
// file because jest.mock('../services/ocrService') is hoisted to the top of whatever file it's written in
// (a Jest/babel-plugin-jest-hoist behavior, not scoped to the describe block it's textually inside), which
// would otherwise auto-mock ocrService for every other describe block in the same file, including the real,
// unmocked ocrService used by test/ocr-error-safety.test.js's sibling test. See that file's own header
// comment for the full root-cause writeup; this file covers just the confirm() half of it. No MongoDB
// connection — ocrService is fully mocked, never touches the database.
const request = require('supertest');
const express = require('express');

jest.mock('../services/ocrService');
const ocrServiceMock = require('../services/ocrService');
const ocrController = require('../controllers/ocrController');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { user: { email: 'tester@example.com' } }; next(); });
  app.post('/api/ocr/confirm', ocrController.confirm);
  return app;
}

describe('controllers/ocrController.js confirm(): a real archiving failure never reaches the client as a raw exception', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  test('confirmJob() rejecting with a raw-looking error yields a safe generic message, logged server-side', async () => {
    ocrServiceMock.getJob.mockReturnValue({ uploadedByEmail: 'tester@example.com', confirmed: false });
    ocrServiceMock.confirmJob.mockRejectedValue(new Error('ENOSPC: no space left on device, write'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(buildApp()).post('/api/ocr/confirm').send({ jobId: 'job-1' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to save the document. Please try again.');
      expect(res.body.error).not.toMatch(/ENOSPC|no space left/i);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('confirmJob() succeeding is unaffected by the fix (existing success path untouched)', async () => {
    ocrServiceMock.getJob.mockReturnValue({ uploadedByEmail: 'tester@example.com', confirmed: false });
    ocrServiceMock.confirmJob.mockResolvedValue({ documentId: 42, fileLink: '/uploads/documents/x.pdf' });

    const res = await request(buildApp()).post('/api/ocr/confirm').send({ jobId: 'job-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, documentId: 42, fileLink: '/uploads/documents/x.pdf' });
  });
});
