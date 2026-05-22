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
    moduleNameMapper: {
        '^@bot/shared$': '<rootDir>/../../packages/shared/src/index.ts',
        // The shared package uses ESM-style `.js` extension imports internally.
        // Jest (CommonJS mode) cannot resolve `.js` to `.ts`, so we strip the
        // extension and let the TypeScript resolver find the `.ts` source file.
        '^(\\.{1,2}/.+)\\.js$': '$1',
    },
};
