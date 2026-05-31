// M17 Wave 3 QA — unit tests for DbBackupScheduler.runOnce and onModuleInit.
//
// All filesystem, stream/promises, and child-process boundaries are mocked —
// NO real pg_dump, NO real disk writes, NO real DB connection. The injected
// clock pins every timestamp so tests are deterministic across machines and
// time zones.
//
// The dump step uses `pipeline(child.stdout, createGzip(), createWriteStream(tmpPath))`
// from `node:stream/promises` in parallel with `awaitCleanExit(child)`. Both
// must succeed for the dump to be promoted via rename. On any failure the .tmp
// is unlinked (orphan cleanup) before the error propagates.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { AlertSeverityEnum, AlertTypeEnum } from '@bot/shared';

// ─── module-level mocks (hoisted before imports) ─────────────────────────────

jest.mock('node:child_process', () => ({
    spawn: jest.fn(),
}));

jest.mock('node:fs', () => ({
    createWriteStream: jest.fn(),
}));

jest.mock('node:zlib', () => ({
    createGzip: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
    readdir: jest.fn(),
    realpath: jest.fn(),
    rename: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
}));

// pipeline lives in node:stream/promises — mock it at module level so the
// scheduler's spawnDumpToFile never blocks on a real stream.
jest.mock('node:stream/promises', () => ({
    pipeline: jest.fn(),
}));

// ─── imports after mocks ──────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import {
    BACKUP_FILENAME_EXTENSION,
    BACKUP_FILENAME_PATTERN,
    BACKUP_FILENAME_PREFIX,
    DB_BACKUP_CRON_JOB_NAME,
    DB_BACKUP_FAILED_REASON,
} from '../../src/backup/const/backupConsts';
import { DbBackupScheduler } from '../../src/backup/DbBackupScheduler';

// ─── typed mock helpers ───────────────────────────────────────────────────────

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockCreateWriteStream = createWriteStream as jest.MockedFunction<typeof createWriteStream>;
const mockCreateGzip = createGzip as jest.MockedFunction<typeof createGzip>;
const mockPipeline = pipeline as jest.MockedFunction<typeof pipeline>;
const mockReaddir = readdir as jest.MockedFunction<typeof readdir>;
const mockRealpath = realpath as jest.MockedFunction<typeof realpath>;
const mockRename = rename as jest.MockedFunction<typeof rename>;
const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;

// ─── fixture constants ────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-05-31T03:00:00.000Z');
const EXPECTED_FILENAME = 'trade_bot_20260531_0300.sql.gz';
const BACKUP_DIR = '/var/backups/trade-bot';
const RESOLVED_DIR = '/var/backups/trade-bot';
const DATABASE_URL = 'postgresql://bot:secret@localhost:5432/trade_bot';
const DEFAULT_RETENTION = 3;

// ─── factory functions ────────────────────────────────────────────────────────

function buildAlerts() {
    return { publish: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
}

function buildClock(date: Date = FIXED_NOW) {
    return { now: jest.fn<Date, []>().mockReturnValue(date) };
}

function buildAppConfig(
    overrides: {
        dbBackupDir?: string;
        dbBackupEnabled?: boolean;
        dbBackupCron?: string;
        dbBackupRetention?: number;
        databaseUrl?: string;
        nodeEnv?: string;
    } = {},
) {
    return {
        dbBackupDir: overrides.dbBackupDir ?? BACKUP_DIR,
        dbBackupEnabled: overrides.dbBackupEnabled ?? true,
        dbBackupCron: overrides.dbBackupCron ?? '0 3 * * *',
        dbBackupRetention: overrides.dbBackupRetention ?? DEFAULT_RETENTION,
        databaseUrl: overrides.databaseUrl ?? DATABASE_URL,
        nodeEnv: overrides.nodeEnv ?? 'test',
    } as never;
}

function buildSchedulerRegistry() {
    return {
        addCronJob: jest.fn(),
        deleteCronJob: jest.fn(),
    };
}

function buildScheduler(
    alerts = buildAlerts(),
    clock = buildClock(),
    appConfig = buildAppConfig(),
    schedulerRegistry = buildSchedulerRegistry(),
): DbBackupScheduler {
    return new DbBackupScheduler(alerts as never, clock as never, appConfig, schedulerRegistry as never);
}

// Builds a mock child process. stdout/stderr are PassThrough streams so
// captureStderrTail and awaitCleanExit can attach listeners. The child emits
// 'close' with exitCode on the next tick unless exitCode is undefined (caller
// controls timing). An 'error' event is emitted instead when spawnError is set.
function buildMockChild(exitCode: number | undefined = 0, spawnError?: Error) {
    const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    if (spawnError !== undefined) {
        setImmediate(() => child.emit('error', spawnError));
    } else if (exitCode !== undefined) {
        setImmediate(() => {
            child.stdout.push(null);
            child.emit('close', exitCode);
        });
    }

    return child;
}

// Sets up stream mocks. createWriteStream and createGzip return PassThroughs so
// the pipeline mock can receive typed arguments without runtime type errors.
function setupStreamMocks() {
    mockCreateWriteStream.mockReturnValue(new PassThrough() as never);
    mockCreateGzip.mockReturnValue(new PassThrough() as never);
}

// Configures a full successful run: pipeline resolves, child exits 0, prune
// infrastructure (realpath/readdir/rename/stat/unlink) all succeed.
function setupSuccessfulRun(existingFiles: string[]) {
    setupStreamMocks();
    mockPipeline.mockResolvedValue(undefined);

    const child = buildMockChild(0);
    mockSpawn.mockReturnValue(child as never);
    mockRename.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 1024 } as never);
    mockRealpath.mockResolvedValue(RESOLVED_DIR);
    mockReaddir.mockResolvedValue(existingFiles as never);
    mockUnlink.mockResolvedValue(undefined);
}

// Generates a backup filename for the given UTC date string.
function backupFileName(utcDatetime: string): string {
    const d = new Date(utcDatetime);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');

    return `${BACKUP_FILENAME_PREFIX}${yyyy}${mm}${dd}_${hh}${min}${BACKUP_FILENAME_EXTENSION}`;
}

// ─── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
});

// ── 1. Filename contract ───────────────────────────────────────────────────────

describe('filename contract', () => {
    it('produces trade_bot_<YYYYMMDD_HHMM>.sql.gz from the injected UTC clock', async () => {
        // BUILD
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — rename is called with the expected final path
        const finalPath = String(mockRename.mock.calls[0][1]);
        expect(finalPath).toContain(EXPECTED_FILENAME);
    });

    it('embeds the correct UTC date components (year, month, day, hour, minute)', async () => {
        // BUILD — a different date: 2026-12-01T23:59:00Z
        const edgeDate = new Date('2026-12-01T23:59:00.000Z');
        const expectedName = 'trade_bot_20261201_2359.sql.gz';
        setupSuccessfulRun([expectedName]);
        const scheduler = buildScheduler(buildAlerts(), buildClock(edgeDate));

        // OPERATE
        await scheduler.runOnce(edgeDate);

        // CHECK
        const finalPath = String(mockRename.mock.calls[0][1]);
        expect(finalPath).toContain(expectedName);
    });

    it('produced filename matches the anchored BACKUP_FILENAME_PATTERN', async () => {
        // BUILD
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        const finalPath = String(mockRename.mock.calls[0][1]);
        const name = finalPath.split('/').at(-1) as string;
        expect(BACKUP_FILENAME_PATTERN.test(name)).toBe(true);
    });

    it('writes to a .tmp path first then renames to the final path (atomic write)', async () => {
        // BUILD
        setupSuccessfulRun([]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — createWriteStream receives the .tmp path; rename target is the final name
        const tmpPath = String(mockCreateWriteStream.mock.calls[0][0]);
        const finalPath = String(mockRename.mock.calls[0][1]);
        expect(tmpPath).toMatch(/\.tmp$/u);
        expect(finalPath).toMatch(/\.sql\.gz$/u);
        expect(finalPath).not.toMatch(/\.tmp$/u);
        // tmp and final share the same base — tmp is final + '.tmp'
        expect(tmpPath).toBe(`${finalPath}.tmp`);
    });
});

// ── 2. Retention boundaries ───────────────────────────────────────────────────

describe('retention boundaries', () => {
    it('with 2 existing dumps (below retention=3) — no file is unlinked after the new dump', async () => {
        // BUILD — 2 old dumps + newly written = 3 total → at retention limit
        const existing = [backupFileName('2026-05-29T03:00:00Z'), backupFileName('2026-05-30T03:00:00Z')];
        setupSuccessfulRun(existing);
        mockReaddir.mockResolvedValue([...existing, EXPECTED_FILENAME] as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — retention=3, 3 total → nothing pruned
        expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('with 3 existing dumps (at retention) — after a new dump the oldest is deleted and 3 remain', async () => {
        // BUILD — 3 old dumps in dir after the new dump is written
        const oldestFile = backupFileName('2026-05-28T03:00:00Z');
        const existingAfterWrite = [oldestFile, backupFileName('2026-05-29T03:00:00Z'), backupFileName('2026-05-30T03:00:00Z'), EXPECTED_FILENAME];
        setupSuccessfulRun(existingAfterWrite);
        mockReaddir.mockResolvedValue(existingAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — 4 total, retention=3 → oldest deleted exactly once
        expect(mockUnlink).toHaveBeenCalledTimes(1);
        const deletedFileName = String(mockUnlink.mock.calls[0][0]).split('/').at(-1);
        expect(deletedFileName).toBe(oldestFile);
    });

    it('with 5 existing dumps — pruned to exactly 3 (newest retained, 2 oldest deleted)', async () => {
        // BUILD — 5 old dumps + newly written = 6 in dir after write
        const files = [
            backupFileName('2026-05-26T03:00:00Z'), // oldest — pruned
            backupFileName('2026-05-27T03:00:00Z'), // second oldest — pruned
            backupFileName('2026-05-28T03:00:00Z'), // third oldest — pruned
            backupFileName('2026-05-29T03:00:00Z'),
            backupFileName('2026-05-30T03:00:00Z'),
        ];
        const filesAfterWrite = [...files, EXPECTED_FILENAME];
        setupSuccessfulRun(filesAfterWrite);
        mockReaddir.mockResolvedValue(filesAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — 6 total, retention=3 → 3 deleted
        expect(mockUnlink).toHaveBeenCalledTimes(3);

        const deletedNames = mockUnlink.mock.calls.map((args) => String(args[0]).split('/').at(-1));

        // The 3 newest are NOT deleted
        expect(deletedNames).not.toContain(EXPECTED_FILENAME);
        expect(deletedNames).not.toContain(backupFileName('2026-05-30T03:00:00Z'));
        expect(deletedNames).not.toContain(backupFileName('2026-05-29T03:00:00Z'));

        // The 3 oldest are deleted
        expect(deletedNames).toContain(backupFileName('2026-05-26T03:00:00Z'));
        expect(deletedNames).toContain(backupFileName('2026-05-27T03:00:00Z'));
        expect(deletedNames).toContain(backupFileName('2026-05-28T03:00:00Z'));
    });

    it('with 0 existing dumps — first dump is kept and nothing is unlinked', async () => {
        // BUILD — empty dir after write
        setupSuccessfulRun([EXPECTED_FILENAME]);
        mockReaddir.mockResolvedValue([EXPECTED_FILENAME] as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        expect(mockUnlink).not.toHaveBeenCalled();
    });
});

// ── 3. Prune scope — unrelated files are never touched ───────────────────────

describe('prune scope', () => {
    it('never unlinks a file named README.md present in the backup dir', async () => {
        // BUILD
        const filesAfterWrite = [
            'README.md',
            backupFileName('2026-05-28T03:00:00Z'),
            backupFileName('2026-05-29T03:00:00Z'),
            backupFileName('2026-05-30T03:00:00Z'),
            EXPECTED_FILENAME,
        ];
        setupSuccessfulRun(filesAfterWrite);
        mockReaddir.mockResolvedValue(filesAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        const deletedNames = mockUnlink.mock.calls.map((args) => String(args[0]).split('/').at(-1));
        expect(deletedNames).not.toContain('README.md');
    });

    it('never unlinks a file with a manual backup_* prefix', async () => {
        // BUILD — manual backup alongside automated ones
        const manualBackup = 'backup_20260531_0300.sql.gz';
        const filesAfterWrite = [manualBackup, backupFileName('2026-05-29T03:00:00Z'), backupFileName('2026-05-30T03:00:00Z'), EXPECTED_FILENAME];
        setupSuccessfulRun(filesAfterWrite);
        mockReaddir.mockResolvedValue(filesAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — 4 files: manual + 3 automated → only automated files can be pruned
        const deletedNames = mockUnlink.mock.calls.map((args) => String(args[0]).split('/').at(-1));
        expect(deletedNames).not.toContain(manualBackup);
    });

    it('never unlinks an other.gz file that does not match the backup pattern', async () => {
        // BUILD
        const strayFile = 'other.gz';
        const filesAfterWrite = [
            strayFile,
            backupFileName('2026-05-28T03:00:00Z'),
            backupFileName('2026-05-29T03:00:00Z'),
            backupFileName('2026-05-30T03:00:00Z'),
            EXPECTED_FILENAME,
        ];
        setupSuccessfulRun(filesAfterWrite);
        mockReaddir.mockResolvedValue(filesAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        const deletedNames = mockUnlink.mock.calls.map((args) => String(args[0]).split('/').at(-1));
        expect(deletedNames).not.toContain(strayFile);
    });

    it('never unlinks a filename that contains ".." (path traversal candidate)', async () => {
        // BUILD — adversarial filename; anchored pattern also guards against this
        const traversalName = '../trade_bot_20260101_0000.sql.gz';
        const filesAfterWrite = [traversalName, EXPECTED_FILENAME];
        setupSuccessfulRun(filesAfterWrite);
        mockReaddir.mockResolvedValue(filesAfterWrite as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — traversal name does not match the pattern, so unlink never receives it
        const deletedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
        const deletedTraversal = deletedPaths.some((p) => p.includes('..'));
        expect(deletedTraversal).toBe(false);
    });
});

// ── 4. Disabled flag — no cron registered when feature is off ────────────────

describe('disabled flag (DB_BACKUP_ENABLED=false)', () => {
    it('does not register a cron job when DB_BACKUP_ENABLED is false', () => {
        // BUILD
        const appConfig = buildAppConfig({ dbBackupEnabled: false });
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), appConfig, schedulerRegistry);

        // OPERATE
        scheduler.onModuleInit();

        // CHECK
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('does not spawn pg_dump when disabled because no cron is registered', () => {
        // BUILD
        const appConfig = buildAppConfig({ dbBackupEnabled: false });
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), appConfig, schedulerRegistry);

        // OPERATE
        scheduler.onModuleInit();

        // CHECK — no cron registered; tick callback never wired up
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});

// ── 5. Dynamic cron honored ───────────────────────────────────────────────────

describe('dynamic cron registration (review H1)', () => {
    it('registers the cron under the db-backup job name when enabled', () => {
        // BUILD
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), buildAppConfig({ dbBackupEnabled: true }), schedulerRegistry);

        // OPERATE
        scheduler.onModuleInit();

        // CHECK
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
        const [jobName] = schedulerRegistry.addCronJob.mock.calls[0];
        expect(jobName).toBe(DB_BACKUP_CRON_JOB_NAME);
    });

    it('registers the non-default cron expression from config (not the hardcoded default)', () => {
        // BUILD
        const customCron = '*/5 * * * *';
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), buildAppConfig({ dbBackupEnabled: true, dbBackupCron: customCron }), schedulerRegistry);

        // OPERATE
        scheduler.onModuleInit();

        // CHECK — addCronJob received a CronJob instance (not null/undefined)
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
        const [, cronJobInstance] = schedulerRegistry.addCronJob.mock.calls[0];
        expect(cronJobInstance).toBeDefined();
    });

    it('deletes the cron job on module destroy to prevent double-registration on hot-reload', () => {
        // BUILD
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), buildAppConfig({ dbBackupEnabled: true }), schedulerRegistry);
        scheduler.onModuleInit(); // registers the job

        // OPERATE
        scheduler.onModuleDestroy();

        // CHECK
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(DB_BACKUP_CRON_JOB_NAME);
    });

    it('does not attempt to delete a cron job on destroy when the scheduler was disabled', () => {
        // BUILD — disabled, so no cron was registered
        const schedulerRegistry = buildSchedulerRegistry();
        const scheduler = buildScheduler(buildAlerts(), buildClock(), buildAppConfig({ dbBackupEnabled: false }), schedulerRegistry);
        scheduler.onModuleInit();

        // OPERATE
        scheduler.onModuleDestroy();

        // CHECK — deleteCronJob must not be called if nothing was registered
        expect(schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
    });
});

// ── 6. Re-entrancy mutex ──────────────────────────────────────────────────────

describe('re-entrancy mutex (review M4)', () => {
    it('skips a second concurrent runOnce call without spawning a second pg_dump', async () => {
        // BUILD — first runOnce does not settle immediately so the second call
        // overlaps it. We use a manually-resolved pipeline mock to control timing.
        let settlePipeline!: () => void;
        const pipelineBarrier = new Promise<void>((resolve) => {
            settlePipeline = resolve;
        });
        setupStreamMocks();
        mockPipeline.mockReturnValue(pipelineBarrier);

        // Child emits close immediately; awaitCleanExit resolves, but pipeline
        // keeps the Promise.all pending until we call settlePipeline.
        const child = buildMockChild(0);
        mockSpawn.mockReturnValue(child as never);

        const scheduler = buildScheduler();

        // OPERATE — fire first call (does not await yet)
        const firstCall = scheduler.runOnce(FIXED_NOW);

        // Second call fires while first is still in-flight
        const secondCall = scheduler.runOnce(FIXED_NOW);

        // Now settle the first dump and wire up the remainder of the success path
        mockRename.mockResolvedValue(undefined);
        mockStat.mockResolvedValue({ size: 512 } as never);
        mockRealpath.mockResolvedValue(RESOLVED_DIR);
        mockReaddir.mockResolvedValue([EXPECTED_FILENAME] as never);
        settlePipeline();

        await Promise.all([firstCall, secondCall]);

        // CHECK — spawn called only once; the second call was skipped
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('allows a subsequent runOnce to proceed after the first completes', async () => {
        // BUILD — standard successful run
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // Reset mocks for the second run
        jest.clearAllMocks();
        setupSuccessfulRun([EXPECTED_FILENAME]);

        await scheduler.runOnce(FIXED_NOW);

        // CHECK — second spawn happened (isRunning was reset to false)
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
});

// ── 7. Adversarial failure modes ─────────────────────────────────────────────

describe('adversarial failure modes', () => {
    // ── 7a. pg_dump exits non-zero ─────────────────────────────────────────────

    describe('pg_dump exits non-zero', () => {
        it('publishes exactly one ALERT_SINK alert with type=UNHANDLED_EXCEPTION', async () => {
            // BUILD — pipeline resolves but exit code is 1
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(alerts.publish).toHaveBeenCalledTimes(1);
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { type: string }).type).toBe(AlertTypeEnum.UNHANDLED_EXCEPTION);
        });

        it('publishes alert with severity=WARN', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { severity: string }).severity).toBe(AlertSeverityEnum.WARN);
        });

        it('publishes alert with data.reason=DB_BACKUP_FAILED', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { data: { reason: string } }).data.reason).toBe(DB_BACKUP_FAILED_REASON);
        });

        it('does not call rename (temp is never promoted) when dump fails', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — atomic write never promoted
            expect(mockRename).not.toHaveBeenCalled();
        });

        it('unlinks the .tmp file (orphan cleanup) when pg_dump exits non-zero', async () => {
            // BUILD — exit 1 triggers failure path; the .tmp must be removed
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            const child = buildMockChild(1);
            mockSpawn.mockReturnValue(child as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — unlink called once for the .tmp orphan (no prune unlinks since dump failed)
            expect(mockUnlink).toHaveBeenCalledTimes(1);
            const unlinkedPath = String(mockUnlink.mock.calls[0][0]);
            expect(unlinkedPath).toMatch(/\.tmp$/u);
        });

        it('resolves without throwing out of runOnce even when pg_dump exits non-zero', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE + CHECK
            await expect(scheduler.runOnce(FIXED_NOW)).resolves.toBeUndefined();
        });
    });

    // ── 7b. Pipeline / gzip stream error (NEW — paired tests for the H fix) ────

    describe('pipeline (gzip/stream) error', () => {
        it('publishes exactly one DB_BACKUP_FAILED alert when the pipeline rejects', async () => {
            // BUILD — pipeline throws a stream error (e.g. ENOSPC or gzip corruption)
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('ENOSPC: no space left on device'));
            // Child exits 0 but the pipeline already failed — failure wins
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(alerts.publish).toHaveBeenCalledTimes(1);
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { data: { reason: string } }).data.reason).toBe(DB_BACKUP_FAILED_REASON);
        });

        it('unlinks the .tmp file (orphan cleanup) when the pipeline rejects', async () => {
            // BUILD — orphan cleanup is mandatory; a partial .tmp must not linger
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('stream error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — unlink called once on the .tmp path
            expect(mockUnlink).toHaveBeenCalledTimes(1);
            const unlinkedPath = String(mockUnlink.mock.calls[0][0]);
            expect(unlinkedPath).toMatch(/\.tmp$/u);
        });

        it('does not rename (no dump promotion) when the pipeline rejects', async () => {
            // BUILD — a truncated .tmp is never promoted to the final filename
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('stream error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockRename).not.toHaveBeenCalled();
        });

        it('does not unlink any prior backup dump when the pipeline rejects (prior dumps untouched)', async () => {
            // BUILD — prune is skipped after any dump failure; prior good dumps are safe
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('stream error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            // unlink is called once (tmp cleanup) but never for a prior dump file
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — only the .tmp is unlinked; readdir / realpath never called
            expect(mockReaddir).not.toHaveBeenCalled();
            expect(mockRealpath).not.toHaveBeenCalled();
            const unlinkedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
            const priorDumpUnlinked = unlinkedPaths.some((p) => p.endsWith('.sql.gz'));
            expect(priorDumpUnlinked).toBe(false);
        });

        it('resolves without throwing out of runOnce when the pipeline rejects', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('stream error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE + CHECK
            await expect(scheduler.runOnce(FIXED_NOW)).resolves.toBeUndefined();
        });
    });

    // ── 7c. Success requires BOTH pipeline resolve AND exit code 0 ─────────────

    describe('success requires both pipeline resolve and exit code 0', () => {
        it('calls rename exactly once when pipeline resolves AND child exits 0', async () => {
            // BUILD — the golden path
            setupSuccessfulRun([EXPECTED_FILENAME]);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — both conditions met → rename promoted the dump
            expect(mockRename).toHaveBeenCalledTimes(1);
        });

        it('does not call rename when pipeline resolves but child exits non-zero', async () => {
            // BUILD — exit 1 → failure even though pipeline succeeded
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockRename).not.toHaveBeenCalled();
        });

        it('does not call rename when child exits 0 but pipeline rejects', async () => {
            // BUILD — stream error → failure even though child exited cleanly
            setupStreamMocks();
            mockPipeline.mockRejectedValue(new Error('gzip error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockRename).not.toHaveBeenCalled();
        });
    });

    // ── 7d. Spawn-level error (pg_dump not on PATH) ────────────────────────────

    describe('backup dir missing or spawn error (pg_dump not on PATH)', () => {
        it('publishes exactly one alert when spawn emits an error event', async () => {
            // BUILD — 'error' event from child (e.g. ENOENT: pg_dump not found)
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            const child = buildMockChild(undefined, new Error('ENOENT: pg_dump not found'));
            mockSpawn.mockReturnValue(child as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(alerts.publish).toHaveBeenCalledTimes(1);
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { type: string }).type).toBe(AlertTypeEnum.UNHANDLED_EXCEPTION);
        });

        it('resolves (does not crash) when spawn emits an error event', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            const child = buildMockChild(undefined, new Error('ENOENT'));
            mockSpawn.mockReturnValue(child as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE + CHECK
            await expect(scheduler.runOnce(FIXED_NOW)).resolves.toBeUndefined();
        });
    });

    // ── 7e. Prune step failure ─────────────────────────────────────────────────

    describe('prune step failure', () => {
        it('resolves as success (dump counted) even when readdir throws during prune', async () => {
            // BUILD — dump succeeds; readdir (prune step) throws
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockRename.mockResolvedValue(undefined);
            mockStat.mockResolvedValue({ size: 2048 } as never);
            mockRealpath.mockResolvedValue(RESOLVED_DIR);
            mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE + CHECK — no throw, prune failure is logged not alerted
            await expect(scheduler.runOnce(FIXED_NOW)).resolves.toBeUndefined();
        });

        it('does not publish an alert when only the prune step fails', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockRename.mockResolvedValue(undefined);
            mockStat.mockResolvedValue({ size: 2048 } as never);
            mockRealpath.mockResolvedValue(RESOLVED_DIR);
            mockReaddir.mockRejectedValue(new Error('disk error'));
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — alert is for dump failures only, not prune failures
            expect(alerts.publish).not.toHaveBeenCalled();
        });

        it('the rename (dump promotion) is still performed even when a subsequent prune fails', async () => {
            // BUILD
            setupStreamMocks();
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockRename.mockResolvedValue(undefined);
            mockStat.mockResolvedValue({ size: 2048 } as never);
            mockRealpath.mockResolvedValue(RESOLVED_DIR);
            mockReaddir.mockRejectedValue(new Error('disk error'));
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockRename).toHaveBeenCalledTimes(1);
        });
    });

    // ── 7f. Non-anchored filename in the dir is never unlinked ────────────────

    describe('non-anchored filename in the dir is never unlinked', () => {
        it('skips files that do not match the anchored backup pattern during prune', async () => {
            // BUILD — only non-matching files alongside the one valid backup;
            // retention=3 means nothing is pruned when only 1 match exists
            const nonMatchingFiles = [
                'trade_bot_backup.sql.gz', // no YYYYMMDD_HHMM
                'trade_bot_20260531.sql.gz', // missing _HHMM
                EXPECTED_FILENAME, // the only valid match
            ];
            setupSuccessfulRun(nonMatchingFiles);
            mockReaddir.mockResolvedValue(nonMatchingFiles as never);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — 1 matching file, retention=3 → nothing pruned
            expect(mockUnlink).not.toHaveBeenCalled();
        });
    });
});

// ── 8. Misconfig guard — non-test env + port-6900 DSN ─────────────────────────

describe('misconfig guard (review M2/N2)', () => {
    it('publishes an alert and does not spawn when NODE_ENV is not "test" and DSN targets port 6900', async () => {
        // BUILD — non-test env, port-6900 DSN (the M16 test-DB guard port)
        setupStreamMocks();
        const alerts = buildAlerts();
        const appConfig = buildAppConfig({
            nodeEnv: 'production',
            databaseUrl: 'postgresql://bot:secret@localhost:6900/trade_bot',
        });
        const scheduler = buildScheduler(alerts, buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — refused to spawn, alerted once
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0];
        expect((payload as { type: string }).type).toBe(AlertTypeEnum.UNHANDLED_EXCEPTION);
        expect((payload as { data: { reason: string } }).data.reason).toBe(DB_BACKUP_FAILED_REASON);
    });

    it('does not guard (allows spawn) when NODE_ENV is "test" even with port 6900 in DSN', async () => {
        // BUILD — in test mode the guard is skipped entirely
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const appConfig = buildAppConfig({
            nodeEnv: 'test',
            databaseUrl: 'postgresql://bot:secret@localhost:6900/trade_bot_test',
        });
        const scheduler = buildScheduler(buildAlerts(), buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — spawn was called (guard inactive in test mode)
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('does not guard when NODE_ENV is not "test" but DSN uses a non-test port', async () => {
        // BUILD — production env with a soak port (5433 ≠ 6900) → no guard
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const appConfig = buildAppConfig({
            nodeEnv: 'production',
            databaseUrl: 'postgresql://bot:secret@localhost:5433/trade_bot',
        });
        const scheduler = buildScheduler(buildAlerts(), buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — spawn was called (not the test port)
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
});

// ── 9. Credentials — never in spawn argv ─────────────────────────────────────

describe('secrets — credentials never in spawn argv', () => {
    it('spawns pg_dump without the DATABASE_URL string in the argv array', async () => {
        // BUILD
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — argv must not contain the DSN or the password
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [, argv] = mockSpawn.mock.calls[0];
        const argvJoined = (argv as string[]).join(' ');
        expect(argvJoined).not.toContain('postgresql://');
        expect(argvJoined).not.toContain('secret');
    });

    it('passes credentials via the child env (PGPASSWORD set in spawn options env)', async () => {
        // BUILD
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — libpq env vars present; no full process.env forwarded
        const [, , options] = mockSpawn.mock.calls[0];
        const childEnv = (options as { env: Record<string, string> }).env;
        expect(childEnv['PGPASSWORD']).toBe('secret');
        expect(childEnv['PGHOST']).toBe('localhost');
        expect(childEnv['PGDATABASE']).toBe('trade_bot');
    });
});
