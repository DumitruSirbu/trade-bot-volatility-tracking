# M12 — Analysis MCP (phase 2)

**Goal:** A read-only MCP server exposing the trade DB and backtest engine as tools,
so the weekly review can be done interactively with an LLM.

**Depends on:** M7 (backtest), M8 (versioning), real accumulated data.

## Tasks

- **Read-only MCP server** over the engine's data.
  - *Output:* MCP server discoverable by an MCP client.
- **Tools:** `get_performance(version, period)`, `compare_versions(a, b, period)`, `list_positions(filters)`, `get_decisions(coin, window)`, `run_backtest(version, range)`.
  - *Output:* each tool returns structured results.
- **Structurally-enforced read-only boundary.** The MCP server depends only on a **read-only data/analysis package with no import path to `ExecutionModule`/`RiskModule`/order code** — write capability is impossible by construction, not by policy. A module-boundary lint rule enforces it.
  - *Output:* the server cannot import execution/order code; a test/lint fails if someone tries.
- **No mutation tools.** No order-placement, no go-live, no DB writes — analysis only.
  - *Output:* server exposes zero write/execute tools.

## Definition of done

An interactive session can query performance, compare versions, and run backtests
through MCP tools — with no ability to move money, enforced by the module boundary.
