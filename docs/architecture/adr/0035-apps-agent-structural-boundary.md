# ADR 0035 — `apps/agent/` structural boundary (no-engine, no-analysis, no-mcp)

**Status:** Accepted (M13 W0 — orchestrator-blessed config-row + HTTP transport + compose cron)
**Date:** 2026-05-27
**Milestone:** M13 — Agentic weekly loop
**Depends on:** ADR 0033 (MCP module-boundary enforcement), ADR 0034 (MCP DB isolation), ADR 0026 (workspace topology), ADR 0003 (strategy purity invariant).
**Consumed by:** M13 W0 (workspace scaffold + ESLint rule), M13 W1 (MCP client), M13 W6 (boundary adversarial QA).
**Related:** `docs/plans/archive/M13-execution-plan.md` §"Workspace shape", §W0, §W6a.6, §Test strategy.

## 1. Context

M13 introduces a new long-running outer-loop process (`apps/agent/`) that:

- Reads via M12's MCP read-only tool surface (now extended with HTTP transport per ADR 0038).
- Talks to an LLM via Vercel AI Gateway.
- Writes exactly one row per week to `strategy_versions` with `status='draft'` — via the `draft_strategy_version` SDF granted to a least-privilege role `agent_writer` (ADR 0036).
- Writes one row per week to `agent_run_history` via the same SDF gate.

The agent process is an LLM-driven loop. CLAUDE.md's hard invariant is unambiguous:

> No LLM in the live trade loop. Outer-loop only; proposes reviewed, backtested code,
> never executes. No order path bypasses the risk gate.

ADR 0033 codified the same property for `apps/mcp/`: the MCP server cannot import
engine code, so a buggy tool surface cannot reach `ExecutionService` or
`RiskGateService`. M13 extends the same structural guarantee one layer outward:
**the agent process cannot import the MCP server's tool registry, the analysis
package's query layer, or the engine** — it talks to MCP **as a network client
only** over the localhost HTTP transport (ADR 0038).

If the boundary collapses, an LLM-driven loop can in principle:

- Resolve a NestJS provider token and call `ExecutionService.placeOrder`.
- Bypass the SDF and INSERT directly into `strategy_versions(status='active')`.
- Inline analysis queries to fetch sensitive tables the MCP role does not
  grant (`auth_tokens`, `account_snapshots`).

The mitigation must be **structural** — the import must fail at compile time
and at boot, not at runtime via "please don't call this" review.

## 2. Decision

### 2.1 `apps/agent/` is a separate workspace app

`apps/agent/` is a new pnpm workspace package (`@bot/agent`). Standalone Node
process, own `package.json`, own `tsconfig.json`, own `dist/`, own runtime
container in `docker-compose.yml` (profile `agent`). It is launched
independently and never instantiated as a NestJS dynamic module inside the
engine, MCP, or analysis address space.

### 2.2 Dependency direction (one-way)

```
apps/agent      --depends-on-->   packages/shared          (DTOs, enums, IBacktestReport, IPerformanceByVersionView)

apps/agent      --MUST NOT depend on-->   @bot/engine
apps/agent      --MUST NOT depend on-->   @bot/analysis
apps/agent      --MUST NOT depend on-->   @bot/mcp
apps/agent      --MUST NOT depend on-->   apps/engine/*    (deep path)
apps/agent      --MUST NOT depend on-->   apps/mcp/*       (deep path)
apps/agent      --MUST NOT depend on-->   packages/analysis/*  (deep path)
```

`apps/agent/package.json` lists exactly one workspace dep: `@bot/shared`. Its
non-workspace deps are `ai` (Vercel AI SDK), `@ai-sdk/anthropic`, `zod`, `pg`,
`pino`, and `proper-lockfile`. **No `typeorm` dep** — the agent uses raw `pg`
to call the SDF, not entity mapping, since there is no DataSource to share
with the engine.

The agent talks to MCP as a network client (ADR 0038 — HTTP, localhost-bound,
Bearer-auth on the M9 HS256 path with `aud=mcp`). It never imports
`@bot/mcp`'s `ToolRegistry`, transport, or any internal type — Zod tool
response schemas are re-exported from `@bot/shared` so both sides converge on
one definition without an import edge.

### 2.3 Three layers of enforcement (defense in depth)

Mirrors ADR 0033 §2.4 — **Layer A is load-bearing**, B and C are belt-and-suspenders.

**Layer A — workspace dependency graph (LOAD-BEARING).** `apps/agent/package.json`
omits `@bot/engine`, `@bot/analysis`, and `@bot/mcp` from every dep section
(`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`).
TypeScript module resolution cannot find these symbols. Any
`import { X } from '@bot/engine'` fails at `tsc --noEmit` with TS2307. There
is no fallback resolution path — the source trees are simply not on the
agent's module-resolution graph.

**Layer B — ESLint `no-restricted-imports` flat-config block.** Scoped to
`apps/agent/**`. Banned patterns:

- `@bot/engine`, `@bot/analysis`, `@bot/mcp`
- `apps/engine/*`, `apps/mcp/*`, `packages/analysis/*`
- Any `../` reach that escapes `apps/agent/src/` (deep relative reaches)
- Any dynamic-`require()`-style hack the lint AST can detect

CI runs `pnpm lint` and fails on any violation. This catches the engineer
who tries to wire in a path hack before `tsc` would catch it (e.g.,
`tsconfig` path alias injection).

**Layer C — runtime guard in agent bootstrap.** Before `runWeeklyLoop`
executes, `main.ts` calls a `RuntimeBoundaryGuard.assert()` that scans
`Object.keys(require.cache)` (CJS) / the loaded-module registry (ESM) for
path substrings:

- `/apps/engine/`
- `/apps/mcp/`
- `/packages/analysis/`

If any match, the process exits non-zero with structured error
`BOUNDARY_VIOLATION` (audit-printable, no stack throw). This is the
final guard against "engineer disabled the lint rule and snuck a dynamic
import through" and against a misconfigured docker volume mount that
shadows in the wrong source tree.

### 2.4 Four-test gating set

Mirrors ADR 0033 §5 (verification). M13 W6 wires the same four checks:

1. **Compile-time** (`apps/agent/tests/boundary.compile.spec.ts`): writes a
   fixture importing `@bot/engine` / `@bot/analysis` / `@bot/mcp`; runs
   `tsc --noEmit`; asserts TS2307 for each.
2. **Lint-time** (`apps/agent/tests/boundary.lint.spec.ts`): runs ESLint on
   a fixture file containing each banned pattern; asserts
   `no-restricted-imports` fires.
3. **Runtime** (`apps/agent/tests/boundary.runtime.spec.ts`): seeds
   `require.cache` with an entry whose path contains `/apps/engine/`;
   invokes `RuntimeBoundaryGuard.assert()`; asserts the process exits
   non-zero with code `BOUNDARY_VIOLATION`.
4. **CI grep** (CI job): `git grep -E
   '@bot/engine|@bot/analysis|@bot/mcp|apps/engine|apps/mcp|packages/analysis'
   apps/agent` returns empty (excluding test fixtures under
   `apps/agent/tests/`).

All four are required-green before the M13 milestone closes.

### 2.5 MCP is a network dependency, not a code dependency

The agent's `McpClient` (M13 W1.4) is a thin HTTP JSON-RPC client. It speaks
Bearer-authenticated JSON-RPC over `127.0.0.1:<MCP_HTTP_PORT>` (the
docker-compose service network — never host-exposed; see ADR 0038 §2.1). It
parses every tool response through a Zod schema re-exported from
`@bot/shared`. There is no compile-time linkage between agent and MCP
beyond shared DTOs.

### 2.6 What this ADR explicitly does NOT do

- Does NOT introduce a separate npm package for shared DTOs beyond
  `@bot/shared`. That package already exists and already serves engine,
  analysis, MCP, and dashboard.
- Does NOT mandate process-level sandboxing (vm2, isolated-vm). Process
  boundary + workspace-dep guarantee is sufficient — same reasoning as
  ADR 0033 §4 (E).
- Does NOT forbid the agent from calling external services (Vercel AI
  Gateway, Postgres directly as `agent_writer`). Those are network calls,
  not code-import paths.

## 3. Consequences

**Positive.**

- `git grep -r 'apps/engine\|apps/mcp\|packages/analysis' apps/agent` returning
  empty is a one-line proof that the agent cannot place an order, halt the
  bot, mutate risk state, or read sensitive tables outside the MCP grant set.
- The boundary survives refactors automatically: adding a new execution
  capability to the engine cannot accidentally surface in the agent because
  the dependency edge does not exist.
- The agent's only surface to the engine's data is (a) the MCP tool set
  (read-only) and (b) the SDF (single hard-coded `status='draft'` write).
  Both surfaces are auditable on the server side.
- The pattern extends cleanly to M14 (code-gen agent) and M15 (cloud deploy)
  — both inherit the same three-layer guard without churn.

**Negative.**

- Some code duplication risk between agent and MCP for Zod tool-response
  schemas. Mitigation: tool-response schemas live in `@bot/shared` so both
  sides import from one source; the agent's Zod usage is a re-import, not a
  copy.
- Three processes to run during dev (engine + MCP + agent). Acceptable: the
  agent is launched on-demand via `docker compose --profile agent run`, not
  always-on.

**Neutral.**

- `apps/agent/` adds a third TypeScript build target. CI parallelism absorbs
  the marginal build-time cost.

## 4. Alternatives considered

- **A. NestJS dynamic module inside `apps/engine/` running the agent loop.**
  Rejected: shares DI container with `ExecutionService`, `RiskGateService`,
  every order-placing provider. The agent could `moduleRef.get(ExecutionService)`
  and place an order. Boundary becomes policy, not structure — the exact
  failure mode ADR 0033 rejected for MCP.
- **B. Same `apps/mcp/` workspace + separate folder.** Rejected: the agent
  has different deps (Vercel AI SDK, `proper-lockfile`), a different runtime
  shape (cron-batch vs. long-running HTTP server), and a different DB role
  (`agent_writer` vs. `mcp_reader`). Forcing them into one package would
  blur the boundary.
- **C. `tsconfig` project references + path mapping with `composite: true`
  and no path to engine/mcp/analysis.** Works; equivalent to Layer A.
  Rejected as primary mechanism: pnpm workspace dependency graph is simpler
  and produces the same `tsc` failure. Kept as a layer-B fallback if
  workspace-dep edges ever prove insufficient (they have not in M12).
- **D. Separate git repo for the agent.** Maximum isolation but introduces
  shared-types versioning friction (every `@bot/shared` change requires
  npm publish + agent bump). Rejected for M13; revisit at M15 if cloud
  topology splits deploy targets.
- **E. Direct DB-only architecture (no MCP, agent SELECTs directly).**
  Rejected: collapses the M12 boundary. If the agent talks directly to
  Postgres for reads, it has to re-implement every analysis query — and
  any future MCP boundary improvement (caching, rate-limit, audit) bypasses
  the agent. Routing reads through MCP keeps one path for both human-MCP
  clients and the agent.
- **F. Runtime sandbox (vm2/isolated-vm) inside the engine.** Rejected for
  the same reasons ADR 0033 §4(E) rejected it for MCP — process boundary
  is cheaper and produces a stronger guarantee.
- **G. Layer C as a `process.versions`-style runtime check only, no
  cache scan.** Rejected: the failure mode the guard catches is "engineer
  added a dynamic `require()` after the lint rule was disabled." A
  process-version check does not detect that — only a loaded-module scan
  does.

## 5. References

- `docs/plans/archive/M13-execution-plan.md` §Workspace shape, §W0 items 1+4,
  §W6a vector 6, §Test strategy items 1–4.
- ADR 0033 §2.4 (three-layer enforcement pattern this ADR mirrors).
- ADR 0026 (workspace topology — `apps/agent/` is the fifth workspace app
  after engine, dashboard, mcp, and the cron sidecar service).
- ADR 0038 (localhost HTTP transport — the agent's only path to MCP).
- ADR 0036 (DB role + SDF — the agent's only write path).
