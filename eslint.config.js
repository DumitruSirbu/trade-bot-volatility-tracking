import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

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
        ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/coverage/**'],
    },
    prettierConfig,
];
