# M13 — Agentic weekly loop (phase 2)

**Goal:** An automated, unattended weekly agent that analyzes performance and drafts
the next strategy version — proposing only, never executing.

**Depends on:** M12 (MCP tools).

## Tasks

- **Agent orchestration** (LangGraph.js or Vercel AI SDK) over the read-only MCP tools.
  - *Output:* a multi-step graph: fetch data → analyze → draft strategy → backtest → report.
- **Draft-strategy step.** Produce a new `strategy_version` (params/code) linked via `parent_version_id`.
  - *Output:* a draft version persisted as `draft`, not `active`.
- **Backtest-and-report step.** Run the draft vs. the current active version; summarize.
  - *Output:* a comparison report for human review.
- **Halt-for-approval gate.** No promotion without explicit human approval.
  - *Output:* drafts never auto-activate.

## Definition of done

The agent runs the weekly loop unattended and produces a backtested draft version
for review — and by design cannot place an order or promote itself.

> Hard rule: this agent proposes and backtests reviewed code only. It never
> executes trades and never auto-promotes a version.
