import globals from 'globals';
import rootConfig from '../../eslint.config.js';

export default [
    ...rootConfig,
    {
        files: ['vitest.config.ts', 'vite.config.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2023,
                // DOM Fetch API types not included in globals.browser — TS already
                // type-checks these; we only need to suppress no-undef for eslint.
                RequestInit: 'readonly',
            },
            parserOptions: {
                ecmaVersion: 2023,
                sourceType: 'module',
                ecmaFeatures: { jsx: true },
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
];
