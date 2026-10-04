const fs = require('fs');
const path = require('path');

const docSrc = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'documents.ejs'), 'utf8');
const bridgeCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'css', 'ciprms-bridge.css'), 'utf8');
const publicBridgeCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'ciprms-bridge.css'), 'utf8');

describe('Document Library — Upload & OCR Extraction Modal Sizing (views/administrator/documents.ejs)', () => {
  test('uploadModal uses modal-xl and centered dialog without being full-screen', () => {
    expect(docSrc).toContain('id="uploadModal"');
    expect(docSrc).toMatch(/<div class="modal-dialog modal-dialog-centered modal-xl"[^>]*id="upload-modal-dialog">/);
    expect(docSrc).not.toMatch(/#uploadModal[^{]*\{[^}]*modal-fullscreen/);
  });

  test('modal dialog width scales responsively across desktop breakpoints (960px, 1080px, 1140px)', () => {
    expect(docSrc).toMatch(/@media \(min-width: 992px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 960px;[^}]*max-width: 960px;/);
    expect(docSrc).toMatch(/@media \(min-width: 1200px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 1080px;[^}]*max-width: 1080px;/);
    expect(docSrc).toMatch(/@media \(min-width: 1400px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 1140px;[^}]*max-width: 1140px;/);
  });

  test('modal content has a comfortable max-height capped to viewport, with internal body scroll', () => {
    expect(docSrc).toMatch(/#uploadModal \.modal-content\s*\{[^}]*max-height: calc\(100vh - 3\.5rem\);/);
    expect(docSrc).toMatch(/#uploadModal \.modal-content\s*\{[^}]*display: flex;\s*flex-direction: column;\s*border-radius: 0\.5rem;/);
    expect(docSrc).toMatch(/#uploadModal \.modal-body\s*\{[^}]*padding: 1\.5rem 1\.75rem;\s*overflow-y: auto;/);
  });

  test('modal header and footer have consistent spacing, border alignment, and wrapping actions', () => {
    expect(docSrc).toMatch(/#uploadModal \.modal-header\s*\{[^}]*padding: 1\.1rem 1\.75rem;\s*flex-shrink: 0;/);
    expect(docSrc).toMatch(/#uploadModal \.modal-title\s*\{[^}]*overflow-wrap: anywhere;/);
    expect(docSrc).toMatch(/#uploadModal \.modal-header \.btn-close\s*\{[^}]*flex-shrink: 0;/);
    expect(docSrc).toMatch(/#uploadModal \.modal-footer\s*\{[^}]*padding: 1rem 1\.75rem;\s*flex-shrink: 0;\s*flex-wrap: wrap;\s*gap: 0\.5rem;/);
  });

  test('dropzone, progress bar, and raw text preview are spacious and prevent cramped layouts', () => {
    expect(docSrc).toMatch(/#uploadModal #doc-library-dropzone-wrap \.ciprms-dropzone\s*\{[^}]*padding: 2\.25rem 1\.5rem;\s*min-height: 200px;/);
    expect(docSrc).toContain('max-width:420px;border-radius:4px;'); // OCR progress bar
    expect(docSrc).toMatch(/#uploadModal \.duplicate-matches-list\s*\{[^}]*max-height: 240px;\s*overflow-y: auto;/);
  });

  test('mobile / small screens (<576px) adjust padding and max-width gracefully', () => {
    expect(docSrc).toMatch(/@media \(max-width: 575\.98px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[\s\S]*?max-width: calc\(100vw - 1\.5rem\);/);
    expect(docSrc).toMatch(/@media \(max-width: 575\.98px\) \{[\s\S]*?#uploadModal \.modal-body\s*\{[^}]*padding: 1rem;/);
    expect(docSrc).toMatch(/@media \(max-width: 575\.98px\) \{[\s\S]*?#uploadModal \.modal-footer\s*\{[^}]*padding: 0\.75rem 1rem;/);
  });

  test('dark-mode styling rules are present and preserve high-contrast surfaces', () => {
    expect(docSrc).toContain('[data-bs-theme="dark"] #uploadModal .modal-content');
    expect(docSrc).toContain('[data-bs-theme="dark"] #uploadModal .modal-header');
    expect(docSrc).toContain('[data-bs-theme="dark"] #uploadModal .modal-footer');
    expect(docSrc).toContain('[data-bs-theme="dark"] #uploadModal .modal-title');
    expect(docSrc).toContain('[data-bs-theme="dark"] #uploadModal .duplicate-match-card');
  });

  test('all required IDs and controls remain intact for workflow functionality', () => {
    for (const id of [
      'id="uploadModal"',
      'id="upload-stage"',
      'id="ocr-stage"',
      'id="result-stage"',
      'id="doc-library-dropzone-wrap"',
      'id="fileInput"',
      'id="ocr-modal-progress-bar"',
      'id="res-file-name"',
      'id="duplicate-warning-box"',
      'id="duplicate-matches-container"',
      'id="btn-continue-duplicate"',
      'id="btn-discard-duplicate"',
      'id="btn-toggle-matches"',
      'id="res-title"',
      'id="res-type"',
      'id="res-inst"',
      'id="res-validity"',
      'id="res-rawtext"',
      'id="saveDocBtn"'
    ]) {
      expect(docSrc).toContain(id);
    }
  });
});

describe('Document Library — Upload Modal Sizing in Shared Bridge Stylesheets', () => {
  for (const [name, css] of [['assets/css/ciprms-bridge.css', bridgeCss], ['public/ciprms-bridge.css', publicBridgeCss]]) {
    test(`${name} includes responsive uploadModal width breakpoints`, () => {
      expect(css).toMatch(/@media \(min-width: 992px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 960px;/);
      expect(css).toMatch(/@media \(min-width: 1200px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 1080px;/);
      expect(css).toMatch(/@media \(min-width: 1400px\) \{[\s\S]*?#uploadModal \.modal-dialog\s*\{[^}]*--vz-modal-width: 1140px;/);
    });

    test(`${name} includes dark-mode styling for uploadModal`, () => {
      expect(css).toContain('[data-bs-theme="dark"] #uploadModal .modal-content');
      expect(css).toContain('[data-bs-theme="dark"] #uploadModal .modal-header');
      expect(css).toContain('[data-bs-theme="dark"] #uploadModal .modal-footer');
      expect(css).toContain('[data-bs-theme="dark"] #uploadModal .modal-title');
      expect(css).toContain('[data-bs-theme="dark"] #uploadModal .duplicate-match-card');
    });
  }
});

describe('Document Library — Live EJS Rendering for Administrator and Staff', () => {
  const ejs = require('ejs');
  const tplPath = path.join(__dirname, '..', 'views', 'administrator', 'documents.ejs');
  const tpl = fs.readFileSync(tplPath, 'utf8');

  for (const role of ['Administrator', 'Staff']) {
    test(`renders full enlarged uploadModal for ${role}`, () => {
      const html = ejs.render(
        tpl,
        {
          user: { role, name: `${role} User`, email: `${role.toLowerCase()}@cspc.edu.ph` },
          activePage: 'documents',
          sidebarPartial: role === 'Staff' ? 'sidebar_staff' : 'sidebar'
        },
        { filename: tplPath }
      );

      expect(html).toContain('id="uploadModal"');
      expect(html).toContain('modal-xl');
      expect(html).toContain('id="upload-modal-dialog"');
      expect(html).toContain('--vz-modal-width: 960px');
      expect(html).toContain('--vz-modal-width: 1080px');
      expect(html).toContain('--vz-modal-width: 1140px');
      expect(html).toContain('max-height: calc(100vh - 3.5rem)');
      expect(html).toContain('Upload Document &amp; OCR Extraction');
    });
  }
});

