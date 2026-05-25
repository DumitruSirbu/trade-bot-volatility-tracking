# ADR 0025 — Startup schema-validation gate (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0002 §6 (persistence — silent-data-loss incident on testnet), ADR 0014 (boot pipeline shape).
**Consumed by:** ADR 0021 (halt-state restore reads `control_audit`), ADR 0024 (boot-failure alert).

## 1. Context

In M2 testnet operation, the engine was once started against a reverted DB. Migrations were missing; per-row inserts failed with `schema not found` errors that were logged but did not halt the boot. The engine kept running, the market-data persistence pipeline kept dropping writes, and several minutes of data were silently lost. The post-mortem (ADR 0002 §6) demanded a startup-time validation gate that fails the process before any write path opens — the M9 brief restates this as the prerequisite for everything else.

The boot pipeline is already 10-phase (ADR 0014). The schema-gate slots in **before** any persistence-using module starts producing or consuming work.

## 2. Decision

### 2.1 Location in the boot pipeline

The gate runs in a new boot phase **`PHASE 0 — SCHEMA_VALIDATION`**, executed before all existing phases (the current phase 1 — "DB connect & repository wire-up" — becomes phase 1.5 after this).

Pipeline order:

```
PHASE 0  SCHEMA_VALIDATION          ← new
PHASE 1  DB connect & repos
PHASE 2  Exchange auth
PHASE 3  Halt-state restore         ← reads control_audit last row (ADR 0021 §2.5)
PHASE 4  ReconciliationService      ← unchanged
PHASE 5..10 unchanged
```

`PHASE 0` is implemented as a NestJS `onApplicationBootstrap` hook on a dedicated `SchemaValidationService` registered first in `AppModule.imports`. It is also re-entrant-safe: if invoked twice (e.g., in tests), it caches the success/failure result.

### 2.2 What counts as "required schema present"

A schema is valid iff **all of**:

1. **TypeORM migration table state matches code state.** The set of executed migrations (read from `migrations` table) must equal the set of migration class names exported from the engine's compiled migration source. Drift in either direction (DB ahead, DB behind, or skew) is a failure.
2. **Every required table from the canonical manifest exists** with a non-empty column set. The manifest is a compile-time constant `REQUIRED_SCHEMA_MANIFEST: ReadonlyArray<{ table: string; requiredColumns: ReadonlyArray<string> }>` co-located with the service. Tables included (current set):
   - `candles`, `tick_aggregates`, `book_snapshots`, `funding_rates`,
   - `decisions`, `positions`, `transactions`,
   - `strategy_versions`, `risk_state`, `account_snapshots`,
   - `control_audit` (new in M9 W1).
3. **All required columns are present** per the manifest. Type checks beyond presence are NOT performed (migration drift catches that already; we keep the gate cheap).
4. **The 90-day partition window on `tick_aggregates`** has a partition for *today* and *yesterday* (M2 partition rollover; flagged as a separate boot warning, not a hard fail, since rollover is its own deferred mechanism).

Steps 1–3 are hard fails. Step 4 is a `warn` log + a Telegram `BOOT_SCHEMA_GATE_FAILED` alert with severity `warn` (per ADR 0024) but does not block boot — partition rollover is a known deferred item.

### 2.3 Failure mode

On a hard fail, `SchemaValidationService`:

1. logs a structured `boot.schema.invalid` record (table list, missing columns, drift detail);
2. emits a `BOOT_SCHEMA_GATE_FAILED` Telegram alert (critical, per ADR 0024) using the alert sender that is wired BEFORE `PHASE 0` — alerts are part of `AppModule` core providers, not gated by schema;
3. throws `SchemaValidationError` from `onApplicationBootstrap`, which Nest converts to a non-zero process exit.

No partial-boot mode. No "degraded operation" flag the operator can override. The process exits; container restart policy decides what happens next. Per project priority ("conservative, low-risk survival over returns") refusing to boot is the safe choice.

### 2.4 Order-of-operations subtlety: alerts before schema

The alert sender (ADR 0024) needs to be wired before `PHASE 0` so a failed gate produces a phone alert. It depends only on `TELEGRAM_BOT_TOKEN` + an HTTP client, neither of which uses the DB. The alert sender therefore lives in a small `AlertModule` registered above `PersistenceModule` in `AppModule.imports`. The schema-gate is the *first* DB-touching code; the alert sender is the *first* I/O code overall.

### 2.5 Recovery from schema fail (operational)

The operator workflow is documented in `docs/runbooks/schema-fail-recovery.md` (scribe in W5):

1. Telegram alert lands → operator sees `BOOT_SCHEMA_GATE_FAILED`.
2. Operator inspects the structured log for the manifest delta.
3. Operator runs `pnpm engine migration:run` (or pulls the missing migration into the deploy bundle).
4. Container restarts; gate passes; normal boot continues.

No special tool is needed — `typeorm` CLI is already wired.

## 3. Consequences

- Silent data loss from missing schema cannot recur. The class of incident from M2 is closed.
- A new boot phase + a small service + a manifest constant — net new code is small.
- The manifest must be kept in sync with migrations; W1 of M9 adds a unit test that asserts manifest ⊆ tables produced by running all migrations against an empty DB, so divergence is caught at PR time.
- Boot is fractionally slower (one `SELECT` per required table, one read of `migrations` table) — negligible.
- The "schema validity" outcome is exposed on `GET /v1/health` (ADR 0022 §2.2) so the dashboard/operator can confirm post-boot.

## 4. Alternatives considered

- **Run-on-every-write validation.** Rejected: too expensive on the hot path; the gate's job is "fail fast at boot," not "guard each insert."
- **Migrate-on-boot if missing.** Rejected: auto-applying migrations in a trading-engine process is dangerous; operator must explicitly run migrations. (We may revisit for a `MIGRATIONS_AUTO_APPLY=true` opt-in flag in a dev-only mode in M11.)
- **Soft-fail with a halt-flag flip instead of process exit.** Rejected: a half-booted process holds a WS subscription and may emit garbage. Clean exit + supervised restart is the safer pattern.
- **Trust TypeORM `synchronize: true`.** Rejected long ago (M2); `synchronize` is destructive and forbidden in this codebase.
- **Manifest auto-derived from entity decorators.** Rejected for V1: explicit manifest is easier to review; the unit test in §3 closes the consistency gap. May revisit when the entity count grows.
