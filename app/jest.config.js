/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo/ios',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 5000,
};
