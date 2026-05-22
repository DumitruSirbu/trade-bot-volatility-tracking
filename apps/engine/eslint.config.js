import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import rootConfig from '../../eslint.config.js';

// Node runtime globals the engine relies on (CLI datasource, path helpers).
const NODE_GLOBALS = {
    process: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    module: 'readonly',
    require: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
};

// Jest injects these into the spec runtime; declare them so test files lint clean.
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

// The engine wires a tsconfig project so the type-aware rules the root config
// deliberately omits (it stays type-info-free to stay cheap) can be enabled here.
export default [
    ...rootConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsparser,
            globals: {
                ...NODE_GLOBALS,
            },
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['**/*.spec.ts', '**/__tests__/**/*.ts', 'test/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            globals: {
                ...JEST_GLOBALS,
            },
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    },
];
