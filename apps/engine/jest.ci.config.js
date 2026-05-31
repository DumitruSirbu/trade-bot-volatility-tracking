/** @type {import('ts-jest').JestConfigWithTsJest} */
// Lightweight config for CI-only pure-unit tests (tests/ci/**).
// No globalSetup/globalTeardown — these suites have no DB dependency.
export default {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    roots: ['<rootDir>/tests/ci'],
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    },
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@bot/shared$': '<rootDir>/../../packages/shared/src/index.ts',
        '^(\\.{1,2}/.+)\\.js$': '$1',
    },
};
