// Loaded by Jest before every test file (jest.config.js -> setupFiles).
//
// The suites run against the REAL shared database, and several of them used to
// `deleteMany({})` the real `googleCalendarIntegration` collection to get a
// clean "not connected" state — which wiped the organization's actual Google
// Calendar connection (its stored refresh token) every time `npm test` ran,
// silently switching off invitation e-mails until an Administrator reconnected.
// Pointing the service at a throw-away collection for the whole test process
// means no test can ever touch the real connection again.
process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION = 'jesttest_googleCalendarIntegration';
