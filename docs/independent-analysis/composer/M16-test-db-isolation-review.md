# Independent Review — M16 Test-DB Isolation

**Plan reviewed:** `docs/plans/M16-test-db-isolation.md`  
**Codebase snapshot:** 2026-05-31 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M16 addresses a **real, active safety defect**: engine integration tests can reach the soak/calibration Postgres on port 5433 whenever `DATABASE_URL` is unset or mis-set. The adversarial migration round-trip suite is especially dangerous — it reverts **all** migrations against whatever DSN it resolves, and today that DSN falls back to the soak DB.

The plan’s core architecture — profile-gated tmpfs container on 6900, mandatory `TEST_DATABASE_URL`, startup guard, separate `trade_bot_migration_test` for destructive suites — is sound and aligned with CLAUDE.md rules 8 & 9. Soak isolation is treated as a structural invariant, not a convention.

**Assessment:** Accept the direction and implement, but resolve the CI env split and a few harness gaps **before** Wave 1 lands. Without those fixes, CI can break or the guard can be bypassed in subtle ways.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | Accurate; verified in repo (`testDataSource.ts`, adversarial round-trip). |
| Safety architecture | A- | tmpfs + profile + dual DB + fail-fast guard is the right stack. |
| File-scope completeness | B- | `:5433` literals are ~8 files, not ~13; comment/doc drift is wider. |
| CI alignment | C+ | `DATABASE_URL` / `TEST_DATABASE_URL` / `migration:run` tension is underspecified. |
| Harness design | B+ | Good helpers; async globalSetup and env load order need explicit spec. |
| Developer ergonomics | B | Docker-required `pretest` is acceptable here but should be documented. |

**Bottom line:** Ship M16. Fix the CI contract and expand the file checklist before dispatching agents.

---

## Verified Current State

### Where 5433 leakage exists today

Grep of `apps/engine/tests/**` for `:5433` literals (2026-05-31):

| File | Issue |
|------|-------|
| `tests/support/testDataSource.ts` | `DATABASE_URL ?? …5433…` — **shared harness; affects all `getTestDataSource()` consumers** |
| `tests/database/migration.roundtrip.adversarial.spec.ts` | Same fallback — **destructive revert against soak** |
| `tests/database/agent-writer-role.integration.spec.ts` | Engine + `agent_writer` URLs hardcoded to 5433 |
| `tests/database/agent-writer-bypass.adversarial.spec.ts` | Same |
| `tests/database/agent-run-history.integration.spec.ts` | Same |
| `tests/database/mcp-reader-role.integration.spec.ts` | Engine + `mcp_reader` URLs hardcoded to 5433 |
| `tests/bootstrap/SchemaValidationService.manifest.integration.spec.ts` | Standalone fallback |
| `tests/strategy/ComparisonReportRepository.integration.spec.ts` | Standalone fallback |

**Additional files with `DB_PORT=5433` in comments/setup instructions (no `:5433` literal):**

- `tests/promotion/PromotionService.integration.spec.ts`
- `tests/paper-mode/repository/paperPersistenceRepositories.integration.spec.ts`
- `tests/market-data/service/tickAggregatePartitionService.spec.ts`
- Plus inline skip/error messages in the role integration specs above

**Already correct:**

- `tests/database/migration.roundtrip.spec.ts` requires `MIGRATION_TEST_DB_URL` and aborts if unset (no soak fallback). Example docs still reference port 5434 — update to 6900.

**Indirectly affected (use `getTestDataSource()` — fixed when harness is fixed):**

- All market-data repository integration specs
- `PromotionService.integration.spec.ts`, paper-mode repository integration, strategy CLI integration, etc.

### Harness today

```20:20:apps/engine/tests/support/testDataSource.ts
export const TEST_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';
```

```6:11:apps/engine/tests/support/globalSetup.ts
export default function globalSetup(): void {
    const envLocal = resolve(__dirname, '../../../../.env.local');
    if (existsSync(envLocal)) {
        config({ path: envLocal, override: false });
    }
}
```

- Loads `.env.local` only; no `.env.test`, no guard, no reachability probe.
- Jest `maxWorkers: 1` serialises DB suites — still appropriate for a shared integration schema on one DB.

### CI today

The `test` job uses GitHub Actions `services.postgres` on **5432**, sets `DATABASE_URL` to that same instance, runs `migration:run`, then `pnpm -r test`. Tests that fall back to `DATABASE_URL` hit the ephemeral CI DB — safe today, but **different port and shape** from the proposed 6900 contract.

---

## High-Risk Findings

### H1 — CI `DATABASE_URL` / `TEST_DATABASE_URL` / `migration:run` triangle is unresolved

The plan says:

1. Map CI Postgres to **6900:5432**.
2. Set `TEST_DATABASE_URL` and `MIGRATION_TEST_DB_URL` to 6900 DSNs.
3. **Keep `DATABASE_URL` as-is** for `validateEnv` at module load.

Locally, (3) works: `.env` keeps soak `DATABASE_URL` on 5433; `.env.test` supplies `TEST_DATABASE_URL` on 6900; guard rule #3 (`TEST_DATABASE_URL !== DATABASE_URL`) passes.

In CI there is no soak `.env`. If `DATABASE_URL` stays `localhost:5432` while the service maps to **6900**, `validateEnv` and `migration:run` (which reads `DATABASE_URL` via `dataSource.ts`) **connect to the wrong port or nothing**.

If CI instead sets both `DATABASE_URL` and `TEST_DATABASE_URL` to the same 6900 integration DSN, **guard rule #3 fails**.

**Required change in the plan:**

- Document the CI env contract explicitly, for example:
  - `TEST_DATABASE_URL` → `postgresql://…@localhost:6900/trade_bot_test` (all integration specs)
  - `MIGRATION_TEST_DB_URL` → `postgresql://…@localhost:6900/trade_bot_migration_test`
  - `DATABASE_URL` → a **distinct** DSN on the same 6900 instance used only for `validateEnv` / module-load specs, e.g. `trade_bot` default DB **or** a dedicated `trade_bot_validate` DB created in CI init — **must differ from `TEST_DATABASE_URL` by database name, not just path semantics**
  - Update `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_PASSWORD` to match the validateEnv DSN
- Repoint the CI `migration:run` step to migrate **`trade_bot_test`** (export `DATABASE_URL=$TEST_DATABASE_URL` for that step only, **or** drop the step and rely on `getTestDataSource()` — but role suites need migrations before first connection; document which path is authoritative).
- Add verification item: CI job env block satisfies guard rules 1–3 before Jest starts.

### H2 — Adversarial migration round-trip is the highest-priority code fix

`migration.roundtrip.spec.ts` is already isolated behind `MIGRATION_TEST_DB_URL`.  
`migration.roundtrip.adversarial.spec.ts` uses the soak fallback:

```28:28:apps/engine/tests/database/migration.roundtrip.adversarial.spec.ts
const TEST_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';
```

**Wave 2 should list this file first**, not as a representative among equals. Repoint to `MIGRATION_TEST_DB_URL` with the same abort-if-unset pattern as the non-adversarial suite.

### H3 — `globalSetup` must become async for the reachability probe

The plan’s guard opens a throwaway connection. Jest supports `async` globalSetup; the current implementation is synchronous. Specify:

```typescript
export default async function globalSetup(): Promise<void> { … await assertTestDb(); }
```

Also specify **env load order** (first match wins vs override):

1. `.env.test` (committed template → copy to gitignored `.env.test`, or load from repo-root `.env.test.example` in CI)
2. `.env.local` (optional local overrides, `override: false` to avoid clobbering test contract)
3. Fail if `TEST_DATABASE_URL` still unset after load

Without a written order, a developer’s `.env.local` pointing `DATABASE_URL` at 5433 could still satisfy validateEnv imports while tests use `TEST_DATABASE_URL` — acceptable — but a `.env.local` that sets `TEST_DATABASE_URL` to 5433 would bypass intent.

### H4 — Role URL builders must derive host/port from `getTestDbUrl()`, not only replace the fallback

Four specs build secondary DSNs:

```typescript
return `postgresql://agent_writer:${password}@localhost:5433/trade_bot`;
return `postgresql://mcp_reader:${password}@localhost:5433/trade_bot`;
```

Replacing the engine URL fallback is insufficient; **parse or template from the base test URL** so port, host, and database name stay in sync when `TEST_DATABASE_URL` changes.

Suggest a small helper:

```typescript
export function buildRoleDbUrl(role: 'agent_writer' | 'mcp_reader', password: string): string
```

that rewrites user/password on the parsed `TEST_DATABASE_URL`.

---

## Medium-Risk Findings

### M1 — File inventory and static tripwire are under-scoped

Plan claims “~13 files, identical edit” and a grep tripwire for `:5433` only.

**Actual scope:**

- **8 files** with `:5433` URL literals (some with multiple occurrences).
- **≥6 additional files** with `DB_PORT=5433` in headers, skip messages, or operator instructions.
- **`validateEnv.spec.ts`** uses port `5433` as a valid integer — fine; tripwire should remain `:5433` in URL context, not ban the number everywhere.

**Required change:**

- Expand Wave 2 checklist to include **comment and error-message updates** (`docker compose --profile test up -d --wait postgres-test`).
- Consider tripwire pattern: `:5433` **or** `DB_PORT=5433` under `apps/engine/tests/` (exclude `validateEnv.spec.ts` if needed via allowlist comment).

### M2 — `.env.test` onboarding gap

Plan adds gitignored `.env.test` and `.env.example` block, but `.gitignore` currently has `.env`, `.env.local`, `.env.*.local` — **not** `.env.test`.

**Required:**

- Add `.env.test` to `.gitignore`.
- Commit **`.env.test.example`** (or document copying a block from `.env.example`) so new contributors get a one-command setup without reading the milestone plan.

### M3 — `pretest` Docker dependency for all engine tests

Wiring `pretest` → `docker compose --profile test up -d --wait postgres-test` means **every** `pnpm --filter @bot/engine test` requires Docker, including pure unit suites that never touch Postgres.

Acceptable for this repo given DB integration volume, but:

- Document in `testing.md` and engine README snippet.
- Consider `test:unit` without pretest vs `test:integration` with pretest if unit-only runs become slow/flaky on machines without Docker.

### M4 — Guard port check needs robust URL parsing

Rule #2: port must equal `TEST_DB_PORT` (6900).

Edge cases to specify in implementation:

- Default PostgreSQL port omitted in URL (`postgresql://user:pass@localhost/dbname` → 5432) — should **fail** the 6900 check.
- IPv6 host brackets — use `URL` parser (with `postgresql:` → `postgres:` substitution) rather than regex on `:5433`.
- Optional: reject URL paths/database names containing soak identifiers if ever used (`trade_bot` without `_test` suffix) — lower priority if DB names are distinct.

### M5 — Postgres version skew: local 18.4 vs CI 16

Compose plan uses `postgres:18.4-alpine`; CI uses `postgres:16`. Migration round-trips and partition behaviour were validated on 18.x locally.

**Recommendation:** Align CI service to `postgres:18-alpine` (or same 18.4 pin) to avoid “passes locally, fails in CI” on partition DDL. Not a blocker if migration tests already pass on 16 in CI today — but M16 is a good moment to align.

---

## Low-Risk / Clarifications

### L1 — Integration vs migration DB naming

`POSTGRES_DB=trade_bot_test` + init `CREATE DATABASE trade_bot_migration_test` is clear. Document that:

- Integration suites + role tests → `trade_bot_test`
- Both round-trip suites → `trade_bot_migration_test`
- Soak `trade_bot` on 5433 is never referenced in test code

### L2 — `maxWorkers: 1` comment in `jest.config.js`

Update comment from “shared Postgres instance” to “shared **integration** schema on `trade_bot_test`” so future readers do not assume 5433.

### L3 — Root `pnpm test` vs engine `pretest`

Only `@bot/engine` needs `pretest`. Root `pnpm test` runs all workspaces — ensure pretest is on the engine package only (plan already says this); agent/dashboard tests do not need the 6900 container.

### L4 — M14 dependency

M14 CI review gate is cited as dependency. M16’s CI edits are self-contained in the `test` job; no conflict observed. Note in milestone log that M16 supersedes the CI postgres port story for tests.

---

## What the Plan Gets Right

1. **tmpfs, no named volume** — eliminates volume confusion with `postgres-data`.
2. **`test` compose profile** — default `docker compose up` unchanged; soak stack untouched.
3. **Dual database in one container** — cheaper than two containers; sufficient isolation for revert-all migrations.
4. **Fail-fast before any spec** — guard in globalSetup prevents “ran 200 tests then deleted soak data”.
5. **Separate migration DB** — matches existing intent in `migration.roundtrip.spec.ts`; only adversarial suite regressed.
6. **Safety notes** — correctly states no dump required; no soak volume operations.
7. **Verification checklist** — soak row-count before/after is the right manual proof.

---

## Recommended Plan Amendments

Add these to `M16-test-db-isolation.md` before dispatch:

| # | Amendment |
|---|-----------|
| 1 | New subsection **“CI env contract”** with explicit values for `DATABASE_URL`, `TEST_DATABASE_URL`, `MIGRATION_TEST_DB_URL`, `DB_*`, and how `migration:run` targets `trade_bot_test`. |
| 2 | Priority ordering in Wave 2: `migration.roundtrip.adversarial.spec.ts` first. |
| 3 | Expand file list to include comment/message updates; add `.env.test.example` + `.gitignore` entry. |
| 4 | Specify async `globalSetup` and env load order. |
| 5 | Add `buildRoleDbUrl()` (or equivalent) for agent/MCP role specs. |
| 6 | Tripwire: `:5433` or `DB_PORT=5433` in tests tree (with allowlist for validateEnv port integer test). |
| 7 | Optional: align CI Postgres to 18.x. |

---

## Suggested Verification Additions

Beyond the plan’s seven checks:

8. **CI guard dry-run:** echo env in CI before test; assert `TEST_DATABASE_URL` port is 6900 and `TEST_DATABASE_URL !== DATABASE_URL`.
9. **Role suite smoke:** `agent_writer` / `mcp_reader` integration specs connect on 6900 (log resolved host:port once in guard or first suite).
10. **Unit-only sanity:** confirm a non-DB spec still passes when test container is up (no regression from pretest latency).
11. **Adversarial round-trip isolation:** after adversarial suite, `trade_bot_test` still has schema (migration DB bore the revert).

---

## Implementation Wave Risk Summary

| Wave | Risk if skipped |
|------|-----------------|
| Wave 1 DevOps | Tests cannot run locally/CI without manual container setup |
| Wave 2 Harness | Soak exposure persists via `testDataSource` + adversarial suite |
| Wave 3 QA | Regressions reintroduce 5433 literals undetected |
| Wave 4 Review | CI env triangle (H1) may ship broken |
| Wave 5 Scribe | Operators revert to old `DB_PORT=5433` docs |

---

## Conclusion

M16 is **necessary, well-motivated, and architecturally correct**. The soak DB risk is not hypothetical — the fallback pattern is in the shared harness and the adversarial migration suite today.

Treat **CI env contract (H1)**, **adversarial suite repoint (H2)**, and **role URL helper (H4)** as pre-implementation clarifications. With those amendments, the plan is ready for the standard dispatch waves (DevOps → Engine → QA → Review → Scribe).

**Recommended status:** Approve with amendments — proceed to implementation after updating the plan document with the CI subsection and expanded file checklist.
