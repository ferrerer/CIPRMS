// Separate Playwright config for specs that exercise page-level JavaScript (template functions extracted
// from a real .ejs file's <script> block) entirely offline, with no server and no database. The project's
// main playwright.config.js unconditionally starts `node cirl.js` against the real, shared MONGO_URI for
// every spec under test/e2e — appropriate for specs that need a real logged-in session (e.g.
// lifecycle-xss.spec.js), but wrong for a spec whose whole point is to never touch the database (2026-11
// Phase 3's explicit "no writes to the production database" requirement). Run with:
//   npx playwright test --config=test/e2e/playwright.nodb.config.js
// Add a spec here only if it never calls page.goto() against the app server — anything that needs a real
// route/session belongs under the main config instead.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['documents-library-xss.spec.js'],
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']]
  // Deliberately no `webServer` and no `use.baseURL` — these specs never navigate to a real URL.
});
