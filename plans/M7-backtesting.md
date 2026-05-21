# M7 — Backtesting engine

**Goal:** Replay stored market data through any strategy version, reproducibly and
*faithfully to live*, using the exact same strategy code as live.

**Depends on:** M2 (sub-minute data + universe history), M3 (strategy interface), M4 (risk rules).

## Tasks

- **Replay at live granularity.** Feed the strategy the **sub-minute data it consumes live** (not just 1m candles), reconstructing the same rolling-window inputs, so intra-minute >2–3% triggers reproduce. Reuse the live `Strategy` code (no duplication). State the accepted fidelity limit.
  - *Output:* a known intra-minute spike triggers identically in replay and live.
- **Causality / look-ahead guard.** At time *t* the strategy sees only data with `open_time ≤ t` and only closed bars; assert this invariant and add a test that proves no future/same-bar leakage.
  - *Output:* a test fails if any future data leaks into a decision.
- **Realistic fill model.** Fill at next-bar open (or trigger price + adverse slippage) — **never at the same-bar high/low extreme**. Document the slippage assumption. Include fees and funding via the shared cost model.
  - *Output:* fills are achievable; no optimistic spike-extreme fills.
- **Shared cost model.** Fees (maker/taker), slippage, and funding come from the *same* constants used by live execution/position PnL (M5/M6) — defined once, consumed by both.
  - *Output:* live and backtest PnL use identical cost inputs.
- **Point-in-time universe.** Replay uses `universe_membership` as it was on each historical date (no survivorship bias).
  - *Output:* delisted/dropped coins present in their historical window.
- **Apply the same risk rules** (sizing, SL/TP, exposure, time-stop) as live.
  - *Output:* backtest respects the same limits live trading would.
- **Metrics.** PnL, win rate, max drawdown + drawdown duration, trade count, avg hold, profit factor, **Sharpe/Sortino (state periodization)**, and a **per-trade return series**.
  - *Output:* a risk-adjusted metrics report object for a run.
- **`run_backtest(version, dateRange)` entry point** (CLI/command).
  - *Output:* reproducible report for a given version + range.

## Definition of done

`run_backtest(version, range)` returns the same risk-adjusted metrics on repeated
runs, computed by the same strategy code at the same granularity as live, with
look-ahead/survivorship guards, realistic fills, and funding included.
