/*
 * Global header search — Administrator / CIRL Staff only. Loaded by views/partials/header.ejs, guarded by the same
 * `!reducedHeader` check that already decides whether those two roles see the search box at all (College Staff and
 * Partner never load this file). Talks to GET /api/search (see services/searchService.js and cirl.js), which is
 * itself gated by requireStaffAccess — this script is convenience, not the authorization boundary.
 *
 * Two render targets, one query:
 *   - the header dropdown (#search-dropdown), small (8 per category), live while typing;
 *   - the full results page (#search-page-results), present only on /search and /staff/search, larger (40 per
 *     category) and driven by the same input box in the header — there is no second search input on that page.
 *
 * Everything the server returns is treated as plain data, never HTML: escapeHtml() runs on every field before it is
 * ever concatenated into a template string, and the highlighted term is escaped the same way before being wrapped in
 * <mark> so a search term that happens to contain HTML-special characters can't inject anything.
 */
(function () {
  'use strict';
  var input = document.getElementById('search-options');
  if (!input || !window.CIPRMS) return; // not on a page that has the search box, or ciprms-rt.js failed to load
  var CIPRMS = window.CIPRMS;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // Wraps every case-insensitive occurrence of `term` inside already-escaped `escapedText` in <mark>. Both sides are
  // escaped the same way first, so this never has to reason about raw HTML.
  function highlight(escapedText, rawTerm) {
    var escapedTerm = escapeHtml(rawTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedTerm) return escapedText;
    try { return escapedText.replace(new RegExp('(' + escapedTerm + ')', 'ig'), '<mark>$1</mark>'); }
    catch (_) { return escapedText; }
  }

  var CATEGORIES = [
    ['partnerships', 'Partnerships / Registry', 'ri-building-4-line'],
    ['requests', 'Partnership Requests', 'ri-file-list-3-line'],
    ['documentRequests', 'Document Requests', 'ri-file-text-line'],
    ['documents', 'Documents', 'ri-folder-3-line']
  ];

  function resultRowHtml(item, q, big) {
    var title = highlight(escapeHtml(item.title), q);
    var subtitle = item.subtitle ? '<div class="fs-12 text-muted">' + escapeHtml(item.subtitle) + '</div>' : '';
    var snippet = item.snippet
      ? '<div class="fs-12 text-muted fst-italic mt-1">' + highlight(escapeHtml(item.snippet), q) + '</div>'
      : '';
    var idBadge = item.id != null ? '<span class="badge bg-light text-muted fs-10 ms-1">#' + escapeHtml(String(item.id)) + '</span>' : '';
    var href = item.href ? escapeHtml(item.href) : '#';
    var target = item.kind === 'document' ? ' target="_blank" rel="noopener"' : '';
    // Rows wrap long text (see .search-result-item in ciprms-bridge.css) rather than truncating, but a `title`
    // still gives a native single-line tooltip with the full, unwrapped title+subtitle on hover/focus.
    var tipParts = [item.title, item.subtitle].filter(Boolean);
    var tip = tipParts.length ? ' title="' + escapeHtml(tipParts.join(' — ')) + '"' : '';
    return '<a href="' + href + '"' + target + tip + ' class="dropdown-item search-result-item' + (big ? ' py-3 border-bottom' : '') + '">' +
      '<div class="fw-medium fs-13">' + title + idBadge + '</div>' + subtitle + snippet + '</a>';
  }

  function groupHtml(key, label, icon, items, q, big) {
    if (!items || !items.length) return '';
    return '<div class="dropdown-header mt-2"><h6 class="text-overflow text-muted mb-0 text-uppercase"><i class="' + icon + ' me-1"></i>' + label + '</h6></div>' +
      items.map(function (item) { return resultRowHtml(item, q, big); }).join('');
  }

  function renderInto(container, data, opts) {
    if (!container) return;
    opts = opts || {};
    if (data.tooShort) {
      container.innerHTML = opts.placeholder || '<div class="dropdown-item bg-transparent text-muted fs-13 text-wrap">Keep typing… (2 characters minimum)</div>';
      return;
    }
    var total = data.partnerships.length + data.requests.length + data.documentRequests.length + data.documents.length;
    if (!total) {
      container.innerHTML = '<div class="text-center text-muted py-4 fs-13"><i class="ri-search-line d-block fs-2 mb-1"></i>No results found for "' + escapeHtml(data.query) + '".</div>';
      return;
    }
    var html = CATEGORIES.map(function (c) { return groupHtml(c[0], c[1], c[2], data[c[0]], data.query, opts.big); }).join('');
    container.innerHTML = html;
  }

  function loadingHtml() { return '<div class="text-center text-muted py-4 fs-13"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Searching…</div>'; }
  function errorHtml(message) { return '<div class="text-center text-danger py-4 fs-13"><i class="ri-error-warning-line d-block fs-2 mb-1"></i>' + escapeHtml(message) + '</div>'; }

  CIPRMS.search = { escapeHtml: escapeHtml, highlight: highlight, renderInto: renderInto };

  // ── wiring ──
  var dropdownBody = document.getElementById('search-dropdown-body'); // the swappable part of #search-dropdown; the
  // rest of that container (the outer dropdown-menu shell, its show/hide behavior) stays exactly Velzon's own.
  var dropdownFooter = document.getElementById('search-dropdown-footer');
  var pageResults = document.getElementById('search-page-results'); // present only on /search and /staff/search
  var defaultDropdownHtml = dropdownBody ? dropdownBody.innerHTML : ''; // the original static "Recent Searches / Pages" shortcuts
  var defaultFooterHtml = dropdownFooter ? dropdownFooter.innerHTML : '';
  var resultsBase = (window.CIPRMS_USER && window.CIPRMS_USER.role) === 'Staff' ? '/staff/search' : '/search';

  var seq = 0, debounceTimer = null;
  function runSearch(full) {
    var q = input.value.trim();
    var mySeq = ++seq;
    if (q.length < 2) {
      if (dropdownBody) dropdownBody.innerHTML = defaultDropdownHtml;
      if (dropdownFooter) dropdownFooter.innerHTML = defaultFooterHtml;
      if (pageResults) renderInto(pageResults, { tooShort: true, query: q }, { big: true });
      return;
    }
    if (dropdownBody) dropdownBody.innerHTML = loadingHtml();
    if (dropdownFooter) dropdownFooter.innerHTML = '';
    if (pageResults && full) pageResults.innerHTML = loadingHtml();
    CIPRMS.api('/api/search?q=' + encodeURIComponent(q) + (full ? '&full=1' : ''), { quiet: true }).then(function (res) {
      if (mySeq !== seq) return; // a newer keystroke's response already landed; discard this stale one
      if (!res.ok) {
        if (dropdownBody) dropdownBody.innerHTML = errorHtml(res.error || 'Search is unavailable right now.');
        if (pageResults) pageResults.innerHTML = errorHtml(res.error || 'Search is unavailable right now.');
        return;
      }
      if (dropdownBody) renderInto(dropdownBody, res.data, {});
      if (dropdownFooter && !full) {
        dropdownFooter.innerHTML = '<a href="' + resultsBase + '?q=' + encodeURIComponent(q) + '" class="btn btn-primary btn-sm">View All Results <i class="ri-arrow-right-line ms-1"></i></a>';
      }
      if (pageResults) renderInto(pageResults, res.data, { big: true });
    });
  }

  input.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { runSearch(!!pageResults); }, 300);
  });

  var form = input.closest('form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearTimeout(debounceTimer);
      var q = input.value.trim();
      if (q.length < 2) return;
      window.location.href = resultsBase + '?q=' + encodeURIComponent(q);
    });
  }

  // The results page runs its initial search from ?q= on load — the header's own box is filled with the same value
  // (server-rendered, see search_results.ejs) so the box and the results agree, and typing further just re-searches.
  if (pageResults && input.value.trim().length >= 2) runSearch(true);
})();
