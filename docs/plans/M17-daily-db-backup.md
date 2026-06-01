# M17 — Automated daily DB backup (local disk, 3-deep retention)

**Goal:** Turn the manual `pg_dump` safeguard (CLAUDE.md rule 9) into an automated **daily**
backup of the soak Postgres DB, written to a host path configured by env, keeping the **3
most recent** dumps (today + 2 previous) and pruning anything older. Cloud/offsite backup
(S3, B2, rclone) is explicitly **out of scope** — local disk only.

**Depends on:** M16 (test-DB isolation) — **soft, not structural** (review M2): M16 makes the
soak vs test DSNs unambiguous locally/CI; the backup **intentionally targets `DATABASE_URL`
(soak)**, never `TEST_DATABASE_URL`. Soft prerequisite: a running soak DB (M11a).

> **Independent review applied (2026-05-31, both passes).** This plan incorporates the amendments
> from `docs/independent-analysis/composer/M17-daily-db-backup-review.md`. **Pass 1** (all H1–H4,
> M1–M7, L1–L6, naming): dynamic cron via `SchedulerRegistry` (H1), the host-vs-container
> `DB_BACKUP_DIR` contract (H2), Docker-only automated-backup scope (H3), non-root mount permissions
> (H4), CI/test `DB_BACKUP_ENABLED=false` (M1), the `pg_dump` spawn/secret contract (M3), a
> re-entrancy mutex (M4), the dropped "admin probe" (M6), Alpine client-version verification (M7),
> the embedded-timestamp sort key (L2), and the anchored filename regex + realpath prune guard (L3).
> **Pass 2** verdict was *Approve for implementation* with no remaining plan blockers; its
> implementation notes N1 (`OnModuleDestroy` cleanup + safe async cron callback), N2
> (`TEST_DB_GUARD_PORT` const), and N5 (host-dev `.env.example` comment) are folded into Waves 1–2.

## Context

CLAUDE.md rules 8 & 9 make the soak DB irreplaceable calibration data and mandate a manual
`pg_dump` before any risky DB operation:

```bash
docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backup_$(date +%Y%m%d_%H%M).sql.gz
```

Today this is **only ever run by hand**, so day-to-day there is no point-in-time recovery if the
soak volume is lost between manual dumps. M17 automates a daily dump on a fixed UTC schedule and
bounds disk usage with a fixed retention depth.

**Locked decisions:**
1. **Mechanism: in-engine NestJS scheduler** mirroring `DailyPnlSummaryScheduler` /
   `RevokedJtiPruneScheduler` (`apps/engine/src/auth/RevokedJtiPruneScheduler.ts`) — testable via a
   pure `runOnce(now)`, UTC-pinned, alerting failures through the existing `ALERT_SINK`. **The cron
   is registered dynamically** (see decision #7), not via a `@Cron()` decorator — no new ops
   surface, no host crontab, no sidecar.
2. **Retention = keep 3 total** (current + 2 previous). On each run, after writing the new dump,
   list backups matching the **anchored** dump pattern, sort by embedded filename timestamp
   (mtime fallback), and unlink everything beyond index 3. Pruning **only** ever deletes files
   matching the backup pattern in the configured dir — never anything else (review L2/L3).
3. **`DB_BACKUP_DIR` is the directory the engine writes to**, and its value differs by run context
   (review H2): in compose it is the **fixed in-container path** `/var/backups/trade-bot` (set as an
   explicit `engine.environment` override), whose host side is the bind-mounted operator path; on
   host dev it is `./backups`. Cloud deployments ship dumps to S3-class storage in a later milestone.
4. **`pg_dump` connects over TCP** using the engine's existing `DATABASE_URL` (read-only, no
   `docker exec`). The engine image must carry a `pg_dump` client matching the server major
   (Postgres 18). **Automated backup is Docker-only for M17** (review H3): host-dev runs
   (`pnpm engine:dev`) should keep `DB_BACKUP_ENABLED=false` and rely on the rule-9 manual dump, since
   a host `pg_dump` client is not provisioned by this milestone.
5. **Naming:** `trade_bot_<YYYYMMDD_HHMM>.sql.gz` (UTC). This **deliberately differs** from the
   rule-9 manual `backup_*` prefix so manual dumps are never counted toward — nor pruned by — the
   3-deep cap; the runbook documents both prefixes so operators aren't surprised when they coexist
   (review naming note / amendment 8).
6. **Out of scope:** S3/offsite upload, encryption-at-rest (age/gpg), restore automation, WAL/PITR,
   cross-region replication, host-dev `pg_dump` provisioning. The env-path design leaves a clean
   seam for the cloud upload milestone (review L6).
7. **Dynamic cron registration** (review H1): NestJS evaluates `@Cron()` decorator arguments before
   DI, so a config-driven expression cannot be passed to the decorator. Register the job in
   `onModuleInit` via `SchedulerRegistry.addCronJob('db-backup', new CronJob(dbBackupCron, …, 'UTC'))`
   so `DB_BACKUP_CRON` is actually honored.

## Tasks

### Wave 1 — DevOps: image client, mount, env (`bot-devops`)

- **Add a `pg_dump` client to the engine image.** `apps/engine/Dockerfile`: install the Postgres-18
  client (`apk add --no-cache postgresql18-client`, alongside the existing `wget`), so `pg_dump`
  matches the `postgres:18.4-alpine` server and won't refuse on a server-newer-than-client mismatch.
  **Verify the exact Alpine package name at build time** (review M7) — naming can vary by base
  image; the build smoke must assert `pg_dump --version` reports major **18**.
  - *Output:* `pg_dump --version` inside the engine image reports a v18 client.
- **Bind-mount the backup dir + pin the in-container write path** (review H2). `docker-compose.yml`
  (`engine` service): mount `${DB_BACKUP_DIR:-./backups}:/var/backups/trade-bot` **and** set an
  explicit `engine.environment` override `DB_BACKUP_DIR: /var/backups/trade-bot` so the engine writes
  to the bind mount, not a container-local `./backups` (which would be lost on recreate). The host
  side (`DB_BACKUP_DIR` from `.env`) is operator-configurable. Do **not** touch the `postgres` service
  or `postgres-data` volume (CLAUDE.md rules 8 & 9).
  - *Output:* dumps written by the engine appear on the **host** at `$DB_BACKUP_DIR`, surviving
    `docker compose up -d --force-recreate engine`.
- **Non-root mount permissions** (review H4). The runtime image runs as `USER node` (uid 1000); a
  host-created `./backups` is often root-owned. Document in `.env.example`/runbook that the operator
  must create the host dir writable by uid 1000 (e.g. `mkdir -p ./backups && chown 1000:1000 ./backups`),
  and add a Wave 1 verification that the `node` user can create/rename/unlink under the mount.
  - *Output:* the engine can write and prune dumps under the mount without permission errors.
- **Env vars + onboarding.** Add to `.env.example` (host-dev defaults) and `.env.test.example`:
  - `DB_BACKUP_DIR=./backups` — host path for local runs; document the compose-vs-host split as a
    small table (compose engine container → `/var/backups/trade-bot`; host dev → `./backups`). Note
    cloud uses S3 (out of scope).
  - `DB_BACKUP_ENABLED` — feature flag. `.env.example` → `true` **with a comment that this is for
    compose soak runs; host dev (`pnpm engine:dev`) should set it `false`** (review N5);
    **`.env.test.example` → `false`** (review M1) so the test/CI engine never spawns `pg_dump`.
  - `DB_BACKUP_CRON=0 3 * * *` — default 03:00 UTC (offset from the 00:00 PnL summary and overnight
    partition crons; low contention for a read-only dump — review L4). Standard 5-field cron, UTC.
  - `DB_BACKUP_RETENTION=3` — number of dumps to keep.
  - Add `backups/` to `.gitignore` (consistent with the default `./backups` path — review L5) so
    dumps are never committed.
  - *Output:* a self-contained backup env block; `cp .env.example .env` yields a working local setup.
- **CI: disable backups explicitly** (review M1). `.github/workflows/ci.yml` `test` job `env:` block
  → `DB_BACKUP_ENABLED: 'false'`, so the ephemeral 6900 DB is never dumped during tests.
  - *Output:* CI runs with backups off; a verification step greps the workflow for the flag.

### Wave 2 — Engine: config + backup scheduler (`bot-engine-nestjs`)

- **Extend env config.** `apps/engine/src/config/EnvironmentVariables.ts` + the `AppConfigService`
  accessor (`apps/engine/src/config/service`): add validated `DB_BACKUP_DIR` (string),
  `DB_BACKUP_ENABLED` (boolean), `DB_BACKUP_CRON` (string, validate as a 5-field cron),
  `DB_BACKUP_RETENTION` (int, `@Min(1)`). Expose typed getters. Follow the existing
  `@Transform`/`class-validator` pattern; no committed secret defaults.
  - *Output:* malformed cron / non-positive retention aborts startup via the fail-fast `validateEnv`.
- **`DbBackupScheduler`** (new, e.g. `apps/engine/src/backup/DbBackupScheduler.ts` + a thin
  `BackupModule`). Mirror `RevokedJtiPruneScheduler`, with **dynamic** registration:
  - **Register the cron in `onModuleInit`** (review H1), NOT via `@Cron(appConfig.dbBackupCron)` —
    decorator args are evaluated before DI so config can't reach them. Use the injected
    `SchedulerRegistry`:
    `this.schedulerRegistry.addCronJob('db-backup', new CronJob(this.appConfig.dbBackupCron, () => void this.onTick(), null, true, 'UTC'))`.
    Guard registration behind `DB_BACKUP_ENABLED` — when disabled, skip registration entirely and
    debug-log (test/CI never dump).
  - `async runOnce(now: Date)` (pure on the injected `CLOCK`) → builds the timestamped filename,
    dumps, then prunes. Command/Query separation: dump and prune are private steps.
  - **Re-entrancy mutex** (review M4): a module-level `isRunning` flag — if a tick fires while a dump
    is still in progress (large DB / slow disk), skip + log rather than spawning a second concurrent
    `pg_dump` against soak (mirror the idempotency guard in `DailyPnlSummaryScheduler`).
  - **Dump step / spawn contract** (review M3): spawn `pg_dump` against `DATABASE_URL` with
    `--no-owner --no-acl` (restore portability), pipe through gzip, write **atomically**
    (`<name>.tmp` → rename) so a crashed/partial dump is never promoted. Pass credentials via the
    child env (`PGPASSWORD` / the URL in env), **never** as a logged argv string — and never log the
    connection string. Wrap the child-process failure in a domain error; never throw raw.
  - **Retention step:** read the backup dir, filter to an **anchored** pattern
    `^trade_bot_\d{8}_\d{4}\.sql\.gz$` only (review L3), sort by the embedded filename timestamp
    descending (mtime fallback — review L2), unlink everything past `DB_BACKUP_RETENTION`. Resolve
    the dir with `realpath` and reject paths containing `..` before any unlink (review L3, security).
  - **Failure alerting:** on dump failure (non-zero exit, write error, missing dir), emit one
    `ALERT_SINK` WARN/ERROR reusing `AlertTypeEnum.UNHANDLED_EXCEPTION` + `data.reason =
    'DB_BACKUP_FAILED'` (review L1) — like the prune scheduler's unbounded alert. A prune failure
    logs but does not abort. Log the resulting dump file size on success; optionally WARN on `ENOSPC`
    (review M5 — optional).
  - Extract the pattern/format constants (filename prefix, extension, reason string) as named
    module-level consts — no magic strings.
  - **Optional misconfig guard** (review M2/N2): when `NODE_ENV !== 'test'`, assert the
    `DATABASE_URL` port is **not** 6900 so a misconfigured engine never dumps the test DB. Use a
    named module const (e.g. `TEST_DB_GUARD_PORT = 6900`, comment pointing at M16) rather than adding
    a production `TEST_DB_PORT` env var that has no soak meaning.
  - **Lifecycle hygiene** (review N1 — first dynamic-registration scheduler in the repo): import
    `CronJob` from `cron` (transitive dep of `@nestjs/schedule`); implement `OnModuleDestroy` to
    `schedulerRegistry.deleteCronJob('db-backup')` so dev hot-reload / restart can't double-register;
    and wrap the cron callback so a rejected `onTick()` is caught and logged, never an unhandled
    rejection (`() => { void this.onTick().catch((err) => this.logger.error(...)); }`).
  - *Output:* one dump per UTC day at the configured time; exactly `DB_BACKUP_RETENTION` dumps on
    disk after steady state; a failed dump raises an alert and leaves prior good dumps intact.
- **Register `BackupModule`** in the engine bootstrap (alongside the other scheduled modules under
  `ScheduleModule.forRoot()`); confirm DI + `SchedulerRegistry` injection resolve at app boot
  (milestone live-app smoke). **No admin/control endpoint** is added in M17 (review M6) — `runOnce`
  is exercised by tests / a temporary boot hook only.

### Wave 3 — QA (`bot-qa-engineer`)

Unit-test `DbBackupScheduler.runOnce` with the filesystem and child-process boundary mocked
(Fast, Independent, Repeatable) — pure on the injected clock:
- **Filename:** produced name matches `trade_bot_<YYYYMMDD_HHMM>.sql.gz` for a fixed injected `now`.
- **Retention boundaries:** with 2 existing dumps → 3 kept, none deleted; with 3 existing → after a
  new dump the **oldest** is deleted, 3 remain; with 5 stray dumps → pruned down to exactly 3,
  newest retained; with 0 existing → first dump kept, nothing deleted.
- **Prune scope:** an unrelated file in the dir (e.g. `README`, `other.gz`) is **never** deleted.
- **Disabled flag:** `DB_BACKUP_ENABLED=false` → no cron is registered and `runOnce` is a no-op
  (no spawn, no unlink).
- **Dynamic cron honored** (review H1): with a mock `SchedulerRegistry`, a non-default
  `DB_BACKUP_CRON` is the expression actually registered for the `db-backup` job.
- **Re-entrancy** (review M4): a second tick while `isRunning` is true is skipped (no second spawn).
- **Adversarial failure modes:** `pg_dump` exits non-zero → an alert is published and **no** prior
  dump is removed (atomic temp never promoted); backup dir missing/unwritable → alert, no crash;
  prune failure → logged, dump still counts as success; a `..`-containing / non-anchored filename in
  the dir is never unlinked.
- Config validation spec: bad cron / `DB_BACKUP_RETENTION=0` fails `validateEnv`.

### Wave 4 — Reviewers (parallel)

`bot-review-security` (path traversal / arbitrary delete in prune, secrets in the spawned command
line vs `DATABASE_URL`, no creds logged), `bot-review-logic` (retention off-by-one, atomic-write
correctness, alert-on-failure, disabled-flag short-circuit, soak DB untouched),
`bot-review-clean-code` (scheduler ≤ conventions, named consts, CQS, error wrapping),
`bot-review-quant` (n/a — no-op pass).

### Wave 5 — Scribe (`bot-scribe`)

Update `docs/milestone-log.md` (M17 summary + outcome), `docs/work-log.md`, `CLAUDE.md` status,
and add an operator note to a runbook / `docs/best-practices` documenting: the daily UTC schedule,
the `DB_BACKUP_*` env vars, the host-vs-container `DB_BACKUP_DIR` split, the non-root mount-permission
step, the 3-deep retention, the local-disk-only scope, **both filename prefixes** (`backup_*` manual
vs `trade_bot_*` automated, and why retention only counts the latter — review naming note), and that
this automates (does not replace) the rule-9 manual dump. Add the M17 row to the
`docs/plans/00-overview.md` milestone table.

## Files touched

| Area | Files |
|------|-------|
| Image | `apps/engine/Dockerfile` (add `postgresql18-client`) |
| Compose / env | `docker-compose.yml` (engine bind mount + `DB_BACKUP_DIR` override), `.env.example`, `.env.test.example` (`DB_BACKUP_ENABLED=false`), `.gitignore` (`backups/`) |
| CI | `.github/workflows/ci.yml` (`test` job env → `DB_BACKUP_ENABLED: 'false'`) |
| Config | `apps/engine/src/config/EnvironmentVariables.ts`, `apps/engine/src/config/service/*` (accessors) |
| Engine | `apps/engine/src/backup/DbBackupScheduler.ts` (new), `apps/engine/src/backup/BackupModule.ts` (new) + bootstrap registration |
| Tests | `apps/engine/tests/backup/DbBackupScheduler.spec.ts` (new), config-validation spec |
| Docs | this file, `milestone-log.md`, `work-log.md`, `CLAUDE.md`, `00-overview.md`, a runbook/best-practice note |

## Safety notes (CLAUDE.md rules 8 & 9)

- `pg_dump` is **read-only** — it never mutates, drops, or reverts. This milestone strengthens rule
  9, never weakens it.
- The `postgres` service and `postgres-data` volume are **not** renamed, recreated, or `-v`-removed.
  The only compose change is an **engine-side** bind mount for the output directory.
- The retention pruner deletes **only** files matching the backup filename pattern inside
  `DB_BACKUP_DIR` — it must never recurse, glob outside the dir, or delete non-backup files.
- No migration, no `down`, no volume operation is part of this milestone. If any step is found to
  touch the soak `postgres` service or its volume, STOP and follow rule 9 (take a dump, ask first).

## Verification (end-to-end)

1. `docker build` the engine image → `pg_dump --version` inside it reports a v18 client.
2. With `DB_BACKUP_ENABLED=true` and a near-future `DB_BACKUP_CRON`, start the stack → at the
   scheduled UTC minute a `trade_bot_<YYYYMMDD_HHMM>.sql.gz` appears under the host `DB_BACKUP_DIR`.
3. Restore smoke: `gunzip -c <dump> | psql` into a throwaway DB succeeds (dump is valid, not partial).
4. **Retention:** seed 3 dated dumps, trigger `runOnce` (from an integration test / temporary boot
   hook) → 4th written, oldest deleted, exactly 3 remain (newest three). Repeat → still 3.
5. **Prune scope:** drop an unrelated file in the dir, run a backup → the unrelated file is still there.
6. **Failure alert:** point `DATABASE_URL` at an unreachable host / make the dir unwritable → a
   single `DB_BACKUP_FAILED` alert fires, the process does not crash, prior dumps are untouched.
7. **Disabled:** `DB_BACKUP_ENABLED=false` → no dump file is created and no cron work runs.
8. **Soak untouched:** soak row counts on the protected DB are identical before/after a backup run.
9. `pnpm --filter @bot/engine test` green, including the new retention/failure specs; CI green
   (backup disabled in CI env).
10. Live-app smoke: app boots with `BackupModule` registered, no DI / `SchedulerRegistry` errors.
11. **Compose path contract** (review): the dump appears on the **host** at `$DB_BACKUP_DIR`, not
    only inside the container layer, and survives `--force-recreate engine`.
12. **Non-default cron:** with `DB_BACKUP_CRON='*/2 * * * *'` (dev only), the registered job fires on
    that schedule (and overlapping ticks are skipped by the mutex).
13. **Concurrent manual + auto:** a manual `backup_*` and automated `trade_bot_*` in the same dir →
    retention prunes only `trade_bot_*`, leaving `backup_*` untouched.
14. **CI disabled:** the workflow contains `DB_BACKUP_ENABLED: 'false'`; no `pg_dump` runs in CI.
15. **Non-root write:** the `node` user (uid 1000) creates, renames, and unlinks under the mount
    without permission errors.

## Definition of done

The engine writes one valid, restorable gzipped dump per UTC day to the env-configured host path,
keeps exactly the 3 newest and prunes the rest (never touching non-backup files), and raises an
alert if a dump fails — all without ever mutating or endangering the soak DB. Disabled cleanly via
env for test/CI. Cloud/offsite upload remains a documented future milestone. Reviewers clear all
blockers/highs and the majority of mediums; docs and milestone log updated.
