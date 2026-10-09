// public/js/ciprms-system-status.js — source-level checks for the banner's Retry/Dismiss contract (brief
// section 4). There is no jsdom in this project's Jest config (jest.config.js: testEnvironment 'node'), so
// — matching the convention test/account-settings-error-handling.test.js already uses for Settings pages'
// own inline <script> — these assert against the real shipped source text rather than executing it.
//
// Bug found and fixed here: on a manual Retry, if the re-check request itself came back inconclusive
// (network hiccup, or the route's own try/catch fallback answering `overall: 'unknown'`), the OLD code
// called removeBanner() anyway — a false "all clear" that could hide a real, still-ongoing failure (e.g.
// email still misconfigured) right after the person clicked Retry hoping to confirm it was fixed.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/ciprms-system-status.js'), 'utf8');

describe('System Status banner — Retry/Dismiss contract', () => {
  test('an inconclusive recheck (status missing or "unknown") never clears the banner, even via manual Retry', () => {
    expect(SRC).not.toMatch(/isManualRetry/); // the old manual-vs-passive distinction that caused the bug is gone entirely
    const inconclusive = SRC.match(/if \(!status \|\| status\.overall === 'unknown'\) [^\n]*/);
    expect(inconclusive).not.toBeNull();
    expect(inconclusive[0]).not.toMatch(/removeBanner/);
  });

  test('Retry re-runs the real check() against the server — it is not a client-only reset', () => {
    const retryHandlers = [...SRC.matchAll(/ciprms-status-retry'\)\.addEventListener\('click', function \(\) \{ ([^}]*) \}\);/g)];
    expect(retryHandlers.length).toBeGreaterThanOrEqual(2); // one for the "core down" banner, one for the "degraded" banner
    for (const m of retryHandlers) expect(m[1].trim()).toBe('check();');
  });

  test('Dismiss is UI-only: it never calls fetch() or check(), only hides the banner client-side', () => {
    const dismissBlock = SRC.slice(SRC.indexOf("'ciprms-status-dismiss'"));
    const handlerBody = dismissBlock.slice(0, dismissBlock.indexOf('});') + 3);
    expect(handlerBody).not.toMatch(/fetch\(|check\(/);
    expect(handlerBody).toContain('dismissedSignature = signature');
    expect(handlerBody).toContain('removeBanner()');
  });

  test('the degraded-services list is built generically from whatever is non-"available" — not hardcoded to email, so fixing email alone does not hide other unrelated warnings', () => {
    expect(SRC).toContain(`var problems = (status.services || []).filter(function (s) { return s.state !== 'available'; });`);
    expect(SRC).not.toMatch(/key === 'email'/); // render() must not special-case any one service
  });

  test('the banner script is wired into every authenticated page via the shared header partial', () => {
    const header = fs.readFileSync(path.join(__dirname, '../views/partials/header.ejs'), 'utf8');
    expect(header).toContain('/js/ciprms-system-status.js');
  });
});
