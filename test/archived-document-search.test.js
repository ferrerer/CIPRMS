require('dotenv').config();
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('TASK 1 — Archived Document Search Indicator and Preview', () => {
  let db;
  const stamp = Date.now();
  const archivedDocId = stamp;
  const activeDocId = stamp + 1;

  beforeAll(async () => {
    db = await connectDB();
  });

  afterAll(async () => {
    if (db) {
      await db.collection('documents').deleteMany({ id: { $in: [archivedDocId, activeDocId] } });
    }
    await closeDB();
  });

  describe('Client-side search rendering (public/js/ciprms-search.js)', () => {
    const src = read('public', 'js', 'ciprms-search.js');
    function extractSrc(name) {
      const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
      if (!m) throw new Error(name + ' not found in ciprms-search.js');
      return m[0];
    }
    const { escapeHtml, highlight, resultRowHtml } = new Function(
      `${extractSrc('escapeHtml')}\n${extractSrc('highlight')}\n${extractSrc('resultRowHtml')}\nreturn { escapeHtml, highlight, resultRowHtml };`
    )();

    test('archived document result renders the "Archived" badge and "Location: Archive" indicator', () => {
      const item = {
        kind: 'document',
        id: 101,
        title: 'Memorandum of Agreement.pdf',
        subtitle: 'MOA · Tokyo University',
        href: '/uploads/documents/moa_101.pdf',
        archived: true
      };
      const html = resultRowHtml(item, 'Memorandum', false);

      expect(html).toContain('search-badge-archived');
      expect(html).toContain('Archived');
      expect(html).toContain('Location: Archive');
      expect(html).toContain('title="Memorandum of Agreement.pdf — MOA · Tokyo University — Location: Archive"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener"');
    });

    test('active (non-archived) document does NOT render the Archived badge or Location: Archive', () => {
      const item = {
        kind: 'document',
        id: 102,
        title: 'Active Research Plan.pdf',
        subtitle: 'MOU · Kyoto University',
        href: '/uploads/documents/mou_102.pdf',
        archived: false
      };
      const html = resultRowHtml(item, 'Active', false);

      expect(html).not.toContain('search-badge-archived');
      expect(html).not.toContain('Location: Archive');
      expect(html).toContain('Active Research Plan.pdf');
    });

    test('non-document items (partnerships, requests) never display Archived indicators', () => {
      const partnership = {
        kind: 'partnership',
        id: 50,
        title: 'Global University Partner',
        subtitle: 'Country: Canada',
        href: '/lifecycle?q=Global',
        archived: true
      };
      const html = resultRowHtml(partnership, 'Global', false);

      expect(html).not.toContain('search-badge-archived');
      expect(html).not.toContain('Location: Archive');
    });
  });

  describe('Search backend service (services/searchService.js)', () => {
    const searchService = require('../services/searchService');

    beforeEach(async () => {
      await db.collection('documents').insertOne({
        id: archivedDocId,
        title: `Jest Archived Research Doc ${stamp}`,
        institution: `Archived Inst ${stamp}`,
        type: 'MOA',
        archived: true,
        fileLink: `/uploads/documents/archived_${archivedDocId}.pdf`
      });

      await db.collection('documents').insertOne({
        id: activeDocId,
        title: `Jest Active Research Doc ${stamp}`,
        institution: `Active Inst ${stamp}`,
        type: 'MOU',
        archived: false,
        fileLink: `/uploads/documents/active_${activeDocId}.pdf`
      });
    });

    afterEach(async () => {
      await db.collection('documents').deleteMany({ id: { $in: [archivedDocId, activeDocId] } });
    });

    test('globalSearch returns archived: true for archived documents and archived: false for active documents', async () => {
      const res = await searchService.globalSearch(db, `Jest Archived Research Doc ${stamp}`);
      const doc = res.documents.find(d => d.id === archivedDocId);
      expect(doc).toBeDefined();
      expect(doc.archived).toBe(true);
      expect(doc.fileLink).toBe(`/uploads/documents/archived_${archivedDocId}.pdf`);

      const activeRes = await searchService.globalSearch(db, `Jest Active Research Doc ${stamp}`);
      const activeDoc = activeRes.documents.find(d => d.id === activeDocId);
      expect(activeDoc).toBeDefined();
      expect(activeDoc.archived).toBe(false);
    });

    test('restoring / unarchiving a document immediately updates subsequent search results without stale indicator', async () => {
      await db.collection('documents').updateOne({ id: archivedDocId }, { $set: { archived: false } });

      const res = await searchService.globalSearch(db, `Jest Archived Research Doc ${stamp}`);
      const doc = res.documents.find(d => d.id === archivedDocId);
      expect(doc).toBeDefined();
      expect(doc.archived).toBe(false);
    });
  });
});
