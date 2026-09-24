// Requests page (Administrator / CIRL Staff): the Partnership Request details + View Draft modals and the Document
// Request details + Drafts modals get a little more room. UI/CSS only — source-content checks here (same technique as
// admin-ui-polish-2026-09-22.test.js); the rendered result was verified in a real browser for both roles at 1440,
// 1200, 1024 and 390px with long unbroken names, filenames and notes.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'partnership_requests.ejs'), 'utf8');
const IDS = ['pr-modal', 'pr-draft-modal', 'dr-modal', 'dr-draft-modal'];

describe('Requests modals — sizing (CSS only)', () => {
  test('all four modals are widened on desktop only, never full-screen', () => {
    for (const id of IDS) {
      expect(src).toContain(`#${id} .modal-dialog`);
    }
    expect(src).toMatch(/@media \(min-width: 992px\) \{\s*#pr-modal \.modal-dialog[^}]*--vz-modal-width: 960px;/);
    expect(src).toMatch(/@media \(min-width: 1400px\) \{\s*#pr-modal \.modal-dialog[^}]*--vz-modal-width: 1040px;/);
    expect(src).not.toMatch(/#(pr|dr)(-draft)?-modal[^{]*\{[^}]*modal-fullscreen/);
  });

  test('the body scrolls inside the modal, capped to the viewport height, with more padding', () => {
    expect(src).toMatch(/#pr-modal \.modal-content[^{]*\{ max-height: calc\(100vh - 2rem\); \}/);
    expect(src).toMatch(/#pr-modal \.modal-body[^{]*\{\s*padding: 1\.5rem 1\.75rem; overflow-y: auto; overflow-wrap: anywhere; min-width: 0;/);
  });

  test('footers wrap instead of squeezing their buttons', () => {
    expect(src).toMatch(/#pr-modal \.modal-footer[^{]*\{\s*flex-wrap: wrap; gap: \.5rem;/);
  });

  test('a long unbroken name in the title can no longer push the close button off-screen', () => {
    expect(src).toMatch(/#pr-modal \.modal-title[^{]*\{ min-width: 0; overflow-wrap: anywhere; \}/);
    expect(src).toMatch(/#pr-modal \.btn-close[^{]*\{ flex-shrink: 0; \}/);
  });

  test('on a phone the padding tightens and Document Request fields stack one per row', () => {
    expect(src).toMatch(/@media \(max-width: 575\.98px\) \{[\s\S]*?#dr-modal \.modal-body \.row > \.col-6 \{ flex: 0 0 100%; max-width: 100%; \}/);
  });
});

describe('Requests modals — structure and behavior untouched', () => {
  test('the modals keep their existing markup, ids and Bootstrap sizing classes (no new modal system)', () => {
    for (const id of IDS) expect((src.match(new RegExp(`id="${id}"`, 'g')) || []).length).toBe(1);
    expect(src).toMatch(/id="pr-modal"[\s\S]{0,60}modal-dialog modal-dialog-centered modal-lg/);
    expect(src).toMatch(/id="dr-modal"[\s\S]{0,60}modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg/);
    expect(src).toMatch(/id="pr-draft-modal"[\s\S]{0,60}modal-dialog modal-dialog-centered modal-lg/);
    expect(src).toMatch(/id="dr-draft-modal"[\s\S]{0,60}modal-dialog modal-dialog-centered modal-lg/);
  });

  test('the draft/upload/status controls and their handlers are all still present', () => {
    for (const s of ['id="pr-draft-upload-btn"', 'onclick="uploadDraftDocument()"', 'id="dr-draft-upload-btn"', 'onclick="uploadDRDraftDocument()"',
      'onclick="openDRDraftModal()"', "onclick=\"openDraftModal('${uid}')\"", 'id="pr-modal-footer"', 'drStatusSelectHtml']) {
      expect(src).toContain(s);
    }
    expect(src).toContain("swapToModal('pr-draft-modal', 'pr-modal')");
  });

  test('the existing long-text protections are kept', () => {
    expect(src).toContain('.draft-card { min-width: 0; overflow-wrap: anywhere; }');
    expect(src).toContain('overflow-wrap: anywhere'); // .detail-value
  });
});
