# Trade Bot — Volatility Tracking · Overview

A crypto volatility-tracking trading bot. It watches the top 200–300 coins by
volume on Binance Futures, detects sharp short-term price moves (>2–3% in a short
window), and opens minimum-leverage positions with disciplined risk management.
Every decision and trade is persisted so strategy versions can be compared and
improved over time.

## Locked decisions

| Area | Decision | Why |
|------|----------|-----|
| Language / framework | **TypeScript + NestJS**, single event-driven process | Maintainability; user knows NestJS; workload is I/O-bound, not CPU-bound |
| Exchange | **Binance USDT-M Futures** via **ccxt** | Shorting requires futures; ccxt keeps exchange swappable |
| Database | **Postgres** + TypeORM | Relational data, ACID money accounting, aggregation for version comparison |
| Decimals | **decimal.js** | Never use JS floats for prices/PnL |
| Trading mode | **Binance testnet first**, then live at minimal size | Zero capital risk during validation |
| Jurisdiction | Outside US | Full Binance Futures available |
| Signal direction | **Backtest decides** — build mean-reversion + momentum | Direction is an empirical question, not a guess |
| LLM in trade loop | **No** — deterministic only | Determinism enables reproducible backtests; safety; auditability |
| LLM role | **Outer loop only** — proposes reviewed, backtested code; never executes | Improve the algo between cycles, not within it |
| Dashboard | **Read-only + kill-switch button**, real-time WS/SSE, built after core engine | Observability without an attack surface |
| MCP / agents | **Phase 2** — read-only analysis MCP, agentic weekly loop, CI review gate | Don't block a working bot on speculative tooling |

## Core principle

**The same strategy code runs live and in backtest.** Strategies are pure and
deterministic (market state in → signal out). All risk limits live *outside* the
strategy and are enforced centrally. Nothing reaches execution without passing the
risk gate.

## Architecture (single NestJS process)

```
   Binance WS ───────────▶ ExchangeModule (ccxt)  ◀──── order calls ───▶ Binance Futures
   (!ticker@arr)                  │                         ▲                (testnet → live)
                                  ▼                         │
                            MarketData ──price.update──▶ Strategy ──signal──▶ Risk ──order──▶ Execution
                            (rolling windows,            engine     (limits,    (place/        │
                             universe filter)         (v1,v2,v3…)   exposure,   reduce/        │
                                  │                       │         stops)      close)         │
                                  │ candles               │ decisions            │ fills       │
                                  ▼                        ▼                      ▼             │
                            ┌───────────── Persistence (TypeORM ─ Postgres) ──────────────────┐│
                            │  candles · positions · transactions · decisions · versions      ││
                            └─────────────────────────────────────────────────────────────────┘
                                  ▲
                            Backtest (replays candles through SAME strategy code)
                            Notification (Telegram alerts + kill switch)
                            (phase 2) read-only Analysis MCP · React dashboard on Vercel
```

### Modules

- **ExchangeModule** — ccxt wrapper; the only code that talks to Binance (market WS, orders, account, symbol metadata). Exchange-agnostic interface.
- **MarketDataModule** — one `!ticker@arr` subscription; maintains the universe (top 200–300 by volume) and in-memory rolling windows; emits `price.update` / `volatility.detected`; writes 1m candles.
- **StrategyModule** — `Strategy` interface + versioned, pure, deterministic implementations; registry + active-version selection; writes `decisions`.
- **RiskModule** — gatekeeper: sizing, daily/weekly loss limits, exposure caps, liquidity/funding filters, stop-loss + trailing-take-profit, cooldowns. Signal → approved/rejected order intent.
- **ExecutionModule** — places/reduces/closes orders; idempotent; partial-fill handling.
- **PositionModule** — authoritative position state; reconciles against exchange; unrealized/realized PnL.
- **PersistenceModule** — TypeORM entities, repositories, migrations.
- **BacktestModule** — replays stored candles through a strategy version with simulated fills/fees/slippage; same strategy code as live.
- **NotificationModule** — Telegram alerts + kill switch (global halt flag + endpoint).
- **CommonModule** — config, decimal helpers, logging, event bus (`@nestjs/event-emitter`), scheduler (`@nestjs/schedule`).
- *(phase 2)* **AnalysisModule** — read-only MCP server + weekly reports.

## Data model (Postgres; money as `NUMERIC`)

```
instruments      id · symbol(unique) · base · quote · status · tick_size · step_size
                 min_notional · is_tradable · volume_24h · updated_at

candles          id · symbol · interval · open_time(idx) · open · high · low · close · volume
                 UNIQUE(symbol, interval, open_time)

tick_aggregates  id · symbol · ts(idx) · price · volume        -- sub-minute (1s/5s) data
                 -- backtest replays this so intra-minute >2-3% triggers reproduce live
                 UNIQUE(symbol, ts)

universe_membership id · symbol · entered_at · left_at(null)   -- point-in-time top-300
                 -- backtests replay the universe as it WAS (no survivorship bias)

funding_rates    id · symbol · funding_time(idx) · rate         -- 8-hourly historical funding
                 -- backtest replays actual funding; live PnL uses real funding events
                 UNIQUE(symbol, funding_time)

strategy_versions id · name · version(int) · direction(mean_reversion|momentum|hybrid)
                 params(jsonb) · status(draft|active|archived)
                 parent_version_id(fk→self, null) · created_at

positions        id · symbol · strategy_version_id(fk) · side(short|long)
                 status(open|closed) · leverage · entry_price · qty · entry_notional
                 exit_price(null) · realized_pnl(null)
                 exit_reason(null: take_profit|stop_loss|signal|manual|kill_switch)
                 opened_at · closed_at(null)
                 idx(strategy_version_id, status) · idx(symbol, status)

transactions     id · position_id(fk) · type(open|add|reduce|close|funding)
                 side · price · qty · fee · client_order_id · exchange_order_id(unique) · created_at
                 -- funding rows record periodic perpetual funding cashflows into realized PnL
                 -- client_order_id is the reconciliation/idempotency match key

decisions        id · symbol · strategy_version_id(fk) · ts
                 signal_type · market_snapshot(jsonb)
                 action(open|add|reduce|close|skip) · reason · position_id(fk, null)
                 idx(strategy_version_id, ts)

risk_state       id · date(unique) · realized_pnl_day · open_exposure
                 trades_count · is_halted · halt_reason

account_snapshots id · ts · balance · equity · unrealized_pnl
```

Performance metrics (win rate, drawdown, PnL by version) are computed via SQL
aggregation over `positions`/`transactions` — denormalize to a materialized view
only if volume later demands it.

## Frontend

The engine runs headless (no UI required to trade). Observability is layered:
structured logs (M0) → Telegram alerts + kill switch (M9) → read-only React
dashboard (M10). Everything is containerized; the stack deploys to a single cloud
(AWS or GCP). The **engine must run as an always-on container** (it holds a
persistent Binance WebSocket and in-memory state — never scale-to-zero). The
dashboard talks to an authenticated read API. Full topology in `M11-go-live-hardening.md`.

## Milestones

| # | Milestone | File |
|---|-----------|------|
| M0 | Foundation & scaffolding | `M0-foundation.md` |
| M1 | Exchange integration & market data | `M1-exchange-market-data.md` |
| M2 | Persistence & data model | `M2-persistence.md` |
| M3 | Strategy engine | `M3-strategy-engine.md` |
| M4 | Risk management | `M4-risk-management.md` |
| M5 | Execution (testnet) | `M5-execution-testnet.md` |
| M6 | Position management & reconciliation | `M6-position-management.md` |
| M7 | Backtesting engine | `M7-backtesting.md` |
| M8 | Strategy versioning & comparison | `M8-versioning-comparison.md` |
| M9 | Observability, control & read API | `M9-observability-control.md` |
| M10 | Dashboard (React, containerized) | `M10-dashboard.md` |
| M11 | Go-live hardening | `M11-go-live-hardening.md` |
| M12 | Analysis MCP (phase 2) | `M12-analysis-mcp.md` |
| M13 | Agentic weekly loop (phase 2) | `M13-agentic-weekly-loop.md` |
| M14 | CI review gate (phase 2) | `M14-ci-review-gate.md` |
