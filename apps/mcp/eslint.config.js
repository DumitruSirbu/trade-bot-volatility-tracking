import rootConfig from '../../eslint.config.js';

// Node runtime globals — `apps/mcp` is a plain Node process (no NestJS DI).
// stdio transport reads stdin/writes stdout; we log to stderr via `process`.
const NODE_GLOBALS = {
    process: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    NodeJS: 'readonly',
    globalThis: 'readonly',
};

// Jest globals — only injected into spec runtimes.
const JEST_GLOBALS = {
    describe: 'readonly',
    it: 'readonly',
    test: 'readonly',
    expect: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
    jest: 'readonly',
};

export default [
    ...rootConfig,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            globals: { ...NODE_GLOBALS },
        },
    },
    {
        files: ['src/**/__tests__/**/*.ts', 'src/**/*.spec.ts'],
        languageOptions: {
            globals: { ...NODE_GLOBALS, ...JEST_GLOBALS },
        },
    },
];
