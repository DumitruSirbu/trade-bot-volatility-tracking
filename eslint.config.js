import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

// MCP boundary patterns (ADR 0033 §2.4 layer B). Banned from apps/mcp/** and
// packages/analysis/**. Layer A (workspace dependency graph) is the
// load-bearing guarantee; this lint rule catches the dynamic-require / path-
// hack case before tsc would.
const MCP_BANNED_IMPORT_PATTERNS = [
    {
        group: ['@bot/engine', '@bot/engine/*'],
        message:
            'apps/mcp and packages/analysis MUST NOT import @bot/engine (ADR 0033 §2.2). The MCP boundary is structural — re-route through @bot/shared or @bot/analysis.',
    },
    {
        group: [
            'apps/engine',
            'apps/engine/*',
            '**/apps/engine/**',
            '../engine',
            '../engine/*',
            '../../engine/*',
            '../../../engine/*',
            '../../apps/engine/*',
        ],
        message:
            'Deep relative reach into apps/engine is banned from apps/mcp and packages/analysis (ADR 0033 §2.2 / §2.4 layer B).',
    },
];

export default [
    js.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 2023,
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
            prettier,
        },
        rules: {
            ...tseslint.configs.recommended.rules,
            '@typescript-eslint/no-explicit-any': 'off',
            // `no-floating-promises` and `no-unsafe-argument` are type-aware rules.
            // Enable them in the engine app's own eslint config where a tsconfig
            // project is wired in. This root config stays type-info-free to keep it cheap.
            'import/no-extraneous-dependencies': 'off',
            'prettier/prettier': 'error',
            'no-console': ['warn', { allow: ['warn', 'error'] }],
        },
    },
    {
        // ADR 0033 §2.4 layer B — boundary lint rule. Scoped tightly to the
        // two locations that must not reach into the engine; the engine itself
        // and the dashboard are unaffected.
        files: ['apps/mcp/**/*.{ts,tsx}', 'packages/analysis/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': ['error', { patterns: MCP_BANNED_IMPORT_PATTERNS }],
        },
    },
    {
        ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/coverage/**'],
    },
    prettierConfig,
];
