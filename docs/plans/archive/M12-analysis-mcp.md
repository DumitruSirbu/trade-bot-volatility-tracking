# M12 — Analysis MCP (phase 2)

**Goal:** A read-only MCP server exposing the trade DB and backtest engine as tools,
so the weekly review can be done interactively with an LLM.

**Depends on:** M7 (backtest), M8 (versioning), real accumulated data.

## Tasks

- **Read-only MCP server** over the engine's data, **bound to localhost / an authenticated transport** (never publicly exposed) and querying a **read replica or read-only role** — never the live engine's DB connection.
  - *Output:* MCP server reachable only via the authed/local transport; cannot contend with the live engine's DB.
- **Tools:** `get_performance(version, period)`, `compare_versions(a, b, period)`, `list_positions(filters)`, `get_decisions(coin, window)`, `run_backtest(version, range)`. `run_backtest` enforces **range + concurrency caps** so it can't be a DoS/compute vector.
  - *Output:* each tool returns structured results; backtests are bounded.
- **Structurally-enforced read-only boundary.** The MCP server depends only on a **read-only data/analysis package with no import path to `ExecutionModule`/`RiskModule`/order code** — write capability is impossible by construction, not by policy. A module-boundary lint rule enforces it.
  - *Output:* the server cannot import execution/order code; a test/lint fails if someone tries.
- **No mutation tools.** No order-placement, no go-live, no DB writes — analysis only.
  - *Output:* server exposes zero write/execute tools.

## Definition of done

An interactive session can query performance, compare versions, and run backtests
through MCP tools — with no ability to move money, enforced by the module boundary.

## Outcome

**Completed definition-of-done:** MCP server serves 5 read-only tools (`get_performance`, `compare_versions`, `list_positions`, `get_decisions`, `run_backtest`) via stdlib transport; backtest invocation is bounded (absolute-path + env validation, CLI spawn with 10-min wallclock timeout, 64KB redacted stderr), query tools enforce per-tool budgets (30s statement timeout, 5s lock timeout, 3-connection pool, per-filter row caps with 10k hard overflow rejection). Boundary guarantee is structurally enforced: `@bot/mcp` package.json omits `@bot/engine` dependency, tsc --noEmit rejects the import, ESLint forbids patterns, runtime guard scans require.cache for engine paths.

**What shipped (W0–W6):**
- **W0 workspace + DB role + lint:** New workspace `apps/mcp/` (@bot/mcp MCP server), `packages/analysis/` (@bot/analysis read-only library). Migration `CreateMcpReaderRole.ts` provisions Postgres `mcp_reader` role: `default_transaction_read_only`, `statement_timeout=30s`, `lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`, SELECT on 13 whitelisted tables. Root `eslint.config.js` boundary rule scoped to `apps/mcp/**` + `packages/analysis/**` bans `@bot/engine` + relative reaches. `docs/runbooks/mcp-deployment.md` operator runbook.
- **W1 analysis query layer:** `packages/analysis/src/db/DataSourceFactory.ts` (pool max=3 min=0, TLS strict verify-full/verify-ca, sentinel-password refusal at init). Four query functions: `getPerformance(versionId, from, to)`, `compareVersions(aVersionId, bVersionId, from, to)`, `listPositions(filters)`, `getDecisions(symbol, from, to, includeSnapshot)`. `CursorCodec.ts` pagination with filterHash binding (sha256 first-16 hex over normalized filters). `analysisValidation.ts` shared validation, `analysisConsts.ts` (MAX_LIMIT, DEFAULT_LIMIT, ANALYSIS_MAX_RANGE_MS, DECISIONS_ROW_CAP).
- **W3 MCP server skeleton:** `apps/mcp/src/main.ts` (MCP SDK stdio transport, lifecycle hooks, DataSource init, SIGINT/SIGTERM shutdown, stderr-only logging). `RuntimeGuard.ts` Layer C runtime guard (scans require.cache for /apps/engine/ paths; ESM no-op acknowledged). `ToolRegistry.ts` forbids write-tool registration by construction (`registerReadOnlyTool` only). Zod schemas + constants (UTC-calendar-day regex for run_backtest, tool descriptions, error types).
- **W4 5 tools:** `getPerformance.tool.ts`, `compareVersions.tool.ts`, `listPositions.tool.ts`, `getDecisions.tool.ts`, `runBacktest.tool.ts`. `run_backtest`: `child_process.spawn` (shell: false, env allowlist [PATH, HOME, DATABASE_URL, NODE_ENV]), MCP_ENGINE_CMD validation (absolute path + exists check, fallback to pnpm with warning), Sema(1) serialization, 10-min SIGTERM→SIGKILL, 64KB stderr buffer with 2KB redacted tail (postgres URLs, Bearer tokens, IPv4/IPv6 incl bracket-notation).
- **W5 adversarial QA:** SQL-injection defense-in-depth (34 tests), boundary compile-time spec (`tsc --noEmit` rejects `@bot/engine`), DB-role permission integration (conditional on PG), DTO boundary tests, redaction (IPv6, JWT, database-URL).
- **W6 review cycle:** R1 2 blockers (compareVersions paired-event double-counting; run_backtest ISO truncation look-ahead), 5 highs, ~17 mediums. Fix wave 1 closed both blockers + 3 highs. Fix waves 2–5 closed remaining highs + 4+ mediums each (security, logic, clean-code). Outstanding mediums deferred to M13+ (TOCTOU, quoting, NOLOGIN rotation, missing index, Math.floor vs round, refactor nits).
- **ADRs 0033 + 0034 Accepted-and-shipped:** ADR 0033 (MCP module-boundary enforcement: workspace deps, ESLint rule, Layer A/B/C defense-in-depth). ADR 0034 (MCP DB isolation: read-only role, 30s timeout, 3-connection pool, per-tool budgets). Both reference `docs/plans/archive/M12-analysis-mcp.md` + `M12-execution-plan.md` + operator runbook.

**Test counts at close:**
- `@bot/analysis`: 94 tests across 7 suites (all green)
- `@bot/mcp`: 99 tests across 7 suites (all green)
- `@bot/engine` M12-touched specs: 11 tests across 2 suites (all green)
- DB-role integration spec: 1 file, conditional on local Postgres, skips cleanly without `RUN_PG_INTEGRATION=1`
- **Total: 204 new tests, all passing**

**Review history:** 4 reviewers (security, logic, clean-code, quant), 5 fix waves. R1 identified 2 blockers (compareVersions double-counting same-event pair; run_backtest ISO string truncation creates date boundary ambiguity); 5 highs. All blockers + 3 highs fixed in fix-wave-1. Fix-waves 2–5 addressed security (SQL-injection, redaction patterns), logic (cursor validation, MIN_PAIRED floor notification), clean-code (const organization, validation refactor, enum nits). Re-review confirmed zero blockers, zero highs; ~60% of outstanding mediums resolved; remainder deferred to M13+ (TOCTOU, quoting policy, rotation checklist, index missing, Math.floor cosmetic, paired test + refactor volume).

**Boundary guarantee at close:**
- `apps/mcp/package.json` deps: `@bot/shared`, `@bot/analysis`, `@modelcontextprotocol/sdk`, `zod` — NO `@bot/engine`.
- `packages/analysis/package.json` deps: `@bot/shared`, `decimal.js`, `pg`, `typeorm` — NO `@bot/engine`.
- ESLint flat-config blocks imports at lint time.
- `tsc --noEmit` compile-time spec verifies @bot/engine import fails.
- Spawn is the only engine-process touch (OS boundary guarantee via shell: false + path validation).

**Operator runbook:** `docs/runbooks/mcp-deployment.md` (MCP_DB_PASSWORD sentinel-rotation validation, MCP_ENGINE_CMD absolute-path setup, tool invocation examples, troubleshooting).

**Live-app sanity check (deferred to operator):** Engine remains in M11a PAPER soak (24/7). MCP server launched on-demand by operator's MCP client. A 10-min smoke would consist of: (1) starting `node apps/mcp/dist/main.js`, (2) invoking one tool (e.g., `list_positions` with empty filters), (3) verifying structured JSON result + no errors, (4) checking process logs show no @bot/engine import warnings. Document as closing step in operator's pre-M13 validation checklist.

### Post-close live-app smoke (fix wave 6)

**Chronology:** Operator started MCP server live against real database after scribe close. Setup required rotating `mcp_reader` password + setting `MCP_DB_PASSWORD` + fixing `MCP_DB_PORT` default (5433 vs 5432 collision). Boot smoke passed: boundary guard validated, DataSource initialized, 5 tools listed, clean SIGTERM. Tool-call smoke: 13 JSON-RPC calls tested (5 tools, validation, adversarial payloads). Validation rejected 8/8 edge cases (reversed range, oversized range, versionId=0, a===b, limit>200, SQL-injection in symbol, invalid symbol regex, unknown tool). Happy paths returned correctly-shaped JSON.

**Bug 1 [HIGH]:** `run_backtest` spawn fired correctly, but engine exited code 1 → MCP returned INTERNAL. Root cause: `CcxtBinanceExchangeClient.onModuleDestroy()` called `close()` which routed through `callExchange('close', ...)`. The string `'close'` was not registered in `OPERATION_REQUEST_WEIGHTS`, triggering a rate-limit assertion error on teardown. Backtest itself ran successfully (valid `IBacktestReport` produced), but teardown crash masked the result.

**Bug 2 [HIGH]:** `get_decisions(symbol='TST/USDT:USDT', ...)` and `list_positions(filters.symbol='TST/USDT:USDT')` returned VALIDATION error. Root cause: symbol regex `^[A-Z0-9]{1,20}$` too narrow — rejected CCXT futures notation (forward slash, colon). M13 LLM agent would be unable to query any real spot-or-futures symbol via the API.

**Bug 3 [MEDIUM]:** `get_performance(versionId=0, from=..., to=...)` for a valid existing strategy version returned `label: "unknown@v<id>", status: "unknown"` whenever the window had 0 trades. Root cause: `getPerformance` SQL aggregation returned empty result set; fallback path did not JOIN `strategy_versions` to resolve the real version name + status. LLM misread output as "version doesn't exist."

**Fixes (fix wave 6):**
1. **Bug 1:** `CcxtBinanceExchangeClient.close()` no longer routes through the rate limiter. Local connection-close consumes no HTTP weight. Errors swallowed + logged so shutdown never crashes.
2. **Bug 2:** `SYMBOL_REGEX` in `apps/mcp/src/const/mcpConsts.ts` + SQL-injection guards in `packages/analysis/src/query/{listPositions,getDecisions}.ts` widened to `^[A-Z0-9]{1,20}(?:\/[A-Z0-9]{1,15}:[A-Z0-9]{1,15})?$`. Still rejects lowercase, partial matches, and injection payloads. Operator can now query real symbols.
3. **Bug 3:** Added `lookupVersionOrThrow()` to `packages/analysis/src/query/getPerformance.ts`. When aggregation returns empty, resolves real `name@v<version>` + `status` from `strategy_versions`. Throws `AnalysisValidationError('versionId', 'no such version: <id>')` when version genuinely doesn't exist.

**Re-smoke verification:** `get_decisions(symbol='TST/USDT:USDT')` returned real data; `get_performance(versionId=0)` for valid version returned `label: "volatility-vwap@v0", status: "active"`; `get_performance(versionId=999)` returned clean VALIDATION error; `run_backtest(versionId=0)` successfully returned full `IBacktestReport` (no exit code 1).

**Configuration deltas:**
- `.env.example` gained "Analysis MCP (M12 — ADR 0033 + 0034)" section with explicit `MCP_DB_PORT=5433` (matches `trade-bot-postgres` host mapping; local Postgres often runs on 5432, causing collision on dev machine).
- Operator must run `ALTER ROLE mcp_reader PASSWORD '<secret>'` to rotate from sentinel — `DataSourceFactory` refuses boot if password still equals sentinel string.

**Test counts updated:** @bot/analysis 94 → 97 tests (+6), @bot/mcp 99 → 100 tests (+1), @bot/engine +2 (new `apps/engine/tests/exchange/service/CcxtBinanceExchangeClient.onModuleDestroy.spec.ts`). All green. Builds clean across all 4 packages.

**Deferred items:**
- M13+: MCP_ENGINE_CMD realpathSync TOCTOU (symlink race in spawn block); GRANT CONNECT identifier quoting (Postgres reserved-word safety); mcp_reader NOLOGIN-until-rotate (password mgmt gate); missing index on decisions(position_id, ts) (query perf); windowDays Math.floor vs round (quant cosmetic); paired test for analysisValidation + BacktestCliArgError own file (test volume); McpToolErrorKindEnum as proper TS enum (clean-code nit); control-flow spacing mass edit (formatter pass); function-size refactors (waitForChild, buildRuntime, listPositions).
- M13+: depth-aware backtest extension (slippage model refinement per M7 roadmap); wizard MCP tools (M13 agentic loop feature expansion); CLI user auth (deferred from M11 W1.5).

**Live-vs-backtest contract:** Unchanged. M12 ships zero strategy/risk/execution code; MCP server is a read-only consumer of M1–M11a persisted data + M7 backtest runner. No order paths, no risk gate touches, no LLM execution loop — outer-loop analysis only.
