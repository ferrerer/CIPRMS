# CIPRMS Security Testing — Capstone Documentation Guide

**For:** Research Authors  
**Relates to:** Chapter 3 (Methodology) and Chapter 4 (Results and Discussion)  
**Date:** October 5, 2026

---

## Chapter 3 — Methodology Guidance

### What to Write

Describe security testing as a component of the system evaluation methodology. Use only what was actually done.

**Suggested structure:**

> **3.x Security Testing of CIPRMS**
>
> Security testing of the CIPRMS web application was conducted on the authorized local development instance (http://localhost:3000) running Node.js v24.14.0 and Express 5.2.1. Testing was performed by the development team on [DATE], using the following tools and methods:
>
> **Tools Used:**
> - `curl` v8.13.0 — used for all manual HTTP-level tests including authentication, authorization, header inspection, input validation, and error handling
> - PowerShell scripting — used as a URL fuzzing substitute to probe 48 common paths for unexpected exposure
> - Source code review — used to verify session management, password handling, upload validation, and error handling logic
>
> **Tools Not Used (and Why):**  
> Burp Suite and OWASP ZAP were not installed on the test machine at the time of testing and therefore could not be executed. Results for these tools are documented as "Not Run" in the test records. This is a limitation of the current evaluation; recommendations for future testing with these tools are included in the limitations section.
>
> **Test Scope:**  
> Testing covered [list from Section 3 of SECURITY_TEST_PLAN.md]. Testing was restricted to the local development environment. No production systems, real user data, or third-party services were accessed. No destructive, denial-of-service, or data-extraction tests were performed.
>
> **Evaluation Criteria:**  
> Each finding was assigned a severity of Critical, High, Medium, Low, or Informational based on confirmed reproducibility and actual impact, following OWASP severity classification conventions. Alert-level outputs from automated tools were not applicable due to the tools not being run.
>
> **Limitations:**  
> The testing described here is not a full penetration test. Results reflect the security posture of the application within the tested scope only. Authenticated cross-role testing, Google OAuth flows, production HTTPS enforcement, and stored XSS in data fields were not tested in this session. The existing automated test suite (Jest + supertest) was used to verify RBAC controls.

---

### What NOT to Write in Chapter 3

- ❌ Do not write that Burp Suite or OWASP ZAP were used — they were not.
- ❌ Do not write that a "full penetration test" was performed.
- ❌ Do not state that the system was tested against all OWASP Top 10 categories — not all were tested.
- ❌ Do not fabricate test counts from tools that were not run.

---

## Chapter 4 — Results and Discussion Guidance

### What to Write

Present the actual findings, the summary table, and interpretation.

**Suggested structure:**

> **4.x Security Testing Results**
>
> Security testing of CIPRMS produced the results summarized in Table X. A total of 30 manual HTTP tests and 48 URL fuzzing probes were executed. No critical or high-severity vulnerabilities were identified. Six findings were confirmed: three of medium severity and three of low/informational severity.
>
> [Insert the Tool Summary Table from SECURITY_TEST_RESULTS.md]
>
> [Insert the Findings by Severity table]
>
> **Authentication and Authorization (Passed)**  
> All 31 protected routes consistently redirected unauthenticated requests to the login page (HTTP 302). No authentication bypass was achieved via invalid credentials, NoSQL operator injection, or unauthorized session reuse. Login rate limiting was confirmed, triggering HTTP 429 after 10 failed attempts within a 15-minute window. Self-registration is disabled — attempts to create accounts via the signup form were rejected.
>
> **Input Validation and Injection (Passed with one medium note)**  
> Reflected XSS payloads were not echoed in login form responses or URL parameters. NoSQL injection via a JSON object body on the login endpoint did not result in authentication bypass; however, it produced an HTTP 500 error (F-04) instead of the expected 400 Bad Request. The error response contained only a generic message with no internal detail.
>
> **File Upload Security (Passed)**  
> The upload middleware enforces a 10 MB file size limit, restricts accepted MIME types to PDF, JPG, JPEG, and PNG, and validates file headers using magic-byte verification, preventing renamed files from bypassing the allowlist.
>
> **Security Headers (Finding F-01)**  
> The application does not set standard security response headers including Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, or Referrer-Policy. This is the most significant finding, as these headers provide browser-level mitigations for classes of attacks (clickjacking, MIME sniffing, XSS scope limiting) that are independent of the server-side controls already in place. Remediation via the `helmet` middleware is straightforward.
>
> **CSRF Protection (Finding F-03)**  
> The application does not implement CSRF synchronizer tokens. The `sameSite: lax` session cookie attribute provides partial mitigation — cross-site POST requests from third-party pages will not carry the session cookie in modern browsers. However, this is not a complete CSRF defense and does not protect against same-site or subdomain-origin attacks. The codebase acknowledges this as a known deferred item.
>
> **URL Fuzzing (No Findings)**  
> Forty-eight common paths including administrative panels, debug endpoints, API documentation routes, and configuration files were probed. No unprotected or unexpected endpoints were discovered. All paths either returned HTTP 404 (not defined) or HTTP 302/401 (authentication required).
>
> **Overall Assessment:**  
> CIPRMS demonstrates a sound security baseline with no critical or high-severity vulnerabilities identified in the tested scope. The confirmed findings are remediable with minimal effort. The most impactful improvement would be the addition of standard security headers via the `helmet` middleware, which addresses multiple medium findings simultaneously.

---

### Figures and Tables to Include in Chapter 4

1. **Table: Security Tool and Test Summary** (from SECURITY_TEST_RESULTS.md "Tool Summary Table")
2. **Table: Confirmed Findings by Severity** (from SECURITY_TEST_RESULTS.md "Findings by Severity")
3. **Table: Test Cases and Results** (from SECURITY_TEST_RESULTS.md "Tests Passed" section)
4. **Table: URL Fuzzing Results** (from SECURITY_TEST_RESULTS.md "URL Fuzzing Results")
5. **Table: Detailed Findings** (F-01 through F-06)
6. **Figure: HTTP response headers (absence of security headers)** — screenshot or curl output excerpt

---

### What NOT to Write in Chapter 4

- ❌ Do not claim the system "passed" Burp Suite or ZAP testing — those tools were not run.
- ❌ Do not claim the system is "fully secure" or "free of vulnerabilities" — these tests have a defined scope.
- ❌ Do not present ZAP alert counts or Burp findings — they were not generated.
- ❌ Do not omit the limitations section — it is required for academic honesty and research validity.

---

## Required Limitation Disclosure (Include in Both Chapters)

> The security evaluation described in this study was conducted using manual HTTP testing and scripted URL probing rather than a full penetration test. Burp Suite and OWASP ZAP, which are referenced in the test plan, were not available on the test machine and were not executed. Authenticated cross-role access testing, persistent XSS testing on stored data, and Google OAuth flow testing were not performed in this evaluation. The results reflect the security posture of the CIPRMS application within the defined test scope and should not be interpreted as a certification of security or as a guarantee that no additional vulnerabilities exist.
