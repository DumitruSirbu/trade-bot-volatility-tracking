# Testing

## Engine (Jest)

- Unit tests mock repositories/services and the exchange client. No real DB, no real exchange.
- Integration tests against a real Postgres (testcontainers or a dedicated `bot_test` DB).
- File location: mirror source in top-level `tests/` tree. `apps/engine/src/common/service/HaltFlagService.ts` → `apps/engine/tests/common/service/HaltFlagService.spec.ts`; `apps/engine/src/config/validateEnv.ts` → `apps/engine/tests/config/validateEnv.spec.ts`. Tests preserve module folder + type subfolder structure without a `__tests__` segment.
- Factory functions for seed data — no shared mutable state.
- F.I.R.S.T.: Fast, Independent, Repeatable, Self-Validating, Timely.

### Trading-domain tests that MUST exist

- **Risk gate:** rejects over-limit / over-exposure / cooldown / illiquid signals; passes within-limit; boundary at exactly the limit.
- **Strategy determinism:** same market-state input → same signal across repeated runs.
- **Idempotent execution:** replaying an order intent or restarting does not double-place.
- **Position lifecycle:** open → add → reduce → close; realized PnL and `exit_reason` correct on close.
- **Reconciliation:** local/exchange divergence detected and corrected.
- **Money math:** decimals exact at boundaries (zero, negative, large); short vs long signs correct.
- **Backtest = live:** strategy over canned candles yields the live path's decisions.

## Dashboard (Vitest + Testing Library)

- File location: mirror source in top-level `tests/` tree (same pattern as Engine). `apps/dashboard/src/component/Button.tsx` → `apps/dashboard/tests/component/Button.spec.tsx`. Preserve module folder + type subfolder structure.
- Mock the network via MSW (or stub the apiClient); mock the WS/SSE stream for live components.
- Query by role/label, not test-id.
- Kill-switch button: confirm step, auth, halted-state reflection.

## Coverage targets

Pragmatic, not numeric — every business rule and risk invariant has at least one test that breaks if the rule changes. No naked happy paths.

## Test DB (port 6900)

The engine test suite runs against a **dedicated, ephemeral Postgres container** on host port `6900` — never the soak DB on `5433`.

### Setup

```sh
# Copy the test-DB env template (gitignored after copy)
cp .env.test.example .env.test

# Start the test container (auto-started by `pretest` when running locally)
docker compose --profile test up -d --wait postgres-test
```

`pnpm --filter @bot/engine test` triggers a `pretest` hook that starts the container. In CI the container is provided as a service.

> **Leave the `.env.test` password as-is.** The default `test_only_change_me` is a
> deliberate, throwaway credential for the ephemeral tmpfs test DB — it must match the
> `postgres-test` container default, so editing it only breaks the connection unless you
> also recreate the container with a matching `TEST_DB_PASSWORD`. The `_change_me` warning
> applies to the soak/prod `.env`, **not** to `.env.test`. The only rule for `.env.test`
> is the one in the template: never reuse a soak or production credential here.

### Three DSNs

| Variable | Database | Used by |
|---|---|---|
| `DATABASE_URL` | `trade_bot` | Module-load / validateEnv specs |
| `TEST_DATABASE_URL` | `trade_bot_test` | Integration + role specs |
| `MIGRATION_TEST_DB_URL` | `trade_bot_migration_test` | Destructive round-trip specs |

All three databases live in the same `postgres-test` container on port 6900.

### Guard

`globalSetup` calls `assertTestDb()` before any spec runs. It aborts if:
- `TEST_DATABASE_URL` is unset
- The resolved port is not `6900`
- `TEST_DATABASE_URL === DATABASE_URL`

A misconfigured DSN aborts the run before a single `DELETE` or migration executes.

### Auto-migration

`globalSetup` calls `getTestDataSource()` which runs all migrations against `trade_bot_test` once. Role specs connect via raw `pg.Client` and find the schema ready regardless of execution order.

**`pnpm --filter @bot/engine test` now requires Docker** (the `pretest` hook starts the test container). Pure unit suites still require Docker to be available (the hook runs before Jest selects which tests to execute).

### Static tripwire

`tests/ci/noSoakDbLiteral.spec.ts` fails if any `:5433` URL literal or `DB_PORT=5433` instruction reappears in test files (with an allowlist for `validateEnv.spec.ts`, `assertTestDb.spec.ts`, and itself).

## Backtest sweep analysis harnesses

### Time-stop horizon sweep

Reusable harness for parameter-sensitivity analysis. Runs the backtest once per parameter horizon over the same soak window and strategy version, then aggregates results into a timestamped markdown comparison.

**One-liner:**

```sh
scripts/analysis/timestop-sweep.sh [FROM_UTC] [TO_UTC] [VERSION_ID] [HORIZONS_CSV]
```

**Defaults:** FROM=2026-06-09 TO=2026-06-24 VERSION=3 HORIZONS=15,30,45,60

**Output:**
- Markdown summary: `docs/analysis/timestop-sweep-<YYYYMMDD-HHMM>.md` (headline metrics, exit-mix table, funnel, caveats, analyst findings)
- Raw JSON reports: `docs/analysis/.runs/<YYYYMMDD-HHMM>/` (gitignored; retained for reproducibility)

**Safety:** The backtest CLI is spawned with a minimal env allowlist (PATH, HOME, NODE_ENV, DATABASE_URL only — no exchange keys). It reads the soak Postgres read-only and writes nothing to the database. Same contract as the MCP `run_backtest` tool.

**Example:** `docs/analysis/timestop-sweep-20260623-1158.md` shows that widening the live 15-min time stop to 30+ minutes degrades expectancy; the apparent gain at 45/60 min is a slot-occupancy artifact from a changing trade population, not a real exit improvement.

Use for: hypothesis-generation on parameter tuning (decision-grade analysis requires ≥30–50 closed trades per scenario and stability across 2–3 disjoint windows).

### Reward:risk ratio sweep

Analyzes sensitivity of backtest expectancy and win rate to take-profit:stop-loss distance ratio by re-deriving the stop loss and re-sizing the position off the new stop (realistic risk-based sizing). Driven by backtest-only `--target-rr` CLI override (analysis-only, opt-in; live trade path untouched; reads soak DB read-only; writes nothing to the database).

**One-liner:**

```sh
scripts/analysis/rr-sweep.sh [FROM_UTC] [TO_UTC] [VERSION_ID] [RATIOS_CSV]
```

**Defaults:** FROM=2026-06-09 TO=2026-06-24 VERSION=3 RATIOS=0.5,1.0,1.5,2.0

**Output:**
- Markdown summary: `docs/analysis/rr-sweep-<YYYYMMDD-HHMM>.md` (headline metrics, RR distribution, expectancy and win-rate movement across ratios, caveats, analyst findings)
- Raw JSON reports: `docs/analysis/.runs/rr-<runId>/` (gitignored; retained for reproducibility)

**Safety:** The backtest CLI is spawned with a minimal env allowlist (PATH, HOME, NODE_ENV, DATABASE_URL only — no exchange keys). It reads the soak Postgres read-only and writes nothing to the database. Same contract as the MCP `run_backtest` tool.

**Example:** `docs/analysis/rr-sweep-20260623-1611.md` shows that RR ratio is not the leverage moving expectancy; the strategy remains net-negative at every ratio (0.5, 1.0, 1.5, 2.0). Win rate is the binding constraint — a 43% win rate cannot generate positive expectancy regardless of RR multiple. Increasing the ratio worsens the realized RR distribution without improving wins.

Use for: validating whether RR restructuring is a worthwhile tuning lever for a given strategy version (isolate RR sensitivity from win-rate dependent expectancy).
