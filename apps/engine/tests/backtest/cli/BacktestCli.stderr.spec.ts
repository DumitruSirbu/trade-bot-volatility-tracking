// M12 W6 R3 #2 — verifies the CLI emits ONLY a redacted single-line summary
// to stderr by default, and never the underlying NestJS stack trace.
//
// The MCP spawn caller tails+redacts the last 2KB of stderr, but a NestJS
// unhandled-rejection stack easily includes `/Users/...` paths and stringified
// provider state. Defense-in-depth at the SOURCE: don't emit the stack at all
// unless `BACKTEST_CLI_VERBOSE=1`.

import { emitRedactedRunFailure } from '../../../src/backtest/cli/emitRedactedRunFailure';

describe('BacktestCli error redaction (stderr)', () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured: string;

    beforeEach(() => {
        captured = '';
        // jest.spyOn doesn't capture if other writes occur; intercept directly.
        (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
            captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
            return true;
        }) as typeof process.stderr.write;
    });

    afterEach(() => {
        (process.stderr.write as unknown) = originalWrite;
        delete process.env.BACKTEST_CLI_VERBOSE;
    });

    it('emits a single redacted line and no stack frames by default', () => {
        const err = new Error('connect ECONNREFUSED');
        // Synthesise a multi-line Node stack like NestJS would produce. The
        // stack typically embeds absolute filesystem paths, provider names,
        // and node_modules edges. Default behaviour must NOT emit any of it.
        err.stack = [
            'Error: connect ECONNREFUSED',
            '    at Object.<anonymous> (/Users/secret/proj/apps/engine/src/database/dataSource.ts:42:11)',
            '    at /Users/secret/proj/node_modules/@nestjs/core/injector/injector.js:200:33',
        ].join('\n');

        emitRedactedRunFailure(err);

        // One line only. No `/Users/...` paths. No stack frames.
        expect(captured.split('\n').filter((s) => s.length > 0)).toHaveLength(1);
        expect(captured).toMatch(/^backtest run failed: Error: connect ECONNREFUSED/);
        expect(captured).not.toContain('/Users/');
        expect(captured).not.toContain('at Object');
        expect(captured).not.toContain('node_modules');
    });

    it('truncates very long error messages to 200 chars + ellipsis', () => {
        const huge = 'x'.repeat(500);
        emitRedactedRunFailure(new Error(huge));

        // Single line, ends with `...`. The summary prefix (`backtest run
        // failed: Error: `) plus 200 chars of message plus `...\n` is the
        // hard upper bound.
        expect(captured.endsWith('...\n')).toBe(true);
        expect(captured.length).toBeLessThan('backtest run failed: Error: '.length + 200 + 5);
    });

    it('handles non-Error throws without crashing (e.g. throw "string")', () => {
        emitRedactedRunFailure('plain string thrown');
        // Falls back to `Error` as the name, message is the stringified throw.
        expect(captured).toMatch(/backtest run failed: Error: plain string thrown/);
    });

    it('emits the full stack ONLY when BACKTEST_CLI_VERBOSE=1', () => {
        const err = new Error('boom');
        err.stack = 'Error: boom\n    at /Users/secret/path/x.ts:1:1';

        process.env.BACKTEST_CLI_VERBOSE = '1';
        emitRedactedRunFailure(err);

        expect(captured).toContain('backtest run failed: Error: boom');
        expect(captured).toContain('/Users/secret/path/x.ts');
    });

    it('does not emit the stack when BACKTEST_CLI_VERBOSE is unset or 0', () => {
        const err = new Error('boom');
        err.stack = 'Error: boom\n    at /Users/secret/path/x.ts:1:1';

        process.env.BACKTEST_CLI_VERBOSE = '0';
        emitRedactedRunFailure(err);

        expect(captured).not.toContain('/Users/secret');
    });
});
