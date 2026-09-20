module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  setupFiles: ['<rootDir>/test/setup-env.js'],
  testPathIgnorePatterns: ['/node_modules/', '/_REDUNDANT_BACKUP/']
};
