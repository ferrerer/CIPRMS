// Global header search (Administrator / CIRL Staff) — 2026-09-23 UI-only fix.
//
// Root cause: Velzon's `.app-search` has no explicit width (see assets/css/app.min.css), so it collapses to a
// narrow intrinsic flex-item width; the results panel (#search-dropdown, `.dropdown-menu-lg` = flat 320px) has no
// viewport cap; #search-dropdown-body relies on `data-simplebar` which never finishes wrapping the panel because
// it's `display:none` at page load (the same gotcha already fixed for `.notif-scroll`); and every rendered result
// row is a Bootstrap `.dropdown-item`, which defaults to `white-space:nowrap`, so a long institution/document/OCR
// name ran off the edge of the panel instead of wrapping. None of the backend search API, RBAC, or live-search
// wiring changed — this is a source-content check of the CSS/markup/client-JS fix, same technique already used by
// admin-ui-polish-2026-09-22.test.js.
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Global header search — search bar sizing (assets/css/ciprms-bridge.css)', () => {
  const css = read('assets', 'css', 'ciprms-bridge.css');

  test('.app-search gets an explicit, wider base width instead of Velzon\'s collapsed default', () => {
    const block = css.slice(css.indexOf('.app-search {'), css.indexOf('.app-search {') + 200);
    expect(block).toMatch(/width:\s*420px/);
  });

  test('the search bar shrinks at progressively smaller breakpoints instead of staying one fixed width', () => {
    expect(css).toMatch(/@media \(max-width:\s*1399\.98px\)\s*\{\s*\.app-search\s*\{\s*width:\s*340px/);
    expect(css).toMatch(/@media \(max-width:\s*1199\.98px\)\s*\{\s*\.app-search\s*\{\s*width:\s*280px/);
    expect(css).toMatch(/@media \(max-width:\s*991\.98px\)\s*\{\s*\.app-search\s*\{\s*width:\s*220px/);
  });

  test('every .app-search width rule is paired with a viewport-relative max-width safety net', () => {
    const rules = css.match(/\.app-search\s*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const rule of rules) expect(rule).toMatch(/max-width:\s*\d+vw/);
  });
});

describe('Global header search — results panel overflow (assets/css/ciprms-bridge.css)', () => {
  const css = read('assets', 'css', 'ciprms-bridge.css');

  test('#search-dropdown is capped to the viewport width so it can never force horizontal page scroll', () => {
    const block = css.slice(css.indexOf('#search-dropdown {'), css.indexOf('#search-dropdown {') + 200);
    expect(block).toMatch(/max-width:\s*calc\(100vw - 2rem\)/);
  });

  test('#search-dropdown also scales down at the same breakpoints as the search bar', () => {
    expect(css).toMatch(/@media \(max-width: 1399\.98px\) \{ #search-dropdown \{ width: 360px; \} \}/);
    expect(css).toMatch(/@media \(max-width: 1199\.98px\) \{ #search-dropdown \{ width: 320px; \} \}/);
    expect(css).toMatch(/@media \(max-width: 991\.98px\)\s*\{ #search-dropdown \{ width: 280px; \} \}/);
  });

  test('#search-dropdown-body gets a real CSS scrollbar (the data-simplebar-when-hidden gotcha, same fix already applied to .notif-scroll)', () => {
    const block = css.slice(css.indexOf('#search-dropdown-body {'), css.indexOf('#search-dropdown-body {') + 150);
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toMatch(/overflow-x:\s*hidden/);
  });

  test('long result text wraps instead of running past the panel edge (Bootstrap .dropdown-item defaults to white-space:nowrap)', () => {
    const block = css.slice(css.indexOf('.search-result-item {'), css.indexOf('.search-result-item {') + 200);
    expect(block).toMatch(/white-space:\s*normal/);
    expect(block).toMatch(/(overflow-wrap|word-break)/);
  });
});

describe('Global header search — result rows still escape everything, tooltip is additive only (public/js/ciprms-search.js)', () => {
  const src = read('public', 'js', 'ciprms-search.js');
  function extractSrc(name) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
    if (!m) throw new Error(name + ' not found in ciprms-search.js');
    return m[0];
  }
  const { escapeHtml, highlight, resultRowHtml } = new Function(
    `${extractSrc('escapeHtml')}\n${extractSrc('highlight')}\n${extractSrc('resultRowHtml')}\nreturn { escapeHtml, highlight, resultRowHtml };`
  )();

  test('a normal result row renders a title attribute with the escaped, un-highlighted title+subtitle', () => {
    const html = resultRowHtml({ title: 'Example University', subtitle: 'Country: Japan', id: 5, href: '/lifecycle?highlight=5' }, 'Example', false);
    expect(html).toContain('title="Example University — Country: Japan"');
    expect(html).toContain('<mark>Example</mark>');
  });

  test('a script-injection-shaped title cannot inject a live tag via the new title attribute', () => {
    const html = resultRowHtml({ title: '<script>alert(1)</script>', subtitle: null, id: 1, href: '#' }, 'x', false);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('title="&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  test('a row with no title/subtitle simply omits the attribute rather than rendering title=""', () => {
    const html = resultRowHtml({ title: '', subtitle: '', id: 2, href: '#' }, 'x', false);
    expect(html).not.toContain('title=""');
  });

  test('every row is still a .dropdown-item.search-result-item (the class the new wrap/overflow CSS targets)', () => {
    const html = resultRowHtml({ title: 'Institution', subtitle: '', id: 3, href: '#' }, 'x', false);
    expect(html).toMatch(/class="dropdown-item search-result-item/);
  });

  test('document results still open in a new tab (unrelated existing behavior, untouched)', () => {
    const html = resultRowHtml({ title: 'Contract.pdf', subtitle: '', id: 4, href: '/uploads/x.pdf', kind: 'document' }, 'x', false);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });
});

describe('Global header search — existing search behavior/markup is unchanged (views/partials/header.ejs)', () => {
  const view = read('views', 'partials', 'header.ejs');

  test('the search box is still gated behind !reducedHeader (College Staff / Partner keep no search bar)', () => {
    expect(view).toMatch(/<% if \(!reducedHeader\) \{ %>\s*<!-- App Search -->/);
  });

  test('the live-search input, dropdown body, and footer elements Administrator/CIRL Staff both rely on are all still present', () => {
    for (const id of ['search-options', 'search-dropdown', 'search-dropdown-body', 'search-dropdown-footer', 'search-close-options']) {
      expect(view).toContain(`id="${id}"`);
    }
  });

  test('ciprms-search.js is still loaded, still deferred (must run after #search-page-results, when present, is in the DOM)', () => {
    expect(view).toContain('<script src="/js/ciprms-search.js?v=2" defer></script>');
  });
});

describe('Global header search — client-side wiring untouched (public/js/ciprms-search.js)', () => {
  const src = read('public', 'js', 'ciprms-search.js');

  test('live-while-typing debounce, the /api/search call, and RBAC-relevant category list are all still present', () => {
    expect(src).toContain("input.addEventListener('input'");
    expect(src).toContain('/api/search?q=');
    expect(src).toContain("['partnerships', 'Partnerships / Registry'");
    expect(src).toContain("['requests', 'Partnership Requests'");
    expect(src).toContain("['documentRequests', 'Document Requests'");
    expect(src).toContain("['documents', 'Documents'");
  });

  test('the stale-response guard (sequence counter) is untouched — a slow keystroke response can never overwrite a newer one', () => {
    expect(src).toContain('var mySeq = ++seq;');
    expect(src).toContain('if (mySeq !== seq) return;');
  });
});
