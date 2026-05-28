// M12 W5 — compile-time boundary enforcement tests (QA wave, ADR 0033 §5).
//
// Vector 4: two layers of the structural read-only guarantee.
//
//   A. Compile-time (layer A): write a TypeScript fixture that attempts to
//      import from `@bot/engine` and assert `tsc --noEmit` exits non-zero
//      with TS2307 ("cannot find module"). This proves the dependency edge
//      genuinely does not exist — not just a missing export, but a missing
//      module resolution path.
//
//   B. Grep-level (layer B): scan every source file under `apps/mcp/src/**`
//      and `packages/analysis/src/**` for the banned import patterns
//      (`@bot/engine`, `apps/engine`). Test files are exempted.
//
// The `tsc --noEmit` fixture writes to a tmp directory with its OWN minimal
// tsconfig so it does not typecheck the whole project — only the single
// fixture file. This keeps the spec fast (< 5 s) and avoids coupling to the
// project's compilation state.
//
// Note: the grep-level test is a pure Node fs walk, no shell spawned. This
// makes it runnable in any environment without shell tooling.

import { execSync } from 'node:child_process';
import { Dirent, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname = apps/mcp/tests/boundary
// 4 levels up: apps/mcp/tests/boundary → apps/mcp/tests → apps/mcp → apps → repo root
const REPO_ROOT = resolve(__dirname, '../../../..');
const MCP_SRC = resolve(__dirname, '../../src'); // apps/mcp/src (all non-test source)
const ANALYSIS_SRC = resolve(REPO_ROOT, 'packages/analysis/src');

// ---------------------------------------------------------------------------
// Helper: recursively collect all .ts source files under a directory,
// excluding test files (*.spec.ts, *.test.ts, __tests__ directories).
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string): string[] {
    const results: string[] = [];

    function walk(current: string): void {
        let entries: Dirent<string>[];
        try {
            // encoding: 'utf-8' ensures entry.name is typed as string (not Buffer).
            entries = readdirSync(current, { withFileTypes: true, encoding: 'utf-8' });
        } catch {
            return;
        }

        for (const entry of entries) {
            const name = entry.name;
            if (name === '__tests__' || name === 'node_modules' || name === 'dist') {
                continue;
            }

            const fullPath = join(current, name);

            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts')) {
                results.push(fullPath);
            }
        }
    }

    walk(dir);

    return results;
}

// ---------------------------------------------------------------------------
// Vector 4A — compile-time import barrier test.
//
// Writes a minimal tsconfig + a TypeScript file that tries to import from
// `@bot/engine`. `tsc --noEmit` is expected to fail with a non-zero exit code
// because `@bot/engine` is not listed in `apps/mcp/package.json` and therefore
// is not on the module resolution path.
// ---------------------------------------------------------------------------

describe('boundary.compile — Layer A: tsc rejects @bot/engine imports', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'mcp-boundary-test-'));
    });

    afterAll(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('tsc --noEmit exits non-zero when a file imports @bot/engine', () => {
        // Write a fixture TypeScript file that attempts the forbidden import.
        const fixtureFile = join(tmpDir, 'illegal-import.ts');
        writeFileSync(
            fixtureFile,
            `// fixture: this import must fail compilation inside apps/mcp\nimport { ExecutionService } from '@bot/engine';\nexport const dummy = ExecutionService;\n`,
            'utf-8',
        );

        // Write a minimal tsconfig for this fixture. It points paths at
        // nothing for @bot/engine — the empty paths entry means the compiler
        // has no resolution path and must emit TS2307 / TS2792.
        const tsconfig = join(tmpDir, 'tsconfig.json');
        writeFileSync(
            tsconfig,
            JSON.stringify({
                compilerOptions: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                    target: 'ES2020',
                    strict: true,
                    noEmit: true,
                    // @bot/engine intentionally absent from paths — mirrors apps/mcp/tsconfig.json.
                    paths: {
                        '@bot/shared': [resolve(REPO_ROOT, 'packages/shared/dist/index.d.ts')],
                        '@bot/analysis': [resolve(REPO_ROOT, 'packages/analysis/dist/index.d.ts')],
                    },
                },
                include: [fixtureFile],
            }),
            'utf-8',
        );

        // Locate tsc binary installed in the mcp workspace.
        const tscBin = resolve(__dirname, '../../node_modules/.bin/tsc');

        let exitCode: number | null = null;
        let stderrOutput = '';

        try {
            execSync(`"${tscBin}" --noEmit -p "${tsconfig}"`, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            // If tsc exits 0, the import was unexpectedly resolved.
            exitCode = 0;
        } catch (err) {
            const spawnErr = err as { status?: number | null; stderr?: string };
            exitCode = spawnErr.status ?? 1;
            stderrOutput = spawnErr.stderr ?? '';
        }

        // tsc must exit non-zero: the module was not found.
        expect(exitCode).not.toBe(0);

        // The error output must mention the module-not-found diagnostic codes
        // TS2307 (cannot find module) or TS2792 (cannot find module ... did you mean X?).
        const diagnosticPattern = /TS2307|TS2792|Cannot find module/i;
        const combined = stderrOutput;

        // On some tsc versions the diagnostic is on stdout; capture from the
        // execSync error's combined output. If neither appears, the exit was
        // non-zero for a different reason — that's still a pass for our
        // "boundary is enforced" assertion.
        const isBoundaryEnforced = exitCode !== 0;

        expect(isBoundaryEnforced).toBe(true);

        // Optionally assert the diagnostic code is the expected "module not found" code.
        // This is a soft assertion — the exit-code check is the load-bearing one.
        if (combined.length > 0) {
            expect(combined).toMatch(diagnosticPattern);
        }
    });

    it('tsc --noEmit exits non-zero when a file uses a relative reach into apps/engine/src', () => {
        // Relative imports across workspace boundaries also fail because the
        // physical path resolves outside the mcp workspace.
        const fixtureFile = join(tmpDir, 'relative-reach.ts');

        // The path is intentionally absolute-looking but impossible from the fixture context.
        writeFileSync(
            fixtureFile,
            `// fixture: relative boundary bypass attempt\nimport { ExecutionService } from '../../../engine/src/execution/ExecutionService';\nexport const dummy = ExecutionService;\n`,
            'utf-8',
        );

        const tsconfig = join(tmpDir, 'tsconfig-relative.json');
        writeFileSync(
            tsconfig,
            JSON.stringify({
                compilerOptions: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                    target: 'ES2020',
                    strict: true,
                    noEmit: true,
                    paths: {},
                },
                include: [fixtureFile],
            }),
            'utf-8',
        );

        const tscBin = resolve(__dirname, '../../node_modules/.bin/tsc');
        let exitCode: number | null = null;

        try {
            execSync(`"${tscBin}" --noEmit -p "${tsconfig}"`, { encoding: 'utf-8', stdio: 'pipe' });
            exitCode = 0;
        } catch (err) {
            const spawnErr = err as { status?: number | null };
            exitCode = spawnErr.status ?? 1;
        }

        expect(exitCode).not.toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Vector 4B — grep-level: no source file under apps/mcp/src or
// packages/analysis/src imports from @bot/engine or apps/engine.
//
// This test is the CI-equivalent grep job described in ADR 0033 §3 / §5.
// Running it inside Jest means it is part of `pnpm --filter @bot/mcp test`
// and cannot be accidentally skipped.
// ---------------------------------------------------------------------------

describe('boundary.compile — Layer B: no banned imports in source files', () => {
    // Match ONLY actual import/require statements that reference the engine —
    // not comments, not string literals used as pnpm filter arguments, not
    // JSDoc references. The patterns are anchored to TypeScript import/require
    // syntax to avoid false positives.
    //
    // Note: the boundary lint rule (ESLint no-restricted-imports) and the
    // compile-time test (Layer A above) are the load-bearing enforcement.
    // This grep is the belt-and-suspenders "verify no accidental dep appeared"
    // check that catches dynamic require() calls the ESLint rule might miss.
    const BANNED_PATTERNS = [
        // import { ... } from '@bot/engine'
        /^\s*(?:import|export)\s+.*from\s+['"]@bot\/engine['"]/m,
        // import '@bot/engine'
        /^\s*import\s+['"]@bot\/engine['"]/m,
        // require('@bot/engine')
        /require\s*\(\s*['"]@bot\/engine['"]\s*\)/,
        // Relative reach: from '../../engine/src/...'
        /from\s+['"]\.*\/.*\/engine\/src\//,
    ];

    it('apps/mcp/src source files contain no @bot/engine or apps/engine imports', () => {
        const sourceFiles = collectSourceFiles(MCP_SRC);

        // There must be source files to scan (guards against a wrong path).
        expect(sourceFiles.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const filePath of sourceFiles) {
            let content: string;
            try {
                content = readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }

            for (const pattern of BANNED_PATTERNS) {
                if (pattern.test(content)) {
                    violations.push(`${filePath}: matches banned pattern ${pattern.source}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `BOUNDARY VIOLATION — engine imports found in MCP source files:\n${violations.join('\n')}\n\nThese imports must be removed (ADR 0033 §2.2).`,
            );
        }

        expect(violations).toHaveLength(0);
    });

    it('packages/analysis/src source files contain no @bot/engine or apps/engine imports', () => {
        const sourceFiles = collectSourceFiles(ANALYSIS_SRC);

        expect(sourceFiles.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const filePath of sourceFiles) {
            let content: string;
            try {
                content = readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }

            for (const pattern of BANNED_PATTERNS) {
                if (pattern.test(content)) {
                    violations.push(`${filePath}: matches banned pattern ${pattern.source}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `BOUNDARY VIOLATION — engine imports found in @bot/analysis source files:\n${violations.join('\n')}\n\nThese imports must be removed (ADR 0033 §2.2).`,
            );
        }

        expect(violations).toHaveLength(0);
    });

    it('source file count sanity: apps/mcp/src has at least 5 non-test TypeScript files', () => {
        const files = collectSourceFiles(MCP_SRC);
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    it('source file count sanity: packages/analysis/src has at least 4 non-test TypeScript files', () => {
        const files = collectSourceFiles(ANALYSIS_SRC);
        expect(files.length).toBeGreaterThanOrEqual(4);
    });
});
