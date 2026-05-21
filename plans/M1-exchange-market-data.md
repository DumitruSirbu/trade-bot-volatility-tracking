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
- **Emit events:** `price.update` and `volatility.detected` (when % change over the window crosses the configured threshold).
  - *Output:* console log of detected >2–3% moves across the universe.

## Definition of done

A live stream of detected sharp moves prints to the console, driven by one
WebSocket connection and an exchange-agnostic interface. No DB writes or orders yet.
