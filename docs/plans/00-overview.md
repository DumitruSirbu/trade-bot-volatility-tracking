# Trade Bot — Volatility Tracking · Overview

A crypto volatility-tracking trading bot. It watches the top 200–300 coins by
volume on Binance USDT-M Futures, uses a VWAP-deviation spike on 5-minute candles as a
**direction-agnostic event detector**, classifies the flow behind each event, and opens
positions through a central risk gate (architectural max 3; live starts at 1). Every
decision and trade is persisted so strategy versions can be compared and improved over time.

The priority is **conservative, stable, low-risk operation over returns**. Profit is an
outcome of edge, not a target — there is no daily profit goal. `Skip` is a first-class,
high-value output: the bot is judged on avoiding bad trades, not on trade frequency. Most
triggers should resolve to `skip`. Live capital starts at $500–$1,000 at minimum leverage,
and the heavier go-live caps relax only after weeks of confirmed live behavior matching
backtest. A RESTRICTED v1 goes live first; the flow-classifying hybrid router (v3) is the
end-state target — go-live is **not** blocked on v3.

## Locked decisions

| Area | Decision | Why |
|------|----------|-----|
| Language / framework | **TypeScript + NestJS**, single event-driven process | Maintainability; user knows NestJS; workload is I/O-bound, not CPU-bound |
| Exchange | **Binance USDT-M Futures** via **ccxt** | Shorting requires futures; ccxt keeps exchange swappable |
| Database | **Postgres** + TypeORM | Relational data, ACID money accounting, aggregation for version comparison |
| Decimals | **decimal.js** | Never use JS floats for prices/PnL |
| Trading mode | **Binance testnet first**, then live at minimal size | Zero capital risk during validation |
| Jurisdiction | Outside US | Full Binance Futures available |
| Candle interval | **5-minute** (not 1-minute) | Reduces noise vs 1m; primary strategy bar (execution sims still use 1s/aggTrade) |
| Signal trigger | **VWAP deviation event detector + volume confirmation** (direction-agnostic) | Locates an event; does **not** imply a trade direction. Bands are **empirically calibrated** (percentile / MAD / winsorized σ), **not** assumed Gaussian — crypto returns are fat-tailed, 3–5σ moves are common, so σ is a normalized distance, not a probability |
| Flow context | **Open Interest + funding are first-class signal inputs** | Used to classify a liquidation-cascade (fade-able) vs new-money / catalyst (skip or follow) event |
| Signal direction | **Empirical, never assumed** — v0 no-trade baseline (logs every trigger), v1 exhaustion-confirmed mean-reversion (first live), v2 momentum, v3 flow-classifying hybrid router (end-state target) | Direction decided by out-of-sample evidence + live shadow on the same event |
| Max open positions | **3** architectural max — slots A+B = idiosyncratic; slot C = at most 1 BTC-correlated. **Live starts at 1 position.** | Prevents correlated cluster losses; restricted live profile proves edge before scaling |
| Starting capital | **$500–$1,000 USDT** at minimum leverage; **no daily profit target** | Goal is survival + measured edge. Success = max drawdown, daily/weekly loss limits, expectancy per unit risk, Sharpe/Sortino, expected shortfall, longest losing streak. Scale only after weeks of confirmed live edge matching backtest |
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
                             universe filter,        (v0,v1,v2,v3)  exposure,   reduce/        │
                             flow + stress)          skip-first    stress halt)  close)        │
                                  │                       │                                    │
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
- **MarketDataModule** — one `!ticker@arr` subscription for breadth + broad mark/ticker streams; maintains the universe (top 200–300 by volume) with tier assignment and symbol-universe age; aggregates 5-min candles; computes per-symbol VWAP/σ bands (with empirical-percentile / MAD calibration), ATR, ADX, RSI, volume ratio + acceleration, idiosyncrasy score, and regime label; tracks **flow context** (Open Interest + change, funding, aggressor imbalance) and **order-book depth** for triggered symbols; computes **market breadth** and **fast market-stress inputs** (BTC/ETH return shock, spread-widening, depth-collapse, OI shock, funding-extreme) independent of ADX; emits `price.update` / `volatility.detected` (enriched payload, with `flow_type` placeholder); writes 1m + 5m candles, OI history, and depth snapshots around decisions.
- **StrategyModule** — `Strategy` interface + versioned, pure, deterministic implementations: **v0** no-trade baseline, **v1** exhaustion-confirmed mean-reversion, **v2** momentum, **v3** flow-classifying hybrid router (end-state target). `skip` is a first-class output. Registry + active-version selection; writes `decisions` with full `market_snapshot` and a stable `event_id`.
- **RiskModule** — gatekeeper: sizing, daily/weekly loss limits, **consecutive-loss / per-symbol / per-bar caps**, exposure caps, liquidity/funding filters, **global market-stress halt** (driven by the fast-stress inputs, overrides ADX), **model-divergence kill switch**, stop-loss (ATR or structural) + take-profit, cooldowns. Signal → approved/rejected order intent. *M19: book depth is a **per-coin** eligibility skip (`coin_book_too_thin`, per-tier floors), NOT a global halt — a thin alt can no longer day-kill the whole market; the global stress halt now covers spread-widening + breadth-distance (risk-only const, decoupled from the `stress_breadth_pct` flow param) + OI/funding/index. See ADR 0004 §6/§6a/§6b. M21: BTC and ETH index-shock legs aligned to 5-minute horizon: `STRESS_BTC_5M_SHOCK_PCT = 1.5` (BTC 1m was inert, peak 0.56%), `STRESS_ETH_5M_SHOCK_PCT = 2.5` (raised from 2.0; only event was 2.12%). Atomic `hasInvalidStressInputs` swap. See ADR 0004 §6c.*
- **ExecutionModule** — places/reduces/closes orders; idempotent; partial-fill handling.
- **PositionModule** — authoritative position state; reconciles against exchange; unrealized/realized PnL.
- **PersistenceModule** — Cross-cutting infra: NUMERIC↔decimal.js transformer, migration timeline. Domain modules own their entities/repositories (see ADR 0002).
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
                 -- intervals: 1m (metrics/views) and 5m (primary strategy candle)

tick_aggregates  id · symbol · ts(idx) · price · volume        -- sub-minute (1s/5s) data
                 -- backtest uses this to reconstruct 5-min candle + VWAP indicator state
                 UNIQUE(symbol, ts)

universe_membership id · symbol · entered_at · left_at(null)   -- point-in-time top-300
                 -- backtests replay the universe as it WAS (no survivorship bias)

funding_rates    id · symbol · funding_time(idx) · rate         -- 8-hourly historical funding
                 -- backtest replays actual funding; live PnL uses real funding events
                 UNIQUE(symbol, funding_time)

open_interest    id · symbol · ts(idx) · value                  -- OI time-series (live + backtest replay)
                 -- polled via REST GET /fapi/v1/openInterest per universe symbol
                 UNIQUE(symbol, ts)

book_snapshots   id · symbol · ts(idx) · spread · depth_10bps · depth_50bps
                 -- top-of-book + depth, persisted ONLY around decisions/open positions

strategy_versions id · name · version(int) · direction(mean_reversion|momentum|hybrid)
                 params(jsonb) · status(draft|active|archived)
                 parent_version_id(fk→self, null) · created_at

positions        id · symbol · strategy_version_id(fk) · side(short|long)
                 status(open|closed) · leverage · entry_price · qty · entry_notional
                 exit_price(null) · realized_pnl(null)
                 exit_reason(null: take_profit|stop_loss|time_stop|signal|manual|kill_switch)
                 opened_at · closed_at(null)
                 -- analysis / algo columns (captured at entry, immutable)
                 vwap_at_entry · atr_at_entry · vwap_deviation_at_entry
                 idiosyncrasy_at_entry · coin_tier · signal_score_at_entry
                 position_slot(A|B|C) · time_stop_at · slippage_model_pct
                 -- flow + liquidity context at entry (immutable)
                 open_interest_at_entry · oi_change_5m_at_entry · flow_type_at_entry
                 funding_annualized_at_entry · book_depth_10bps_at_entry · spread_at_entry_pct
                 vwap_anchor_type · symbol_universe_age_hours
                 -- lifetime instrumentation (tracked through the position's life)
                 mae_pct · mfe_pct · time_to_reversion_secs · stop_gap_pct
                 min_liquidation_distance_pct · protective_order_type(exchange_side|local_fallback)
                 mark_vs_last_max_divergence_pct
                 idx(strategy_version_id, status) · idx(symbol, status)

transactions     id · position_id(fk) · type(open|add|reduce|close|funding)
                 side · price · qty · fee · client_order_id · exchange_order_id(unique) · created_at
                 -- funding rows record periodic perpetual funding cashflows into realized PnL
                 -- client_order_id is the reconciliation/idempotency match key

decisions        id · symbol · strategy_version_id(fk) · ts
                 event_id · signal_type · market_snapshot(jsonb)
                 -- event_id = one stable id per VWAP trigger event, so v0/v1/v2/v3 are
                 --   compared on the SAME event under the same market path (M8)
                 action(open|add|reduce|close|skip) · reason · position_id(fk, null)
                 idx(strategy_version_id, ts) · idx(event_id)

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
dashboard talks to an authenticated read API. Full topology in `M15-cloud-go-live.md`
(local-soak prerequisite in `M11a-local-soak.md`; both summarised in `M11-go-live-hardening.md`).

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
| M11 | Go-live hardening (index — split into M11a + M15) | `M11-go-live-hardening.md` |
| M11a | Local soak hardening (Binance demo trading, $0 infra) | `M11a-local-soak.md` |
| M12 | Analysis MCP (phase 2, local) | `M12-analysis-mcp.md` |
| M13 | Agentic weekly loop (phase 2, local) | `M13-agentic-weekly-loop.md` |
| M14 | CI review gate (phase 2, local) | `M14-ci-review-gate.md` |
| M17 | Automated daily DB backup (local disk, 3-deep retention) | `M17-daily-db-backup.md` |
| M15 | Cloud go-live & scaling (gated by M11a soak exit criteria + M12/M13/M14) | `M15-cloud-go-live.md` |

## Cross-cutting risks

Tracked here when they cross a single milestone's scope. Each item links to the ADR or
plan that owns the resolution.

- **`positions.protective_order_type` nullability** (raised by ADR 0008 §5). M2's schema
  allows `NULL`; the always-protected invariant is much easier to enforce structurally
  with `NOT NULL DEFAULT 'local_fallback'`. **Action:** add a small migration in M5 W1
  (or W2) flipping the column, or document a code-only enforcement path. Recommendation:
  migrate.
- **ccxt 4.5.54 futures testnet auth** (memory note). Verified working with
  `options.disableFuturesSandboxWarning: true` in `CcxtBinanceExchangeClient`. Long-term
  migration to Binance demo trading before go-live (M11). M5 stays on testnet.
- **Order-policy matrix as shared truth** (ADR 0005 §1, §5; live-vs-backtest contract C5).
  Both ExecutionModule (M5) and BacktestModule (M7) import the matrix from
  `executionConsts`. A divergence is a must-fix; CI smoke (M14 phase 2) should pin the
  shared import.
- **Backtest fidelity gap when `book_snapshots` is missing** (live-vs-backtest contract
  C6, C9). M2 captures depth only around decisions; pre-M5 historical depth coverage is
  sparse. M7 falls back to tier-floor slippage and flags `low_fidelity=true`. Versions
  whose edge depends on low-fidelity trades **do not graduate to live** — operator
  policy, not engine enforcement.
- **Sizing inputs absent from params/config** (ADR 0004 Conflicts §1, carry-over from M4
  review). `riskPerTradePct`, `allocatedCapital`, daily/weekly loss limits, exposure
  caps live as operator-level config in `executionConsts`/`riskConsts`, not in
  `strategy_versions.params`. Decision pending main session if any need
  per-version-comparability.
- **`positions.status` legacy column carry-over** (ADR 0009 §1 revised post-W1).
  M6 W1 shipped the position state machine as two columns:
  `positions.state` (`PositionStateEnum`, six values, authoritative) +
  `positions.status` (`PositionStatusEnum ∈ {open, closed}`, dual-written
  deprecated alias). Drop is named as the **M7 W0 task** "drop
  `positions.status` after grace window." If M7 lands before every reader
  migrates from `status` → `state`, the drop slips forward; tracked on the
  M7 plan.
