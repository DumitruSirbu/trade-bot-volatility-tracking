# M13 — Agentic weekly loop (phase 2)

**Goal:** An automated, unattended weekly agent that analyzes performance and drafts
the next strategy version — proposing only, never executing.

**Depends on:** M12 (MCP tools).

## Tasks

- **Agent orchestration** (LangGraph.js or Vercel AI SDK) over the read-only MCP tools.
  - *Output:* a multi-step graph: fetch data → analyze → draft strategy → backtest → report.
- **Draft-strategy step (draft-only write path).** Produce a new `strategy_version` via a **constrained repository method that physically cannot set `status='active'`** — the agent's only DB capability. Linked via `parent_version_id`.
  - *Output:* a draft version persisted as `draft`; the agent has no code path to activate it.
- **Backtest-and-report step.** Run the draft vs. the current active version using the M8 out-of-sample + significance gate; summarize.
  - *Output:* a statistically-qualified comparison report for human review.
- **Promotion is a separate human-only path.** Activating a version is code the agent cannot reach.
  - *Output:* drafts never auto-activate; promotion requires explicit human action.

## Definition of done

The agent runs the weekly loop unattended and produces a backtested draft version
for review — and by design cannot place an order or promote itself.

> Hard rule: this agent proposes and backtests reviewed code only. It never
> executes trades and never auto-promotes a version.
