# M2 — Persistence & data model

**Goal:** The full schema exists as migrations, and sub-minute + 5m + 1m market data
begin accumulating as a backtest dataset that faithfully reproduces live triggers.

**Depends on:** M0 (TypeORM), M1 (market data).

## Tasks

- **TypeORM entities** for all tables: `instruments`, `candles`, `tick_aggregates`, `universe_membership`, `funding_rates`, `open_interest`, `book_snapshots`, `strategy_versions`, `positions`, `transactions`, `decisions`, `risk_state`, `account_snapshots`. Money columns as `NUMERIC`.
  - *Output:* entities compile; relationships and indexes defined.
- **Migrations** for the full schema (reversible).
  - *Output:* `migration:run` creates all tables; `migration:revert` cleanly drops.
- **`open_interest` time-series table.** Columns: `symbol`, `ts`, `value`; `UNIQUE(symbol, ts)`. Persist OI samples (polled via `GET /fapi/v1/openInterest` in M1) for live use and backtest replay (M7).
  - *Output:* OI history accumulating per symbol; queryable by date.
- **`book_snapshots` table.** Columns: `symbol`, `ts`, `spread`, `depth_10bps`, `depth_50bps`. Persisted **only around decisions / open positions** (not streamed for all symbols), per the M1 practical compromise.
  - *Output:* depth snapshots recorded around decisions; verified they line up with the triggering decision row.
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
  - `open_interest_at_entry NUMERIC` — OI snapshot at entry
  - `oi_change_5m_at_entry NUMERIC` — 5-min OI change % at entry
  - `flow_type_at_entry VARCHAR` — classified flow type at entry (M3)
  - `funding_annualized_at_entry NUMERIC` — annualized funding at entry
  - `book_depth_10bps_at_entry NUMERIC` — book depth at ~10bps at entry
  - `spread_at_entry_pct NUMERIC` — bid/ask spread % at entry
  - `vwap_anchor_type VARCHAR` — which VWAP anchor drove the decision
  - `symbol_universe_age_hours NUMERIC` — hours in the top-300 at entry
  - *Output:* migration adds these columns; repositories expose them.
- **`positions` lifetime-instrumentation columns.** Tracked through the position's life (mutable until close), used to diagnose whether the strategy is actually low-risk (populated by M6):
  - `mae_pct NUMERIC` — max adverse excursion
  - `mfe_pct NUMERIC` — max favorable excursion
  - `time_to_reversion_secs INT` — seconds until price reverted toward VWAP
  - `stop_gap_pct NUMERIC` — fill slippage beyond the stop level
  - `min_liquidation_distance_pct NUMERIC` — closest the position came to liquidation
  - `protective_order_type VARCHAR` — `exchange_side` | `local_fallback`
  - `mark_vs_last_max_divergence_pct NUMERIC` — max mark-vs-last price divergence observed
  - *Output:* migration adds these columns; M6 populates them over the position's life.
- **Stable `event_id` on `decisions`.** Add an `event_id` column (one id per VWAP trigger event). All strategy versions (v0/v1/v2/v3) writing a decision for the same trigger share the same `event_id`, so M8 compares them on the **same event under the same market path** — this replaces the fragile paired-timestamp matching.
  - *Output:* migration adds `event_id` with an index; decisions for one trigger share it across versions.
- **`decisions.market_snapshot` payload standard.** Document (and enforce via a Zod schema at write time) that every `market_snapshot` JSONB contains at minimum: `vwap_session`, `vwap_20bar`, `vwap_deviation_pct`, `vwap_deviation_sigma`, `volume_ratio`, `volume_20bar_avg`, `atr_14`, `adx_14`, `adx_di_plus`, `adx_di_minus`, `rsi_14`, `bollinger_upper`, `bollinger_lower`, `bollinger_pct_b`, `btc_5m_move_pct`, `idiosyncrasy_score`, `funding_rate`, `funding_rate_annualized`, `bid_ask_spread_pct`, `estimated_slippage_pct`, `coin_tier`, `coin_volume_rank`, `correlation_mode`, `signal_score`, `position_slot`, `active_positions_count`, `regime_label`, `entry_candle_open_time`, plus the M1 flow/liquidity/stress fields: `open_interest`, `open_interest_change_5m_pct`, `open_interest_change_15m_pct`, `agg_trade_buy_volume_ratio`, `market_breadth_5m_up_pct`, `same_bar_trigger_count`, `book_depth_10bps_usdt`, `book_depth_50bps_usdt`, `vwap_anchor_type`, `symbol_universe_age_hours`, `btc_1m_move_pct`, `eth_5m_move_pct`, and `flow_type`.
  - *Output:* Zod schema validated at write; missing fields cause a logged warning, not a crash.
- **`strategy_versions.params` documented defaults.** Seed **v0** (no-trade baseline), **v1** (exhaustion-confirmed mean-reversion), **v2** (momentum), and **v3** (hybrid router) rows with the canonical `params` JSONB. Shared base:
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
    "slippage_tier3_pct": 1.00,
    "require_oi_available": true,
    "oi_rising_skip": true,
    "consecutive_loss_halt": 2,
    "max_trades_per_symbol_per_day": 2,
    "max_trades_per_bar_universe": 1,
    "stress_btc_1m_shock_pct": 1.0,
    "stress_eth_1m_shock_pct": 1.2,
    "stress_breadth_pct": 70,
    "stress_same_bar_trigger_count": 5,
    "structural_stop_wick_buffer_pct": 0.1,
    "structural_stop_hard_cap_pct": 2.0
  }
  ```
  Per-version additions:
  - **v0** — `{ "trade_enabled": false }` (logs every trigger + full snapshot + `flow_type`, opens nothing).
  - **v1** — `{ "direction": "mean_reversion", "require_exhaustion_confirmation": true }`.
  - **v2** — `{ "direction": "momentum" }`.
  - **v3** — `{ "direction": "hybrid" }` (flow-classifying router; routes per `flow_type`).
  - *Output:* v0, v1, v2, v3 persisted with their full params; existing params retained.
- **Repositories** for each entity with the queries later milestones need.
  - *Output:* typed repository methods, unit-tested against a test DB.

## Definition of done

All tables exist via reversible migrations; sub-minute data, 5m + 1m candles, funding
rates, instrument metadata, and point-in-time universe membership (with tier) persist
continuously and are verifiable in Postgres. `decisions.market_snapshot` is validated
by a Zod schema at write time. `positions` carries all entry-time analysis columns.

## Outcome / Review rounds

**Shipped:**
- **13 entities across domain-owned modules:** market-data owns `instruments`, `candles`, `tick_aggregates`, `open_interest`, `funding_rates`, `book_snapshots`, `universe_membership` (strategy/position/risk module shells own their entities from day one); reversible migrations (CreateSchema + SeedStrategyVersions on the Baseline anchor); NUMERIC↔decimal.js `ValueTransformer` that rejects JS number (float-money guard); `tick_aggregates` as native daily RANGE partitions (90-day retention, 1-second OHLC buckets); `@OnEvent` persistence listeners (passive subscriber) wiring six new emit points: `CANDLE_CLOSED` (1m+5m), `TICK_AGGREGATE` (1s OHLC), `OPEN_INTEREST_SAMPLED`, `FUNDING_RATE_OBSERVED` (8h settlement time), `INSTRUMENT_REFRESHED`, `UNIVERSE_SYMBOL_TIER_CHANGED`; point-in-time `universe_membership` (gap-free tier timeline, partial unique index enforcing one open row/symbol); `strategy_versions` v0–v3 seed (v0 active no-trade baseline, v1/v2/v3 draft); repositories per entity; `decisions.market_snapshot` validated by shared Zod schema at write (warn-not-throw); `decimal` type alias (`DecimalValue`) separating non-money decimals from `MoneyValue`. 353 Jest tests, all gates pass (build, lint, tsc, test). Migration round-trip verified on real Postgres (run/revert/re-run). Live testnet persistence verified: 1m+5m candles flowing, `tick_aggregates` 1s bucketing (reconstructs intra-candle spike), instruments with correct tick/step, point-in-time universe membership (tier changes atomic).
- **Architecture:** Reference `docs/architecture/adr/0002-persistence-and-data-model.md`. Three surfaced-and-approved decisions: (a) entity-ownership re-read as INFRA concern (PersistenceModule owns the cross-cutting transformer + migration timeline; domain modules own their entities per code-conventions—no file relocation later); (b) `coin_tier` stored as CoinTierEnum string varchar, NOT the brief's SMALLINT (single canonical representation) — **overrides the M2 brief**; (c) zod added as `packages/shared` dependency.
- **Review rounds:** Round 1 (security/logic/clean-code/quant): security clean; logic found 2 blockers — `tick_aggregates` emitted per-raw-ms-tick with no 1s bucketing (UNIQUE collisions + couldn't reconstruct an intra-candle spike) and `funding_rates.funding_time` used the poll wall-clock instead of the 8h settlement time (fake idempotency + corrupted backtest funding); highs — non-atomic tier-change close+open, duplicate `symbolEntered` creating a 2nd open membership row, instruments never flipped `is_tradable=false` on leave, migration `down()` not dropping indexes explicitly, `MoneyValue` misused for non-money columns, empty `where:{}` on repository queries, listener deps not `private readonly`; clean-code blocker — duplicated magic constants across entity files. Round 1 fixes: real 1s OHLC bucketing emitted on both tick+sweep paths; `funding_rates.funding_time` keyed on ccxt settlement timestamp (added `IFundingRateSnapshot.fundingTimestampMs`); atomic `changeTier` transaction + partial unique index `UNIQUE(symbol) WHERE left_at IS NULL`; leaver flips `is_tradable=false`; explicit reverse-order index drops; `DecimalValue` alias + `MoneyValue` audit; real ccxt `tick_size`/`step_size`/`minNotional` surfaced on `IMarketInfo`. Round 2: all round-1 items verified resolved; clean-code found residual `DecimalValue`-typing must-fixes on `leverage`/`tickSize`/`stepSize`/`funding_rate` + `MS_PER_HOUR` constant placement — all fixed. Post-review smoke test caught wrong ccxt mapping (`tickSize` read from `limits.price.min` = `minPrice`, e.g. BTC 261.1 instead of 0.1); fixed to map from `precision.price` (TICK_SIZE mode) and verified BTC=0.1/ETH=0.01 against testnet. End state: zero blockers/highs.
- **Carry-over notes:** OI/funding/book_snapshots accumulate via 5-min pollers + around-decision writes (not seen in a 90s smoke window — verify on >5min run); persistence insert-failure on missing tick partition is logged not alarmed (M9 to alarm); book_snapshots writer fully wired in M3+ around decisions; decisions/positions/transactions have schema+repositories+Zod hook but no live writer until M3–M6.

## Adversarial backfill — 2026-05-23

**Surfaces (5):**

1. **NUMERIC ↔ Decimal transformer at column boundaries** — exceeded precision/scale, negative zero, exponent-form strings, `NaN`/`Infinity` from upstream, JS-number rejection.
2. **`tick_aggregates` partition boundary** at second/microsecond seam, insert-before-partition-exists race, backdated rows older than 90-day retention.
3. **Migration up → down → up round-trip** with simulated row volume; indexes reversed + recreated without collision.
4. **Unique-constraint races** on concurrent inserts: `universe_membership` partial unique, `candles` UNIQUE, `funding_rates` settlement timestamp.
5. **Zod-validated `market_snapshot` write under schema drift** — missing required field, unknown extra field (`.strict()`), decimal as JS number.

**Findings:**

- **Round 1 (2 real bugs):**
  - **Bug 1 (Surface 1):** `decimalColumnTransformer` silently passed `NaN`/`Infinity`/`-Infinity` to NUMERIC columns. Fixed: added `isFinite()` guard on both `to()` and `from()` paths + extended `MoneyTransformerException` with `'non-finite'` discriminator. 3 bug-documenting tests flipped to assert correct behavior.
  - **Bug 2 (Surface 4):** `UniverseMembershipRepository.openMembershipWith` propagated unique-violation errors on concurrent open instead of being idempotent. Real bug. Fixed: try/catch on SQLSTATE 23505 with constraint match, re-fetch existing row. ADR 0002 §point-in-time universe got new "open-row contract" sentence locking the idempotency invariant.
  - **(Fidelity, Surface 3):** Migration round-trip adversarial spec hardcoded 3 `undoLastMigration` calls when chain has 6. Test-harness fidelity, fixed: loop-until-empty helper applied to both adversarial and pre-existing baseline specs.
- **Round 2 (0 blockers, 0 highs):** Ran DB-integration suite against real Postgres; all pre-round-1 fixes verified. **Deferred to follow-up before M6:** `repository.integration.spec.ts` has 7 partition-not-found failures when run against freshly-initialized Postgres volume (need partition-rollover service or test-harness pre-create for current/upcoming date window). Tracked as narrow pre-M6 task.

**Architect audit (cross-cutting):** 6 producer-side risk sites where non-finite Decimals can be born (vwap, deviation, atr, sizer, stops, PnL) — covered as Producer-side guards in M1's adversarial pass.

**Tests added:** 60 adversarial tests in round 1 (42 unit + 18 DB-integration-ready). Engine unit-test count: 353 (pre) → 395 (post-backfill) — excluding 18 DB-integration tests that activate only when Postgres is live.

**Round count: 2.** Zero blockers, zero highs. End state: clean.
