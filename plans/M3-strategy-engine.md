# M3 — Strategy engine

**Goal:** Pluggable, deterministic strategies that turn market state into signals
and record every decision.

**Depends on:** M1 (market events), M2 (decisions table).

## Tasks

- **`Strategy` interface.** Pure function of market state **+ current open-position state for the symbol** → optional signal. The signal vocabulary is `open | add | reduce | close` — being position-aware lets a strategy scale in (`add`), scale out (`reduce`), or exit (`close`), matching the downstream action set. No I/O, no LLM, no wall-clock dependence beyond inputs (so it runs identically live and in backtest).
  - *Output:* documented interface + signal type covering all four actions.
- **Protective exits are NOT the strategy's job.** Stop-loss, trailing-take-profit, and time-stop closes are owned by the risk/position layer (M4/M6), not the strategy. The strategy expresses *thesis* signals; protection is enforced centrally.
  - *Output:* clear split documented — strategy emits thesis actions, risk layer emits protective closes.
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
