// Document Library stored-XSS regression (2026-11 Phase 3). Root cause: views/administrator/documents.ejs's
// renderGrid()/renderList() interpolated doc.title/institution/partner/type/status/date/nature and, for
// Accreditation records, doc.issuingBody/accreditationLevel/certificateNumber straight into innerHTML with
// no escaping — despite this exact file already defining and using escHtml() everywhere else (folder names,
// tag filter buttons, the duplicate-match warning). Every one of those fields is attacker-reachable: directly
// via PATCH /api/documents/:id (services/documentLibraryService.js's updateDocument() whitelists the field
// names but validates nothing about their content), or via OCR-extracted content at upload time
// (archiveToDocumentLibrary() copies extraction.title/institution/issuingBody/etc. straight through). This
// page is shared by Administrator, Auth. Personnel and potential_partner's Document Library (one `res.render`
// call site for all three), so fixing it once covers all three.
//
// Deliberately does NOT start the real app or touch MongoDB — Phase 3's safety requirements forbid writing
// to the production database from a test, and this app has no isolated test database wired up yet. Instead
// this extracts the EXACT, unmodified <script> block from the real .ejs file as text and runs it in a real
// browser against a blank page with just the DOM ids it touches — the identical function definitions a real
// visitor's browser would run, exercised with fixture data instead of a real fetch('/api/documents').
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const EJS_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'documents.ejs');

function extractScriptBlock(html) {
  // Anchored on the escHtml() definition (unambiguous, and the function this whole spec exists to verify
  // is actually used) rather than exact surrounding whitespace, which can differ by line-ending style.
  const anchor = html.indexOf('function escHtml(s) {');
  if (anchor === -1) throw new Error(`Could not locate escHtml() in ${EJS_PATH} — has it moved or been renamed?`);
  const scriptStart = html.lastIndexOf('<script>', anchor);
  const scriptEnd = html.indexOf('</script>', anchor);
  if (scriptStart === -1 || scriptEnd === -1) throw new Error(`Could not locate the enclosing <script> tags around escHtml() in ${EJS_PATH}.`);
  return html.slice(scriptStart + '<script>'.length, scriptEnd);
}

const MARK = 'window.__xssFired = (window.__xssFired || []).concat([TAG])';
function payload(tag) {
  return `<img src=x onerror="${MARK.replace('TAG', `'${tag}'`)}">${tag}-MARKER`;
}

const MALICIOUS_DOC = {
  id: 1,
  title: payload('TITLE'),
  type: payload('TYPE'),
  institution: payload('INST'),
  partner: null,
  status: payload('STATUS'),
  date: payload('DATE'),
  tags: [payload('NATURE')],
  fileLink: '/uploads/documents/x.pdf',
  archived: false,
  folderId: null
};

const ACCRED_MALICIOUS_DOC = {
  id: 2,
  title: payload('ACCTITLE'),
  type: 'Accreditation',
  institution: payload('ACCINST'),
  issuingBody: payload('ISSUING'),
  accreditationLevel: payload('LEVEL'),
  certificateNumber: payload('CERTNO'),
  status: 'Active',
  date: 'Jan 1, 2026',
  tags: [],
  fileLink: '/uploads/documents/y.pdf',
  archived: false,
  folderId: null
};

const SPECIAL_CHARS_DOC = {
  id: 3,
  title: 'Smith & Jones "International" <Partners> MOA',
  type: 'MOA',
  institution: 'Smith & Jones "International" <Partners>',
  partner: null,
  status: 'Active',
  date: 'Jan 1, 2026',
  tags: ['Research'],
  fileLink: '/uploads/documents/z.pdf',
  archived: false,
  folderId: null
};

async function loadScriptInBlankPage(page) {
  const html = fs.readFileSync(EJS_PATH, 'utf8');
  const script = extractScriptBlock(html);
  await page.setContent('<!doctype html><html><body><div id="document-grid"></div><table><tbody id="document-list-body"></tbody></table></body></html>');
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => typeof renderGrid === 'function' && typeof renderList === 'function');
}

test.describe('Document Library (documents.ejs) — stored XSS is neutralized in both Grid and List views', () => {
  test('renderGrid(): every malicious field it actually displays (title, institution, type, nature) renders as inert text', async ({ page }) => {
    // renderGrid() (the card view) never shows status/date at all — only renderList() (the table, tested
    // below) does; asserting on fields a given view doesn't render would be asserting nothing real.
    await loadScriptInBlankPage(page);
    await page.evaluate((doc) => { window.__xssFired = []; renderGrid([doc]); }, MALICIOUS_DOC);

    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]);
    const html = await page.locator('#document-grid').innerHTML();
    expect(html).not.toContain('<img');
    expect(await page.locator('#document-grid img').count()).toBe(0);
    const text = await page.locator('#document-grid').innerText();
    for (const marker of ['TITLE-MARKER', 'TYPE-MARKER', 'INST-MARKER', 'NATURE-MARKER']) {
      expect(text).toContain(marker);
    }
  });

  test('renderGrid(): the Accreditation-only fields (issuingBody, accreditationLevel, certificateNumber) are also neutralized', async ({ page }) => {
    await loadScriptInBlankPage(page);
    await page.evaluate((doc) => { window.__xssFired = []; renderGrid([doc]); }, ACCRED_MALICIOUS_DOC);

    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]);
    expect(await page.locator('#document-grid img').count()).toBe(0);
    const text = await page.locator('#document-grid').innerText();
    for (const marker of ['ACCTITLE-MARKER', 'ACCINST-MARKER', 'ISSUING-MARKER', 'LEVEL-MARKER', 'CERTNO-MARKER']) {
      expect(text).toContain(marker);
    }
  });

  test('renderList(): the same malicious fields are neutralized in the table view', async ({ page }) => {
    await loadScriptInBlankPage(page);
    await page.evaluate((doc) => { window.__xssFired = []; renderList([doc]); }, MALICIOUS_DOC);

    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]);
    expect(await page.locator('#document-list-body img').count()).toBe(0);
    const text = await page.locator('#document-list-body').innerText();
    for (const marker of ['TITLE-MARKER', 'TYPE-MARKER', 'INST-MARKER', 'STATUS-MARKER', 'DATE-MARKER', 'NATURE-MARKER']) {
      expect(text).toContain(marker);
    }
  });

  test('legitimate special characters (&, <, >, ", \') still render correctly in both views, not double-escaped', async ({ page }) => {
    await loadScriptInBlankPage(page);
    await page.evaluate((doc) => { renderGrid([doc]); }, SPECIAL_CHARS_DOC);
    const gridText = await page.locator('#document-grid').innerText();
    expect(gridText).toContain('Smith & Jones "International" <Partners> MOA');
    expect(gridText).not.toContain('&amp;');

    await page.evaluate((doc) => { renderList([doc]); }, SPECIAL_CHARS_DOC);
    const listText = await page.locator('#document-list-body').innerText();
    expect(listText).toContain('Smith & Jones "International" <Partners>');
    expect(listText).not.toContain('&amp;');
  });
});
