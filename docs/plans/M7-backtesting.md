# M7 — Backtesting engine

**Goal:** Replay stored market data through any strategy version, reproducibly and
*faithfully to live*, using the exact same strategy code as live.

**Depends on:** M2 (sub-minute + 5m candle data + universe history), M3 (strategy interface), M4 (risk rules).

## Pre-W1 carry-over tasks (W0)

- **Drop `positions.status` after grace window.** M6 W1 shipped the position state machine as a two-column form: `positions.state` (`PositionStateEnum`, six values) became authoritative; `positions.status` (`PositionStatusEnum ∈ {open, closed}`) was kept as a deprecated dual-written alias for the M6 → M7 grace window. Per ADR-0009 §1 (revised post-W1): (1) verify zero readers remain on `positions.status` via codebase grep + a read-site lint that fails on `status` access; (2) drop migration `<timestamp>-DropPositionsStatusLegacyColumn.ts`; (3) `bot-shared-maintainer` removes the `PositionStatusEnum` export. If readers remain, slip this task forward and document.
  - *Output:* the legacy column is gone, no reader compiles against it, only `state` is canonical.

## Tasks

- **Replay at live granularity.** Feed the strategy the **same 5-min closed-bar data it consumes live**, reconstructing the full indicator state (VWAP/σ bands, ATR, ADX, RSI, volume ratio, idiosyncrasy score, regime label) from stored candles so triggers reproduce identically. Reuse the live `Strategy` code (no duplication). State the accepted fidelity limit.
  - *Output:* a known intra-session spike triggers identically in replay and live.

- **Causality / look-ahead guard.** At time *t* the strategy sees only **closed bars** with `open_time < t`. Assert this invariant and add a test that proves no same-bar or future-bar data leaks into a decision. Entry fills at **next-bar open**, not at the signal bar's close or extreme.
  - *Output:* a test fails if any future/same-bar data leaks into a decision.

- **Tier-based, liquidity-aware fill model (the floor).** Fill at next-bar open + slippage, where slippage is drawn from the tier model in `strategy_versions.params`:
  - Tier 1 (top 50): `slippage_tier1_pct` (default 0.15%)
  - Tier 2 (51–150): `slippage_tier2_pct` (default 0.50%)
  - Tier 3 (151–300): `slippage_tier3_pct` (default 1.00%)
  - Slippage is applied in the adverse direction (entry and exit). Never fill at the same-bar high/low extreme.
  - *Output:* fills are tier-appropriate and adverse; no optimistic spike-extreme fills.

- **Depth-aware slippage (target; extends the tier floor).** Around trigger windows, compose slippage as:
  `slippage = base_tier + spread_component + volatility_component + depth_component + market_stress_component + adverse_selection_component`, drawing spread/depth from persisted `book_snapshots` (M2) where available. **State explicitly:** if historical L2 depth is unavailable, the backtest can only **REJECT bad strategies, not PROVE live fill quality**. Mean-reversion enters exactly when spreads widen, depth thins, and adverse selection is highest — so the fixed tier model understates the bad fills that matter most.
  - *Output:* depth-aware slippage applied when book data exists; the fidelity limit is documented in the report.

- **Missed-fill model.** When limit orders are used (per the M5 order policy), model orders that do **not** fill within the cancel timeout as missed — no fill, no PnL. Mirrors the live "no chasing" rule.
  - *Output:* limit-order backtests show a realistic fill rate; missed entries are excluded from PnL.

- **Latency model.** Apply a configurable latency between signal and order so fills reflect realistic delay, not instantaneous next-bar open.
  - *Output:* latency is parameterized and applied to entry/exit timing.

- **Intrabar stop/TP path simulation.** Simulate the within-bar price path from 1s / aggTrade data (M2 `tick_aggregates`) to decide stop/TP hits, instead of assuming next-bar open. Use mark-price-vs-last-price for stop/liquidation logic. Replay `open_interest` history for OI-dependent strategy/flow logic.
  - *Output:* intrabar stop/TP and liquidation logic driven by sub-minute path + OI replay; not next-bar open alone.

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

- **Stress-period test set (mandatory).** Maintain a dedicated set of adverse windows and run every candidate against them: FTX collapse, LUNA, major BTC ETF days, exchange outages, high-liquidation days, and strong bull/bear trend windows. Handle symbol delisting/death within the window.
  - *Output:* every candidate reports metrics over each stress window; delisted symbols handled without crashing.

- **Robustness gates (edge must survive all).** The edge must survive: doubling slippage assumptions; removing the best 5% of trades; the stress windows above; and must **not** be concentrated in one symbol or one week.
  - *Output:* a robustness report per candidate covering each gate; failures flagged.

- **Same-event multi-version simulation.** Simulate v0 / v1 / v2 / v3 (and no-trade) on the **same `event_id` under the same market path**, so versions are compared on identical events (feeds M8).
  - *Output:* per-`event_id` outcomes for all versions over one replay.

- **`run_backtest(version, dateRange)` entry point** (CLI/command).
  - *Output:* reproducible report for a given version + range.

## Definition of done

`run_backtest(version, range)` returns the same risk-adjusted metrics on repeated
runs, computed by the same strategy code with the same indicator state as live,
look-ahead/survivorship guards in place, tier-based fills, funding included, and
regime suppression applied.
