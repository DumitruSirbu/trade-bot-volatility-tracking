# M16 — Test-DB isolation (dedicated 6900 container)

**Goal:** Give the test suite its own ephemeral Postgres on host port **6900** and make it
structurally impossible for any test to connect to the soak DB on **5433**. Nothing runs on
5433 again; everything runs on 6900, auto-started and health-gated before Jest begins.

**Depends on:** M14 (CI review gate — its `test` job is updated here).

> **Independent review applied (2026-05-31).** This plan incorporates the amendments from
> `docs/independent-analysis/composer/M16-test-db-isolation-review.md` — the CI env contract (H1),
> adversarial-suite-first ordering (H2), async `globalSetup` + env load order (H3), the
> `buildRoleDbUrl` helper (H4), the corrected file inventory and expanded tripwire (M1), `.env.test`
> gitignore/onboarding (M2), the Docker-`pretest` caveat (M3), robust URL-parse port check (M4), and
> CI Postgres-18 alignment (M5).

## Context

Tests currently resolve their DB connection with a hardcoded fallback to the soak/calibration DB:

```ts
process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot'
```

Port **5433** is the protected, irreplaceable **soak DB** (`postgres` compose service, named
volume `postgres-data`). When `pnpm test` runs in a shell where `DATABASE_URL` is unset or
points at 5433, the suites hit the soak DB directly. This is not theoretical:

- ~13 specs run `DELETE FROM … WHERE … LIKE <prefix>` against the resolved DB.
- `apps/engine/tests/database/migration.roundtrip.adversarial.spec.ts` **reverts ALL
  migrations** (drops every table/partition) against the resolved DB.

A single mis-set env var can wipe soak calibration data — exactly the loss CLAUDE.md rules
8 & 9 exist to prevent.

**Locked decisions:**
1. Test DB is **ephemeral (tmpfs-backed)** — wiped on every container start, no named volume,
   impossible to confuse with the protected `postgres-data` volume.
2. **One container on 6900 hosting two databases:** `trade_bot_test` (integration specs) and
   `trade_bot_migration_test` (destructive round-trip), created via an init script.
3. **Auto-start + fail-fast guard:** a `pretest` hook brings the container up and waits for
   health; `globalSetup` then asserts the resolved port is 6900 and the DB is reachable.

## Tasks

### Wave 1 — DevOps: container, env, init, orchestration (`bot-devops`)

- **New `postgres-test` compose service (profile `test`).** `docker-compose.yml`:
  `postgres:18.4-alpine`, `container_name: trade-bot-postgres-test`, host mapping
  `${TEST_DB_PORT:-6900}:5432`, **tmpfs-backed data dir** (no named volume), `pg_isready`
  healthcheck, init-script mount (`./docker/postgres-test-init.d:/docker-entrypoint-initdb.d:ro`).
  Gated behind a `test` profile so the default soak stack never starts it and the soak
  `postgres` service is left untouched.
  - *Output:* `docker compose --profile test up -d postgres-test` brings up an isolated,
    disposable DB on 6900; `docker compose up` behaves exactly as today.
- **Init script for the second database.** `docker/postgres-test-init.d/01-create-migration-db.sql`
  running `CREATE DATABASE trade_bot_migration_test;` so the destructive round-trip suite gets
  its own database in the same container.
  - *Output:* init creates both `trade_bot_test` (via `POSTGRES_DB`) and `trade_bot_migration_test`.
- **Env vars + onboarding.** Add to `.env.example`: `TEST_DB_PORT=6900`, `TEST_DB_USER`,
  `TEST_DB_PASSWORD`, `TEST_DB_NAME=trade_bot_test`,
  `TEST_DATABASE_URL=postgresql://…@localhost:6900/trade_bot_test`, and repoint
  `MIGRATION_TEST_DB_URL=postgresql://…@localhost:6900/trade_bot_migration_test`. Test-only
  throwaway values; comment that they MUST NOT reuse soak/prod creds. **Commit
  `.env.test.example`** (the copy-to-`.env.test` template) and **add `.env.test` to
  `.gitignore`** — the existing `.env.*.local` glob does NOT match `.env.test`, so it must be
  added explicitly (with `!.env.test.example` kept tracked).
  - *Output:* a self-contained test-DB env block pointing only at 6900, plus one-command
    contributor setup (`cp .env.test.example .env.test`).
- **Auto-start `pretest` orchestration.** Engine-package `pretest`:
  `docker compose --profile test up -d --wait postgres-test` (`--wait` blocks on healthcheck);
  wire `apps/engine` `test` so `pretest` runs first. Place `pretest` on `@bot/engine` **only** —
  agent/dashboard suites don't need the 6900 container (L3).
  - *Output:* `pnpm --filter @bot/engine test` guarantees the 6900 container is healthy before
    Jest starts; other workspaces are unaffected.
- **CI `test` job — explicit env contract** (`.github/workflows/ci.yml`). The CI runner has no
  soak `.env`, so the three DSNs must be disambiguated by **database name on the same 6900
  instance** (resolves review H1). Map the service to `6900:5432`, align the image to
  **`postgres:18-alpine`** (match local 18.4; review M5), and set:
  - `DB_HOST=localhost`, `DB_PORT='6900'`, `DB_NAME=trade_bot`, `DB_USER`/`DB_PASSWORD` as today.
  - `DATABASE_URL=postgresql://…@localhost:6900/trade_bot` — **validateEnv / module-load specs
    only**; distinct DB name from the test DB so guard rule #3 (`TEST_DATABASE_URL !== DATABASE_URL`) holds.
  - `TEST_DATABASE_URL=postgresql://…@localhost:6900/trade_bot_test` — every integration + role spec.
  - `MIGRATION_TEST_DB_URL=postgresql://…@localhost:6900/trade_bot_migration_test` — both round-trip suites.
  - **Create both extra databases in CI** (service containers can't mount init scripts): a step
    running `psql -c 'CREATE DATABASE trade_bot_test;' -c 'CREATE DATABASE trade_bot_migration_test;'`.
  - **Authoritative migration path (two consumers):** integration + role specs connect directly to
    `trade_bot_test`, so **globalSetup pre-migrates `trade_bot_test`** (next wave). Any spec that boots
    the full Nest `DatabaseModule` connects via `DATABASE_URL` (= `trade_bot`), so **keep the CI
    `migration:run` step** but pointed at `trade_bot` on 6900. Roles are cluster-wide (created once);
    their per-DB GRANTs land in whichever DB the migration ran against, so role specs must hit the DB
    that globalSetup migrated (`trade_bot_test`). The engine agent must confirm whether any e2e spec
    actually boots the DataSource; if none do, the `migration:run` step may be dropped.
  - *Output:* CI runs every suite — including both round-trips — against 6900, with all three guard
    rules satisfied before Jest starts, and schema present for both connection paths.

### Wave 2 — Engine test harness + guard (`bot-engine-nestjs`)

> **Do `migration.roundtrip.adversarial.spec.ts` FIRST** — it is the single most dangerous file
> (reverts ALL migrations against its resolved DSN, which today falls back to the soak DB). It is a
> priority fix, not a representative among equals (review H2).

- **Repoint `migration.roundtrip.adversarial.spec.ts`** to `MIGRATION_TEST_DB_URL` (the 6900
  migration DB) with the **same abort-if-unset** pattern the non-adversarial round-trip already
  uses — remove its `?? '…5433…'` fallback entirely.
  - *Output:* the destructive revert can only ever hit `trade_bot_migration_test`; it can never
    touch the integration schema or the soak DB.
- **Rewrite `apps/engine/tests/support/testDataSource.ts`.** Replace the
  `process.env['DATABASE_URL'] ?? '…5433…'` default with a **mandatory** read of
  `TEST_DATABASE_URL`, **no soak fallback**. Export a `getTestDbUrl()` accessor and a
  `buildRoleDbUrl(role, password)` helper (parses `TEST_DATABASE_URL` via the `URL` API and rewrites
  only user/password, so host/port/db stay in sync). Fix the stale "port 5433" doc comment.
  - *Output:* the shared DataSource and every role spec derive host/port/db from one source of truth.
- **Add a hard isolation guard** (`apps/engine/tests/support/assertTestDb.ts`, called from
  `globalSetup.ts`):
  1. `TEST_DATABASE_URL` must be set (throw with setup instructions if not).
  2. Parse with the `URL` API (handle omitted-port → 5432, IPv6 brackets; `postgresql:`→`postgres:`
     substitution if needed) — the resolved port **must equal `TEST_DB_PORT` (6900)**; throw on 5433
     or anything else. Do not regex on `:5433` (review M4).
  3. Resolved DSN must **not** equal `DATABASE_URL` (the soak/validate DSN) — belt-and-suspenders.
  4. Open a throwaway connection to confirm reachability; fail fast if the container is down.
  - *Output:* it is structurally impossible for any spec to reach 5433; a misconfig aborts the
    run before a single `DELETE`/migration executes.
- **Make `globalSetup.ts` async; specify env load order and pre-migrate the integration DB.**
  Signature becomes `async function globalSetup(): Promise<void>` (review H3). Load order:
  1. `.env.test` (from gitignored `.env.test`, copied from `.env.test.example`) — supplies the test contract.
  2. `.env.local` (optional local overrides) with `override: false` so it can't clobber the test contract.
  3. After load, run `assertTestDb()`; then **apply migrations to `trade_bot_test` once** (via
     `buildDataSourceOptions(getTestDbUrl())` + `runMigrations`). Because the test DB is a fresh
     tmpfs instance and role specs connect via raw `pg.Client`, schema/roles/GRANTs must exist
     before any suite runs — this removes all reliance on suite ordering.
  - *Output:* one enforcement + schema-bootstrap point covering every worker; role specs find their
    schema regardless of execution order.
- **Systematically remove the 5433 fallback** from the **8 specs that carry a `:5433` URL literal**,
  replacing each with `getTestDbUrl()` / `buildRoleDbUrl()` (identical mechanical edit):
  - `tests/database/migration.roundtrip.adversarial.spec.ts` *(done above)*
  - `tests/database/agent-writer-role.integration.spec.ts`, `agent-writer-bypass.adversarial.spec.ts`,
    `agent-run-history.integration.spec.ts` — base URL + `buildRoleDbUrl('agent_writer', …)`
  - `tests/database/mcp-reader-role.integration.spec.ts` — base URL + `buildRoleDbUrl('mcp_reader', …)`
  - `tests/strategy/ComparisonReportRepository.integration.spec.ts`,
    `tests/bootstrap/SchemaValidationService.manifest.integration.spec.ts`
  - `tests/support/testDataSource.ts` *(done above)*
  - Note: `tests/database/migration.roundtrip.spec.ts` is **already** isolated behind
    `MIGRATION_TEST_DB_URL`; only update its example doc comment from port `5434` → `6900`.
- **Update comments / skip / error messages that still say `DB_PORT=5433` or port 5433** (≈6 more
  files, no URL literal): `tests/promotion/PromotionService.integration.spec.ts`,
  `tests/paper-mode/repository/paperPersistenceRepositories.integration.spec.ts`,
  `tests/market-data/service/tickAggregatePartitionService.spec.ts`, and the operator-facing skip
  strings in the role specs above — point operators at
  `docker compose --profile test up -d --wait postgres-test`.
  - *Output:* zero `:5433` literals and zero stale `DB_PORT=5433` instructions remain in tests.
- **Update the `maxWorkers: 1` comment in `jest.config.js`** from "shared Postgres instance" to
  "shared **integration** schema on `trade_bot_test`" so future readers don't assume 5433 (review L2).

### Wave 3 — QA (`bot-qa-engineer`)

- **Guard unit tests** for `assertTestDb.ts` / `buildRoleDbUrl`: throws when `TEST_DATABASE_URL`
  is unset, when the port is 5433, when the port is omitted (→5432), and when the DSN matches
  `DATABASE_URL`; passes for a 6900 DSN; `buildRoleDbUrl` keeps host/port/db and swaps only
  user/password (pure, no live DB).
- **Static "no-5433" tripwire**: scan `apps/engine/tests/**` and fail if any **`:5433` URL literal**
  OR **`DB_PORT=5433`** reappears — with an explicit allowlist for
  `tests/config/validateEnv.spec.ts` (it uses `5433` as a valid port integer, not a soak DSN; review M1).

### Wave 4 — Reviewers (parallel)

`bot-review-security` (any path still reaching 5433? secrets in compose/CI?),
`bot-review-logic` (guard correctness, round-trip DB isolation, init ordering),
`bot-review-clean-code` (naming, helper/guard, comment accuracy),
`bot-review-quant` (n/a — likely a no-op pass).

### Wave 5 — Scribe (`bot-scribe`)

Update `docs/milestone-log.md` (M16 summary + outcome; note M16 supersedes the CI Postgres-port
story for tests — review L4), `docs/work-log.md`, `CLAUDE.md` status, and add a section to
`docs/best-practices/testing.md` documenting: the 6900 test-DB contract, the three CI DSNs,
`--profile test` startup, and that **`pnpm --filter @bot/engine test` now requires Docker** (the
`pretest` hook) — including for pure unit suites (review M3).

## Files touched

| Area | Files |
|------|-------|
| Compose / init | `docker-compose.yml`, `docker/postgres-test-init.d/01-create-migration-db.sql` (new) |
| Env | `.env.example`, `.env.test.example` (new, tracked), `.gitignore` (add `.env.test`, keep `!.env.test.example`) |
| CI | `.github/workflows/ci.yml` (`test` job — image→18, port→6900, create DBs, three DSNs) |
| Test harness | `apps/engine/tests/support/testDataSource.ts` (+`getTestDbUrl`/`buildRoleDbUrl`), `globalSetup.ts` (async), `assertTestDb.ts` (new), `apps/engine/jest.config.js` (comment) |
| Test specs | **8** specs with `:5433` URL literals + **≈6** with stale `DB_PORT=5433` comments/messages — see Wave 2 list |
| Scripts | `apps/engine/package.json` (`pretest` on `@bot/engine` only) |
| Docs | this file, `milestone-log.md`, `work-log.md`, `CLAUDE.md`, `testing.md` |

## Safety notes (CLAUDE.md rules 8 & 9)

- The protected soak `postgres` service (5433 / `postgres-data`) is **not modified** — no rename,
  no volume change, no `down -v`, no migration revert against it.
- `postgres-test` is a separate, tmpfs-backed, profile-gated container. Resetting it destroys only
  disposable test data, never the soak volume.
- No pre-work DB dump is required because nothing here touches the soak DB or its volume. If any
  step is found to touch the `postgres` service or `postgres-data`, STOP and follow rule 9.

## Verification (end-to-end)

1. `docker compose --profile test up -d --wait postgres-test` → healthy; `docker compose ps` shows
   `trade-bot-postgres-test` on `6900`; soak `trade-bot-postgres` still on 5433, untouched.
2. `docker exec trade-bot-postgres-test psql -U <user> -lqt` lists `trade_bot_test` and
   `trade_bot_migration_test`.
3. **Guard (negative):** run the engine tests with `TEST_DATABASE_URL` pointed at `:5433` → the run
   aborts in `globalSetup` before any spec executes.
4. **Guard (positive):** with `.env.test` on 6900, `pnpm --filter @bot/engine test` runs green;
   round-trip suites operate on `trade_bot_migration_test`.
5. **No 5433 leakage:** `grep -rn ':5433\|DB_PORT=5433' apps/engine/tests` returns nothing (modulo
   the `validateEnv.spec.ts` allowlist); the static tripwire test passes.
6. **Soak DB untouched:** soak row counts on 5433 (e.g. `SELECT count(*) FROM candles;`) are
   identical before and after a full test run.
7. **CI green:** the `test` job provisions the 6900 service, creates both extra DBs, and all
   suites (incl. both round-trips) pass.
8. **CI guard dry-run:** a CI step echoes the test env and asserts `TEST_DATABASE_URL` port is 6900
   and `TEST_DATABASE_URL !== DATABASE_URL` before Jest starts.
9. **Role suite smoke:** `agent_writer` / `mcp_reader` integration specs connect on 6900 (guard or
   first suite logs the resolved `host:port` once).
10. **Unit-only sanity:** a non-DB spec still passes with the test container up (no regression from
    `pretest` latency).
11. **Adversarial round-trip isolation:** after the adversarial suite runs, `trade_bot_test` still
    has its schema intact — the revert hit only `trade_bot_migration_test`.

## Definition of done

Every test connects only to the dedicated 6900 container; the soak DB on 5433 is provably never
touched by any spec (guarded at startup, enforced by a regression test, verified by unchanged soak
row counts). The test DB auto-starts and is health-gated before Jest runs, hosts an isolated
`trade_bot_migration_test` for destructive round-trips, and is fully disposable. CI runs the same
way. Reviewers clear all blockers/highs and the majority of mediums; docs and milestone log updated.
