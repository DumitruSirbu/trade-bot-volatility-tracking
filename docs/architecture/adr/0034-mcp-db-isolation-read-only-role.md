# ADR 0034 — MCP DB isolation: read-only role + statement timeout + bounded pool

**Status:** Accepted and shipped (M12 W0–W6, close 2026-05-27)
**Date:** 2026-05-27
**Milestone:** M12 — Analysis MCP
**Depends on:** ADR 0002 (persistence + domain-owned entities), ADR 0033 (MCP module-boundary enforcement).
**Related:** `docs/plans/M12-analysis-mcp.md`, `docs/plans/M12-execution-plan.md`.

## 1. Context

The trade engine is a long-running NestJS process holding a persistent Binance
WebSocket and writing to Postgres continuously (5-min candles, tick aggregates,
funding, OI, decisions, positions, transactions, account snapshots, audit
trails). The MCP server (ADR 0033) introduces a second client to the same
database, queried interactively by an LLM that can in principle ask for
"performance for all symbols over the last 6 months" — a query that scans
millions of rows.

Two failure modes must be impossible by construction:

1. **MCP writes data.** A buggy tool, a misconfigured ORM, or a SQL-injection
   path lets the agent mutate live state.
2. **MCP starves the live engine.** A long aggregate query holds shared locks
   on `positions`/`decisions`, an MV-refresh-style scan exhausts the
   shared-buffer cache, or a runaway query saturates connections so the
   engine's writes block.

M11a is local-only on a single Postgres instance. M15 will move to managed
Postgres in the cloud — at that point a read replica becomes feasible. For
M12 the constraint is **same instance, must not contend**.

## 2. Decision

### 2.1 Read-only Postgres role

A new Postgres role `mcp_reader` is created via migration. It has:

- `LOGIN` with a password stored in a secret (env var
  `MCP_DB_PASSWORD`, never committed). The role-creation migration ships
  with a publicly-known sentinel password; the operator MUST rotate it via
  `ALTER ROLE "mcp_reader" PASSWORD '<secret>'` before launch.
  `packages/analysis/src/db/DataSourceFactory.ts` refuses to initialise
  while `MCP_DB_PASSWORD` still matches the sentinel — see
  `docs/runbooks/mcp-deployment.md`.
- `CONNECT` on the engine database.
- `USAGE` on `public` schema only.
- `SELECT` on the exact whitelist of tables MCP needs (see §2.5).
- **No** `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`,
  `CREATE`, `ALTER`, `DROP` on any table or sequence.
- **No** `EXECUTE` on any function unless explicitly granted.
- `default_transaction_read_only = on` set at role level — even if a future
  grant slips in, the transaction itself rejects writes.
- `statement_timeout = '30s'` set at role level.
- `idle_in_transaction_session_timeout = '60s'`.
- `lock_timeout = '5s'` — MCP never waits long for a row lock; if the engine
  holds it, MCP fails fast rather than block the writer.

The role grant set is managed by a dedicated migration
`<timestamp>-CreateMcpReaderRole.ts` and is part of the M12 W0 schema work.
Grants are tested by an integration spec that attempts each forbidden DML
under `mcp_reader` and asserts `42501 insufficient_privilege`.

### 2.2 Read replica — deferred to M15

Decision: **read replica is NOT used in M12.** Justification:

- M11a / M12 are explicitly local-only. Standing up streaming replication on
  the operator's laptop adds operational surface (replication slot,
  WAL retention, lag monitoring) without commensurate benefit.
- Throughput is small in local soak: candles every 5 min, tick aggregates
  modestly, decisions a handful per hour. The engine is I/O-bound on the
  exchange WS, not on Postgres write throughput.
- A read-only role + `statement_timeout` + small pool gives an enforceable
  isolation guarantee without replication.

M15 plan adds a read replica when the deploy target supports one (managed
Postgres on AWS/GCP). The MCP `DataSource` config switches host string; the
role + grants migration is reused on the replica side. ADR 0033's import-graph
guarantee is the load-bearing safety property; replica is a performance
isolation optimization, not a correctness one.

### 2.3 Bounded MCP connection pool

MCP TypeORM `DataSource` config:

- `max` connections: **3** (vs the engine's typical 10).
- `min`: 0 (cold start cheap; MCP is interactive, not always busy).
- `idleTimeoutMillis`: 30_000.
- `application_name`: `mcp_reader` so the engine's PG dashboards/logs can
  distinguish MCP queries.

Three connections is enough for one tool call plus a streaming follow-up plus
headroom; it caps the worst case where the agent fans out parallel
`get_performance` calls.

### 2.4 Per-tool query budget

Inside `packages/analysis/`, every query function takes an explicit time-range
+ symbol filter and **rejects unbounded queries at the DTO validation layer**
(M12 W3). A request like "all positions, no filter" is rejected with
`ValidationError` before SQL is issued. The cap rules:

- Time range ≤ 90 days unless the tool explicitly carries an
  `acknowledgedLargeRange: true` flag.
- Result row cap of 10_000 with mandatory cursor pagination beyond.
- `run_backtest` separately capped (§2.6).

### 2.5 Table whitelist

`mcp_reader` is granted `SELECT` on read-only tables only:

- `candles`, `tick_aggregates`, `instruments`, `universe_membership`,
  `funding_rates`, `open_interest`, `book_snapshots`.
- `strategy_versions`, `positions`, `transactions`, `decisions`,
  `risk_state`, `account_snapshots`.
- M7/M8 outputs visible through `decisions` and `positions`; no separate
  result table needed.

**Not granted (sensitive):** `auth_tokens`/`revoked_jti`, `paper_account_state*`,
`boot_mode_history*`, `control_audit`, `key_permission_*`, `crn_tape`, any
audit/HMAC table. These contain secrets, audit chains, or operator action
records that have no place in analysis tools.

### 2.6 `run_backtest` resource caps

The MCP `run_backtest` tool is bounded independently of DB caps because the
backtest is CPU+memory bound, not query-bound:

- Date range ≤ 30 days per call (`acknowledgedLargeRange` extends to 180).
- One concurrent backtest per MCP process (`Sema(1)`).
- Wallclock budget: 10 minutes; exceeding cancels with a `TIMEOUT` tool
  error.
- Memory soft-cap: V8 `--max-old-space-size=2048` on the MCP launcher.
- If the backtest extraction lands (ADR 0033 §2.5 Option I), the runner is
  called in-process with the cap above. If Option II is used, the spawn is
  killed by the wallclock guard.

### 2.7 Engine continues to use the writer role

The engine's existing `DataSource` (full-privilege role) is untouched. No
change to the engine's connection pool, isolation level, or migrations. The
new role and grants are additive.

## 3. Consequences

**Positive.**

- A SQL-injection or buggy ORM path in MCP cannot mutate state — the role
  rejects DML. `default_transaction_read_only` makes this airtight even on
  future schemas.
- `statement_timeout = 30s` caps MCP's worst-case query and is enforced
  inside Postgres regardless of MCP code. The engine cannot be starved
  for >30 s + lock_timeout window.
- `lock_timeout = 5s` means an MCP query that hits a row the engine is
  writing **fails fast** instead of blocking the writer. Live trading
  never waits for analysis.
- Bounded pool (3) means MCP cannot exhaust the Postgres `max_connections`
  budget. The engine's writers always have headroom.
- Sensitive tables are not visible to MCP queries — agent prompts cannot
  exfiltrate auth tokens, HMAC chain seeds, or paper-mode crypto state
  even if creative.

**Negative.**

- An additional migration to maintain; whenever a new table is added the
  migration author must consider MCP visibility. M12 W0 includes a docs
  block (`docs/architecture/data-model.md`) noting the grant policy.
- Local dev needs to provision the role — a one-line script in
  `apps/engine/scripts/` covers it.
- 30-second statement timeout requires care for `get_performance` over
  long ranges — addressed by the 90-day soft cap and cursor pagination.

**Neutral.**

- No replica today is a deferred optimization, not a correctness
  trade-off. The boundary guarantee from ADR 0033 + the role grant is the
  primary safety mechanism.

## 4. Alternatives considered

- **A. Same role, runtime "no write" wrapper.** A TypeORM custom logger or
  query interceptor refuses non-SELECT. Rejected: bypassable from inside
  the same process; not enforced by Postgres.
- **B. Read replica now.** Best long-term isolation. Rejected for M12
  local-only scope; deferred to M15.
- **C. Separate Postgres instance, replicate manually.** Heaviest option;
  pure-overkill at local scale. Rejected.
- **D. PgBouncer in front of the engine, route MCP through a `RO` pool.**
  Adds an operational dependency. The role-level guarantee already
  enforces RO at the database; PgBouncer pooling is a perf optimization
  that buys nothing extra for safety. Reconsider at M15 if connection
  churn becomes an issue.
- **E. No caps; trust the agent.** Rejected — M13 is an LLM-driven loop;
  trust is exactly the property we are removing.
- **F. Materialized views computed offline, MCP reads only the MVs.**
  Adds a refresh-pipeline maintenance burden. Considered for `get_
  performance` if it becomes a hotspot; deferred. The base tables are
  small enough today.

## 5. Verification

- Migration test: under `mcp_reader`, attempt `INSERT INTO decisions ...`
  → expect `42501`.
- Migration test: under `mcp_reader`, attempt `SELECT FROM auth_tokens`
  → expect `42501` (no SELECT grant on sensitive tables).
- Statement-timeout test: `SELECT pg_sleep(35)` under `mcp_reader`
  → expect `57014 query_canceled`.
- Pool-cap test: open 4 connections under `mcp_reader`, expect the 4th to
  wait or fail per `max` config.
- Engine-isolation smoke (M12 W6): engine running writes; MCP runs a slow
  aggregate; engine write latency in pg_stat_statements does not regress
  beyond noise threshold (documented baseline).
