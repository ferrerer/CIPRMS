// Sign-in page — Google only (2026-11 Google-only sign-in / progressive rate limiting).
//
// Root cause / before state: views/index.ejs rendered a full email+password form (with a "Remember me"
// checkbox that was already non-functional — it had no `name` attribute, so it was never even submitted)
// alongside the Google button. Since every CIPRMS account is provisioned by an Administrator and matched to
// a Google account purely by e-mail (self-registration has been disabled since 2026-09-05 — see
// test/oauth-allowlist.test.js), the password form was never a second independent way to reach a DIFFERENT
// set of accounts, just a second way into the exact same allowlisted ones. Removed in favor of Google alone.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, cleanupAll } = require('./helpers');

afterAll(async () => { await cleanupAll(); await closeDB(); });
beforeAll(async () => { await connectDB(); });

describe('GET / — the sign-in page offers Google only', () => {
  let html;
  beforeAll(async () => { html = (await request(app).get('/')).text; });

  test('no email field, no password field, no Remember-me checkbox, no password-form submit button', () => {
    expect(html).not.toContain('id="username"');
    expect(html).not.toContain('id="password-input"');
    expect(html).not.toContain('Email Address');
    expect(html).not.toContain('auth-remember-check');
    expect(html).not.toContain('Remember me');
    expect(html).not.toMatch(/type="submit"[^>]*>\s*Sign In\s*</);
    expect(html).not.toContain('action="/login"'); // no form posts to /login from this page anymore
  });

  test('the Google sign-in button is present and still points at the real OAuth initiation route', () => {
    expect(html).toContain('Sign in with Google');
    expect(html).toContain("window.location.href='/auth/google'");
  });

  test('branding, title, and layout/theme scaffolding are unchanged', () => {
    expect(html).toContain('<title>Sign In | CIPRMS - CSPC-CIRL</title>');
    expect(html).toContain('CSPC Center for International Relations and Linkages');
    expect(html).toContain('data-layout="vertical"');
    expect(html).toContain('cirl-logo.jpg');
  });

  test('an error message (e.g. from a blocked or failed sign-in) still renders correctly with no empty/broken form left behind', async () => {
    const res = await request(app).post('/login').type('form').send({ username: 'nobody@example.com', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('alert-danger');
    expect(res.text).toContain('Invalid email or password.');
    // The re-rendered error page is the exact same Google-only page, not a stale/different template.
    expect(res.text).toContain('Sign in with Google');
    expect(res.text).not.toContain('id="username"');
  });
});

describe('POST /login — unchanged, still reachable (not UI-linked, but not removed)', () => {
  test('a correct password still signs a real account in normally', async () => {
    const user = await createTestUser({ role: 'Administrator' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.status).toBe(302);
  });
});

// Centered branding composition + About Us (2026-11 UI enhancement) — brand/logo/system-title/
// institutional-name, and a 5-member team modal with real, verified names from the capstone manuscript on
// file (see the chat response for the verification trail: package.json's "author", git log, and the
// manuscript's own title page). No internal user data, credentials, or configuration is ever in this
// section — it is static project/team information baked into the template, not read from any database.
describe('GET / — centered branding composition and About Us', () => {
  let html;
  beforeAll(async () => { html = (await request(app).get('/')).text; });

  test('the full system name/acronym and institutional office name are both present, alongside the logo', () => {
    expect(html).toContain('>CIPRMS<');
    expect(html).toContain('Centralized Institutional Partnership Registry and Management System');
    expect(html).toContain('CSPC Center for International Relations and Linkages');
    expect(html).toContain('cirl-logo.jpg');
    expect(html).toContain('auth-brand-logo'); // the larger logo treatment, not the old plain <img height="40">
  });

  test('About Us is a real trigger for the modal, not a dead link, and sits above the footer', () => {
    expect(html).toContain('data-bs-toggle="modal"');
    expect(html).toContain('data-bs-target="#about-modal"');
    expect(html).toMatch(/about-us-trigger[^]*?About Us/);
    expect(html.indexOf('about-us-trigger')).toBeLessThan(html.indexOf('<footer'));
  });

  test('the About Us modal is a standard Bootstrap modal (Escape/backdrop-click both close it by default) with a visible close control', () => {
    const modalStart = html.indexOf('id="about-modal"');
    expect(modalStart).toBeGreaterThan(-1);
    const modalBlock = html.slice(modalStart, modalStart + 6000);
    expect(modalBlock).not.toContain('data-bs-backdrop="static"');
    expect(modalBlock).not.toContain('data-bs-keyboard="false"');
    expect(modalBlock).toContain('btn-close');
  });

  test('all five real, verified team members are listed with a consistent structure (name, role, contribution)', () => {
    const names = ['Joshua B. Baliber', 'Lui Vhinz Dominic P. Briñas', 'John Raven M. Ferrer', 'Begie B. Golpe', 'Zyra Devie D. Malto'];
    names.forEach((name) => expect(html).toContain(name));
    // Same role label and same number of "Project Proponent" occurrences as names — no entry singled out
    // with different structure/formatting.
    expect(html.match(/Project Proponent, Team Dunbar/g)).toHaveLength(names.length);
    expect(html).toContain('Team Dunbar');
  });

  test('the project title, institution, office, purpose, and academic context all appear in the modal', () => {
    expect(html).toContain('Centralized Institutional Partnership Registry and Management System with Decision Support Analytics for CSPC');
    expect(html).toContain('Camarines Sur Polytechnic Colleges (CSPC)');
    expect(html).toContain('Center for International Relations and Linkages (CIRL)');
    expect(html).toContain('capstone project');
  });

  test('never exposes internal user data, credentials, e-mail addresses, or configuration in the About Us content', () => {
    const modalStart = html.indexOf('id="about-modal"');
    const modalBlock = html.slice(modalStart, html.indexOf('</body>'));
    expect(modalBlock).not.toMatch(/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i); // no real e-mail-shaped text at all
    expect(modalBlock).not.toMatch(/password|MONGO_URI|GOOGLE_CLIENT_SECRET|SESSION_SECRET/i);
  });
});
