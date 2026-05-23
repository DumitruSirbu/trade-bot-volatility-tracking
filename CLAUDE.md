# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

Crypto volatility-tracking trading bot (Binance USDT-M Futures, TypeScript/NestJS).
Priority is **conservative, low-risk survival over returns**. Full design and locked
decisions in `docs/plans/00-overview.md` — read it before any non-trivial work.

Use **Claude Opus** (`/model`). The main session orchestrates.

## How to work in this repo

The **main session is the orchestrator** (subagents cannot spawn subagents). For every
non-trivial task, decompose the work, dispatch specialists with `Agent`, run reviewers,
trigger the scribe, and report a summary. **Verify the actual diff after each wave** —
agent summaries describe intent, not reality.

Specialist agents live in `.claude/agents/`. Dispatch in waves:

1. **Serial:** `bot-shared-maintainer` for shared-contract changes (before engine/dashboard).
2. **Parallel:** `bot-engine-nestjs` + `bot-dashboard-react`.
3. **Serial:** `bot-qa-engineer`.
4. **Parallel:** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`.
5. **Serial:** `bot-scribe` to close out docs + work-log.

Each agent's ownership is defined in its `.claude/agents/<name>.md` frontmatter.

## Hard rules

1. Follow the dispatch waves for every non-trivial change. Don't skip reviewers or the scribe.
2. **Read `docs/best-practices/code-conventions.md` before engine code.** Authoritative; overrides generic Clean Code where they conflict.
3. **Read `docs/best-practices/dev-qa-cycle.md` before dispatching any fix or QA wave.** Authoritative process rules — ≤5 items/files per dispatch, adversarial QA, architect on contract touches, reviewer continuity across rounds, paired tests per fix item, orchestrator verifies every diff. Distilled from the M5 retrospective.
4. **Use `context7-mcp` before calling any third-party API** (per `~/.claude/CLAUDE.md`).
5. **Shared types live in `packages/shared/`** — route changes through `bot-shared-maintainer`.
6. Quality over speed. Smaller iterations even if there are more of them. Cycle review/fix until zero blockers, zero highs, majority of mediums resolved.

## Trading-safety invariants (non-negotiable)

- **No order path bypasses the risk gate.** Strategies/controllers never call the exchange order API directly.
- **Strategies are pure and deterministic** (no `Date.now()`/`Math.random()`/I/O) so backtests reproduce live behavior.
- **No LLM in the live trade loop** — outer-loop only; proposes reviewed, backtested code, never executes.
- **Money is `decimal`, never float.**
- **Exchange keys never committed; key is least-privilege (no withdrawals).**
- **Validate on testnet first**; go live only at minimal size.
- **The VWAP trigger is a detector, not a direction** — fade/follow/skip decided empirically per `flow_type` and regime.
- **No daily profit target.** `skip` is the expected outcome for most triggers; success is risk-adjusted survival.
- **Live starts restricted** ($500–$1,000, 1 position, tier-1 only, isolated margin); caps relax only after confirmed live edge.

## Documentation map

- Overview + locked decisions → `docs/plans/00-overview.md`
- Milestone plans → `docs/plans/`
- Architecture → `docs/architecture/`
- Code conventions (AUTHORITATIVE) → `docs/best-practices/code-conventions.md`
- Dev + QA cycle rules (AUTHORITATIVE) → `docs/best-practices/dev-qa-cycle.md`
- Testing → `docs/best-practices/testing.md`
- Work log → `docs/work-log.md`

## Status

**M0 — Foundation & scaffolding:** DONE (pnpm + Docker + NestJS 11 + TypeORM + event bus + halt-flag + money helpers).
**M1 — Exchange & market data:** DONE (ccxt/Binance testnet, MarketDataModule, shared trigger, 251 tests, 3 review rounds, zero blockers).
**M2 — Persistence & data model:** DONE (13 domain-owned entities, 353 tests, reversible migrations + 90-day partitioned tick_aggregates, 2 review rounds + post-review smoke test, zero blockers, testnet persistence verified).
**M3 — Strategy engine:** DONE (4 pure strategies v0–v3, registry + config-selected active version, orchestrator stamps flow_type/signal_score/event_id and writes dry-run decisions, 202 tests, 2 review rounds, zero blockers).
**M4 — Risk management:** DONE (bypass-proof risk gate, 3-slot position model, BTC-correlated single-candidate, daily/weekly loss windows, in-flight reservation ledger, funding suppression + flow rules, spread/liquidity/SL/time-stop/cooldown/market-stress/consecutive-loss/overtrading/OI/tier-3 gates, isolated-margin default, model-divergence kill-switch, 700 tests, 2 review rounds, zero blockers).
**M5 — Execution (testnet):** DONE (ExecutionModule idempotent open/add/reduce/close, marketable-limit-IOC + post-only-maker + reduce-market policies, partial-fill FillAccumulator, LocalProtectiveMonitor arm/disarm, ccxt testnet, EXECUTION_MODE config, 898 tests, 5 review rounds, zero blockers, testnet smoke runbook documented).
**M5.5 — Adversarial backfill (pre-M6 hardening):** DONE (2 production bugs fixed in M2, 172 adversarial tests added across M1–M5, dev-qa-cycle validation complete, 3-round strict cap held, zero blockers/highs at close, pre-M6 deferred items catalogued).
**Pre-M6 deferred:** M2 partition-rollover task for fresh Postgres volume (narrow scope, test-harness or service pre-create partitions for current/upcoming date window).
**Next:** **M6 — Position management & reconciliation** (`docs/plans/M6-position-management.md`).
