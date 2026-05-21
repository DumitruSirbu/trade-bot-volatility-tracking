# M2 — Persistence & data model

**Goal:** The full schema exists as migrations, and sub-minute + 1m market data
begin accumulating as a backtest dataset that faithfully reproduces live triggers.

**Depends on:** M0 (TypeORM), M1 (market data).

## Tasks

- **TypeORM entities** for all tables: `instruments`, `candles`, `tick_aggregates`, `universe_membership`, `strategy_versions`, `positions`, `transactions`, `decisions`, `risk_state`, `account_snapshots`. Money columns as `NUMERIC`.
  - *Output:* entities compile; relationships and indexes defined.
- **Migrations** for the full schema (reversible).
  - *Output:* `migration:run` creates all tables; `migration:revert` cleanly drops.
- **Sub-minute market data for backtest fidelity.** Persist the same granularity the live engine consumes — raw ticks or short aggregates (e.g. 1s/5s `tick_aggregates`) per universe symbol — so the backtest can reproduce intra-minute >2–3% triggers that a 1m candle would hide. (Reviewer blocker: live triggers on ticks, so replaying 1m candles alone breaks backtest==live.)
  - *Output:* sub-minute data flowing into Postgres; verified it reconstructs a known intra-minute spike.
- **1m candle persistence.** Aggregate into 1m OHLCV per symbol and upsert (`UNIQUE(symbol, interval, open_time)`) — for longer-range views/metrics.
  - *Output:* candle rows flowing in; verified counts per symbol.
- **Point-in-time universe membership.** Write a timestamped `universe_membership` row whenever a symbol enters/leaves the top-200–300, so backtests replay the universe as it *was* (avoids survivorship bias).
  - *Output:* membership history queryable by date.
- **Instrument persistence.** Persist/refresh universe metadata (tick size, step size, min notional, volume).
  - *Output:* `instruments` reflects the current tradable universe.
- **Repositories** for each entity with the queries later milestones need.
  - *Output:* typed repository methods, unit-tested against a test DB.

## Definition of done

All tables exist via reversible migrations; sub-minute data, 1m candles, instrument
metadata, and point-in-time universe membership persist continuously and are
verifiable in Postgres.
