/* System Status banner (2026-11) — one reusable, dismissible notice reused by every authenticated page via
   views/partials/header.ejs, instead of each page building its own ad hoc "service down" message. Reads
   GET /api/system-status (see services/systemStatusService.js) and never assumes a single failed service
   means CIPRMS itself is down (see RECHECK_MS re-polling + the explicit coreAvailable distinction below). */
(function () {
  'use strict';
  if (!window.CIPRMS_USER) return; // only on authenticated pages, same gate ciprms-rt.js itself uses

  var RECHECK_MS = 120000; // re-check every 2 minutes so a resolved failure clears without a full page reload
  var dismissedSignature = null; // the exact problem list the person last dismissed — a NEW problem still shows

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function signatureOf(problems) {
    return problems.map(function (p) { return p.key + ':' + p.state; }).sort().join(',');
  }

  function removeBanner() {
    var el = document.getElementById('ciprms-status-banner');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function render(status) {
    var problems = (status.services || []).filter(function (s) { return s.state !== 'available'; });

    if (!status.coreAvailable) {
      // The database itself is unreachable — a different, broader claim than "one feature is unavailable"
      // (brief section 11). Every page that depends on data will fail anyway, so this one is not dismissible.
      removeBanner();
      var core = document.createElement('div');
      core.id = 'ciprms-status-banner';
      core.setAttribute('role', 'alert');
      core.style.cssText = 'position:sticky;top:0;z-index:1200;background:#f06548;color:#fff;padding:10px 16px;font-size:13.5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
      core.innerHTML =
        '<i class="ri-error-warning-line fs-16"></i>' +
        '<div style="flex:1 1 auto;"><strong>CIPRMS is currently unavailable.</strong> The database is not responding, so most pages and actions will fail until it recovers. Please try again shortly.</div>' +
        '<button type="button" class="btn btn-sm btn-light" id="ciprms-status-retry">Retry</button>';
      document.body.insertBefore(core, document.body.firstChild);
      document.getElementById('ciprms-status-retry').addEventListener('click', function () { check(); });
      return;
    }

    if (!problems.length) { removeBanner(); dismissedSignature = null; return; }

    var signature = signatureOf(problems);
    if (signature === dismissedSignature) return; // the person already dismissed exactly this set of problems

    removeBanner();
    var items = problems.map(function (p) {
      return '<li>' + esc(p.label) + ' — ' + esc(p.message) + '</li>';
    }).join('');
    var banner = document.createElement('div');
    banner.id = 'ciprms-status-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:sticky;top:0;z-index:1200;background:#f7b84b;color:#212529;padding:10px 16px;font-size:13.5px;';
    banner.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:10px;">' +
        '<i class="ri-error-warning-line fs-16 mt-1"></i>' +
        '<div style="flex:1 1 auto;">' +
          '<strong>Some CIPRMS features are currently unavailable.</strong> Everything else works normally.' +
          '<ul style="margin:6px 0 0;padding-left:1.1rem;">' + items + '</ul>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-shrink:0;">' +
          '<button type="button" class="btn btn-sm btn-light" id="ciprms-status-retry">Retry</button>' +
          '<button type="button" class="btn btn-sm btn-light" id="ciprms-status-dismiss">Dismiss</button>' +
        '</div>' +
      '</div>';
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('ciprms-status-retry').addEventListener('click', function () { check(); });
    document.getElementById('ciprms-status-dismiss').addEventListener('click', function () {
      dismissedSignature = signature;
      removeBanner();
    });
  }

  function check() {
    fetch('/api/system-status', { headers: { 'X-Requested-With': 'ciprms', Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (!res.ok || !/json/i.test(ct)) return null; // a failed health-check request is not itself proof of an outage (brief §16) — stay silent
        return res.json().catch(function () { return null; });
      })
      .then(function (status) {
        // An inconclusive re-check (network hiccup, or the route's own fallback) is not proof the problem
        // is gone — clearing the banner here, even on a manual Retry, would be a false "all clear" that
        // could mask a real, still-ongoing failure (brief: never falsely report a resolved state).
        if (!status || status.overall === 'unknown') return;
        render(status);
      })
      .catch(function () { /* network hiccup checking status — never let this crash the page or claim an outage */ });
  }

  if (document.body) check(); else document.addEventListener('DOMContentLoaded', function () { check(); });
  setInterval(check, RECHECK_MS);
})();
