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
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    NodeJS: 'readonly',
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
            // M11a R2a Item 5C (ADR 0032 §3 D14). CI gate against the
            // `ModuleRef.get(IExchangeClient)` / `forwardRef` / `useFactory(injector)`
            // escape hatches the static module-graph walk cannot see. Allow-listed
            // files are exempted via the override block below. The runtime
            // AsyncLocalStorage capability guard is the third layer of defence;
            // the lint rule keeps these strings from creeping into new code at
            // all.
            // R2a-fix-wave-2 Item 2: `EXCHANGE_CLIENT` is a Symbol identifier
            // (not a string literal), so call sites use `@Inject(EXCHANGE_CLIENT)`
            // with an AST `Identifier` node, not a `Literal`. The previous
            // `arguments.0.value=...` selectors never fired. Match the Identifier
            // name directly.
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.property.name='get'][arguments.0.type='Identifier'][arguments.0.name='EXCHANGE_CLIENT']",
                    message:
                        'Account-state reads must inject IAccountStateSource (ACCOUNT_STATE_SOURCE); order commands must inject IExecutionClient (EXECUTION_CLIENT or ENGINE_EXECUTION_CLIENT); only EXCHANGE_CLIENT for connection/market-data is allowed in the listed module paths. See ADR 0032 §3 D14.',
                },
                {
                    selector:
                        "Decorator[expression.type='CallExpression'][expression.callee.name='Inject'][expression.arguments.0.type='Identifier'][expression.arguments.0.name='EXCHANGE_CLIENT']",
                    message:
                        'Account-state reads must inject IAccountStateSource (ACCOUNT_STATE_SOURCE); order commands must inject IExecutionClient (EXECUTION_CLIENT or ENGINE_EXECUTION_CLIENT); only EXCHANGE_CLIENT for connection/market-data is allowed in the listed module paths. See ADR 0032 §3 D14.',
                },
            ],
        },
    },
    {
        // M11a R2a Item 5C — D14 whitelist for the no-restricted-syntax rule
        // above. Only these files may resolve / inject EXCHANGE_CLIENT
        // directly. New entries require an architect adjudication.
        //
        // R2a fix-wave Item 5 (security R2a): the `paper-mode/**` glob was
        // dropped — too wide. The only legitimate future caller from the
        // PAPER tree is the D13 `PaperExchangeNullityProbe`; until that
        // file exists, NO paper-mode file is whitelisted to inject
        // EXCHANGE_CLIENT. `ReconciliationService` no longer needs the
        // allowlist either (BLOCKER B1: rebound to `IAccountStateSource`).
        // M11a R4 BLOCKER fix: extended to include market-data + execution
        // modules. Those callers consume EXCHANGE_CLIENT for connection +
        // market-data (NOT account-state), which is permitted per the rule
        // message above. Without the allowlist the rule fires on 5 legitimate
        // callers (MarketDataService, UniverseService, FlowPollService,
        // DepthAggressorService, ExecutionService) and breaks `pnpm lint`.
        files: [
            'src/bootstrap/KeyPermissionAssertionService.ts',
            'src/exchange/**',
            'src/market-data/**/*.ts',
            'src/execution/**/*.ts',
            'src/paper-mode/security/PaperExchangeNullityProbe.ts',
        ],
        rules: {
            'no-restricted-syntax': 'off',
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
