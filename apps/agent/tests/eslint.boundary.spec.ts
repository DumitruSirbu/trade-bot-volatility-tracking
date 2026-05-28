/**
 * M13 W0 — ESLint boundary lint test (ADR 0035 §2.3 layer B).
 *
 * Confirms that `no-restricted-imports` fires for every import that the root
 * `eslint.config.js` bans inside `apps/agent/**`. The fixture source is fed
 * to ESLint via `--stdin --stdin-filename apps/agent/src/fake.ts`, which
 * makes ESLint apply the rule configured for the `apps/agent/**` glob without
 * the `apps/agent/tests/**` exemption. This is a pure-Node test — no real
 * files are written; ESLint reads from stdin.
 *
 * Three banned imports are asserted independently so a single rule omission
 * fails a precise test rather than a compound one.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Four levels up from apps/agent/tests/ to the repo root.
const REPO_ROOT = resolve(__dirname, '../../..');
const ESLINT_BIN = resolve(REPO_ROOT, 'node_modules/.bin/eslint');

interface EslintResult {
    exitCode: number;
    output: string;
}

/**
 * Runs ESLint against an inline `source` string as if it lived at
 * `virtualPath` (relative to the repo root).
 */
function runEslintOnStdin(source: string, virtualFilename: string): EslintResult {
    let output = '';
    let exitCode = 0;

    try {
        output = execSync(`echo ${JSON.stringify(source)} | "${ESLINT_BIN}" --stdin --stdin-filename "${virtualFilename}"`, {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        const spawnErr = err as { status?: number; stdout?: string; stderr?: string };
        exitCode = spawnErr.status ?? 1;
        output = (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '');
    }

    return { exitCode, output };
}

// Virtual path inside apps/agent/src/ — matches the rule glob but NOT the
// tests/** exemption, so the no-restricted-imports rule fires.
const VIRTUAL_AGENT_SRC = 'apps/agent/src/fake.ts';

describe('ESLint boundary — apps/agent no-restricted-imports (ADR 0035 §2.3)', () => {
    it('import from @bot/engine triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import x from '@bot/engine';", VIRTUAL_AGENT_SRC);

        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/@bot\/engine/);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('import from @bot/analysis triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import y from '@bot/analysis';", VIRTUAL_AGENT_SRC);

        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/@bot\/analysis/);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('import from @bot/mcp triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import z from '@bot/mcp';", VIRTUAL_AGENT_SRC);

        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/@bot\/mcp/);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('all three banned imports in one file each trigger a violation', () => {
        const source = ["import x from '@bot/engine';", "import y from '@bot/analysis';", "import z from '@bot/mcp';"].join(' ');

        const { exitCode, output } = runEslintOnStdin(source, VIRTUAL_AGENT_SRC);

        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/@bot\/engine/);
        expect(output).toMatch(/@bot\/analysis/);
        expect(output).toMatch(/@bot\/mcp/);
    });

    // M13 W6 fix wave 2 (#5): the AGENT_BANNED_IMPORT_PATTERNS list in
    // `eslint.config.js` includes relative-path reach-arounds (e.g. `../mcp/x`,
    // `../../apps/mcp/...`). Without explicit tests for those, a regression
    // that drops a pattern from the list would slip through.
    it('relative reach `../mcp/x` triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import x from '../mcp/x';", VIRTUAL_AGENT_SRC);
        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('relative reach `../../apps/mcp/x` triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import x from '../../apps/mcp/x';", VIRTUAL_AGENT_SRC);
        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('relative reach `../../packages/analysis/x` triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import x from '../../packages/analysis/x';", VIRTUAL_AGENT_SRC);
        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('relative reach `../../engine/x` triggers a no-restricted-imports violation', () => {
        const { exitCode, output } = runEslintOnStdin("import x from '../../engine/x';", VIRTUAL_AGENT_SRC);
        expect(exitCode).not.toBe(0);
        expect(output).toMatch(/no-restricted-imports/);
    });

    it('a clean import from @bot/shared does NOT trigger no-restricted-imports', () => {
        // @bot/shared is the one allowed cross-workspace dep — it must not be blocked.
        const { output } = runEslintOnStdin("import { IOrder } from '@bot/shared';", VIRTUAL_AGENT_SRC);

        // The no-restricted-imports rule must not mention @bot/shared.
        expect(output).not.toMatch(/no-restricted-imports.*@bot\/shared/);
        expect(output).not.toMatch(/@bot\/shared.*no-restricted-imports/);
    });
});
