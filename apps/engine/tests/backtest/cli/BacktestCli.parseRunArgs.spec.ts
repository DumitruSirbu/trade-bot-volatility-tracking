// M12 W6 fix wave 4b — paired test for the BacktestCli raw-`Error` removal.
//
// `parseRunArgs` previously threw `new Error(...)`. Per code-conventions raw
// `Error` is forbidden; the fix introduces a local `BacktestCliArgError`. We
// can't directly import the private class (intentionally local to the CLI
// boundary), so we assert the `.name` discriminator instead — that's the
// canonical signal used by the global filter to identify CLI-arg errors vs
// runtime ones.

import { parseRunArgs, runBacktestCli, BACKTEST_CLI_EXIT_BAD_ARGS } from '../../../src/backtest/cli/BacktestCli';

describe('BacktestCli.parseRunArgs argv errors', () => {
    it('throws a typed BacktestCliArgError (not a raw Error) when --version is missing', () => {
        let caught: unknown;
        try {
            parseRunArgs([]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).name).toBe('BacktestCliArgError');
        expect((caught as Error).message).toMatch(/--version/);
    });

    it('throws BacktestCliArgError when --version is non-positive', () => {
        let caught: unknown;
        try {
            parseRunArgs(['--version', '0', '--from', '2026-01-01', '--to', '2026-01-02', '--output', '/tmp/x']);
        } catch (err) {
            caught = err;
        }
        expect((caught as Error).name).toBe('BacktestCliArgError');
    });

    it('throws BacktestCliArgError when --from is missing or malformed', () => {
        let caught: unknown;
        try {
            parseRunArgs(['--version', '1', '--to', '2026-01-02', '--output', '/tmp/x']);
        } catch (err) {
            caught = err;
        }
        expect((caught as Error).name).toBe('BacktestCliArgError');
    });

    it('throws BacktestCliArgError when --to is missing or malformed', () => {
        let caught: unknown;
        try {
            parseRunArgs(['--version', '1', '--from', '2026-01-01', '--output', '/tmp/x']);
        } catch (err) {
            caught = err;
        }
        expect((caught as Error).name).toBe('BacktestCliArgError');
    });

    it('throws BacktestCliArgError when --output is missing', () => {
        let caught: unknown;
        try {
            parseRunArgs(['--version', '1', '--from', '2026-01-01', '--to', '2026-01-02']);
        } catch (err) {
            caught = err;
        }
        expect((caught as Error).name).toBe('BacktestCliArgError');
    });

    it('writes unknown-subcommand diagnostics to stderr (not stdout) and exits with BAD_ARGS', async () => {
        // why: stdout is reserved for the MCP side-channel; all CLI
        // diagnostics must funnel through stderr so the spawner's tail+
        // redact pipeline sees them. Previously the unknown-subcommand
        // branch used `console.error` — Node prints `console.error` to
        // stderr but the convention bans the bare call.
        const originalStderr = process.stderr.write.bind(process.stderr);
        const originalStdout = process.stdout.write.bind(process.stdout);
        let stderrCaptured = '';
        let stdoutCaptured = '';

        (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
            stderrCaptured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
            return true;
        }) as typeof process.stderr.write;
        (process.stdout.write as unknown) = ((chunk: string | Uint8Array) => {
            stdoutCaptured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
            return true;
        }) as typeof process.stdout.write;

        try {
            const code = await runBacktestCli(['bogus-subcommand']);
            expect(code).toBe(BACKTEST_CLI_EXIT_BAD_ARGS);
            expect(stderrCaptured).toMatch(/backtest: missing or unknown subcommand 'bogus-subcommand'/);
            expect(stdoutCaptured).toBe('');
        } finally {
            (process.stderr.write as unknown) = originalStderr;
            (process.stdout.write as unknown) = originalStdout;
        }
    });
});
