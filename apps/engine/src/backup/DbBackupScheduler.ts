import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import { CLOCK, IClock } from '../common/clock/Clock';
import { NodeEnvEnum } from '../config/enum';
import { AppConfigService } from '../config/service';
import {
    BACKUP_FILENAME_EXTENSION,
    BACKUP_FILENAME_PATTERN,
    BACKUP_FILENAME_PREFIX,
    BACKUP_TMP_SUFFIX,
    DB_BACKUP_CRON_JOB_NAME,
    DB_BACKUP_FAILED_REASON,
    PG_DUMP_PORTABILITY_FLAGS,
    STDERR_CAPTURE_BYTES,
    TEST_DB_GUARD_PORT,
} from './const';
import { DbBackupFailedException } from './exception';

// M17 — automated daily DB backup (ADR plan docs/plans/M17-daily-db-backup.md).
//
// Mirrors RevokedJtiPruneScheduler/DailyPnlSummaryScheduler but registers its
// cron DYNAMICALLY in onModuleInit via SchedulerRegistry (review H1): NestJS
// evaluates @Cron() decorator args before DI, so a config-driven expression
// cannot reach the decorator. Registration is guarded behind DB_BACKUP_ENABLED
// so test/CI never spawns pg_dump.
//
// The dump is READ-ONLY pg_dump (never a mutate/drop/revert — CLAUDE.md rule
// 9). It streams atomically to `<name>.tmp` and is renamed on a clean exit, so
// a crashed/partial dump is never promoted. Credentials flow via DATABASE_URL
// in the child env — never as a logged argv string, never logged at all.

@Injectable()
export class DbBackupScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(DbBackupScheduler.name);

    // Re-entrancy mutex (review M4): a tick firing while a dump is in progress
    // is skipped, never spawning a second concurrent pg_dump against soak.
    private isRunning = false;

    private isCronRegistered = false;

    constructor(
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Inject(CLOCK) private readonly clock: IClock,
        private readonly appConfig: AppConfigService,
        private readonly schedulerRegistry: SchedulerRegistry,
    ) {}

    onModuleInit(): void {
        if (!this.appConfig.dbBackupEnabled) {
            this.logger.debug('dbBackup.disabled reason=DB_BACKUP_ENABLED=false noCronRegistered');

            return;
        }

        this.registerCronJob();
    }

    onModuleDestroy(): void {
        if (!this.isCronRegistered) {
            return;
        }

        this.schedulerRegistry.deleteCronJob(DB_BACKUP_CRON_JOB_NAME);
        this.isCronRegistered = false;
    }

    // Public entrypoint for tests — pure on the injected clock. Builds the
    // timestamped filename, dumps, then prunes. The dump and prune are private
    // steps (command-query separation).
    async runOnce(now: Date): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('dbBackup.skip reason=alreadyRunning');

            return;
        }

        this.isRunning = true;

        try {
            await this.backupThenPrune(now);
        } finally {
            this.isRunning = false;
        }
    }

    private registerCronJob(): void {
        const job = new CronJob(
            this.appConfig.dbBackupCron,
            () => {
                void this.onTick().catch((cause) => this.logger.error(`dbBackup.tick.failed cause=${describe(cause)}`));
            },
            null,
            true,
            'UTC',
        );

        this.schedulerRegistry.addCronJob(DB_BACKUP_CRON_JOB_NAME, job);
        this.isCronRegistered = true;
        this.logger.log(`dbBackup.cron.registered cron='${this.appConfig.dbBackupCron}' dir='${this.appConfig.dbBackupDir}'`);
    }

    private async onTick(): Promise<void> {
        await this.runOnce(this.clock.now());
    }

    private async backupThenPrune(now: Date): Promise<void> {
        const dir = this.appConfig.dbBackupDir;
        const fileName = buildBackupFileName(now);

        try {
            const sizeBytes = await this.dump(dir, fileName);
            this.logger.log(`dbBackup.dump.ok file=${fileName} bytes=${sizeBytes}`);
        } catch (cause) {
            await this.alertDumpFailed(cause, now);

            return;
        }

        await this.pruneSafely(dir);
    }

    private async dump(dir: string, fileName: string): Promise<number> {
        this.assertNotTestDatabase();

        const finalPath = join(dir, fileName);
        const tmpPath = `${finalPath}${BACKUP_TMP_SUFFIX}`;

        await this.spawnDumpToFile(tmpPath);
        await rename(tmpPath, finalPath);

        const { size } = await stat(finalPath);

        return size;
    }

    // Spawns pg_dump (argv array — NOT a shell string, review M3) and streams
    // its stdout through gzip into the temp file. Success requires BOTH the
    // pg_dump exit code to be 0 AND the gzip→file pipeline to flush without
    // error — so a truncated `.tmp` under backpressure is never promoted, and a
    // gzip/stdout stream error can never escape as an unhandled rejection. On
    // any failure the partial `.tmp` is removed before the error propagates.
    // Credentials flow EXCLUSIVELY via libpq PG* env vars (nothing sensitive in
    // argv / the process table) and the connection string is NEVER logged.
    private async spawnDumpToFile(tmpPath: string): Promise<void> {
        const child = spawn('pg_dump', PG_DUMP_PORTABILITY_FLAGS, {
            env: buildLibpqEnv(this.appConfig.databaseUrl),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stderr = captureStderrTail(child);

        try {
            await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(tmpPath)), awaitCleanExit(child, stderr)]);
        } catch (cause) {
            await unlink(tmpPath).catch(() => undefined);

            throw cause instanceof DbBackupFailedException ? cause : new DbBackupFailedException('pg_dump pipeline', describe(cause));
        }
    }

    // M16 misconfig guard (review M2/N2): outside tests, refuse to dump a
    // DATABASE_URL pointing at the ephemeral test DB port so a mistyped DSN
    // never dumps (and prunes around) the wrong database.
    private assertNotTestDatabase(): void {
        if (this.appConfig.nodeEnv === NodeEnvEnum.TEST) {
            return;
        }

        const port = parseDatabasePort(this.appConfig.databaseUrl);

        if (port === TEST_DB_GUARD_PORT) {
            throw new DbBackupFailedException('refusing test DB', `DATABASE_URL port is the M16 test-DB port ${TEST_DB_GUARD_PORT}`);
        }
    }

    private async pruneSafely(dir: string): Promise<void> {
        try {
            await this.prune(dir);
        } catch (cause) {
            this.logger.error(`dbBackup.prune.failed cause=${describe(cause)}`);
        }
    }

    // Retention step: list the dir, keep ONLY anchored-pattern matches, sort
    // newest-first by embedded timestamp (mtime fallback), unlink everything
    // past the retention depth. Resolves the dir with realpath and rejects any
    // `..` before any unlink (review L3). NEVER touches a non-matching file.
    private async prune(dir: string): Promise<void> {
        const resolvedDir = await realpath(dir);
        const candidates = await this.listBackupFiles(resolvedDir);
        const expired = candidates.slice(this.appConfig.dbBackupRetention);

        for (const file of expired) {
            await this.unlinkBackup(resolvedDir, file.name);
        }
    }

    private async listBackupFiles(resolvedDir: string): Promise<ReadonlyArray<BackupFile>> {
        const entries = await readdir(resolvedDir);
        const matches = entries.filter((name) => BACKUP_FILENAME_PATTERN.test(name));
        const files = await Promise.all(matches.map((name) => this.describeBackupFile(resolvedDir, name)));

        return files.sort(byTimestampDescending);
    }

    private async describeBackupFile(resolvedDir: string, name: string): Promise<BackupFile> {
        const sortKey = embeddedTimestampKey(name) ?? (await mtimeKey(resolvedDir, name));

        return { name, sortKey };
    }

    private async unlinkBackup(resolvedDir: string, name: string): Promise<void> {
        if (name.includes('..') || !BACKUP_FILENAME_PATTERN.test(name)) {
            this.logger.warn(`dbBackup.prune.refused name='${name}' reason=nonAnchoredOrTraversal`);

            return;
        }

        await unlink(join(resolvedDir, name));
        this.logger.log(`dbBackup.prune.deleted file=${name}`);
    }

    private async alertDumpFailed(cause: unknown, now: Date): Promise<void> {
        this.logger.error(`dbBackup.dump.failed reason=${DB_BACKUP_FAILED_REASON} cause=${describe(cause)}`);

        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.WARN,
            occurredAt: now.toISOString(),
            title: 'Daily DB backup failed',
            body: `pg_dump backup failed. Reason=${DB_BACKUP_FAILED_REASON}. cause=${describe(cause)}`,
            data: { reason: DB_BACKUP_FAILED_REASON },
        };

        try {
            await this.alerts.publish(payload);
        } catch (alertCause) {
            this.logger.warn(`dbBackup.alert.failed cause=${describe(alertCause)}`);
        }
    }
}

// File-private association of a backup filename with its sort key. Not a
// public contract — a local `type`, not an exported `I`-interface.
type BackupFile = { name: string; sortKey: number };

// Captures the trailing bytes of pg_dump stderr so a non-zero exit can report
// the actual cause. Returns a getter so the close handler reads the final tail.
function captureStderrTail(child: ReturnType<typeof spawn>): () => string {
    let tail = '';

    child.stderr?.on('data', (chunk: Buffer) => {
        tail = `${tail}${chunk.toString('utf8')}`.slice(-STDERR_CAPTURE_BYTES);
    });

    return () => tail.trim();
}

// Resolves only when pg_dump exits with code 0; otherwise rejects with a domain
// error carrying the exit code + captured stderr tail. A spawn-level 'error'
// (e.g. pg_dump not on PATH) also rejects wrapped.
function awaitCleanExit(child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        child.on('error', (cause) => reject(new DbBackupFailedException('spawn pg_dump', describe(cause))));

        child.on('close', (code) => {
            if (code === 0) {
                resolve();

                return;
            }

            reject(new DbBackupFailedException('pg_dump exited non-zero', `code=${code} stderr=${stderr()}`));
        });
    });
}

// trade_bot_<YYYYMMDD_HHMM>.sql.gz from the UTC instant of `now`.
function buildBackupFileName(now: Date): string {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const min = String(now.getUTCMinutes()).padStart(2, '0');

    return `${BACKUP_FILENAME_PREFIX}${yyyy}${mm}${dd}_${hh}${min}${BACKUP_FILENAME_EXTENSION}`;
}

// Sort key from the embedded YYYYMMDD_HHMM (review L2 — primary key). Returns
// undefined for a name that does not carry a parseable timestamp so the caller
// can `??`-fall back to mtime.
function embeddedTimestampKey(name: string): number | undefined {
    const match = BACKUP_FILENAME_PATTERN.exec(name);

    if (match === null) {
        return undefined;
    }

    const parsed = Number.parseInt(`${match[1]}${match[2]}`, 10);

    return Number.isNaN(parsed) ? undefined : parsed;
}

async function mtimeKey(resolvedDir: string, name: string): Promise<number> {
    const { mtimeMs } = await stat(join(resolvedDir, name));

    return mtimeMs;
}

function byTimestampDescending(left: BackupFile, right: BackupFile): number {
    return right.sortKey - left.sortKey;
}

// Parses the TCP port from a postgres connection URL. The URL itself is never
// logged here — only the integer port is returned.
function parseDatabasePort(databaseUrl: string): number | null {
    try {
        const port = new URL(databaseUrl).port;

        return port.length > 0 ? Number.parseInt(port, 10) : null;
    } catch {
        return null;
    }
}

// Builds a MINIMAL child env for pg_dump: only PATH (so the binary resolves)
// plus the libpq PG* vars mapped from the connection URL. Other engine secrets
// in process.env (exchange keys, auth secrets) are deliberately NOT forwarded
// to the child. No credential is ever passed in argv / the process table;
// PGPASSWORD is set only when the URL carries one.
function buildLibpqEnv(databaseUrl: string): NodeJS.ProcessEnv {
    const url = new URL(databaseUrl);
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        PGHOST: url.hostname,
        PGPORT: url.port.length > 0 ? url.port : undefined,
        PGUSER: decodeURIComponent(url.username),
        PGDATABASE: url.pathname.replace(/^\//u, ''),
    };

    if (url.password.length > 0) {
        env.PGPASSWORD = decodeURIComponent(url.password);
    }

    return env;
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
