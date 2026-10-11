module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  setupFiles: ['<rootDir>/test/setup-env.js'],
  // test/e2e holds @playwright/test specs (run via `npm run test:e2e`, see playwright.config.js) — Jest's
  // own default testMatch would otherwise also pick up *.spec.js files there and fail trying to run them
  // under Jest's APIs instead of Playwright's.
  testPathIgnorePatterns: ['/node_modules/', '/_REDUNDANT_BACKUP/', '/test/e2e/']
};
