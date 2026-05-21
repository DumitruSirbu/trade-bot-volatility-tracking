# M3 — Strategy engine

**Goal:** Pluggable, deterministic strategies that turn market state into signals
and record every decision.

**Depends on:** M1 (market events), M2 (decisions table).

## Tasks

- **`Strategy` interface.** Pure function of market state → optional signal. No I/O, no LLM, no wall-clock dependence beyond inputs (so it runs identically live and in backtest).
  - *Output:* documented interface + signal type.
- **v1 — mean-reversion strategy.** Sharp pump → short; sharp dump → long. Configurable threshold/window via `params`.
  - *Output:* deterministic signals on the live stream (dry-run).
- **v2 — momentum strategy.** Follow the move (opposite trade on the same trigger).
  - *Output:* deterministic signals on the live stream (dry-run).
- **Strategy registry + active-version selection** by config; stamp `strategy_version_id` on outputs.
  - *Output:* switching active version changes which strategy emits, no code change.
- **Decision logging.** Write a `decisions` row for every trigger (acted or skipped) with `market_snapshot`.
  - *Output:* `decisions` table fills during dry-run.
- **Seed `strategy_versions` rows** for v1 and v2.
  - *Output:* both versions persisted with their params.

## Definition of done

On testnet/dry-run, the active strategy emits deterministic signals and writes a
decision for every trigger. No risk checks or orders yet.
