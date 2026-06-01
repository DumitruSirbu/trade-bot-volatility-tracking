/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    roots: ['<rootDir>/src', '<rootDir>/tests'],
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    },
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
    coverageDirectory: '<rootDir>/coverage',
    testEnvironment: 'node',
    // DB integration tests share a single integration schema on `trade_bot_test`
    // (the dedicated port-6900 test container).  Running them in parallel across
    // Jest workers causes races (one worker reverts migrations while another tries
    // to use the schema).  maxWorkers=1 serialises all suites so DB suites execute
    // one at a time without conflicting on the shared integration schema.
    maxWorkers: 1,
    // Loads .env.test before any suite runs, asserts TEST_DATABASE_URL points at the
    // port-6900 test DB, and pre-migrates the shared integration schema.
    // See tests/support/globalSetup.ts.
    globalSetup: '<rootDir>/tests/support/globalSetup.ts',
    // Destroys the shared DataSource after all suites complete so the process exits cleanly.
    globalTeardown: '<rootDir>/tests/support/globalTeardown.ts',
    moduleNameMapper: {
        '^@bot/shared$': '<rootDir>/../../packages/shared/src/index.ts',
        // The shared package uses ESM-style `.js` extension imports internally.
        // Jest (CommonJS mode) cannot resolve `.js` to `.ts`, so we strip the
        // extension and let the TypeScript resolver find the `.ts` source file.
        '^(\\.{1,2}/.+)\\.js$': '$1',
    },
};
