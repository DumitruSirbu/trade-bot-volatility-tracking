// M13 W5.A — Process entry-point for `@bot/agent`.
//
// Wires CLI args + env into `runWeeklyLoop`. Responsibilities:
//   - Resolve `weekIso` from --week-iso flag (or AGENT_WEEK_ISO env fallback).
//   - PID-lockfile via `proper-lockfile` (with `realpath: false` so the lock
//     target may not exist) — on contention exit 0 with `LOCK_HELD` (NOT a
//     failure; overlapping cron triggers are expected when a prior run
//     overruns).
//   - 45-min wallclock SIGTERM, env-overridable for tests
//     (`AGENT_WALLCLOCK_MS_OVERRIDE`). On timeout: best-effort history INSERT
//     with `terminal_state=FAILED`, `failure_reason=WALLCLOCK_EXCEEDED`, then
//     release lock + exit 1.
//   - --dry-run: persistence stub that returns a deterministic fake id and
//     refuses to touch Postgres; markdown printed to stdout; the real
//     `ReportWriter` is replaced by an in-memory stub.
//
// What this file does NOT do:
//   - Does NOT compute the "active version" itself — that lookup is deferred
//     (W5.B will inject it). Today: --parent-version-id is REQUIRED on the
//     CLI (or via AGENT_PARENT_VERSION_ID env) so we have something to wire.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { TerminalStateEnum } from '@bot/shared';
import pino from 'pino';
import { lock as lockFile } from 'proper-lockfile';

import { runBoundaryGuard } from './boundary/RuntimeBoundaryGuard.js';
import { parseCliArgs, isValidIsoWeek, CliArgError } from './cli/parseCliArgs.js';
import { ReportWriter } from './io/ReportWriter.js';
import { AiGatewayClient, DEFAULT_AGENT_MODEL_ID } from './llm/aiGateway.js';
import { McpClient } from './mcp/McpClient.js';
import { AgentPersistence } from './persistence/AgentPersistence.js';
import { AgentPgClient } from './persistence/AgentPgClient.js';
import {
    runWeeklyLoop,
    type IAgentHistoryRow,
    type IPersistencePort,
    type IReportPaths,
    type IReportWriterPort,
    type IRunWeeklyLoopResult,
} from './loop/runWeeklyLoop.js';

const LOCKFILE_DEFAULT_PATH = '/tmp/bot-agent.lock';
const LOCKFILE_STALE_MS = 90 * 60 * 1000;
const WALLCLOCK_DEFAULT_MS = 45 * 60 * 1000;
// M13 W6 fix wave 2 (#4): the lockfile stale window must always strictly
// exceed the wallclock budget so a second cron-launched agent cannot steal
// the lock from a still-running first agent. Default ordering (45 min
// wallclock < 90 min stale) is safe; the override path
// (`AGENT_WALLCLOCK_MS_OVERRIDE`) needs the same guarantee.
const LOCK_STALE_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const DRY_RUN_FAKE_DRAFT_ID = -1;

type IMainEnv = Readonly<Record<string, string | undefined>>;

interface IResolvedArgs {
    readonly weekIso: string;
    readonly dryRun: boolean;
    readonly parentVersionId: number;
}

async function bootstrap(): Promise<void> {
    runBoundaryGuard();
    const logger = pino({
        level: process.env.LOG_LEVEL ?? 'info',
        // M13 W6 fix wave 4 (#1): defense-in-depth secret redaction at the
        // pino layer. Anything matched is stripped from log records BEFORE
        // serialization, so an accidental `logger.info({ config })` cannot
        // leak DB password / AI gateway key / MCP bearer / auth header.
        redact: {
            paths: [
                '*.password',
                '*.apiKey',
                '*.bearer',
                '*.token',
                '*.secret',
                '*.AGENT_DB_PASSWORD',
                '*.AI_GATEWAY_API_KEY',
                '*.AGENT_MCP_BEARER',
                'authorization',
                'headers.authorization',
                'config.password',
                'config.apiKey',
            ],
            remove: true,
        },
    });
    let args: IResolvedArgs;

    try {
        args = resolveArgs(process.argv, process.env);
    } catch (err) {
        logger.error({ msg: 'agent.cli.invalid_args', error: errMessage(err) });
        process.exit(2);

        return;
    }

    const lockPath = process.env.AGENT_LOCKFILE_PATH ?? LOCKFILE_DEFAULT_PATH;
    const wallclockMs = resolveWallclockMs(process.env);
    const lockStaleMs = computeEffectiveLockStaleMs(wallclockMs);
    const release = await tryAcquireLock(lockPath, lockStaleMs, logger);

    if (release === null) {
        process.exit(0);

        return;
    }

    const exitCode = await runUnderWallclock({
        wallclockMs,
        logger,
        runLoop: () => runEffectiveLoop(args, logger),
        onWallclockExceeded: (startedAt) => recordWallclockExceeded(args, startedAt, logger),
        release,
    });
    process.exit(exitCode);
}

export interface IRunUnderWallclockArgs {
    readonly wallclockMs: number;
    readonly logger: pino.Logger;
    readonly runLoop: () => Promise<IRunWeeklyLoopResult>;
    readonly onWallclockExceeded: (startedAt: Date) => Promise<void>;
    readonly release: () => Promise<void>;
}

export class WallclockExceededError extends Error {
    constructor() {
        super('Agent wallclock exceeded');
        this.name = 'WallclockExceededError';
    }
}

export async function runUnderWallclock(args: IRunUnderWallclockArgs): Promise<number> {
    const startedAt = new Date();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sigtermHandler: (() => void) | null = null;

    const wallclockPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WallclockExceededError()), args.wallclockMs);
        timer.unref();
        sigtermHandler = (): void => reject(new WallclockExceededError());
        process.once('SIGTERM', sigtermHandler);
    });

    try {
        const result = await Promise.race([args.runLoop(), wallclockPromise]);
        return mapTerminalStateToExitCode(result.terminalState);
    } catch (err) {
        if (err instanceof WallclockExceededError) {
            args.logger.error({ msg: 'agent.wallclock.fired' });
            await args.onWallclockExceeded(startedAt);
            return 1;
        }
        args.logger.error({ msg: 'agent.fatal', error: errMessage(err) });
        return 1;
    } finally {
        if (timer !== null) {
            clearTimeout(timer);
        }

        if (sigtermHandler !== null) {
            process.removeListener('SIGTERM', sigtermHandler);
        }

        await releaseQuietly(args.release, args.logger);
    }
}

interface IPersistenceHandle {
    readonly port: IPersistencePort;
    close(): Promise<void>;
}

// M13 W6 fix wave 4 (#5b): hide nullable pg client behind a factory that
// always returns an IPersistencePort + a paired close(). The non-null-assert
// (`pg!`) is gone — the live branch owns the client lifecycle inside the
// closure, the dry-run branch has nothing to close.
function buildPersistence(args: IResolvedArgs, logger: pino.Logger): IPersistenceHandle {
    if (args.dryRun) {
        return { port: buildDryRunPersistence(logger), close: async () => undefined };
    }
    const pg = new AgentPgClient();
    return {
        port: new AgentPersistence(pg),
        close: async () => {
            await pg.close().catch(() => undefined);
        },
    };
}

async function runEffectiveLoop(args: IResolvedArgs, logger: pino.Logger): Promise<IRunWeeklyLoopResult> {
    const mcp = buildMcpClient();
    const llm = new AiGatewayClient();
    const persistenceHandle = buildPersistence(args, logger);
    const reportWriter = args.dryRun ? buildDryRunReportWriter(logger) : await buildRealReportWriter();
    try {
        return await runWeeklyLoop({
            mcp,
            llm,
            persistence: persistenceHandle.port,
            reportWriter,
            logger: {
                info: (msg, ctx) => logger.info({ msg, ...(ctx ?? {}) }),
                error: (msg, ctx) => logger.error({ msg, ...(ctx ?? {}) }),
            },
            weekIso: args.weekIso,
            parentVersionId: args.parentVersionId,
            dryRun: args.dryRun,
        });
    } finally {
        mcp.destroy();
        await persistenceHandle.close();
    }
}

function resolveArgs(argv: ReadonlyArray<string>, env: IMainEnv): IResolvedArgs {
    const cli = parseCliArgs(argv);
    const weekIso = cli.weekIso ?? env.AGENT_WEEK_ISO ?? null;

    if (weekIso === null) {
        throw new CliArgError('--week-iso', 'required (or set AGENT_WEEK_ISO env)');
    }

    if (!isValidIsoWeek(weekIso)) {
        throw new CliArgError('--week-iso', `not an ISO-week string: "${weekIso}"`);
    }

    const parentVersionId = cli.parentVersionId ?? parseEnvPositiveInt(env.AGENT_PARENT_VERSION_ID);

    if (parentVersionId === null) {
        throw new CliArgError('--parent-version-id', 'required (or set AGENT_PARENT_VERSION_ID env)');
    }

    return { weekIso, dryRun: cli.dryRun, parentVersionId };
}

function parseEnvPositiveInt(raw: string | undefined): number | null {
    if (raw === undefined || raw.length === 0) {
        return null;
    }

    const parsed = Number(raw);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveWallclockMs(env: IMainEnv): number {
    const override = env.AGENT_WALLCLOCK_MS_OVERRIDE;

    if (override !== undefined && override.length > 0) {
        const parsed = Number(override);

        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return WALLCLOCK_DEFAULT_MS;
}

export function computeEffectiveLockStaleMs(wallclockMs: number): number {
    // Lock stale window must strictly exceed the wallclock budget so an
    // overlapping cron-launched agent cannot steal the lock from a still-
    // running first agent. We pad by LOCK_STALE_SAFETY_MARGIN_MS on top of
    // the wallclock so the timer + history-write + lock-release tail also
    // happens inside the protection window.
    const fromWallclock = wallclockMs + LOCK_STALE_SAFETY_MARGIN_MS;
    const effective = Math.max(LOCKFILE_STALE_MS, fromWallclock);

    if (effective <= wallclockMs) {
        // Defensive: the Math.max + margin guarantees this, but assert so a
        // future refactor that drops the margin trips a clear error rather
        // than a silent lock-steal.
        throw new Error(`Lock stale window (${effective}ms) must exceed wallclock budget (${wallclockMs}ms); refusing to boot`);
    }
    return effective;
}

async function tryAcquireLock(lockPath: string, staleMs: number, logger: pino.Logger): Promise<(() => Promise<void>) | null> {
    await mkdir(dirname(lockPath), { recursive: true }).catch(() => undefined);
    try {
        const release = await lockFile(lockPath, { realpath: false, stale: staleMs });
        logger.info({ msg: 'agent.lock.acquired', lockPath, staleMs });
        return release;
    } catch (err) {
        if (isLockHeldError(err)) {
            logger.info({ msg: 'LOCK_HELD', lockPath });
            return null;
        }
        logger.error({ msg: 'agent.lock.error', error: errMessage(err) });
        throw err;
    }
}

function isLockHeldError(err: unknown): boolean {
    if (err === null || typeof err !== 'object') {
        return false;
    }

    const code = (err as { code?: string }).code;

    return code === 'ELOCKED';
}

async function releaseQuietly(release: () => Promise<void>, logger: pino.Logger): Promise<void> {
    try {
        await release();
    } catch (err) {
        logger.error({ msg: 'agent.lock.release_failed', error: errMessage(err) });
    }
}

function mapTerminalStateToExitCode(state: TerminalStateEnum): number {
    if (state === TerminalStateEnum.FAILED) {
        return 1;
    }

    return 0;
}

function buildMcpClient(): McpClient {
    const baseUrl = readRequiredEnv('AGENT_MCP_URL');
    const bearer = readRequiredEnv('AGENT_MCP_BEARER');
    return new McpClient(baseUrl, bearer);
}

async function buildRealReportWriter(): Promise<ReportWriter> {
    const dir = process.env.AGENT_REPORT_DIR ?? './reports/agent';
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    return new ReportWriter(dir);
}

function buildDryRunReportWriter(logger: pino.Logger): IReportWriterPort {
    return {
        async write(weekIso: string, draftVersionId: number, markdown: string, json: unknown): Promise<IReportPaths> {
            logger.info({ msg: 'agent.dry_run.report', weekIso, draftVersionId });
            process.stdout.write(markdown);
            process.stdout.write('\n');
            void json;
            return { mdPath: `dry-run:${weekIso}/${draftVersionId}.md`, jsonPath: `dry-run:${weekIso}/${draftVersionId}.json` };
        },
    };
}

function buildDryRunPersistence(logger: pino.Logger): IPersistencePort {
    return {
        async draftStrategyVersion(): Promise<number> {
            logger.info({ msg: 'DRY_RUN_SKIPPED', op: 'draftStrategyVersion' });
            return DRY_RUN_FAKE_DRAFT_ID;
        },
        async recordHistory(): Promise<number> {
            logger.info({ msg: 'DRY_RUN_SKIPPED', op: 'recordHistory' });
            return DRY_RUN_FAKE_DRAFT_ID;
        },
    };
}

async function recordWallclockExceeded(args: IResolvedArgs, startedAt: Date, logger: pino.Logger): Promise<void> {
    if (args.dryRun) {
        logger.error({ msg: 'agent.wallclock.exceeded', dryRun: true });
        return;
    }
    const row: IAgentHistoryRow = {
        weekIso: args.weekIso,
        parentVersionId: args.parentVersionId,
        draftVersionId: null,
        modelId: process.env.AGENT_MODEL_ID ?? DEFAULT_AGENT_MODEL_ID,
        reportMdPath: null,
        reportJsonPath: null,
        terminalState: TerminalStateEnum.FAILED,
        failureReason: 'WALLCLOCK_EXCEEDED',
        startedAt,
        finishedAt: new Date(),
        bootstrapCiLo: null,
        bootstrapCiHi: null,
        passesPromotionGate: null,
    };
    try {
        const pg = new AgentPgClient();
        try {
            const persistence = new AgentPersistence(pg);
            await persistence.recordHistory(row);
        } finally {
            await pg.close().catch(() => undefined);
        }
        logger.error({ msg: 'agent.wallclock.exceeded', recorded: true });
    } catch (err) {
        logger.error({ msg: 'agent.wallclock.history_write_failed', error: errMessage(err) });
    }
}

function readRequiredEnv(name: string): string {
    const value = process.env[name];

    if (value === undefined || value.length === 0) {
        throw new Error(`Missing required env var: ${name}`);
    }

    return value;
}

function errMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }

    if (typeof err === 'string') {
        return err;
    }

    return 'unknown';
}

// The entry-point is only executed when this file is invoked as `node main.js`
// (or via ts-node). Tests import named helpers without triggering bootstrap.
const isDirectInvocation = process.argv[1] !== undefined && /[\\/](main\.(?:t|j)s)$/.test(process.argv[1]);
if (isDirectInvocation) {
    void bootstrap();
}

export { bootstrap, resolveArgs, parseEnvPositiveInt, resolveWallclockMs };
export { LOCKFILE_STALE_MS, LOCK_STALE_SAFETY_MARGIN_MS };
