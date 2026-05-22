# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A crypto volatility-tracking trading bot. Watches the top 200–300 coins by volume on
Binance USDT-M Futures and uses a VWAP-deviation spike on 5-minute candles as a
**direction-agnostic event detector**, then classifies the flow behind each event
(Open Interest + funding) to decide whether to fade, follow, or — most often — skip.
It opens minimum-leverage positions through a central risk gate (architectural max 3;
live starts at 1) and persists every decision/trade so strategy versions can be
compared and improved. The priority is **conservative, stable, low-risk operation over
returns**: there is no daily profit target, `skip` is a first-class output, and live
capital starts at $500–$1,000 under a restricted profile. Full design in `docs/plans/`
(start with `docs/plans/00-overview.md`).

## Recommended model

Use **Claude Opus** for this repo. The main session orchestrates — decomposing work,
dispatching specialists, verifying diffs, and making judgment calls. Switch with `/model`.

## How to work in this repo

The **main session acts as the orchestrator** (there is no orchestrator subagent —
subagents cannot spawn other subagents). For every non-trivial task the main session
decomposes the work, dispatches specialists with the `Agent` tool, runs the reviewers,
triggers the scribe, and reports a summary.

Specialist agents live in `.claude/agents/` (also via the `.agents/agents/` symlink):

| Agent | Owns |
|---|---|
| `bot-architect` | ADRs, data model, strategy/risk/execution contracts (docs only) |
| `bot-engine-nestjs` | `apps/engine/` — NestJS engine, ccxt, strategy/risk/execution, migrations |
| `bot-dashboard-react` | `apps/dashboard/` — read-only React monitoring UI + kill switch |
| `bot-shared-maintainer` | `packages/shared/` — shared enums/types/Zod schemas |
| `bot-devops` | Dockerfiles, compose, env, healthchecks, smoke tests |
| `bot-qa-engineer` | Tests for the current diff (Jest engine / Vitest dashboard) |
| `bot-review-security` | Read-only security review |
| `bot-review-logic` | Read-only business-logic review |
| `bot-review-clean-code` | Read-only conventions/clean-code review |
| `bot-review-quant` | Read-only math/stats review (PnL, backtest bias, metric validity) |
| `bot-scribe` | README, docs, milestone outcomes, work-log, this file |

### Dispatch waves

1. **Serial:** `bot-shared-maintainer` for shared-contract changes (before engine/dashboard).
2. **Parallel (single message):** `bot-engine-nestjs` + `bot-dashboard-react`.
3. **Serial:** `bot-qa-engineer`.
4. **Parallel (single message):** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`.
5. **Serial:** `bot-scribe` to close out docs + work-log.

Verify the actual diff after each wave — agent summaries describe intent, not reality.

## Hard rules

1. Follow the dispatch waves for every non-trivial change. Don't skip reviewers or the scribe.
2. **Read `docs/best-practices/code-conventions.md` before engine code.** It is authoritative and overrides the generic Clean Code defaults where they conflict.
3. **Use `context7-mcp` before calling any third-party API** (mandatory per `~/.claude/CLAUDE.md`).
4. **Shared types live in `packages/shared/`** — never redefined in engine/dashboard. Route changes through `bot-shared-maintainer`.
5. Two mandatory review rounds per milestone (see conventions doc).

## Trading-safety invariants (non-negotiable)

- **No order path bypasses the risk gate.** Strategies/controllers never call the exchange order API directly.
- **Strategies are pure and deterministic** (no `Date.now()`/`Math.random()`/I/O) so backtests reproduce live behavior.
- **No LLM in the live trade loop.** LLM/agentic work is outer-loop only — it proposes reviewed, backtested code and never executes.
- **Money is `decimal`, never float.**
- **Exchange keys never committed; key is least-privilege (no withdrawals).**
- **Validate on testnet first**; go live only at minimal size.
- **The VWAP trigger is a detector, not a direction.** Trade direction (fade / follow / skip) is decided empirically per `flow_type` and regime — never assume mean-reversion.
- **No daily profit target.** Success is risk-adjusted survival (drawdown, loss limits, expectancy-per-risk, tail loss), not a profit quota. `skip` is the expected outcome for most triggers.
- **Live starts restricted** ($500–$1,000, 1 position, tier-1 only, isolated margin); caps relax only after weeks of confirmed live edge matching backtest.

## Documentation map

- Milestone plans → `docs/plans/`
- Architecture → `docs/architecture/`
- Code conventions (AUTHORITATIVE) → `docs/best-practices/code-conventions.md`
- Testing → `docs/best-practices/testing.md`
- Work log → `docs/work-log.md`

## Project status

Greenfield. Design complete (`docs/plans/`). Implementation starts at **M0 — Foundation & scaffolding**.
