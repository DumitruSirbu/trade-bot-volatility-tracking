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

// Agent boundary patterns (ADR 0035 §2.3 layer B). Banned from apps/agent/**.
// Layer A (workspace dependency graph — apps/agent/package.json omits
// @bot/engine, @bot/analysis, @bot/mcp) is the load-bearing guarantee; this
// lint rule catches the dynamic-require / path-hack case before tsc would.
// The agent reaches MCP as a network client over HTTP only (ADR 0038); reads
// shared DTOs from @bot/shared.
const AGENT_BANNED_IMPORT_PATTERNS = [
    {
        group: [
            '@bot/engine',
            '@bot/engine/*',
            '@bot/analysis',
            '@bot/analysis/*',
            '@bot/mcp',
            '@bot/mcp/*',
        ],
        message:
            'apps/agent MUST NOT import @bot/engine, @bot/analysis, or @bot/mcp (ADR 0035 §2.2). The agent talks to MCP as a network client only — re-route through @bot/shared for shared DTOs / Zod schemas.',
    },
    {
        group: [
            'apps/engine',
            'apps/engine/*',
            '**/apps/engine/**',
            'apps/mcp',
            'apps/mcp/*',
            '**/apps/mcp/**',
            'packages/analysis',
            'packages/analysis/*',
            '**/packages/analysis/**',
            '../engine',
            '../engine/*',
            '../mcp',
            '../mcp/*',
            '../analysis',
            '../analysis/*',
            '../../engine/*',
            '../../mcp/*',
            '../../analysis/*',
            '../../../engine/*',
            '../../../mcp/*',
            '../../../analysis/*',
            '../../apps/engine/*',
            '../../apps/mcp/*',
            '../../packages/analysis/*',
        ],
        message:
            'Deep relative reach into apps/engine, apps/mcp, or packages/analysis is banned from apps/agent (ADR 0035 §2.2 / §2.3 layer B).',
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
        // ADR 0035 §2.3 layer B — agent boundary lint rule. Scoped tightly to
        // apps/agent/**; the agent reaches MCP as a network client only.
        files: ['apps/agent/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': ['error', { patterns: AGENT_BANNED_IMPORT_PATTERNS }],
        },
    },
    {
        // ADR 0035 §2.4 — boundary test fixtures intentionally import banned
        // symbols to verify the rule fires. Exempt the test tree from the
        // restriction (mirrors the mcp/analysis pattern already in place via
        // workspace-dep absence + test exclusion of the tsconfig).
        files: ['apps/agent/tests/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/coverage/**'],
    },
    prettierConfig,
];
