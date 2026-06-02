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
    writeFile: jest.fn(),
}));

// pipeline lives in node:stream/promises — mock it at module level so the
// scheduler's spawnDumpToFile never blocks on a real stream.
jest.mock('node:stream/promises', () => ({
    pipeline: jest.fn(),
}));

// ─── imports after mocks ──────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import {
    BACKUP_FILENAME_EXTENSION,
    BACKUP_FILENAME_PATTERN,
    BACKUP_FILENAME_PREFIX,
    BACKUP_WRITE_PROBE_PREFIX,
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
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;

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

// Tracks every real CronJob instance handed to addCronJob so teardown can
// stop them.  Without this the live timer (start=true) keeps the event loop
// alive after the suite finishes.
const startedCronJobs: Array<{ stop: () => void }> = [];

function buildSchedulerRegistry() {
    return {
        addCronJob: jest.fn((_name: string, job: { stop: () => void }) => {
            startedCronJobs.push(job);
        }),
        deleteCronJob: jest.fn(),
    };
}

afterEach(() => {
    // splice empties the array up-front, so a throwing job.stop() can never
    // leave an orphan entry to bleed into the next test.
    const jobs = startedCronJobs.splice(0);
    for (const job of jobs) {
        job.stop();
    }
});

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

// Configures a full successful run: writability probe passes, pipeline resolves,
// child exits 0, prune infrastructure (realpath/readdir/rename/stat/unlink) all succeed.
function setupSuccessfulRun(existingFiles: string[]) {
    setupStreamMocks();
    mockWriteFile.mockResolvedValue(undefined);
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
    it('with 2 existing dumps (below retention=3) — no backup file is unlinked after the new dump', async () => {
        // BUILD — 2 old dumps + newly written = 3 total → at retention limit
        const existing = [backupFileName('2026-05-29T03:00:00Z'), backupFileName('2026-05-30T03:00:00Z')];
        setupSuccessfulRun(existing);
        mockReaddir.mockResolvedValue([...existing, EXPECTED_FILENAME] as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — retention=3, 3 total → no backup files pruned.
        // The probe unlink (`.write_probe_<pid>`) fires once per run; filter it out.
        const deletedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
        const prunedBackups = deletedPaths.filter((p) => BACKUP_FILENAME_PATTERN.test(p.split('/').at(-1) as string));
        expect(prunedBackups).toHaveLength(0);
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

        // CHECK — 4 total, retention=3 → exactly one backup file deleted.
        // Filter out the probe unlink (`.write_probe_<pid>`) before asserting prune count.
        const deletedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
        const prunedBackups = deletedPaths.filter((p) => BACKUP_FILENAME_PATTERN.test(p.split('/').at(-1) as string));
        expect(prunedBackups).toHaveLength(1);
        expect(prunedBackups[0]!.split('/').at(-1)).toBe(oldestFile);
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

        // CHECK — 6 total, retention=3 → 3 backup files deleted.
        // Filter out the probe unlink (`.write_probe_<pid>`) before asserting prune count.
        const deletedNames = mockUnlink.mock.calls
            .map((args) => String(args[0]).split('/').at(-1) as string)
            .filter((name) => BACKUP_FILENAME_PATTERN.test(name));
        expect(deletedNames).toHaveLength(3);

        // The 3 newest are NOT deleted
        expect(deletedNames).not.toContain(EXPECTED_FILENAME);
        expect(deletedNames).not.toContain(backupFileName('2026-05-30T03:00:00Z'));
        expect(deletedNames).not.toContain(backupFileName('2026-05-29T03:00:00Z'));

        // The 3 oldest are deleted
        expect(deletedNames).toContain(backupFileName('2026-05-26T03:00:00Z'));
        expect(deletedNames).toContain(backupFileName('2026-05-27T03:00:00Z'));
        expect(deletedNames).toContain(backupFileName('2026-05-28T03:00:00Z'));
    });

    it('with 0 existing dumps — first dump is kept and no backup files are unlinked', async () => {
        // BUILD — empty dir after write
        setupSuccessfulRun([EXPECTED_FILENAME]);
        mockReaddir.mockResolvedValue([EXPECTED_FILENAME] as never);
        const scheduler = buildScheduler();

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — no backup files pruned (probe unlink is not a backup file)
        const deletedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
        const prunedBackups = deletedPaths.filter((p) => BACKUP_FILENAME_PATTERN.test(p.split('/').at(-1) as string));
        expect(prunedBackups).toHaveLength(0);
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
        mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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

        it('publishes alert with severity=CRITICAL (M17 escalation from WARN)', async () => {
            // BUILD — M17 hardening escalated dump-failure alerts from WARN to CRITICAL
            setupStreamMocks();
            mockWriteFile.mockResolvedValue(undefined);
            mockPipeline.mockResolvedValue(undefined);
            mockSpawn.mockReturnValue(buildMockChild(1) as never);
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            const [payload] = alerts.publish.mock.calls[0];
            expect((payload as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
        });

        it('publishes alert with data.reason=DB_BACKUP_FAILED', async () => {
            // BUILD
            setupStreamMocks();
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
            mockPipeline.mockResolvedValue(undefined);
            const child = buildMockChild(1);
            mockSpawn.mockReturnValue(child as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — the .tmp path must be among the unlinked paths.
            // Two unlinks total: probe (`.write_probe_<pid>`) + .tmp orphan.
            const unlinkedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
            const tmpUnlinked = unlinkedPaths.some((p) => p.endsWith('.tmp'));
            expect(tmpUnlinked).toBe(true);
        });

        it('resolves without throwing out of runOnce even when pg_dump exits non-zero', async () => {
            // BUILD
            setupStreamMocks();
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
            mockPipeline.mockRejectedValue(new Error('stream error'));
            mockSpawn.mockReturnValue(buildMockChild(0) as never);
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — the .tmp path must be among the unlinked paths.
            // Two unlinks total: probe (`.write_probe_<pid>`) + .tmp orphan.
            const unlinkedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
            const tmpUnlinked = unlinkedPaths.some((p) => p.endsWith('.tmp'));
            expect(tmpUnlinked).toBe(true);
        });

        it('does not rename (no dump promotion) when the pipeline rejects', async () => {
            // BUILD — a truncated .tmp is never promoted to the final filename
            setupStreamMocks();
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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
            mockWriteFile.mockResolvedValue(undefined);
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

            // CHECK — 1 matching backup file, retention=3 → no backup files pruned.
            // The probe unlink (`.write_probe_<pid>`) is excluded from this assertion.
            const deletedPaths = mockUnlink.mock.calls.map((args) => String(args[0]));
            const prunedBackups = deletedPaths.filter((p) => BACKUP_FILENAME_PATTERN.test(p.split('/').at(-1) as string));
            expect(prunedBackups).toHaveLength(0);
        });
    });
});

// ── 8. Misconfig guard — non-test env + port-6900 DSN ─────────────────────────

describe('misconfig guard (review M2/N2)', () => {
    it('publishes an alert and does not spawn when NODE_ENV is not "test" and DSN targets port 6900', async () => {
        // BUILD — non-test env, port-6900 DSN (the M16 test-DB guard port)
        // Note: assertNotTestDatabase() throws BEFORE assertDirWritable(), so writeFile
        // is never reached in this path. No writeFile mock needed here.
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
        // BUILD — production env with the soak port (5432 ≠ 6900) → no guard
        setupSuccessfulRun([EXPECTED_FILENAME]);
        const appConfig = buildAppConfig({
            nodeEnv: 'production',
            databaseUrl: 'postgresql://bot:secret@localhost:5432/trade_bot',
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

// ── 10. Pre-flight writability probe (M17 hardening) ─────────────────────────
//
// assertDirWritable() writes `.write_probe_<pid>` then unlinks it before pg_dump
// spawns. A stale / missing bind mount is now caught loudly before any wasted
// spawn. These tests verify the three fix items:
//   Fix-1: probe file is created and removed; pg_dump spawns exactly once on success.
//   Fix-2: probe write failure → DbBackupFailedException, no spawn, CRITICAL alert.
//   Fix-3: probe filename never matches BACKUP_FILENAME_PATTERN.

describe('pre-flight writability probe (M17 hardening)', () => {
    // ── 10a. Writable dir: probe created+removed, pg_dump spawns ──────────────

    describe('when the backup dir is writable', () => {
        it('calls writeFile once with a path rooted in the backup dir before spawn', async () => {
            // BUILD
            setupSuccessfulRun([EXPECTED_FILENAME]);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — probe write happened once, path is inside the backup dir
            expect(mockWriteFile).toHaveBeenCalledTimes(1);
            const [probePath] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
            expect(probePath).toContain(BACKUP_DIR);
        });

        it('unlinks the probe file (no straggler) after the dump succeeds', async () => {
            // BUILD — unlink is called at least once for the probe itself; the
            // dump succeeds so no .tmp cleanup unlink occurs.
            setupSuccessfulRun([EXPECTED_FILENAME]);
            mockReaddir.mockResolvedValue([] as never); // empty dir → no prune unlinks
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — unlink is called exactly once: the probe (no .tmp, no prune)
            expect(mockUnlink).toHaveBeenCalledTimes(1);
            const [unlinkedPath] = mockUnlink.mock.calls[0] as [string, ...unknown[]];
            expect(unlinkedPath).toContain(BACKUP_WRITE_PROBE_PREFIX);
        });

        it('spawns pg_dump exactly once when the probe succeeds', async () => {
            // BUILD
            setupSuccessfulRun([EXPECTED_FILENAME]);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — one spawn, one probe write — not two (no double-probe)
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(mockWriteFile).toHaveBeenCalledTimes(1);
        });

        it('logs dbBackup.dump.ok after a successful probe and dump', async () => {
            // BUILD — confirm the happy path is end-to-end intact after probe addition
            setupSuccessfulRun([EXPECTED_FILENAME]);
            const scheduler = buildScheduler();
            const logSpy = jest.spyOn((scheduler as unknown as { logger: { log: jest.Mock } }).logger, 'log');

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — success log emitted (regression guard: probe must not swallow success path)
            const successLog = logSpy.mock.calls.some((args) => String(args[0]).includes('dbBackup.dump.ok'));
            expect(successLog).toBe(true);
        });
    });

    // ── 10b. Unwritable dir: throws before spawn, CRITICAL alert ─────────────

    describe('when the backup dir is not writable (stale mount / ENOENT)', () => {
        function buildEnoentError(): Error {
            const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
            err.code = 'ENOENT';

            return err;
        }

        it('does NOT spawn pg_dump when writeFile rejects with ENOENT', async () => {
            // BUILD — simulate the stale-mount regression: the probe fails
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — exact regression: pg_dump must NEVER be reached
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('publishes exactly one CRITICAL alert when writeFile rejects', async () => {
            // BUILD
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — one alert, severity CRITICAL
            expect(alerts.publish).toHaveBeenCalledTimes(1);
            const [payload] = alerts.publish.mock.calls[0] as [{ severity: string }[]];
            expect((payload as unknown as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
        });

        it('resolves (does not throw out of runOnce) when writeFile rejects', async () => {
            // BUILD
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE + CHECK — runOnce absorbs all dump failures
            await expect(scheduler.runOnce(FIXED_NOW)).resolves.toBeUndefined();
        });

        it('includes the ENOENT cause detail in the alert body when probe fails', async () => {
            // BUILD — the alert body must carry the actual failure reason, not just a static msg
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const alerts = buildAlerts();
            const scheduler = buildScheduler(alerts);

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — the carried cause string appears in the body
            const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
            const body = (payload as unknown as { body: string }).body;
            expect(body).toContain('ENOENT');
        });

        it('does not call rename when probe write fails (no .tmp promotion)', async () => {
            // BUILD
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockRename).not.toHaveBeenCalled();
        });

        it('does not call readdir/realpath (no prune attempt) when probe write fails', async () => {
            // BUILD — prune is skipped entirely on any dump failure
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK
            expect(mockReaddir).not.toHaveBeenCalled();
            expect(mockRealpath).not.toHaveBeenCalled();
        });

        it('still attempts probe unlink in the finally block even though write failed', async () => {
            // BUILD — the finally-unlink must run even when writeFile rejects
            setupStreamMocks();
            mockWriteFile.mockRejectedValue(buildEnoentError());
            mockUnlink.mockResolvedValue(undefined);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — unlink was called once (the probe cleanup in the finally block)
            // The probe path was never created, but the finally-unlink fires regardless.
            // unlink is mocked to resolve, so no secondary error from the cleanup.
            expect(mockUnlink).toHaveBeenCalledTimes(1);
            const [unlinkedPath] = mockUnlink.mock.calls[0] as [string, ...unknown[]];
            expect(unlinkedPath).toContain(BACKUP_WRITE_PROBE_PREFIX);
        });
    });

    // ── 10c. Probe filename never matches BACKUP_FILENAME_PATTERN ─────────────

    describe('probe filename shape', () => {
        it('the probe filename does NOT match BACKUP_FILENAME_PATTERN (pruner never touches it)', () => {
            // BUILD — probe path is `.write_probe_<pid>`; verify the shape directly
            const probeName = `${BACKUP_WRITE_PROBE_PREFIX}${process.pid}`;

            // CHECK — the regex must NOT match so the pruner can never delete a straggler probe
            expect(BACKUP_FILENAME_PATTERN.test(probeName)).toBe(false);
        });

        it('the probe filename starts with the BACKUP_WRITE_PROBE_PREFIX constant', async () => {
            // BUILD — confirm the actual path written to disk uses the correct prefix
            setupSuccessfulRun([]);
            mockReaddir.mockResolvedValue([] as never);
            const scheduler = buildScheduler();

            // OPERATE
            await scheduler.runOnce(FIXED_NOW);

            // CHECK — writeFile received a path whose basename starts with the probe prefix
            const [probePath] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
            const probeName = probePath.split('/').at(-1) as string;
            expect(probeName.startsWith(BACKUP_WRITE_PROBE_PREFIX)).toBe(true);
        });

        it('the probe path encodes process.pid so two distinct pids produce distinct paths', () => {
            // BUILD — construct the probe names for two imaginary pids
            const pidA = 12345;
            const pidB = 99999;
            const probeA = `${BACKUP_WRITE_PROBE_PREFIX}${pidA}`;
            const probeB = `${BACKUP_WRITE_PROBE_PREFIX}${pidB}`;

            // CHECK — different pids → different probe paths (no collision between processes)
            expect(probeA).not.toBe(probeB);
            expect(probeA).toContain(String(pidA));
            expect(probeB).toContain(String(pidB));
        });
    });
});

// ── 11. Surface real cause via describeWithCause (M17 hardening) ──────────────
//
// alertDumpFailed() must include the DomainException's carried `cause` detail in
// BOTH the logger.error call and the alert body. Without this fix the real failure
// reason (pg_dump stderr tail / "nonexistent directory") was silently dropped.

describe('failure cause surfaced in alert body and error log (M17 hardening)', () => {
    // ── 11a. DbBackupFailedException carries cause → alert body includes it ────

    it('alert body includes the carried cause string from DbBackupFailedException', async () => {
        // BUILD — simulate a probe failure carrying a known sentinel cause string
        const SENTINEL_CAUSE = 'nonexistent directory — mount may be stale';
        setupStreamMocks();
        // Force the probe to throw with the sentinel detail in the message
        mockWriteFile.mockRejectedValue(new Error(SENTINEL_CAUSE));
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — the body must contain the carried cause, not just the static message
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
        const body = (payload as unknown as { body: string }).body;
        expect(body).toContain(SENTINEL_CAUSE);
    });

    it('alert body does not contain a bare "[object Object]" (non-Error cause handled gracefully)', async () => {
        // BUILD — simulate an unusual throw of a plain object (not an Error)
        setupStreamMocks();
        mockWriteFile.mockRejectedValue({ code: 'ESTALE', message: 'stale file handle' });
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — must not crash and must not produce "[object Object]" in the body
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
        const body = (payload as unknown as { body: string }).body;
        expect(body).not.toContain('[object Object]');
    });

    it('logger.error call includes the carried cause detail', async () => {
        // BUILD — the error log must carry the actual failure reason, not just the static msg.
        // We simulate a probe failure (synchronous path) so the cause is deterministically
        // captured in the logger call. The pg_dump stderr approach is timing-sensitive
        // (captureStderrTail reads after close, data may not have arrived yet via setImmediate).
        const SENTINEL_CAUSE = 'FATAL: role does not exist';
        setupStreamMocks();
        // Probe fails with the sentinel message → DbBackupFailedException wraps it
        mockWriteFile.mockRejectedValue(new Error(SENTINEL_CAUSE));
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);
        const logSpy = jest.spyOn((scheduler as unknown as { logger: { error: jest.Mock } }).logger, 'error');

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — the dbBackup.dump.failed error log must contain the sentinel cause
        const errorLogLine = logSpy.mock.calls.find((args) => String(args[0]).includes('dbBackup.dump.failed'));
        expect(errorLogLine).toBeDefined();
        expect(String(errorLogLine?.[0])).toContain(SENTINEL_CAUSE);
    });
});

// ── 12. Severity escalation: dump failure alert must be CRITICAL ──────────────
//
// The M17 hardening escalated the dump-failure alert from WARN to CRITICAL.
// These tests pin that requirement so a future regression (re-downgrading to WARN)
// is immediately visible.

describe('dump failure alert severity is CRITICAL (M17 hardening)', () => {
    it('publishes severity=CRITICAL (not WARN) when pg_dump exits non-zero', async () => {
        // BUILD — any dump failure must use AlertSeverityEnum.CRITICAL
        setupStreamMocks();
        mockWriteFile.mockResolvedValue(undefined);
        mockPipeline.mockResolvedValue(undefined);
        mockSpawn.mockReturnValue(buildMockChild(1) as never);
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — CRITICAL, never WARN
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0] as [{ severity: string }[]];
        expect((payload as unknown as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
        expect((payload as unknown as { severity: string }).severity).not.toBe(AlertSeverityEnum.WARN);
    });

    it('publishes severity=CRITICAL when pipeline rejects', async () => {
        // BUILD
        setupStreamMocks();
        mockWriteFile.mockResolvedValue(undefined);
        mockPipeline.mockRejectedValue(new Error('ENOSPC: no space left on device'));
        mockSpawn.mockReturnValue(buildMockChild(0) as never);
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        const [payload] = alerts.publish.mock.calls[0] as [{ severity: string }[]];
        expect((payload as unknown as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
    });

    it('publishes severity=CRITICAL when the writability probe fails', async () => {
        // BUILD — the most direct path to the new fix: probe ENOENT → CRITICAL alert
        setupStreamMocks();
        mockWriteFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0] as [{ severity: string }[]];
        expect((payload as unknown as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
    });

    it('publishes severity=CRITICAL when the misconfig guard fires (non-test env + test port)', async () => {
        // BUILD — misconfig guard throws DbBackupFailedException before the probe
        setupStreamMocks();
        const alerts = buildAlerts();
        const appConfig = buildAppConfig({
            nodeEnv: 'production',
            databaseUrl: 'postgresql://bot:secret@localhost:6900/trade_bot',
        });
        const scheduler = buildScheduler(alerts, buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        expect(alerts.publish).toHaveBeenCalledTimes(1);
        const [payload] = alerts.publish.mock.calls[0] as [{ severity: string }[]];
        expect((payload as unknown as { severity: string }).severity).toBe(AlertSeverityEnum.CRITICAL);
    });
});

// ── 13. Credential safety — password absent from alert body ──────────────────
//
// Even when a DSN with a password is configured, the alert body published to
// Telegram must never contain the raw password or the full DSN string.

describe('credential safety — password absent from alert body and logs', () => {
    const DSN_WITH_PASSWORD = 'postgresql://bot:supersecretpassword@localhost:5432/trade_bot';

    it('alert body does not contain the database password when probe fails', async () => {
        // BUILD — use a DSN whose password is a recognisable sentinel
        setupStreamMocks();
        mockWriteFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const appConfig = buildAppConfig({ databaseUrl: DSN_WITH_PASSWORD });
        const scheduler = buildScheduler(alerts, buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — password must NOT appear in the alert body
        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
        const body = (payload as unknown as { body: string }).body;
        expect(body).not.toContain('supersecretpassword');
    });

    it('alert body does not contain the full DATABASE_URL string when probe fails', async () => {
        // BUILD
        setupStreamMocks();
        mockWriteFile.mockRejectedValue(new Error('ENOENT'));
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const appConfig = buildAppConfig({ databaseUrl: DSN_WITH_PASSWORD });
        const scheduler = buildScheduler(alerts, buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK — full DSN must not appear in the body
        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
        const body = (payload as unknown as { body: string }).body;
        expect(body).not.toContain(DSN_WITH_PASSWORD);
    });

    it('alert body does not contain the password when pg_dump exits non-zero', async () => {
        // BUILD — pg_dump path: password flows via PGPASSWORD child env, must not leak back into alert
        setupStreamMocks();
        mockWriteFile.mockResolvedValue(undefined);
        mockPipeline.mockResolvedValue(undefined);
        mockSpawn.mockReturnValue(buildMockChild(1) as never);
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const appConfig = buildAppConfig({ databaseUrl: DSN_WITH_PASSWORD });
        const scheduler = buildScheduler(alerts, buildClock(), appConfig);

        // OPERATE
        await scheduler.runOnce(FIXED_NOW);

        // CHECK
        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];
        const body = (payload as unknown as { body: string }).body;
        expect(body).not.toContain('supersecretpassword');
    });
});

// ── 14. describe() asymmetric field coverage for non-Error plain objects ──────
//
// The parts-filter join in describe() must handle objects that carry only one
// of the two recognised fields (code / message) without producing stray
// punctuation, and must fall back to JSON for objects that carry neither.
// Each case is paired directly to a specific asymmetric input so a regression
// in any branch is immediately pinned to the exact cause shape.

describe('describe() serialisation — asymmetric non-Error object fields (M17 hardening)', () => {
    // Helper: run a probe-failure scenario and return the published alert body.
    async function publishedBodyFor(cause: unknown): Promise<string> {
        setupStreamMocks();
        mockWriteFile.mockRejectedValue(cause);
        mockUnlink.mockResolvedValue(undefined);
        const alerts = buildAlerts();
        const scheduler = buildScheduler(alerts);

        await scheduler.runOnce(FIXED_NOW);

        const [payload] = alerts.publish.mock.calls[0] as [{ body: string }[]];

        return (payload as unknown as { body: string }).body;
    }

    it('code-only object: body contains the code string and no trailing colon artifact', async () => {
        // BUILD — object has `code` but no `message`; parts-join must produce 'ESTALE', NOT 'ESTALE:'
        // OPERATE
        const body = await publishedBodyFor({ code: 'ESTALE' });

        // CHECK
        expect(body).toContain('ESTALE');
        expect(body).not.toContain('[object Object]');
        // A stray trailing colon from describe() itself would produce a double separator:
        // wrapper "…stale: " + describe artifact "ESTALE: " → "stale: ESTALE: " (two colons close together).
        // Assert no double-colon separator appears anywhere in the body.
        expect(body).not.toMatch(/: :\s/u);
    });

    it('message-only object: body contains the message and no leading ": " artifact', async () => {
        // BUILD — object has `message` but no `code`; parts-join must produce 'stale file handle',
        // NOT ': stale file handle'. The wrapper already contributes one "stale: " separator; if
        // describe() also emitted a leading colon the body would read "stale: : stale file handle".
        // OPERATE
        const body = await publishedBodyFor({ message: 'stale file handle' });

        // CHECK
        expect(body).toContain('stale file handle');
        expect(body).not.toContain('[object Object]');
        // A stray leading colon from describe() would produce a double-colon in the body.
        expect(body).not.toMatch(/: :\s/u);
    });

    it('neither-code-nor-message object: body falls back to JSON containing the actual fields', async () => {
        // BUILD — object has neither string `code` nor `message`; must JSON-serialise,
        // NOT collapse to '[object Object]'
        // OPERATE
        const body = await publishedBodyFor({ errno: -116 });

        // CHECK — JSON representation surfaced so the operator sees something useful
        expect(body).not.toContain('[object Object]');
        // The JSON fallback must include the field name and value
        expect(body).toContain('errno');
        expect(body).toContain('-116');
    });
});
