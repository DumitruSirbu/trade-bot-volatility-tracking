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
- **Define the trigger formula ONCE (live + backtest share it).** Trigger fires on a **closed 5-min bar** when: (1) `abs(vwap_deviation_sigma) ≥ params.vwap_sigma_trigger`, (2) `volume_ratio ≥ params.volume_ratio_min`, (3) `abs(vwap_deviation_pct) ≥ tier_min_abs_move_pct`, (4) `abs(vwap_deviation_pct) ≤ tier_max_abs_move_pct`. This exact function is reused by the M7 backtest — triggers cannot diverge between live and replay.
  - *Output:* a single documented shared trigger function; a unit test pins its behavior on a known candle series.
- **Emit events:** `price.update` (each tick) and `volatility.detected` (when the trigger formula fires on a closed bar). The `volatility.detected` payload includes: `symbol`, `side` (long/short), `vwap_session`, `vwap_20bar`, `vwap_deviation_pct`, `vwap_deviation_sigma`, `volume_ratio`, `volume_20bar_avg`, `atr_14`, `adx_14`, `adx_di_plus`, `adx_di_minus`, `rsi_14`, `bollinger_upper`, `bollinger_lower`, `bollinger_pct_b`, `btc_5m_move_pct`, `idiosyncrasy_score`, `coin_tier`, `coin_volume_rank`, `funding_rate`, `bid_ask_spread_pct`, `regime_label`, and `entry_candle_open_time`.
  - *Output:* enriched signal events logged to console.
- **Universe-membership transitions.** MarketDataModule owns emitting enter/leave events that M2 persists to `universe_membership`; tier assignment is re-evaluated on each universe refresh.
  - *Output:* enter/leave transitions recorded as the universe refreshes.

## Definition of done

A live stream of VWAP-deviation signal events prints to the console, each carrying
the full indicator snapshot needed by the strategy and risk modules. Trigger formula
is documented, shared with backtest, and unit-tested. Driven by one WebSocket
connection. No DB writes or orders yet.
