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
