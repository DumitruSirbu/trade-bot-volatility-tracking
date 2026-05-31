// M17 — automated daily DB backup constants. Centralised so the scheduler,
// the retention pruner, and the QA specs all agree on the on-disk contract
// (no magic strings — conventions §Constants Placement).

// Filename contract: trade_bot_<YYYYMMDD_HHMM>.sql.gz (UTC). The `trade_bot_`
// prefix deliberately differs from the rule-9 manual `backup_*` prefix so a
// manual dump is never counted toward — nor pruned by — the retention cap
// (M17 plan decision #5).
export const BACKUP_FILENAME_PREFIX = 'trade_bot_';
export const BACKUP_FILENAME_EXTENSION = '.sql.gz';

// Anchored pattern the pruner matches before unlinking ANYTHING (review L3).
// Only files of the exact shape `trade_bot_<8 digits>_<4 digits>.sql.gz` are
// ever eligible for deletion; a non-matching file (README, manual backup_*,
// a `..`-bearing name) is never touched.
export const BACKUP_FILENAME_PATTERN = /^trade_bot_(\d{8})_(\d{4})\.sql\.gz$/u;

// Unique key the cron job is registered under in SchedulerRegistry. Used by
// both onModuleInit (addCronJob) and onModuleDestroy (deleteCronJob).
export const DB_BACKUP_CRON_JOB_NAME = 'db-backup';

// Alert reason stamped on data.reason when a dump fails (review L1). Reuses
// the existing AlertTypeEnum.UNHANDLED_EXCEPTION wire type — no shared change.
export const DB_BACKUP_FAILED_REASON = 'DB_BACKUP_FAILED';

// M16 test-DB port. When NODE_ENV !== 'test' the scheduler refuses to dump a
// DATABASE_URL pointing at this port so a misconfigured engine can never dump
// (and prune around) the ephemeral test DB (review M2 / N2). This is a guard
// const, NOT a production env var — the soak DB has no notion of a test port.
export const TEST_DB_GUARD_PORT = 6900;

// pg_dump portability flags (review M3). --no-owner / --no-acl strip the
// owner + grant statements so a restore into a throwaway DB does not require
// the same roles to exist.
export const PG_DUMP_PORTABILITY_FLAGS: ReadonlyArray<string> = ['--no-owner', '--no-acl'];

// Atomic-write staging suffix. The dump streams into `<name>.tmp` and is only
// renamed to its final name on a clean exit, so a crashed/partial dump is
// never promoted to a real backup (review M3).
export const BACKUP_TMP_SUFFIX = '.tmp';

// Trailing bytes of pg_dump stderr retained for the failure-cause string. The
// tail is enough to surface the actual error (e.g. auth failure, missing role)
// without unbounded buffering of a chatty stderr.
export const STDERR_CAPTURE_BYTES = 500;
