# M1 — Exchange integration & market data

**Goal:** Live, single-socket market data across the top 200–300 coins, with
in-memory rolling windows that surface sharp short-term moves.

**Depends on:** M0.

## Tasks

- **ExchangeModule over ccxt** (Binance USDT-M Futures, testnet creds). The only code that talks to Binance.
  - *Output:* authenticated client; fetches account balance on testnet.
- **Instrument & universe loading.** Fetch tradable USDT-M perpetuals + 24h volume; select top 200–300 by volume with a liquidity floor; refresh periodically.
  - *Output:* in-memory universe list, logged, refreshed on schedule.
- **Single `!ticker@arr` WebSocket subscription** for the whole universe.
  - *Output:* one connection streaming all symbols; reconnect on drop.
- **In-memory rolling windows** per symbol (configurable lookback, e.g. 1–5 min).
  - *Output:* per-symbol % change computed continuously.
- **Define the trigger formula ONCE (live + backtest share it).** Simple return `(p_last / p_first) − 1` over a rolling N-second window, evaluated **per tick** on trade price. State N and whether the threshold is on the windowed move (not bar high-low range). This exact function is reused by the M7 backtest so triggers can't diverge. Constant: `VOLATILITY_THRESHOLD_PCT`.
  - *Output:* a single documented, shared trigger function; a unit test pins its behavior on a known series.
- **Emit events:** `price.update` and `volatility.detected` (when the windowed return crosses `VOLATILITY_THRESHOLD_PCT`).
  - *Output:* console log of detected >2–3% moves across the universe.
- **Universe-membership transitions.** MarketDataModule owns emitting enter/leave events that M2 persists to `universe_membership`.
  - *Output:* enter/leave transitions recorded as the universe refreshes.

## Definition of done

A live stream of detected sharp moves prints to the console, driven by one
WebSocket connection and an exchange-agnostic interface. No DB writes or orders yet.
