// M12 W4 — adversarial unit tests for the spawn-based `run_backtest` tool.
//
// Tests never spawn a real engine. We inject a fake `spawn` that constructs a
// minimal EventEmitter-based stub child process, lets us control its stderr
// stream, exit code, and timing.

import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import type { IBacktestReport } from '@bot/shared';

import { McpToolErrorKindEnum } from '../../src/errors/McpToolError';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { __test, buildRunBacktestTool, createSingleSlotSemaphore, redactStderrTail } from '../../src/tools/runBacktest.tool';

const FROM = '2026-01-01';
const TO = '2026-01-15';

const SAMPLE_REPORT: IBacktestReport = {
    runLabel: 'test',
    strategyVersionId: 7,
    strategyName: 'v1-reversion',
    strategyVersion: 1,
    fromUtcDate: '2026-01-01',
    toUtcDate: '2026-01-15',
    tradeCount: 4,
    winCount: 2,
    lossCount: 2,
    winRatePct: '50.00',
    grossPnlUsdt: '12.34',
    feesUsdt: '0.10',
    fundingUsdt: '0.00',
    slippageCostUsdt: '0.05',
    netPnlUsdt: '12.19',
    returnPct: '1.219',
    profitFactor: '1.50',
    avgHoldMs: 60000,
    maxDrawdownPct: '0.50',
    maxDrawdownDurationDays: 1,
    sharpeAnnualized: '1.10',
    sortinoAnnualized: '1.50',
    skippedTriggerCount: 0,
    rejectedByGateCount: 0,
    missedLimitFillCount: 0,
    lowFidelityTradeCount: 0,
    equityCurve: [],
    perRegime: [],
    perFlowType: [],
    perSymbol: [],
    trades: [],
};

interface IFakeChild extends EventEmitter {
    stdout: EventEmitter | null;
    stderr: EventEmitter & { setEncoding: (enc: string) => void };
    kill: jest.Mock;
}

function makeFakeChild(): IFakeChild {
    const stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() }) as IFakeChild['stderr'];
    const child = new EventEmitter() as IFakeChild;
    child.stdout = new EventEmitter();
    child.stderr = stderr;
    child.kill = jest.fn();
    return child;
}

// Build a fresh tool/registry pair per test for isolation. We always pass a
// fresh semaphore so concurrency state never leaks across tests.
function newToolWithSpawn(spawn: jest.Mock): { registry: ToolRegistry; sema: ReturnType<typeof createSingleSlotSemaphore> } {
    const sema = createSingleSlotSemaphore();
    const registry = new ToolRegistry();
    registry.registerReadOnlyTool(buildRunBacktestTool({ spawn: spawn as unknown as typeof import('node:child_process').spawn, semaphore: sema }));
    return { registry, sema };
}

describe('run_backtest tool — happy path', () => {
    it('parses the output JSON and returns the IBacktestReport on exit code 0', async () => {
        const child = makeFakeChild();
        const spawn = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            const outputIdx = args.indexOf('--output');
            const outputPath = args[outputIdx + 1];
            // Schedule the child to "succeed": write report, exit 0.
            setImmediate(() => {
                writeFileSync(outputPath, JSON.stringify(SAMPLE_REPORT), 'utf-8');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        const result = await registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });

        expect(result).toMatchObject({
            runLabel: 'test',
            strategyVersionId: 7,
            netPnlUsdt: '12.19',
        });

        // Spawn invocation surface assertions: pnpm + correct flags + no shell.
        expect(spawn).toHaveBeenCalledTimes(1);
        const [cmd, argv, opts] = spawn.mock.calls[0];
        expect(cmd).toBe('pnpm');
        expect(argv.slice(0, 4)).toEqual(['--filter', '@bot/engine', 'backtest', 'run']);
        expect(argv).toContain('--version');
        expect(argv).toContain('7');
        expect(argv).toContain('--from');
        expect(argv).toContain('2026-01-01');
        expect(argv).toContain('--to');
        expect(argv).toContain('2026-01-15');
        expect(opts.shell).toBe(false);
        // Env allowlist: only the 4 keys (and only those present in process.env).
        const envKeys = Object.keys(opts.env);
        for (const key of envKeys) {
            expect(['PATH', 'HOME', 'DATABASE_URL', 'NODE_ENV']).toContain(key);
        }
    });
});

describe('run_backtest tool — failure paths', () => {
    it('exit code non-zero → INTERNAL with redacted stderr tail in cause', async () => {
        const child = makeFakeChild();
        const spawn = jest.fn().mockImplementation(() => {
            setImmediate(() => {
                child.stderr.emit('data', 'connecting to postgres://user:s3cret@10.0.0.1:5432/db\nBearer abc.def.ghi\nfatal: oh no\n');
                child.emit('close', 2, null);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        try {
            await registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });
            throw new Error('expected throw');
        } catch (err) {
            const e = err as { kind: string; message: string; getInternalCause: () => unknown };
            expect(e.kind).toBe(McpToolErrorKindEnum.INTERNAL);
            expect(e.message).toMatch(/exit code 2/);
            const cause = e.getInternalCause() as { stderrTail: string };
            // Redaction assertions
            expect(cause.stderrTail).not.toContain('s3cret');
            expect(cause.stderrTail).not.toContain('abc.def.ghi');
            expect(cause.stderrTail).not.toContain('10.0.0.1');
            expect(cause.stderrTail).toContain('[REDACTED');
        }
    });

    it('wallclock timeout → TIMEOUT and SIGTERM sent', async () => {
        jest.useFakeTimers();
        try {
            const child = makeFakeChild();
            // Spawn never emits 'close' on its own. The wallclock timer should
            // fire SIGTERM; in this test we also have the child emit 'close'
            // after SIGTERM so the promise resolves to a TIMEOUT rejection.
            child.kill.mockImplementation(() => {
                setImmediate(() => child.emit('close', null, 'SIGTERM'));
                return true;
            });

            const spawn = jest.fn().mockReturnValue(child);
            const { registry } = newToolWithSpawn(spawn);

            const pending = registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });
            const settled = pending.catch((e) => e as Error & { kind?: string });

            // Advance past the wallclock cap (10 minutes).
            await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
            // Let the queued setImmediate from child.kill emit 'close'.
            await jest.advanceTimersByTimeAsync(0);

            const result = await settled;
            expect((result as { kind: string }).kind).toBe(McpToolErrorKindEnum.TIMEOUT);
            expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        } finally {
            jest.useRealTimers();
        }
    });

    it('concurrent invocation while another is in-flight → VALIDATION "already in progress"', async () => {
        const child1 = makeFakeChild();
        const child2 = makeFakeChild();
        let call = 0;
        const spawn = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            call += 1;
            const c = call === 1 ? child1 : child2;
            if (call === 1) {
                // First call: never resolves naturally; we close after assertion.
                return c;
            }
            // Second call must NEVER actually be spawned — guarded by semaphore.
            // But if it is, emit a synthetic success to surface the bug.
            const outputIdx = args.indexOf('--output');
            setImmediate(() => {
                writeFileSync(args[outputIdx + 1], JSON.stringify(SAMPLE_REPORT));
                c.emit('close', 0, null);
            });
            return c;
        });

        const { registry } = newToolWithSpawn(spawn);

        const first = registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });
        // Do not await `first` yet — the semaphore should hold its slot.
        const secondAttempt = registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });

        await expect(secondAttempt).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
            message: expect.stringMatching(/already in progress/u),
        });
        expect(spawn).toHaveBeenCalledTimes(1);

        // Close the first call cleanly so the test process can exit.
        const firstSpawnArgs = spawn.mock.calls[0][1] as string[];
        const outputIdx = firstSpawnArgs.indexOf('--output');
        writeFileSync(firstSpawnArgs[outputIdx + 1], JSON.stringify(SAMPLE_REPORT));
        child1.emit('close', 0, null);
        await first;
    });

    it('engine writes invalid JSON to the output file → INTERNAL', async () => {
        const child = makeFakeChild();
        const spawn = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            const outputIdx = args.indexOf('--output');
            const outputPath = args[outputIdx + 1];
            setImmediate(() => {
                writeFileSync(outputPath, '{ not json', 'utf-8');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        await expect(registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO })).rejects.toMatchObject({ kind: McpToolErrorKindEnum.INTERNAL });
    });

    it('engine exits 0 but never wrote the output file → INTERNAL', async () => {
        const child = makeFakeChild();
        const spawn = jest.fn().mockImplementation(() => {
            setImmediate(() => child.emit('close', 0, null));
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        await expect(registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO })).rejects.toMatchObject({ kind: McpToolErrorKindEnum.INTERNAL });
    });
});

// M12 W6 R3 #3 — MCP_ENGINE_CMD env-var resolution.
describe('resolveEngineCmd — MCP_ENGINE_CMD hardening', () => {
    const ORIGINAL_ENV = process.env.MCP_ENGINE_CMD;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.MCP_ENGINE_CMD;
        } else {
            process.env.MCP_ENGINE_CMD = ORIGINAL_ENV;
        }
    });

    it('falls back to bare "pnpm" with the classic pnpm-filter leading args when env is unset', () => {
        const resolved = __test.resolveEngineCmd({}, () => true);
        expect(resolved.cmd).toBe('pnpm');
        expect(resolved.leadingArgs).toEqual(['--filter', '@bot/engine', 'backtest']);
    });

    it('uses MCP_ENGINE_CMD verbatim when set to an existing absolute path', () => {
        const resolved = __test.resolveEngineCmd({ MCP_ENGINE_CMD: '/opt/bot/bin/backtest.sh' }, () => true);
        expect(resolved.cmd).toBe('/opt/bot/bin/backtest.sh');
        // The launcher IS the engine entrypoint; no pnpm-filter prefix.
        expect(resolved.leadingArgs).toEqual([]);
    });

    it('throws when MCP_ENGINE_CMD is a relative path', () => {
        expect(() => __test.resolveEngineCmd({ MCP_ENGINE_CMD: 'bin/backtest.sh' }, () => true)).toThrow(/must be an absolute path/);
    });

    it('throws when MCP_ENGINE_CMD points at a non-existent file (fail-fast at boot)', () => {
        expect(() => __test.resolveEngineCmd({ MCP_ENGINE_CMD: '/no/such/launcher' }, () => false)).toThrow(/non-existent file/);
    });

    it('spawn uses the env-var path when MCP_ENGINE_CMD is set', async () => {
        process.env.MCP_ENGINE_CMD = process.execPath; // guaranteed-existing absolute path

        const child = makeFakeChild();
        const spawn = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            const outputIdx = args.indexOf('--output');
            setImmediate(() => {
                writeFileSync(args[outputIdx + 1], JSON.stringify(SAMPLE_REPORT), 'utf-8');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);
        await registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });

        const [cmd, argv] = spawn.mock.calls[0];
        expect(cmd).toBe(process.execPath);
        // No pnpm prefix when MCP_ENGINE_CMD is set; the launcher is direct.
        expect(argv.slice(0, 1)).toEqual(['run']);
        expect(argv).not.toContain('--filter');
        expect(argv).not.toContain('@bot/engine');
    });
});

describe('redactStderrTail unit', () => {
    it('strips postgres URLs, bearer tokens, IPv4, IPv6', () => {
        const raw = [
            'connecting to postgres://app:hunter2@db.internal:5432/trade',
            'Authorization: Bearer eyJabc.def-ghi.jkl_mno',
            'remote_addr=192.168.1.42',
            'ipv6=fe80::1ff:fe23:4567:890a',
        ].join('\n');

        const out = redactStderrTail(raw);

        expect(out).not.toContain('hunter2');
        expect(out).not.toContain('eyJabc.def-ghi.jkl_mno');
        expect(out).not.toContain('192.168.1.42');
        expect(out).not.toContain('fe80::1ff:fe23:4567:890a');
    });

    it('truncates to the last 2KB when stderr is large', () => {
        const big = 'X'.repeat(10_000) + 'TAIL_MARKER';
        const out = redactStderrTail(big);
        expect(out.length).toBeLessThanOrEqual(2 * 1024);
        expect(out).toContain('TAIL_MARKER');
    });
});

describe('helpers (unit)', () => {
    it('toUtcCalendarDay strips the canonical UTC-midnight time suffix', () => {
        expect(__test.toUtcCalendarDay('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');
        expect(__test.toUtcCalendarDay('2026-01-15')).toBe('2026-01-15');
        expect(__test.toUtcCalendarDay('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    });

    it('isBacktestReportShape requires the documented top-level fields', () => {
        expect(__test.isBacktestReportShape(SAMPLE_REPORT)).toBe(true);
        expect(__test.isBacktestReportShape({})).toBe(false);
        expect(__test.isBacktestReportShape({ runLabel: 'x', strategyVersionId: 'not-a-number' })).toBe(false);
    });

    it('filterEnvAllowlist keeps only PATH/HOME/DATABASE_URL/NODE_ENV', () => {
        const out = __test.filterEnvAllowlist({ PATH: '/usr/bin', HOME: '/home/x', SECRET: 'leak', NODE_ENV: 'test' });
        expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'test' });
        expect(out.SECRET).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// M12 W5 — adversarial vectors 3 & 6 (QA wave).
//
// Vector 3: long-range and concurrent attack cases.
// Vector 6: extended spawn-stderr redaction (R1c from the W2 pivot).
// ---------------------------------------------------------------------------

describe('run_backtest tool — vector 3: long-range and get_decisions constraints', () => {
    it('rejects > 180d range at the DTO schema level (hard cap) — spawn never called', async () => {
        const spawn = jest.fn();
        const { registry } = newToolWithSpawn(spawn);

        // T_NOW - 365 days is > 180d hard cap for run_backtest.
        const farFrom = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        const nowIso = new Date(Date.now()).toISOString();

        await expect(registry.callTool('run_backtest', { versionId: 1, from: farFrom, to: nowIso })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
        });

        expect(spawn).not.toHaveBeenCalled();
    });

    it('second concurrent call rejects even while first is mid-stream reading stderr', async () => {
        // The critical edge: the semaphore must hold the slot even BEFORE the
        // child process has started writing stderr. The first call acquires on
        // entry to the handler; the second call must see it busy immediately,
        // not after the first's first I/O event.
        const child = makeFakeChild();
        let firstSpawnResolved = false;

        const spawn = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            // The child will only close AFTER we signal from the assertion below.
            // This gives the test a window to issue a concurrent call while the
            // first is definitively in-flight.
            setImmediate(() => {
                // Emit some stderr to keep the stream alive (simulates mid-read).
                child.stderr.emit('data', 'engine is running...');
                // Only close after both assertions have been checked.
                setTimeout(() => {
                    const outputIdx = args.indexOf('--output');
                    writeFileSync(args[outputIdx + 1], JSON.stringify(SAMPLE_REPORT));
                    child.emit('close', 0, null);
                    firstSpawnResolved = true;
                }, 20);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        const first = registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });

        // Issue the concurrent call immediately — the semaphore must already
        // be held by `first` at this point.
        const secondAttempt = registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });

        // The second call must reject with VALIDATION while the first is
        // still in-flight (spawn has not emitted 'close' yet).
        await expect(secondAttempt).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
            message: expect.stringMatching(/already in progress/u),
        });

        // Only one spawn should have been invoked.
        expect(spawn).toHaveBeenCalledTimes(1);

        // Now let the first finish.
        await first;
        expect(firstSpawnResolved).toBe(true);
    });
});

describe('redactStderrTail — vector 6: extended redaction cases', () => {
    it('redacts secrets at the beginning of a 5KB multi-line stderr tail', () => {
        // Secret appears on line 1; lines 2-N are noise to push it past 2KB.
        const secretLine = 'connecting to postgres://admin:TopSecret99@prod.db.internal:5432/tradeprod\n';
        const noiseLine = 'INFO engine processing candle at 2026-01-15T12:00:00Z\n';
        // Build ~5KB of content where the secret is at position 0.
        const fiveKb = secretLine + noiseLine.repeat(Math.ceil((5 * 1024 - secretLine.length) / noiseLine.length));

        const out = redactStderrTail(fiveKb);

        // Result must be at most 2KB.
        expect(out.length).toBeLessThanOrEqual(2 * 1024);
        // The secret must be gone (tail-slicing might remove the first line, but
        // verify the password is not present anywhere in whatever was returned).
        expect(out).not.toContain('TopSecret99');
        // Must contain redaction marker if the postgres URL survived the tail.
        if (out.includes('postgres://')) {
            expect(out).toContain('[REDACTED]');
        }
    });

    it('redacts JWT-shaped Bearer tokens (eyJ... base64url)', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const raw = `Authorization: Bearer ${jwt}\nsome other line\n`;

        const out = redactStderrTail(raw);

        expect(out).not.toContain(jwt);
        expect(out).toContain('Bearer [REDACTED]');
    });

    it('redacts bare IPv6 addresses (without bracket notation) using the heuristic regex', () => {
        // The heuristic pattern matches colon-separated hex groups.
        // Example: fe80::1ff:fe23:4567:890a (no surrounding brackets).
        const raw = 'remote_addr=fe80::1ff:fe23:4567:890a ts=2026-01-15\n';

        const out = redactStderrTail(raw);

        expect(out).not.toContain('fe80::1ff:fe23:4567:890a');
        expect(out).toContain('[REDACTED');
    });

    // M12 W5 QA-discovered bug, now fixed: bracket-notation IPv6 (e.g.
    // `[::1]:5432`) was passing through `redactStderrTail` because the IPv6
    // heuristic used `\b` word-boundary anchors that don't match `[`. The
    // production regex now includes a dedicated bracket-notation pattern
    // running BEFORE the unbracketed heuristic.
    it('redacts bracket-notation IPv6 [::1]:5432', () => {
        const raw = 'connected to database at [::1]:5432 via TCP\n';

        const out = redactStderrTail(raw);

        expect(out).not.toContain('::1');
        expect(out).not.toContain('[::1]');
        expect(out).toContain('[REDACTED-IPV6]');
    });

    it('redacts database URL embedded in a Node stack trace line', () => {
        const raw = [
            'Error: connect ECONNREFUSED postgres://bot_user:hunter2@10.0.0.5:5432/trade_bot',
            '    at Object.<anonymous> (/app/dist/database/dataSourceOptions.js:42:11)',
            '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
        ].join('\n');

        const out = redactStderrTail(raw);

        expect(out).not.toContain('hunter2');
        expect(out).not.toContain('10.0.0.5');
        expect(out).toContain('[REDACTED');
    });

    it('public error message does NOT contain any stderr content on non-zero exit', async () => {
        const child = makeFakeChild();
        const secretStderr = 'FATAL: password authentication failed for user "admin"';
        const spawn = jest.fn().mockImplementation(() => {
            setImmediate(() => {
                child.stderr.emit('data', secretStderr);
                child.emit('close', 1, null);
            });
            return child;
        });

        const { registry } = newToolWithSpawn(spawn);

        let thrownError: unknown;
        try {
            await registry.callTool('run_backtest', { versionId: 7, from: FROM, to: TO });
        } catch (err) {
            thrownError = err;
        }

        expect(thrownError).toBeDefined();
        const err = thrownError as { kind: string; message: string };

        // The public .message must only contain "engine backtest failed (exit code N)".
        // It MUST NOT contain any fragment of the stderr.
        expect(err.message).toMatch(/engine backtest failed \(exit code 1\)/);
        expect(err.message).not.toContain('password authentication');
        expect(err.message).not.toContain('admin');
        // The stderr tail goes in the cause, NOT in the public message.
        expect(err.message).not.toContain(secretStderr);
    });
});
