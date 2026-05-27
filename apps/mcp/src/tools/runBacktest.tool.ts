// M12 W4 — `run_backtest` MCP tool (spawn-based, ADR 0033 §2.5 Option II).
//
// MCP-side contract:
//   - The engine CLI accepts:
//       pnpm --filter @bot/engine backtest run
//         --version <strategy_version_id>
//         --from <YYYY-MM-DD>
//         --to   <YYYY-MM-DD>
//         --output <abs-tmpfile-path>
//   - On exit code 0 the CLI MUST have written an `IBacktestReport` JSON
//     document to the `--output` path. Anything else is engine failure.
//   - Exit non-zero with stderr describing the cause; we tail the last 2 KB
//     (redacted) into the public error's server-side `cause`.
//
// Boundary invariant (ADR 0033 §2.2): the spawned engine process never
// shares address space with MCP. This file imports ONLY node:* + sibling MCP
// modules + zod (via DTO schema). Zero `@bot/engine` edges. The cross-process
// JSON file is the entire contract surface.
//
// Resource caps (ADR 0034 §2.6):
//   - Single concurrent invocation per MCP process (`Sema(1)` below).
//   - Wallclock kill at 10 minutes (SIGTERM, then SIGKILL after 5 s grace).
//   - Env passed to child is the minimal allowlist `PATH`, `HOME`,
//     `DATABASE_URL`, `NODE_ENV`. Nothing else is inherited.
//   - Tmpfile lives in a fresh mkdtemp directory and is always removed in
//     `finally`, even on timeout / crash.

import { ChildProcess, spawn as defaultSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute as isAbsolutePath, join as joinPath } from 'node:path';

import type { IBacktestReport } from '@bot/shared';

import { RunBacktestParamsSchema, type RunBacktestParams } from '../dtos/index.js';
import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

const TOOL_NAME = 'run_backtest';

const WALLCLOCK_MS = 10 * 60 * 1_000;
const KILL_GRACE_MS = 5_000;
const STDERR_BUFFER_CAP_BYTES = 64 * 1_024;
const STDERR_TAIL_BYTES = 2 * 1_024;
const REPORT_MAX_BYTES = 50 * 1_024 * 1_024;
const TMP_DIR_PREFIX = 'mcp-bt-';
const REPORT_FILENAME = 'report.json';

type SpawnFn = typeof defaultSpawn;

interface IRunBacktestToolDeps {
    /** Defaults to `node:child_process.spawn`; tests inject a fake. */
    readonly spawn?: SpawnFn;
    /** Defaults to a private module-level semaphore; tests inject a fresh one for isolation. */
    readonly semaphore?: ISemaphore;
}

// ---------------------------------------------------------------------------
// Semaphore — N=1 concurrency guard. Rejects (does NOT queue) the second
// caller per ADR 0034 §2.6.
// ---------------------------------------------------------------------------

export interface ISemaphore {
    tryAcquire(): boolean;
    release(): void;
}

export function createSingleSlotSemaphore(): ISemaphore {
    let busy = false;
    return {
        tryAcquire(): boolean {
            if (busy) {
                return false;
            }
            busy = true;
            return true;
        },
        release(): void {
            busy = false;
        },
    };
}

const moduleSemaphore = createSingleSlotSemaphore();

// ---------------------------------------------------------------------------
// stderr redaction — defense-in-depth before any stderr text reaches the
// server-side log sink. We tail the last 2 KB and strip patterns that
// could leak credentials, IPs, or DB paths.
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
    { pattern: /postgres(?:ql)?:\/\/[^@\s]+@[^\s]+/giu, replacement: 'postgres://[REDACTED]' },
    { pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]+/giu, replacement: 'Bearer [REDACTED]' },
    // IPv4
    { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, replacement: '[REDACTED-IP]' },
    // IPv6 bracket notation (e.g. `[::1]:5432`) — must run before the
    // unbracketed heuristic since `\b` does not match `[`.
    { pattern: /\[[0-9a-f:]+\](?::\d+)?/giu, replacement: '[REDACTED-IPV6]' },
    // IPv6 (heuristic: at least two `:` separators with hex groups)
    { pattern: /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]+\b/giu, replacement: '[REDACTED-IPV6]' },
];

export function redactStderrTail(raw: string): string {
    const tail = raw.length > STDERR_TAIL_BYTES ? raw.slice(raw.length - STDERR_TAIL_BYTES) : raw;
    let out = tail;
    for (const { pattern, replacement } of REDACTION_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

// ---------------------------------------------------------------------------
// JSON schema for `tools/list`.
// ---------------------------------------------------------------------------

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        versionId: { type: 'integer', minimum: 1 },
        from: { type: 'string', description: 'ISO 8601 lower bound (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 upper bound (exclusive). Hard cap 180 days.' },
    },
    required: ['versionId', 'from', 'to'],
    additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

// M12 W6 R3 #3 — `MCP_ENGINE_CMD` env var lets the operator pin the engine
// launcher to an absolute path (recommended in deployed setups, where PATH
// shenanigans are an attack surface). When set, it MUST be an absolute path
// pointing at an existing file; we fail-fast at boot rather than at first
// invocation. When unset, we fall back to the bare `pnpm` command and emit a
// warning to stderr so the operator sees the PATH dependency.
const MCP_ENGINE_CMD_ENV = 'MCP_ENGINE_CMD';
const FALLBACK_ENGINE_CMD = 'pnpm';

interface IResolvedEngineCmd {
    readonly cmd: string;
    readonly leadingArgs: readonly string[];
}

export function resolveEngineCmd(env: NodeJS.ProcessEnv = process.env, statFn: (p: string) => boolean = pathExists): IResolvedEngineCmd {
    const raw = env[MCP_ENGINE_CMD_ENV];
    if (typeof raw === 'string' && raw.length > 0) {
        if (!isAbsolutePath(raw)) {
            throw new Error(`${MCP_ENGINE_CMD_ENV} must be an absolute path, got "${raw}"`);
        }
        if (!statFn(raw)) {
            throw new Error(`${MCP_ENGINE_CMD_ENV} points at a non-existent file: "${raw}"`);
        }
        // The launcher is the engine backtest entrypoint; only the subcommand
        // + flags trail it.
        return { cmd: raw, leadingArgs: [] };
    }

    // Fallback: classic pnpm-based spawn. Warn once so the operator knows the
    // resolved cmd depends on PATH.
    process.stderr.write(
        `[mcp:run_backtest] WARN ${MCP_ENGINE_CMD_ENV} not set; falling back to bare "${FALLBACK_ENGINE_CMD}" (PATH-resolved). Set ${MCP_ENGINE_CMD_ENV} to an absolute engine launcher for hardened deployments.\n`,
    );
    return { cmd: FALLBACK_ENGINE_CMD, leadingArgs: ['--filter', '@bot/engine', 'backtest'] };
}

function pathExists(p: string): boolean {
    try {
        statSync(p);
        return true;
    } catch {
        return false;
    }
}

export function buildRunBacktestTool(deps: IRunBacktestToolDeps = {}): IReadOnlyToolRegistration<typeof RunBacktestParamsSchema> {
    const spawn = deps.spawn ?? defaultSpawn;
    const sema = deps.semaphore ?? moduleSemaphore;
    // Resolved at factory time so a misconfigured env fails fast at boot, not
    // at first tool invocation.
    const engineCmd = resolveEngineCmd();

    return {
        name: TOOL_NAME,
        description: 'Run an out-of-process backtest for the given strategy version over an ISO date window. Single concurrent run; 10-minute wallclock cap.',
        paramsSchema: RunBacktestParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (params: RunBacktestParams): Promise<IBacktestReport> => runBacktestOnce(params, spawn, sema, engineCmd),
    };
}

async function runBacktestOnce(params: RunBacktestParams, spawn: SpawnFn, sema: ISemaphore, engineCmd: IResolvedEngineCmd): Promise<IBacktestReport> {
    if (!sema.tryAcquire()) {
        throw McpToolError.validation('backtest already in progress — only one concurrent run_backtest is permitted');
    }

    const tmpDir = mkdtempSync(joinPath(tmpdir(), TMP_DIR_PREFIX));
    const outputPath = joinPath(tmpDir, REPORT_FILENAME);

    try {
        await spawnBacktestChild(params, outputPath, spawn, engineCmd);
        return readReportFromTmp(outputPath);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        sema.release();
    }
}

function spawnBacktestChild(params: RunBacktestParams, outputPath: string, spawn: SpawnFn, engineCmd: IResolvedEngineCmd): Promise<void> {
    // why: schema already restricted `from`/`to` to `YYYY-MM-DD` or canonical
    // UTC-midnight `YYYY-MM-DDT00:00:00.000Z`. The helper strips the optional
    // time suffix to the bare calendar day the engine CLI expects, with no
    // timezone-dependent truncation surface.
    const fromIso = toUtcCalendarDay(params.from);
    const toIso = toUtcCalendarDay(params.to);

    const args = [...engineCmd.leadingArgs, 'run', '--version', String(params.versionId), '--from', fromIso, '--to', toIso, '--output', outputPath];

    const env = filterEnvAllowlist(process.env);

    const child = spawn(engineCmd.cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No shell — argv is passed directly to avoid quote-handling pitfalls.
        shell: false,
    });

    return waitForChild(child);
}

function waitForChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let stderrBytes = 0;
        let stderrBuffer = '';

        if (child.stderr) {
            child.stderr.setEncoding('utf-8');
            child.stderr.on('data', (chunk: string) => {
                if (stderrBytes < STDERR_BUFFER_CAP_BYTES) {
                    const remaining = STDERR_BUFFER_CAP_BYTES - stderrBytes;
                    const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
                    stderrBuffer += slice;
                    stderrBytes += slice.length;
                }
            });
        }

        let timedOut = false;
        let killTimer: NodeJS.Timeout | null = null;

        const wallclockTimer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill('SIGTERM');
            } catch {
                // ignore — process may already be dead
            }
            killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }, KILL_GRACE_MS);
            // If the kill-timer is the only thing pinning the event loop, do
            // NOT block process exit on it.
            if (killTimer.unref) {
                killTimer.unref();
            }
        }, WALLCLOCK_MS);
        if (wallclockTimer.unref) {
            wallclockTimer.unref();
        }

        child.on('error', (cause) => {
            clearTimeout(wallclockTimer);
            if (killTimer !== null) {
                clearTimeout(killTimer);
            }
            reject(McpToolError.internal(`failed to spawn engine backtest: ${cause.message}`, cause));
        });

        child.on('close', (code, signal) => {
            clearTimeout(wallclockTimer);
            if (killTimer !== null) {
                clearTimeout(killTimer);
            }

            if (timedOut) {
                reject(
                    McpToolError.timeout(`engine backtest exceeded ${WALLCLOCK_MS / 1_000}s wallclock cap`, {
                        signal,
                        stderrTail: redactStderrTail(stderrBuffer),
                    }),
                );
                return;
            }

            if (code === 0) {
                resolve();
                return;
            }

            reject(
                McpToolError.internal(`engine backtest failed (exit code ${String(code)})`, {
                    exitCode: code,
                    signal,
                    stderrTail: redactStderrTail(stderrBuffer),
                }),
            );
        });
    });
}

function readReportFromTmp(outputPath: string): IBacktestReport {
    let stat;
    try {
        stat = statSync(outputPath);
    } catch (cause) {
        throw McpToolError.internal('engine did not write the expected backtest report file', cause);
    }

    if (stat.size > REPORT_MAX_BYTES) {
        throw McpToolError.internal(`backtest report size ${stat.size} exceeds max ${REPORT_MAX_BYTES} bytes`);
    }

    let raw: string;
    try {
        raw = readFileSync(outputPath, { encoding: 'utf-8' });
    } catch (cause) {
        throw McpToolError.internal('failed to read backtest report file', cause);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw McpToolError.internal('backtest report file is not valid JSON', cause);
    }

    if (!isBacktestReportShape(parsed)) {
        throw McpToolError.internal('backtest report JSON missing required top-level fields');
    }

    return parsed;
}

function isBacktestReportShape(value: unknown): value is IBacktestReport {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const r = value as Record<string, unknown>;
    return (
        typeof r['runLabel'] === 'string' &&
        typeof r['strategyVersionId'] === 'number' &&
        typeof r['strategyName'] === 'string' &&
        typeof r['fromUtcDate'] === 'string' &&
        typeof r['toUtcDate'] === 'string' &&
        typeof r['tradeCount'] === 'number' &&
        typeof r['netPnlUsdt'] === 'string'
    );
}

// M12 W6 R3 #4 — env allowlist passes `DATABASE_URL` (not `ENGINE_DB_*`) per
// the engine's actual connection mechanism: `apps/engine/src/database/
// dataSource.ts` reads `process.env.DATABASE_URL` directly. The engine's
// TypeORM `DataSourceOptions` does NOT set `migrationsRun`, so it defaults to
// `false` — the spawned engine boot will never auto-mutate schema. Verified at
// W6 R3.
const ALLOWED_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'DATABASE_URL', 'NODE_ENV'];

function filterEnvAllowlist(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
        const value = env[key];
        if (typeof value === 'string') {
            out[key] = value;
        }
    }
    return out;
}

function toUtcCalendarDay(input: string): string {
    // Schema guarantees input matches `YYYY-MM-DD` or `YYYY-MM-DDT00:00:00.000Z`.
    // Slicing the first 10 chars is correct under both shapes — no Date math,
    // no implicit timezone surface.
    return input.slice(0, 10);
}

// Exposed for test isolation only — not part of the tool's public surface.
export const __test = {
    redactStderrTail,
    toUtcCalendarDay,
    isBacktestReportShape,
    filterEnvAllowlist,
    resolveEngineCmd,
};
