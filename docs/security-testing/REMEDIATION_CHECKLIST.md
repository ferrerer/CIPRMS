# CIPRMS Security Testing — Remediation Checklist

**Document:** Post-Testing Remediation Tracker  
**Date:** October 5, 2026  

---

## Checklist

| ID | Severity | Finding | Fix Required | Fixed? | Retested? |
|---|---|---|---|---|---|
| F-01 | Medium | Missing security headers (CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy, Permissions-Policy) | `npm install helmet` + `app.use(helmet())` in `cirl.js` | ☐ | ☐ |
| F-02 | Low | `X-Powered-By: Express` header disclosed | `app.disable('x-powered-by')` or covered by helmet | ☐ | ☐ |
| F-03 | Medium | No CSRF token on state-mutating routes | Add `csrf-csrf` or `csurf` package; generate + validate tokens on forms | ☐ | ☐ |
| F-04 | Medium | JSON object in login body causes HTTP 500 | Add `typeof` checks on `username` and `password` before `.trim()` | ☐ | ☐ |
| F-05 | Info | No `/.well-known/security.txt` | Create `public/.well-known/security.txt` (RFC 9116) | ☐ | ☐ |
| F-06 | Info | No `robots.txt` | Optional: create `public/robots.txt` with `Disallow: /api/` | ☐ | ☐ |

---

## F-01 Fix: Add Helmet

```js
// In cirl.js, after: const app = express();
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "lh3.googleusercontent.com"],
      connectSrc: ["'self'"],  // SSE /api/realtime/stream is same-origin
    }
  }
}));
```
> **Note:** Adjust CSP directives to match actual CDN sources used by the Velzon theme.

---

## F-04 Fix: Login Input Type Guard

```js
// In cirl.js POST /login handler, after: const { username, password } = req.body;
if (typeof username !== 'string' || typeof password !== 'string') {
  return res.render('index', { activePage: '', error: 'Please enter your email and password.' });
}
```

---

## Retest Procedure

For each fix applied:

1. Restart the local server (`node cirl.js`)
2. Re-run the relevant curl test from `SECURITY_TEST_RESULTS.md`
3. Verify the finding is no longer reproducible
4. Mark "Fixed?" and "Retested?" as ✅ above
5. Record the retest date and result in the Results document

---

## Limitations Disclosure

- Burp Suite and OWASP ZAP were not available on this machine. Their specific tests (proxy-based interception, full active scan, spider crawl) were not performed. This checklist covers only confirmed findings from curl-based manual testing and code review.
- Authenticated cross-role RBAC testing was not performed live in this session. The existing Jest test suite (`test/rbac-matrix.test.js`, `test/request-endpoint-rbac.test.js`, `test/security-hardening.test.js`) covers this and should be run to verify authorization controls.
- This list covers the current test scope only. Security testing should be repeated after major feature additions or before production deployment.
