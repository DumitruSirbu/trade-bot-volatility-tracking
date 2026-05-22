# M1 — Exchange integration & market data

**Goal:** Live, single-socket market data across the top 200–300 coins, with
5-minute candle aggregation, VWAP/σ-band computation, and enriched signal events.

**Depends on:** M0.

## Tasks

- **ExchangeModule over ccxt** (Binance USDT-M Futures, testnet creds). The only code that talks to Binance.
  - *Output:* authenticated client; fetches account balance on testnet.
- **Instrument & universe loading.** Fetch tradable USDT-M perpetuals + 24h volume; select top 200–300 by volume with a liquidity floor; assign each symbol a **coin tier** (tier 1 = top 50, tier 2 = 51–150, tier 3 = 151–300) at load time; refresh periodically.
  - *Output:* in-memory universe list with tier assignment, logged, refreshed on schedule.
- **Single `!ticker@arr` WebSocket subscription** for the whole universe.
  - *Output:* one connection streaming all symbols; reconnect on drop.
- **5-minute candle aggregation** per symbol in memory. Aggregate tick stream into OHLCV bars; also accumulate 1m candles for persistence (M2).
  - *Output:* closed 5-min bars emitted per symbol.
- **Rolling VWAP and σ-band computation** per symbol on the 5-min candle stream (configurable window, default 20 bars). Compute session-anchored VWAP, rolling 20-bar σ of price deviations from VWAP, ATR(14), ADX(14) (+DI/−DI), RSI(14), and Bollinger Band %B alongside. All computed on **closed bars only** — no look-ahead into the forming candle.
  - *Output:* per-symbol indicator state updated on each closed 5-min bar.
- **Volume ratio** computed per symbol: current closed-bar volume / 20-bar average volume.
  - *Output:* `volume_ratio` available per symbol on each closed bar.
- **BTC reference move** maintained: BTC's % change in VWAP and in raw price over the same 5-min window, updated each closed BTC bar.
  - *Output:* `btc_5m_move_pct` and `btc_vwap_deviation_sigma` accessible for idiosyncrasy scoring.
- **Idiosyncrasy score** derived per triggered symbol: `1 − (abs(btc_5m_move_pct) / abs(coin_5m_move_pct))`. Clamped to [0, 1]. Score > 0.5 = idiosyncratic; < 0.3 = BTC-correlated.
  - *Output:* `idiosyncrasy_score` included in signal events.
- **Regime label** derived from ADX(14): ADX < 20 → `ranging`; ADX > 25 → `trending_up` or `trending_down` (based on +DI vs −DI); between 20–25 → `transitioning`.
  - *Output:* `regime_label` included in signal events.
- **Define the trigger formula ONCE (live + backtest share it).** The trigger is a **direction-agnostic event detector**, not a trade-direction decision. It fires on a **closed 5-min bar** when: (1) `abs(vwap_deviation_sigma) ≥ params.vwap_sigma_trigger`, (2) `volume_ratio ≥ params.volume_ratio_min`, (3) `abs(vwap_deviation_pct) ≥ tier_min_abs_move_pct`, (4) `abs(vwap_deviation_pct) ≤ tier_max_abs_move_pct`. σ here is a **normalized distance, not a probability statement** — crypto returns are fat-tailed, so the bands are calibrated empirically (see "Empirical band calibration" below), not by Gaussian intuition. This exact function is reused by the M7 backtest — triggers cannot diverge between live and replay.
  - *Output:* a single documented shared trigger function; a unit test pins its behavior on a known candle series.

- **Open Interest tracking.** Poll `GET /fapi/v1/openInterest` per universe symbol (REST — there is no all-symbol realtime OI stream) and pull historical OI for backtest. Compute `open_interest_change_5m_pct` and `open_interest_change_15m_pct`. Poll more frequently for symbols approaching the trigger.
  - *Output:* per-symbol current OI + short-window change available on each closed bar; OI history persisted (M2) for replay.

- **Funding as flow signal.** Stream mark price / funding where practical (per-symbol mark-price stream); pull funding history via `GET /fapi/v1/fundingRate`. Expose `funding_rate` and `funding_rate_annualized`. Funding is a crowding/trailing indicator, not a clean price-leading signal — it feeds the flow classifier and risk skips, not direction by itself.
  - *Output:* `funding_rate` and `funding_rate_annualized` available per symbol.

- **Aggressor imbalance.** For symbols near/at trigger, capture aggTrade buy-volume vs sell-volume ratio over the trigger window.
  - *Output:* `agg_trade_buy_volume_ratio` available for triggered symbols.

- **Order-book depth (triggered symbols only).** Snapshot top-of-book spread + depth at ~10bps and ~50bps. **Practical compromise:** broad ticker/mark streams for all symbols; subscribe/poll depth + OI more frequently only as a symbol approaches the trigger; persist depth only around decisions / open positions. Do **not** stream deep books for all ~300 symbols.
  - *Output:* `book_depth_10bps_usdt` and `book_depth_50bps_usdt` captured around triggers; persisted (M2) only around decisions/positions.

- **Market breadth.** Percent of the universe up/down over 1m / 5m / 15m, and `same_bar_trigger_count` (how many symbols fire the trigger in the same 5-min bar).
  - *Output:* `market_breadth_5m_up_pct` and `same_bar_trigger_count` available per closed bar.

- **Symbol universe age.** Hours since the symbol entered the top-300 (fresh entrants are pump-risk and should generally be skipped).
  - *Output:* `symbol_universe_age_hours` available per symbol.

- **Fast market-stress inputs (independent of ADX).** Maintain BTC and ETH 1m & 5m return shock, spread-widening and depth-collapse flags, OI shock, and a funding-extreme flag. These feed M4's global market-stress halt. Rationale: ADX(14) is lagging by design — it labels the market "ranging" exactly as a new trend starts, which is the most dangerous moment to fade a move.
  - *Output:* `btc_1m_move_pct`, `eth_5m_move_pct`, and stress flags computed continuously and exposed to the risk layer.

- **Empirical band calibration.** Track per-symbol / per-tier empirical percentiles of VWAP deviation (and/or MAD / winsorized σ); store per-symbol distribution stats. Trigger bands are calibrated by realized false-positive rate, not by Gaussian intuition.
  - *Output:* per-symbol distribution stats accumulating; documented that σ is a normalized distance, not a probability.

- **VWAP anchoring.** Compute and compare multiple anchors — rolling 20-bar, rolling 24-hour, session, and event-anchored (after a high-volume regime shift). Be explicit that a session / 00:00-UTC reset can destroy context right after a late move; the backtest (M7) compares anchors rather than assuming one is best. Emit `vwap_anchor_type` in the payload.
  - *Output:* multiple VWAP anchors available; `vwap_anchor_type` carried in the signal payload.
- **Emit events:** `price.update` (each tick) and `volatility.detected` (when the trigger formula fires on a closed bar). `side` here is the **deviation direction of the event**, not a trade direction — direction is decided downstream by the strategy. The `volatility.detected` payload includes: `symbol`, `side`, `vwap_session`, `vwap_20bar`, `vwap_deviation_pct`, `vwap_deviation_sigma`, `volume_ratio`, `volume_20bar_avg`, `atr_14`, `adx_14`, `adx_di_plus`, `adx_di_minus`, `rsi_14`, `bollinger_upper`, `bollinger_lower`, `bollinger_pct_b`, `btc_5m_move_pct`, `idiosyncrasy_score`, `coin_tier`, `coin_volume_rank`, `funding_rate`, `bid_ask_spread_pct`, `regime_label`, `entry_candle_open_time`, and the flow/liquidity/stress fields: `open_interest`, `open_interest_change_5m_pct`, `open_interest_change_15m_pct`, `funding_rate_annualized`, `agg_trade_buy_volume_ratio`, `market_breadth_5m_up_pct`, `same_bar_trigger_count`, `book_depth_10bps_usdt`, `book_depth_50bps_usdt`, `vwap_anchor_type`, `symbol_universe_age_hours`, `btc_1m_move_pct`, `eth_5m_move_pct`, and a `flow_type` placeholder (classified in M3).
  - *Output:* enriched signal events logged to console.
- **Universe-membership transitions.** MarketDataModule owns emitting enter/leave events that M2 persists to `universe_membership`; tier assignment is re-evaluated on each universe refresh.
  - *Output:* enter/leave transitions recorded as the universe refreshes.

## Definition of done

A live stream of VWAP-deviation signal events prints to the console, each carrying
the full indicator snapshot needed by the strategy and risk modules. Trigger formula
is documented, shared with backtest, and unit-tested. Driven by one WebSocket
connection. No DB writes or orders yet.
