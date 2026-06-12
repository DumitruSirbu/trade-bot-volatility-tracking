# M12 — Execution plan

**Goal recap.** Read-only MCP server exposing trade DB + backtest engine as
five tools, structurally separated from execution/risk so write capability is
impossible by construction. Local-only (no cloud — that's M15). Engine
continues to run 24/7 as a separate NestJS process.

**Authoritative ADRs locked first:**
- **ADR 0033** — MCP module-boundary enforcement (workspace dep graph + lint +
  runtime guard).
- **ADR 0034** — DB isolation via `mcp_reader` role, statement timeout,
  bounded pool. Read replica deferred to M15.

**Workspace shape (decided).** Two new locations:

- `apps/mcp/` — `@bot/mcp` standalone Node process, MCP-protocol server.
  Depends on `@bot/shared` + `@bot/analysis` only. **Does not** list
  `@bot/engine` as a dep.
- `packages/analysis/` — `@bot/analysis` pure TypeScript library: query
  functions, DTOs, and (preferred) the extracted backtest runner. Depends on
  `@bot/shared` only.

Justification (vs alternatives `apps/engine/src/mcp/`, separate repo, NestJS
dynamic module): only the separate-app shape gives a compile-time guarantee
that `apps/mcp` cannot reach `apps/engine` source. See ADR 0033 §4.

**Transport (decided).** **stdio** (JSON-RPC over stdin/stdout) per the
standard MCP transport. The MCP server is launched as a child process by the
operator's MCP client (Claude Code, Cursor, etc.). No TCP listener, no port
binding, no auth surface to defend. The engine's HTTP read-API stays the
authenticated channel for the dashboard; MCP is a separate channel for the
agent.

If a future use-case needs HTTP transport (M13 agentic loop running on a
different host), the design upgrade is **localhost-bound HTTP with a
short-lived bearer issued by the same auth path as ADR 0020/0027** — flagged
as deferred to M13.

**Engine coexistence.** MCP queries Postgres via the `mcp_reader` role (ADR
0034). The 24/7 engine process is untouched; MCP and engine never share a
connection pool, never share a TypeORM `DataSource`, and (by ADR 0033) never
share a process address space.

---

## Wave plan

Each wave is ≤5 files/items per `docs/best-practices/dev-qa-cycle.md`. Waves
are listed in dependency order; serial unless marked otherwise.

### W0 — Workspace scaffolding + DB role migration (serial; bot-shared-maintainer + bot-engine-nestjs)

**Scope (5 items):**

1. Add `apps/mcp/` workspace stub: `package.json` (`@bot/mcp`, deps
   `@bot/shared workspace:^`, `@bot/analysis workspace:^`, MCP SDK), empty
   `src/main.ts`, `tsconfig.json`. **Critical:** do NOT list `@bot/engine`.
2. Add `packages/analysis/` workspace stub: `package.json` (`@bot/analysis`,
   deps `@bot/shared workspace:^`, `typeorm`, `pg`, `decimal.js`),
   `src/index.ts`, `tsconfig.json`.
3. Engine migration `<ts>-CreateMcpReaderRole.ts`: creates `mcp_reader` role,
   sets `default_transaction_read_only`, `statement_timeout=30s`,
   `lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`; grants
   SELECT on the whitelist from ADR 0034 §2.5; reversible.
4. Update `docs/architecture/data-model.md` with the grant-policy block (new
   tables must explicitly opt into MCP visibility).
5. Add ESLint flat-config block in root `eslint.config.js` with
   `no-restricted-imports` scoped to `apps/mcp/**` and `packages/analysis/**`
   banning `@bot/engine`, `apps/engine/*`, deep relative reaches.

**Exit:** `pnpm install` clean, migration up+down works, `pnpm lint` passes,
forbidden-import test asserts violation.

### W1 — Analysis package query layer (serial; bot-engine-nestjs)

**Scope (5 items):**

1. `packages/analysis/src/db/DataSourceFactory.ts` — TypeORM DataSource
   builder reading `MCP_DB_*` env vars; `application_name=mcp_reader`;
   `max=3 min=0 idleTimeoutMillis=30_000`.
2. `packages/analysis/src/query/getPerformance.ts` — function taking
   `{ versionId: number; from: Date; to: Date }`, returns
   `IPerformanceByVersionView` (existing shared DTO). SQL aggregation over
   `positions`/`transactions`.
3. `packages/analysis/src/query/compareVersions.ts` — `{ aVersionId,
   bVersionId, from, to }` → per-version metrics + same-event paired diff
   over `decisions.event_id`.
4. `packages/analysis/src/query/listPositions.ts` — filtered position
   listing with cursor pagination (reuse `IPaginated`).
5. `packages/analysis/src/query/getDecisions.ts` — decisions for a symbol
   over a window, with `market_snapshot` selectable, capped 10k rows.

**Exit:** unit tests with fixture rows green; range/row caps enforced;
integration test runs each query under `mcp_reader` role and asserts result
shape.

### W2 — Backtest runner extraction (DEFERRED — Option II selected)

**Status:** Deferred per ADR 0033 §2.5 — **Option II (spawn) taken**.

The W2 spike confirmed Option I is infeasible within a single ≤5-item wave:
`BacktestRunnerService` pulls in `StrategyRegistry`, `RiskGateService`,
`OrderPolicyRouter`, `InstrumentRepository`, seven TypeORM entities
(`CandleEntity`, `FundingRateEntity`, `BookSnapshotEntity`,
`OpenInterestEntity`, `TickAggregateEntity`, `UniverseMembershipEntity`,
`StrategyVersionEntity`), `BaseRepository`, money helpers, and indicator
helpers. Detangling inverts strategy/risk/market-data module ownership —
unbounded scope vs `dev-qa-cycle.md` caps. The runner stays at
`apps/engine/src/backtest/`; the boundary guarantee is preserved by Option
II because the MCP process's address space never loads engine code.

**No file moves. No engine DI changes. M7/M8 layout untouched.** W4
`run_backtest` calls the spawn path defined below.

### W3 — MCP server skeleton + tool registry (serial; bot-engine-nestjs)

**Scope (5 items):**

1. `apps/mcp/src/main.ts` — MCP SDK server, stdio transport, lifecycle
   hooks. Per the SDK conventions (resolve current SDK via `context7-mcp`
   at wave start before writing imports).
2. `apps/mcp/src/boundary/RuntimeGuard.ts` — at boot, scan loaded module set
   for `/apps/engine/` paths; exit non-zero if any match. Honors
   `MCP_BOUNDARY_GUARD=disabled` only in tests.
3. `apps/mcp/src/tools/ToolRegistry.ts` — registers the five tools below.
   Each tool has a Zod (or class-validator) schema for params and a typed
   handler. Mutation-shaped tools (`create_*`, `set_*`, etc.) are not
   registered — the registry has no API for write tools, so adding one is
   itself a code change.
4. `apps/mcp/src/dtos/` — request/response DTO schemas for each tool;
   validation rejects unbounded ranges, missing required filters, and
   `acknowledgedLargeRange` absent for > 90d queries.
5. `apps/mcp/src/errors/McpToolError.ts` — typed errors (`VALIDATION`,
   `TIMEOUT`, `INTERNAL`, `BOUNDARY_VIOLATION`) returned as MCP tool
   errors, never as opaque exceptions.

**Exit:** server boots, lists 5 tools, rejects invalid requests, runtime
guard works.

### W4 — Tool implementations (parallel under one wave; bot-engine-nestjs)

**Scope (5 tools = 5 files):**

1. `get_performance(versionId: number, from: ISO, to: ISO)` → calls
   `analysis.getPerformance`. Cap: 90 days unless `acknowledgedLargeRange`.
2. `compare_versions(aVersionId, bVersionId, from, to)` → calls
   `analysis.compareVersions`. Cap: 90 days.
3. `list_positions(filters: { symbol?, versionId?, status?, from, to,
   cursor?, limit?<=200 })` → calls `analysis.listPositions`.
4. `get_decisions(symbol: string, from: ISO, to: ISO, includeSnapshot:
   boolean = false)` → calls `analysis.getDecisions`. Cap: 30 days.
5. `run_backtest(versionId: number, from: ISO, to: ISO)` → **spawn path
   per ADR 0033 §2.5 Option II.** Tool handler `spawn`s `pnpm --filter
   @bot/engine backtest run --version <id> --from <iso> --to <iso>
   --output <tmpfile>`; on exit-0 reads the tmpfile, parses
   `IBacktestReport`, deletes the tmpfile, returns the report. Exit-nonzero
   maps to `McpToolError.INTERNAL` with stderr tail in the message. Caps
   per ADR 0034 §2.6: ≤30 days, single concurrent run (`Sema(1)`), 10-min
   wallclock kill (SIGTERM then SIGKILL+5s). `JSON.parse` is bounded to a
   max-size read of the tmpfile (reject >50 MB). The engine CLI must
   already accept `--output` (verify in W3; if missing, the engine-side
   addition is a 1-item shim — track as W4 sub-item rather than a new
   wave). The spawned process inherits no MCP env vars except a minimal
   allowlist (`PATH`, `HOME`, `NODE_ENV`, `ENGINE_DB_*`).

**Exit:** each tool tested with happy-path + cap-violation cases.

### W5 — QA wave (serial; bot-qa-engineer; adversarial)

**Scope (5 adversarial vectors):**

1. SQL-injection attempts via `symbol` and other string params; assert
   parameterized queries / validator rejection.
2. Bypass attempts on range caps: missing `to`, future-dated `to`,
   reversed range, NaN/Infinity in numeric params.
3. Long-running query attempts: `run_backtest` with 365-day range
   (rejected), `get_decisions` over the full universe (rejected or
   paginated).
4. Concurrent `run_backtest` invocations from one MCP session — second
   must queue or reject per `Sema(1)`.
5. Boundary-violation attempts: a test file under `apps/mcp/tests/`
   tries `import { ExecutionService } from '@bot/engine'` and
   `import('../../engine/src/...')`; both must fail at `tsc --noEmit`.

**Exit:** zero blockers; all five vectors covered by failing-attempt tests.

### W6 — Reviewer wave (parallel; bot-review-security + bot-review-logic + bot-review-clean-code + bot-review-quant)

**Scope:** standard 4-reviewer parallel pass. Specifically:

- Security: confirm `mcp_reader` grants match ADR 0034 whitelist; confirm
  no sensitive table is selectable; confirm stdio transport has no
  ambient network listener.
- Logic: confirm pagination cursors HMAC-bound (reuse `CursorCodec` from
  M9 if feasible — note `apps/mcp` cannot import it from engine; either
  reshuffle into `@bot/shared/util` or duplicate-as-pure with shared key
  derivation).
- Clean-code: tool DTOs follow naming conventions.
- Quant: spot-check `compare_versions` paired-event semantics still align
  with ADR 0017/0018.

**Exit:** 0 blockers, 0 highs, majority of mediums resolved per
`dev-qa-cycle.md`.

### W7 — Scribe close (serial; bot-scribe)

Update `docs/work-log.md`, `CLAUDE.md` status block, M12 plan outcome
section, ADR statuses to Accepted-and-shipped.

---

## Tool DTO shapes (canonical)

All DTOs live in `packages/analysis/src/dtos/` and re-export from
`@bot/analysis`. Validation is Zod (or class-validator — wave-1 implementer's
choice, consistent with engine convention).

```
GetPerformanceParams      { versionId: number; from: ISO; to: ISO;
                            acknowledgedLargeRange?: boolean }
CompareVersionsParams     { aVersionId: number; bVersionId: number;
                            from: ISO; to: ISO;
                            acknowledgedLargeRange?: boolean }
ListPositionsParams       { symbol?: string; versionId?: number;
                            status?: 'open'|'closed'; from: ISO; to: ISO;
                            cursor?: string; limit?: number /* ≤200 */ }
GetDecisionsParams        { symbol: string; from: ISO; to: ISO;
                            includeSnapshot?: boolean /* default false */ }
RunBacktestParams         { versionId: number; from: ISO; to: ISO }
```

Range cap defaults: `get_performance`, `compare_versions`, `list_positions`,
`get_decisions` → 90d soft / 365d hard with explicit flag.
`run_backtest` → 30d soft / 180d hard.

All responses are existing shared DTOs (`IPerformanceByVersionView`,
`IOpenPositionView`/`IClosedPositionView`, `IDecisionView`,
`IBacktestReport`) so the contract is already pinned and dashboard-compatible.

---

## Test strategy — boundary enforcement specifically

The boundary itself is tested (ADR 0033 §5):

1. **Compile-time test.** `apps/mcp/tests/boundary.compile.spec.ts` writes
   a tempfile with `import { ExecutionService } from '@bot/engine'`; runs
   `tsc --noEmit`; asserts non-zero exit + TS2307. Same for relative
   reach.
2. **Lint-time test.** A spec invokes `pnpm eslint apps/mcp --
   --no-eslintrc --config <path>` against a fixture that imports
   `@bot/engine`; asserts the `no-restricted-imports` rule fires.
3. **Runtime-guard test.** Boots the MCP server with a planted entry in
   `require.cache` matching `/apps/engine/`; asserts the boot guard
   exits non-zero.
4. **Grep-level CI.** A CI job runs `git grep -E '@bot/engine|apps/
   engine' apps/mcp packages/analysis` and fails on any match outside
   tests.
5. **DB-role test.** Migration spec attempts INSERT/UPDATE/DELETE under
   `mcp_reader`, asserts `42501`; attempts `SELECT FROM auth_tokens`,
   asserts `42501`.

These five tests are wave-5 deliverables and gate the milestone.

---

## Risks, deferrals, M13 hand-off

**Risks:**

- **R1 — Backtest extraction (W2) snowballs.** *Realised.* Spike
  confirmed `BacktestRunnerService` pulls in strategy/risk/market-data DI
  + 7 entities. Option II (spawn) selected per ADR 0033 §2.5. W2 deferred;
  W4 `run_backtest` uses the spawn path. Boundary guarantee unchanged.
- **R1a — Spawn cold-start wallclock.** Each `run_backtest` call now
  incurs engine boot cost (NestJS module init + TypeORM bootstrap, ~2–4s
  on the local box). Adds to the 10-min wallclock cap but acceptable.
  Mitigation: cap already accounts for it; no streaming partial-progress
  protocol attempted in M12.
- **R1b — JSON-stdout/file contract drift.** The MCP↔engine contract is
  now the engine CLI's `--output` JSON shape (`IBacktestReport`).
  Mitigation: `IBacktestReport` is a shared DTO already pinned by M7/M8;
  reviewer wave W6 logic-review confirms the engine CLI writes exactly
  that shape with no extra fields.
- **R1c — Error-propagation opacity.** Engine crashes/throws inside the
  spawned process surface only as exit code + stderr to MCP. Mitigation:
  MCP tool tails last 4 KB of stderr into `McpToolError.INTERNAL.message`
  and logs full stderr to MCP's own log; do not surface raw stderr to the
  agent (could leak DB paths). Treated as W4 implementation detail; W5
  QA adds a vector for "engine-side throw → tool returns INTERNAL with
  redacted stderr".
- **R1d — Tmpfile residue + race.** Concurrent rejected via `Sema(1)`,
  but crashed spawns may leave tmpfiles. Mitigation: tmpfile path in
  `os.tmpdir()` with `mcp-backtest-<uuid>.json`; startup sweep on MCP
  boot deletes orphans older than 1h.
- **R2 — `mcp_reader` grant drift over time.** New tables added in
  future milestones may default to no grant (safe) but become invisible
  to MCP (functional gap). Mitigation: data-model.md doc block + a unit
  test enumerates expected MCP-visible tables and fails if the grant set
  drifts.
- **R3 — stdio transport limits multi-host agents.** M13's agent may
  want to run on a different machine than the engine. Deferred: M13
  introduces localhost-bound HTTP transport with bearer auth if needed.
- **R4 — Long-running query bypassing the 30 s timeout via streaming.**
  Postgres `statement_timeout` covers each statement; cursor-paginated
  result sets that hold open transactions could theoretically be abused.
  Mitigation: `idle_in_transaction_session_timeout=60s` + small pool +
  per-tool wallclock guard in MCP.
- **R5 — CursorCodec reuse from M9.** Lives in engine today. Either
  reshuffle into `@bot/shared/util` (preferred — pure crypto) or build a
  parallel pure-key one in `@bot/analysis`. Reshuffle is the cleaner
  fix; routes through `bot-shared-maintainer`.

**Deferred to M13:**

- Localhost-bound HTTP MCP transport with bearer auth (if multi-host
  agent needed).
- Tool: `propose_strategy_change` (write-shaped but proposing-only;
  needs human gate path — out of M12 scope).
- Materialized views for `get_performance` if it becomes a hotspot.

**Deferred to M15 (cloud):**

- Postgres read replica + replica-only DataSource for MCP.
- PgBouncer pool fronting both engine and MCP (only if connection churn
  needs it).
- Master-account `apiRestrictions` predicate verification (pre-M15
  carry-over from M11a, unrelated to MCP but tracked here for
  cross-reference).

**M13 needs from M12:**

- The 5 tools above as stable contracts (DTOs and error codes pinned).
- `IBacktestReport` continues to be the unit of truth for backtest
  output — M13 will diff reports across versions.
- `mcp_reader` role exists and is documented; M13 agents inherit it.
- A documented way for M13 to register additional READ-ONLY tools
  without touching the engine (i.e., new files in
  `apps/mcp/src/tools/`).

---

## Summary — wave dispatch for orchestrator

1. **W0** — workspace scaffold + `mcp_reader` migration + lint rule. 5 items.
   Serial. Shared-maintainer + engine engineer.
2. **W1** — analysis-package query functions (4 queries + DataSource
   factory). Serial. Engine engineer.
3. **W2** — **DEFERRED.** Option II (spawn) selected per ADR 0033 §2.5.
   Runner stays in `apps/engine/src/backtest/`; W4 `run_backtest` invokes
   it via `pnpm --filter @bot/engine backtest run`. No file moves.
4. **W3** — MCP server skeleton: stdio transport, runtime guard, tool
   registry, DTOs, typed errors. 5 files. Serial. Engine engineer.
5. **W4** — implement the 5 tools. Each tool calls into `@bot/analysis`
   only. Serial within wave; tools share validator + error infra.
6. **W5** — adversarial QA: SQL-injection, cap bypass, concurrency,
   boundary-violation compile tests. Serial. QA engineer.
7. **W6** — 4-reviewer parallel pass (security, logic, clean-code, quant).
   Cycle to zero blockers/highs.
8. **W7** — scribe close: work log, status block, ADR statuses to
   accepted-and-shipped.

ADRs **0033** (boundary) and **0034** (DB isolation) are the load-bearing
decisions; both are accepted at the start of W0 so engineers have an
authoritative reference.
