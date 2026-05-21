# M7 — Backtesting engine

**Goal:** Replay stored market data through any strategy version, reproducibly and
*faithfully to live*, using the exact same strategy code as live.

**Depends on:** M2 (sub-minute + 5m candle data + universe history), M3 (strategy interface), M4 (risk rules).

## Tasks

- **Replay at live granularity.** Feed the strategy the **same 5-min closed-bar data it consumes live**, reconstructing the full indicator state (VWAP/σ bands, ATR, ADX, RSI, volume ratio, idiosyncrasy score, regime label) from stored candles so triggers reproduce identically. Reuse the live `Strategy` code (no duplication). State the accepted fidelity limit.
  - *Output:* a known intra-session spike triggers identically in replay and live.

- **Causality / look-ahead guard.** At time *t* the strategy sees only **closed bars** with `open_time < t`. Assert this invariant and add a test that proves no same-bar or future-bar data leaks into a decision. Entry fills at **next-bar open**, not at the signal bar's close or extreme.
  - *Output:* a test fails if any future/same-bar data leaks into a decision.

- **Tier-based, liquidity-aware fill model.** Fill at next-bar open + slippage, where slippage is drawn from the tier model in `strategy_versions.params`:
  - Tier 1 (top 50): `slippage_tier1_pct` (default 0.15%)
  - Tier 2 (51–150): `slippage_tier2_pct` (default 0.50%)
  - Tier 3 (151–300): `slippage_tier3_pct` (default 1.00%)
  - Slippage is applied in the adverse direction (entry and exit). Never fill at the same-bar high/low extreme.
  - *Output:* fills are tier-appropriate and adverse; no optimistic spike-extreme fills.

- **Shared cost model.** Fees (maker/taker), the slippage function, and funding come from the *same* source used by live execution/position PnL (M5/M6) — defined once, consumed by both. Backtest funding uses the persisted `funding_rates` history (M2), not a constant.
  - *Output:* live and backtest PnL use identical cost inputs and real historical funding.

- **Point-in-time universe.** Replay uses `universe_membership` (including tier history) as it was on each historical date. Coins that were in the universe and later delisted are included in their historical window — no survivorship bias.
  - *Output:* delisted/dropped coins present in their historical window; tier correctly assigned per date.

- **Apply the same risk rules** (3-slot position model, ATR sizing, BTC-correlated mode, SL/TP, time-stop, exposure caps, daily/weekly loss limits) as live.
  - *Output:* backtest respects the same limits live trading would.

- **Regime labels reproduced.** ADX(14) regime labels are computed from stored candles in the backtest, using the same formula as live. Regime-based suppression in v1/v2 applies identically.
  - *Output:* per-regime trade counts match expectations from hand-labelled test windows.

- **Metrics with pinned definitions.** All trade-level metrics computed on **net PnL (after fees + funding + slippage)**. Win rate, profit factor, trade count, avg hold time, regime breakdown. **Max drawdown = peak-to-trough on the mark-to-market equity curve, expressed as %**, plus drawdown duration. **Sharpe/Sortino on daily-resampled equity returns, annualized with √365** (crypto trades 24/7/365); Sortino target = 0. Emit the per-trade return series.
  - *Output:* a risk-adjusted metrics report with explicit, comparable definitions.

- **`run_backtest(version, dateRange)` entry point** (CLI/command).
  - *Output:* reproducible report for a given version + range.

## Definition of done

`run_backtest(version, range)` returns the same risk-adjusted metrics on repeated
runs, computed by the same strategy code with the same indicator state as live,
look-ahead/survivorship guards in place, tier-based fills, funding included, and
regime suppression applied.
