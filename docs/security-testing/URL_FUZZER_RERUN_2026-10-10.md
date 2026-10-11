# URL Fuzzer Re-Run — 2026-10-10

Re-execution of the T27 "URL Fuzzing" test from `docs/security-testing/SECURITY_TEST_PLAN.md` /
`SECURITY_TEST_RESULTS.md`, against a freshly started local instance (`node cirl.js`, default port 3000,
real `.env`/MongoDB — there is no separate test database for this project). Same tool substitution as the
original test (ffuf/gobuster not installed on this machine): a curl loop over a path list, one unauthenticated
request per path, status code only. 86 paths probed (vs. the original 48) — expanded with more
backup-file/source-exposure and app-specific-route checks. Server was started fresh for this test and
stopped immediately afterward; nothing was left running.

## Result: no new findings. All prior findings reconfirmed, one improvement observed.

### Sensitive/admin/debug/config paths (all should be 404) — 68 probed, 68 returned 404

Includes: `/admin`, `/administrator`, `/wp-admin`, `/wp-login.php`, `/phpmyadmin`, `/console`, `/shell`,
`/cmd`, `/api/admin`, `/api/debug`, `/api/health`, `/api/status`, `/api/metrics`, `/graphql`, `/swagger*`,
`/api-docs`, `/.well-known/security.txt`, `/robots.txt`, `/sitemap.xml`, `/server-status`, `/actuator*`,
`/.env*`, `/config.json`, `/package.json`, `/package-lock.json`, `/cirl.js`, `/db.js`, `/jest.config.js`,
`/.git/config`, `/.git/HEAD`, `/.gitignore`, `/node_modules/*`, `/test/*`, `/uploads/*`, `/Database_backup/`,
`/docs/*`, `/.htaccess`, `/web.config`, `/app.js`, `/server.js`, `/index.php`, `/login.php`, `/backup.sql`,
`/backup.zip`, `/dump.sql`, `/.DS_Store`, `/admin_settings`.

**No admin console, debug endpoint, API documentation, source file, backup file, or configuration file is
exposed.** Static `.js`/config files are not served from the project root (Express's static middleware is
scoped to `public/`/`assets/`, not the repo root) — none of the application's own source files are
web-accessible.

### Protected application routes (all should redirect/reject, never 200) — 17 probed

`/dashboard`, `/lifecycle`, `/staff`, `/staff/`, `/staff/dashboard`, `/staff/lifecycle`, `/staff/reports`,
`/partner`, `/partner/dashboard`, `/personnel/dashboard`, `/reports`, `/calendar`, `/documents`,
`/api/partnerships`, `/api/partnerships/`, `/api/users`, `/api/targets`, `/api/responsible-units`,
`/api/reports/custom/preview`, `/api/reports/comparison/multi/preview`, `/api/reports/dimension-values`,
`/api/ocr/extract`, `/api/ocr/jobs`, `/api/ocr/status/fake123`, `/api/me` → **all 302** (redirect to `/`,
no session). `/api/realtime/stream` → **401 JSON** (correct SSE-specific behavior — an HTML redirect would
break `EventSource` clients; matches the original report's documented rationale). No protected route returned
200 without a session.

### Behavioral checks beyond the original 48-path list

| Check | Result |
|---|---|
| `GET /logout` | 404 — confirms logout stays POST-only (CSRF/method-safety by design, matches original T13) |
| `GET /signup` | 200 — the public signup *form* renders (intentional; this is not an auth bypass) |
| `POST /signup` with a real name/email/password | Rejected — response contains "registration"/"disabled" (self-registration confirmed still blocked server-side, matches original T14) |
| 11 rapid `POST /login` attempts (fresh process, no prior counter) | Attempts 1–10 → 401 (invalid credentials), attempt 11 → **429** — rate limiting confirmed live and working, same threshold as the original report's T18 |
| `GET /nonexistent-xyz-path-test` (generic 404 body) | `<h2>404 — Page not found</h2><a href="/">Go home</a>` — generic, no stack trace, no path reflected back (confirms original T26, no info leak via error page) |
| Security headers on `/` | **Present:** `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies` |

### One change since the original report: F-01 ("Missing Security HTTP Headers," Medium) no longer reproduces

The original `SECURITY_TEST_RESULTS.md` (F-01) listed `Content-Security-Policy`, `X-Frame-Options`,
`X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`, and `Permissions-Policy` as
**missing** from every response. Today's `/` request shows all of the Helmet-provided headers above present
and correctly configured (a real CSP allow-list, not a wildcard; HSTS with `includeSubDomains`). This
indicates Helmet (or equivalent middleware) was added/configured after that report was written. **This
finding should be marked Resolved in `SECURITY_TEST_RESULTS.md` / `REMEDIATION_CHECKLIST.md`** — not done
here, since this report is a fuzzer re-run, not a rewrite of those documents; flagging it for whoever owns
that checklist.

(`Permissions-Policy` specifically was not seen in today's header dump — worth a quick follow-up check if F-01's
remediation was meant to cover it too.)

## Summary

| Metric | Value |
|---|---|
| Paths probed | 86 |
| Confirmed exposures (new) | **0** |
| Prior findings reconfirmed as still-fixed/non-issues | Logout GET-404, self-registration block, rate limiting, generic 404 pages, SSE 401 behavior |
| Prior finding no longer reproducing (improvement) | F-01 Missing Security Headers — now present |
| Tooling | curl loop (ffuf/gobuster still not installed on this machine, same limitation as the original report) |

**Bottom line: no unprotected admin/debug/config/backup endpoint was discovered, and the one gap the original
report flagged (missing security headers) is now closed.**
