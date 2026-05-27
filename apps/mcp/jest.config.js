/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    roots: ['<rootDir>/src', '<rootDir>/tests'],
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                    esModuleInterop: true,
                    target: 'ES2023',
                    strict: true,
                    types: ['jest', 'node'],
                },
            },
        ],
    },
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@bot/shared$': '<rootDir>/../../packages/shared/src/index.ts',
        '^@bot/analysis$': '<rootDir>/../../packages/analysis/src/index.ts',
        // Strip ESM-style `.js` extensions so ts-jest (CommonJS) resolves
        // sibling .ts files. Mirrors the @bot/analysis jest config.
        '^(\\.{1,2}/.+)\\.js$': '$1',
    },
};
