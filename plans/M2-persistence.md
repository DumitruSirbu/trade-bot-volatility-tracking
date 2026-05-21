# M2 — Persistence & data model

**Goal:** The full schema exists as migrations, and 1m candles begin accumulating
as the backtest dataset.

**Depends on:** M0 (TypeORM), M1 (market data).

## Tasks

- **TypeORM entities** for all tables: `instruments`, `candles`, `strategy_versions`, `positions`, `transactions`, `decisions`, `risk_state`, `account_snapshots`. Money columns as `NUMERIC`.
  - *Output:* entities compile; relationships and indexes defined.
- **Migrations** for the full schema (reversible).
  - *Output:* `migration:run` creates all tables; `migration:revert` cleanly drops.
- **Candle persistence.** Aggregate the live stream into 1m OHLCV per universe symbol and upsert (`UNIQUE(symbol, interval, open_time)`).
  - *Output:* candle rows flowing into Postgres; verified counts per symbol.
- **Instrument persistence.** Persist/refresh universe metadata (tick size, step size, min notional, volume).
  - *Output:* `instruments` table reflects current tradable universe.
- **Repositories** for each entity with the queries later milestones need.
  - *Output:* typed repository methods, unit-tested against a test DB.

## Definition of done

All tables exist via reversible migrations; 1m candles and instrument metadata
persist continuously and are verifiable in Postgres.
