# ADR 0033 — MCP module-boundary enforcement (structural read-only guarantee)

**Status:** Accepted and shipped (M12 W0–W6, close 2026-05-27)
**Date:** 2026-05-27
**Milestone:** M12 — Analysis MCP
**Depends on:** ADR 0002 (persistence + domain-owned entities), ADR 0004 (risk gate as gatekeeper), ADR 0005 (execution order policy), ADR 0015 (backtest module — pure replay, no writes), ADR 0026 (workspace topology).
**Related:** `docs/plans/archive/M12-analysis-mcp.md`, `docs/plans/archive/M12-execution-plan.md`.

## 1. Context

M12 introduces a read-only MCP server exposing trade data and the backtest engine
as tools to an outer-loop LLM agent (M13 will drive it). The hard invariant from
the milestone brief and from `CLAUDE.md`:

> **No LLM in the live trade loop.** Outer-loop only; proposes reviewed code,
> never executes. No order path bypasses the risk gate.

The MCP surface is the most plausible accidental ingress for an LLM-driven write.
If the MCP process can `import { ExecutionService }` or `import { RiskGateService }`
or any order-placing function, a single misconfigured tool could place an order
on behalf of a model. The mitigation must be **structural** — the import must fail
at compile/CI time, not at runtime via a "please don't call this" comment.

The engine today is a single NestJS process (`apps/engine/`) housing every module
including `ExecutionModule`, `RiskModule`, `PaperMode`, `BacktestModule`, the
ccxt client, and order code. `apps/dashboard/` is a separate workspace package
that consumes only `@bot/shared` types over HTTP — it is already structurally
unable to import execution code. We want the MCP server to inherit that same
property.

## 2. Decision

### 2.1 The MCP server is a separate workspace app

`apps/mcp/` is a new pnpm workspace package (`@bot/mcp`). It is a **standalone
Node process** with its own `package.json`, `tsconfig.json`, `dist/`, and its
own dependency graph. It is launched independently (`pnpm --filter @bot/mcp
start`) — never as a NestJS dynamic module inside the engine process.

### 2.2 Dependency direction is one-way

```
apps/mcp                  --depends-on-->   packages/shared
apps/mcp                  --depends-on-->   packages/analysis        (new in M12)
packages/analysis         --depends-on-->   packages/shared
apps/engine               --depends-on-->   packages/shared
apps/engine               --depends-on-->   packages/analysis        (for the in-process backtest invocation path; see §2.5)

apps/mcp                  --MUST NOT depend on-->   apps/engine
packages/analysis         --MUST NOT depend on-->   apps/engine
```

`apps/mcp/package.json` lists exactly two workspace deps: `@bot/shared` and
`@bot/analysis`. It **does not list** `@bot/engine`. Because pnpm workspaces are
resolved by `package.json` declarations and TypeScript path mapping is scoped
per `tsconfig.json`, any `import { ... } from '@bot/engine'` or
`import { ... } from '../../engine/src/...'` fails at `tsc --noEmit`. There is
no fallback — the engine source is simply not on the module resolution path of
the MCP app.

### 2.3 The analysis package is the read-only data layer

`packages/analysis/` (`@bot/analysis`) is a new pure TypeScript library:

- Exports query functions and DTO types only.
- Depends on `@bot/shared` (DTOs, enums) and on `typeorm` + `pg` for query
  building.
- Does **not** export entities/repositories that have `save()`/`insert()`/
  `update()`/`delete()` methods. Internally it constructs read-only repository
  views via TypeORM's `QueryRunner` in a connection configured with a
  read-only DB role (see ADR 0034). DDL is forbidden by the role; statement
  timeouts cap runtime.
- Exposes a `BacktestRunner` re-export only if M12 carves the runner cleanly
  out of `apps/engine/src/backtest/` into `packages/analysis/` (preferred,
  see §2.5). Otherwise an out-of-process invocation path is used and no
  engine import is needed.

### 2.4 Three layers of enforcement (defense in depth — but the load-bearing
one is layer A)

**Layer A — workspace dependency graph (LOAD-BEARING).** `apps/mcp/package.json`
omits `@bot/engine` and `apps/engine/src/*`. `tsc` cannot resolve the import.
This is the compile-time guarantee.

**Layer B — ESLint `no-restricted-imports` rule.** A flat-config block scoped to
`apps/mcp/**` and `packages/analysis/**` bans patterns:

- `@bot/engine`
- `apps/engine/*`
- `../engine/*` and any deeper relative reach
- Any module whose default export is a NestJS `*Module` from the engine.

CI runs `pnpm lint` and fails on violations. This catches an engineer who tries
to wire the engine in via a path hack before `tsc` would catch it (e.g., dynamic
`require()`).

**Layer C — runtime guard in MCP bootstrap.** Before the MCP server registers
any tool, it asserts that `process.env.MCP_BOUNDARY_GUARD !== 'disabled'` AND
that the loaded module set (`Object.keys(require.cache)` or
`import.meta.url`-resolved registry equivalent for ESM) contains no path
matching `/apps/engine/`. If either fails, the process exits non-zero with a
specific error code. This is belt-and-suspenders for the case where someone
silently adds the dep and the lint rule is suppressed.

### 2.5 The `run_backtest` tool — invocation path

**M12 selection: Option II (spawn).** The W2 extraction spike confirmed
`BacktestRunnerService` is entangled with `StrategyRegistry`,
`RiskGateService`, `OrderPolicyRouter`, `InstrumentRepository`, seven
TypeORM entities, `BaseRepository`, money helpers, and indicator helpers —
detangling inverts strategy/risk/market-data module ownership and exceeds
the `dev-qa-cycle.md` wave cap. Option II preserves the boundary guarantee
identically (the spawned engine process is short-lived and never shares
address space with MCP) and is therefore selected. The runner remains at
`apps/engine/src/backtest/`. Option I remains the long-term ideal once a
strategy/risk-module re-platform is on the milestone roadmap; revisit
post-M13 if usage justifies it.

Two options were considered (see §4); the originally-recorded preference
was **Option I: extract the backtest runner into `packages/analysis/`**:

- The backtest runner is already pure (ADR 0015 §2 — "no writes to positions,
  transactions, decisions, account_snapshots, risk_state"; in-memory adapters;
  no NestJS DI for the in-memory ports). Moving it from `apps/engine/src/
  backtest/` to `packages/analysis/backtest/` is mechanical for the
  `service/`, `adapter/`, `fill/`, `state/`, `guard/`, and `stats/`
  sub-directories. The NestJS `BacktestModule.ts` and the CLI shell stay in
  `apps/engine/` and re-export the runner from `@bot/analysis`.
- After extraction, both `apps/engine` (via NestJS DI for the existing M7 CLI)
  and `apps/mcp` (via direct function call from the `run_backtest` tool)
  consume the same `BacktestRunnerService` from `@bot/analysis`. Live and
  MCP-backtest paths share one implementation.
- Strategy code (which the runner needs) is also re-locatable: strategies are
  pure (ADR 0003). If they cannot be moved cleanly in M12 W2 scope, the
  fallback is **Option II — out-of-process invocation**: the MCP `run_backtest`
  tool `spawn`s `pnpm --filter @bot/engine backtest run --version X --from Y
  --to Z --output /tmp/...json`. The engine process is short-lived, the result
  is parsed from a JSON file, and the MCP process still cannot reach engine
  code in its address space.

The execution plan W2 attempted Option I; the spike result triggered the
documented fallback, and Option II is now the live path for M12. The
boundary guarantee is identical either way.

## 3. Consequences

**Positive.**

- A `git grep -r 'apps/engine' apps/mcp packages/analysis` returning empty is
  a one-line proof that the MCP cannot place an order, halt the bot, or
  mutate risk state.
- The boundary survives refactors automatically — adding a new execution
  capability to the engine cannot accidentally surface in MCP because the
  dependency edge does not exist.
- M13 (agentic loop) can run with the MCP as its only tool surface and has
  no path to writes.
- Layer B/C catch the "engineer disables one safety to ship a feature" case
  that pure compile-time guarantees miss.

**Negative.**

- Code duplication risk if a helper used by both engine and MCP lives in
  the wrong place. Mitigation: `packages/shared` for DTOs/enums,
  `packages/analysis` for query/replay code.
- Backtest extraction (Option I) is real work — touches M7's directory
  layout. M8 references stay valid because all imports go through
  `@bot/analysis`.
- Two processes to run during dev. Acceptable: dev runs the engine
  separately already; the MCP is launched on-demand by the operator's
  agent.

**Neutral.**

- `apps/mcp` adds a second TypeScript build target. Build time grows
  marginally; CI parallelism absorbs it.

## 4. Alternatives considered

- **A. NestJS dynamic module inside `apps/engine/`.** Rejected: the MCP would
  share the engine's DI container. Any provider can be resolved by token; a
  buggy tool could `moduleRef.get(ExecutionService)`. The boundary becomes
  policy, not structure.
- **B. Same-app, separate folder + ESLint rule only.** Rejected: ESLint is
  bypassable (`// eslint-disable-next-line`), and CI lint can be flaky-skipped
  by a PR. Want compile-time guarantee.
- **C. TypeScript project references with `composite: true` and no path
  mapping to engine.** Considered. Works, but pnpm workspace dependency graph
  achieves the same with less ceremony and the same failure mode at `tsc`.
  Kept as a layer-B fallback if the workspace edge proves insufficient.
- **D. Separate repo for MCP.** Maximum isolation but creates a shared-types
  versioning problem and slows the M13 iteration loop. Rejected for M12;
  revisit at M15 if cloud topology splits the deploy targets.
- **E. Runtime sandboxing (vm2, isolated-vm).** Address-space isolation
  without process split. Rejected: heavier than process boundary, and ADR
  0029 already pays the cost of a separate process for paper-mode
  reconciliation — same trade-off here is cheap.
- **F. Out-of-process invocation only (no analysis package extraction).**
  Simpler short-term but every MCP query then either re-implements SQL or
  shells out to the engine. Performance and maintenance cost too high; only
  kept as the Option II fallback for `run_backtest`.

## 5. Verification

- Wave 6 test plan adds a CI job `mcp:boundary` that runs:
  1. `git grep -E '@bot/engine|apps/engine' apps/mcp packages/analysis` —
     must return empty (non-test files).
  2. `pnpm --filter @bot/mcp typecheck` with a temporary test file that
     attempts `import { ExecutionService } from '@bot/engine'` — must fail
     with TS2307 (module not found).
  3. ESLint runs the `no-restricted-imports` rule and reports zero
     violations.
  4. A unit test in `apps/mcp/tests/boundary.spec.ts` spawns the MCP
     entrypoint with `MCP_BOUNDARY_GUARD=disabled` set to assert the
     runtime guard rejects boot.
