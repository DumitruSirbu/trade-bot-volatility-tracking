# M7 — Backtesting engine

**Goal:** Replay stored candles through any strategy version, reproducibly, using
the exact same strategy code as live.

**Depends on:** M2 (candles), M3 (strategy interface), M4 (risk rules).

## Tasks

- **Candle replay harness.** Feed stored 1m candles to a strategy version as if live, reusing the live `Strategy` code (no duplication).
  - *Output:* a version processes a historical range deterministically.
- **Simulated fill model.** Fees, slippage, and minimum-leverage sizing approximating testnet/live behavior.
  - *Output:* simulated trades with realistic costs.
- **Apply the same risk rules** (sizing, SL/TP, exposure) as live.
  - *Output:* backtest respects the same limits live trading would.
- **Metrics.** PnL, win rate, max drawdown, trade count, avg hold time, profit factor.
  - *Output:* a metrics report object for a run.
- **`run_backtest(version, dateRange)` entry point** (CLI/command).
  - *Output:* reproducible report for a given version + range.

## Definition of done

`run_backtest(version, range)` returns the same metrics report on repeated runs,
computed by the same strategy code that trades live.
