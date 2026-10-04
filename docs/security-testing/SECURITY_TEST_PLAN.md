# CIPRMS Security Test Plan

**System:** Centralized Institutional Partnership Registry and Management System with Decision Support Analytics (CIPRMS)  
**Institution:** Camarines Sur Polytechnic Colleges – CIRL  
**Test Date:** October 4–5, 2026  
**Environment:** Local development instance (`http://localhost:3000`)  
**Tester:** CIPRMS Development Team (authorized)  
**Document Version:** 1.0

---

## 1. Objective

Conduct authorized security testing of the CIPRMS web application to identify security vulnerabilities, verify the effectiveness of existing controls, and produce reproducible evidence for inclusion in Chapters 3 and 4 of the capstone research.

Testing is limited to the authorized local development environment. No production systems, real user data, or third-party systems are in scope.

---

## 2. System Overview

| Property | Value |
|---|---|
| Framework | Node.js / Express 5.2.1 |
| View Engine | EJS |
| Database | MongoDB (via Mongoose/native driver) |
| Authentication | Session-based (express-session 1.19.0) + Passport.js (Google OAuth) |
| Password Hashing | bcrypt (12 rounds) |
| Rate Limiting | express-rate-limit 7.5.1 |
| File Uploads | multer with MIME+extension allowlist and magic-byte verification |
| Session Cookie | `httpOnly: true`, `sameSite: lax`, `secure: auto` |
| Session Timeout | 2 hours idle |

---

## 3. Tool Availability Assessment

| Tool | Status | Notes |
|---|---|---|
| **Burp Suite** | ❌ Not installed | Not available on this machine. Cannot perform proxy-based interception testing. |
| **OWASP ZAP** | ❌ Not installed | Not available on this machine. Cannot perform automated active scanning. |
| **ffuf / gobuster** | ❌ Not installed | Not available on this machine. |
| **curl.exe** | ✅ Available (v8.13.0) | Used for all manual HTTP-level tests. |
| **Node.js** | ✅ v24.14.0 | Used for syntax/logic analysis and running the test suite. |
| **Jest + supertest** | ✅ Available | Existing automated test suite used for RBAC and workflow verification. |
| **PowerShell** | ✅ Available | Used for scripted batch URL testing (URL fuzzing substitute). |

**Decision:** Burp Suite and OWASP ZAP were not executed because they are not installed. All results marked "Not Tested" for those tools are genuine limitations, not omissions. Manual curl-based testing and code review were performed in their place.

---

## 4. Test Scope

### In Scope
- Authentication: login, logout, session management, credential handling
- Authorization: RBAC guards per endpoint and page
- Direct access to restricted routes (unauthenticated and cross-role)
- Input validation and common injection patterns (NoSQL injection, XSS)
- CSRF posture assessment
- File upload validation (type, size, magic-byte checks)
- Sensitive information exposure (HTTP headers, error responses, file exposure)
- URL discovery / fuzzing (manual, PowerShell-scripted)
- Security header presence
- Rate limiting on authentication and sensitive endpoints

### Out of Scope
- Production/staging environment (not tested)
- Denial-of-service testing
- Third-party services (Google OAuth, MongoDB Atlas, email)
- Destructive payloads or real data extraction
- Physical/network-layer security

---

## 5. Test Cases

| ID | Area | Description | Tool |
|---|---|---|---|
| T01 | Headers | Inspect all HTTP response headers | curl |
| T02–T16 | Authentication | Unauthenticated access to all 31 protected routes | curl |
| T11 | Authentication | Invalid credential login — error message wording | curl |
| T12 | Authentication | Empty credential submission | curl |
| T13 | Authentication | GET on POST-only `/logout` | curl |
| T14 | Authentication | Self-registration bypass attempt | curl |
| T15 | XSS | Reflected XSS via login username field | curl |
| T16 | XSS | Reflected XSS via URL query parameter | curl |
| T17 | Injection | NoSQL injection via JSON body on login | curl |
| T17b | Error Disclosure | Error response body check on malformed request | curl |
| T18 | Rate Limiting | Brute-force login — 12 rapid requests | curl |
| T19 | Authorization | POST `/api/ocr/extract` without session | curl |
| T20 | Path Traversal | `/uploads/documents/` with traversal payloads | curl |
| T21 | Verb Tampering | GET on POST-only `/logout` | curl |
| T22 | Info Disclosure | `X-Powered-By` / `Server` header presence | curl |
| T23 | Info Disclosure | `robots.txt` and `sitemap.xml` exposure | curl |
| T24 | Info Disclosure | Sensitive file exposure (`.env`, `package.json`, `.git/config`) | curl |
| T25 | Security Headers | Full security header audit | curl |
| T26 | Error Handling | API 404/500 error format (stack trace leakage) | curl |
| T27 | URL Fuzzing | 48 common paths probed for unexpected exposure | PowerShell/curl |
| T28 | Authorization | SSE stream unauthenticated access | curl |
| T29 | CSRF | State-mutating POST with cross-origin headers | curl |
| T30 | Session | Session fixation — regeneration on login (code review) | Code review |
| T31 | Authorization | `/api/me` without session | curl |
| T32 | File Upload | Fake PDF (wrong magic bytes) upload attempt | curl |
| T33 | File Upload | Oversized file (12 MB vs 10 MB limit) | curl |
| — | RBAC | Cross-role access via existing Jest test suite | Jest/supertest |
| — | Burp Suite | All Burp Suite tests | Not Run |
| — | OWASP ZAP | Automated scan | Not Run |

---

## 6. Evaluation Criteria

- **Critical**: Direct authentication bypass or privilege escalation possible without credentials
- **High**: Authenticated user can access another user's data; XSS achievable with no interaction; stack traces exposed
- **Medium**: Security headers missing; CSRF possible on state-changing routes; information disclosure
- **Low**: Minor information leakage; missing best-practice headers; non-sensitive route enumeration
- **Informational**: Observations with no direct exploitability in the current threat model

Findings are only confirmed when the behavior is reproduced with evidence. ZAP/Burp alerts are not applicable (tools not run).

---

## 7. Safety Constraints Applied

- Only localhost:3000 was targeted
- No production database, credentials, or real user data accessed
- No destructive payloads (no data deletion, no DoS)
- Rate limiting tests used invalid credentials only
- File upload tests used dummy/test files immediately cleaned up
- No results fabricated; every finding has an actual curl command and output
