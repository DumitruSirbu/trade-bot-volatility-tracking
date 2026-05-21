# M2 — Persistence & data model

**Goal:** The full schema exists as migrations, and sub-minute + 5m + 1m market data
begin accumulating as a backtest dataset that faithfully reproduces live triggers.

**Depends on:** M0 (TypeORM), M1 (market data).

## Tasks

- **TypeORM entities** for all tables: `instruments`, `candles`, `tick_aggregates`, `universe_membership`, `funding_rates`, `strategy_versions`, `positions`, `transactions`, `decisions`, `risk_state`, `account_snapshots`. Money columns as `NUMERIC`.
  - *Output:* entities compile; relationships and indexes defined.
- **Migrations** for the full schema (reversible).
  - *Output:* `migration:run` creates all tables; `migration:revert` cleanly drops.
- **Sub-minute market data for backtest fidelity.** Persist raw ticks or short aggregates (e.g. 1s/5s `tick_aggregates`) per universe symbol. State a retention + partitioning policy (≈20–26M rows/day for 300 symbols at 1s): time-partition the table and define a retention window (or downsample older data) that still covers the backtest range.
  - *Output:* sub-minute data flowing into Postgres with a documented retention/partitioning policy; verified it reconstructs a known intra-candle spike.
- **5-minute candle persistence.** Aggregate into 5m OHLCV per symbol and upsert (`UNIQUE(symbol, interval, open_time)`) — primary candle unit for the strategy and backtest.
  - *Output:* 5m candle rows flowing in; verified counts per symbol.
- **1-minute candle persistence.** Also aggregate into 1m OHLCV for longer-range views and metrics.
  - *Output:* 1m candle rows flowing in.
- **Historical funding rates.** Persist per-symbol 8-hourly funding rates (`funding_rates`) so the backtest can replay *actual* historical funding, not a constant.
  - *Output:* funding-rate history accumulating per symbol.
- **Point-in-time universe membership.** Write a timestamped `universe_membership` row whenever a symbol enters/leaves the top-200–300 and whenever its **coin tier changes** (tier 1/2/3), so backtests replay the universe as it *was* (no survivorship bias).
  - *Output:* membership and tier history queryable by date.
- **Instrument persistence.** Persist/refresh universe metadata (tick size, step size, min notional, volume, coin tier).
  - *Output:* `instruments` reflects the current tradable universe with tier.
- **`positions` table extra columns.** The following analysis/algo columns are captured at entry time and are immutable after that:
  - `vwap_at_entry NUMERIC` — VWAP snapshot at entry (TP target reference)
  - `atr_at_entry NUMERIC` — ATR(14) used to compute the stop distance
  - `vwap_deviation_at_entry NUMERIC` — deviation in σ at entry
  - `idiosyncrasy_at_entry NUMERIC` — idiosyncrasy score at entry (0–1)
  - `coin_tier SMALLINT` — tier 1/2/3 at entry time
  - `signal_score_at_entry NUMERIC` — composite signal quality score (0–100)
  - `position_slot VARCHAR(1)` — A, B, or C slot assignment
  - `time_stop_at TIMESTAMPTZ` — absolute time when time-stop fires
  - `slippage_model_pct NUMERIC` — expected round-trip slippage from tier model
  - *Output:* migration adds these columns; repositories expose them.
- **`decisions.market_snapshot` payload standard.** Document (and enforce via a Zod schema at write time) that every `market_snapshot` JSONB contains at minimum: `vwap_session`, `vwap_20bar`, `vwap_deviation_pct`, `vwap_deviation_sigma`, `volume_ratio`, `volume_20bar_avg`, `atr_14`, `adx_14`, `adx_di_plus`, `adx_di_minus`, `rsi_14`, `bollinger_upper`, `bollinger_lower`, `bollinger_pct_b`, `btc_5m_move_pct`, `idiosyncrasy_score`, `funding_rate`, `funding_rate_annualized`, `bid_ask_spread_pct`, `estimated_slippage_pct`, `coin_tier`, `coin_volume_rank`, `correlation_mode`, `signal_score`, `position_slot`, `active_positions_count`, `regime_label`, `entry_candle_open_time`.
  - *Output:* Zod schema validated at write; missing fields cause a logged warning, not a crash.
- **`strategy_versions.params` documented defaults.** Seed v1 and v2 rows with the canonical `params` JSONB:
  ```jsonb
  {
    "vwap_window_bars": 20,
    "vwap_sigma_trigger": 2.0,
    "volume_ratio_min": 1.5,
    "atr_period": 14,
    "atr_stop_multiplier": 1.5,
    "time_stop_minutes": 15,
    "idiosyncrasy_min_score": 0.5,
    "btc_correlated_move_threshold_pct": 1.5,
    "max_open_positions": 3,
    "max_btc_correlated_positions": 1,
    "tier1_min_abs_move_pct": 0.8,
    "tier2_min_abs_move_pct": 1.2,
    "tier3_min_abs_move_pct": 1.5,
    "tier1_max_abs_move_pct": 4.0,
    "tier2_max_abs_move_pct": 6.0,
    "tier3_max_abs_move_pct": 8.0,
    "funding_rate_suppress_threshold": 0.001,
    "candle_interval": "5m",
    "slippage_tier1_pct": 0.15,
    "slippage_tier2_pct": 0.50,
    "slippage_tier3_pct": 1.00
  }
  ```
  - *Output:* both versions persisted with their full params.
- **Repositories** for each entity with the queries later milestones need.
  - *Output:* typed repository methods, unit-tested against a test DB.

## Definition of done

All tables exist via reversible migrations; sub-minute data, 5m + 1m candles, funding
rates, instrument metadata, and point-in-time universe membership (with tier) persist
continuously and are verifiable in Postgres. `decisions.market_snapshot` is validated
by a Zod schema at write time. `positions` carries all entry-time analysis columns.
