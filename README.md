# Trade Bot — Crypto Volatility-Tracking Trading Bot

A conservative, risk-first crypto trading bot that tracks VWAP deviations on Binance USDT-M Futures. The engine uses direction-agnostic event detection, empirically validated signal routing, and a central risk gate to enforce position limits and safeguards. All decisions are persisted for strategy comparison and continuous improvement.

**Key principle:** Profit is an outcome of edge, not a target. The bot is judged on avoiding bad trades, not on trade frequency.

## Philosophy

- **Conservative survival first** — $500–$1,000 starting capital, 1 position minimum, tier-1 symbols only, isolated margin, no daily profit target.
- **Deterministic, reproducible** — strategies are pure; the same code runs live and in backtests.
- **Empirically validated** — direction decided by out-of-sample evidence, not assumptions.
- **No-bypass architecture** — all orders route through a central risk gate; strategies cannot execute directly.

## Monorepo Structure

```
trade-bot-volatility-tracking/
├── apps/
│   ├── engine/                    # NestJS trading engine
│   │   ├── src/
│   │   │   ├── strategy/          # v0–v3 versioned strategies
│   │   │   ├── risk/              # Risk gate (sizing, limits, halts)
│   │   │   ├── execution/         # Order execution + fills
│   │   │   ├── position/          # Position state machine
│   │   │   ├── market-data/       # VWAP, candles, market context
│   │   │   ├── backtest/          # Replay engine + metrics
│   │   │   ├── persistence/       # TypeORM, migrations, repos
│   │   │   ├── exchange/          # ccxt Binance wrapper
│   │   │   ├── alert/             # Telegram notifications
│   │   │   ├── control/           # Kill switch + halt API
│   │   │   ├── read-api/          # Read-only operator API
│   │   │   ├── ws/                # WebSocket gateway
│   │   │   └── common/            # Shared services (config, decimal, logging)
│   │   └── tests/
│   └── dashboard/                 # React monitoring UI (M10, Vite + React 19)
├── packages/
│   └── shared/                    # Shared enums, types, schemas
├── docs/
│   ├── plans/                     # Milestone breakdowns
│   ├── architecture/              # ADRs, data model, modules
│   ├── best-practices/            # Code conventions, testing, dev-qa cycle
│   └── work-log.md                # Execution history
├── docker-compose.yml
├── pnpm-workspace.yaml
├── CLAUDE.md                      # Internal team guidance
└── package.json
```

## Prerequisites

- **Node.js** >= 22.x
- **pnpm** >= 9.15.9 (see `packageManager` in `package.json`)
- **Docker** + **Docker Compose** (for Postgres, optional local setup)
- **Postgres** >= 14 (database for persistence)

## Local Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd trade-bot-volatility-tracking
pnpm install
```

### 2. Set up environment variables

Copy the example file and adjust:

```bash
cp .env.example .env
```

Key variables:
- `EXECUTION_MODE=dry-run` — test mode, no exchange orders
- `EXECUTION_MODE=live` — real trades on testnet/live (requires Binance keys)
- `ACTIVE_STRATEGY_VERSION_ID=v1` — which strategy to run (v0, v1, v2, v3)
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — Postgres connection
- `BINANCE_API_KEY`, `BINANCE_API_SECRET` — exchange credentials (never commit)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional, for alerts

### 3. Start Postgres

Using Docker Compose (simplest):

```bash
docker compose up -d postgres
```

This starts Postgres on `localhost:5432` and Adminer (web UI) on `localhost:8080`.

Alternatively, connect to an existing Postgres instance and update `DB_HOST`, etc.

### 4. Run migrations

```bash
pnpm --filter @bot/engine run migration:run
```

### 5. Start the engine

Development (watch mode):

```bash
pnpm --filter @bot/engine run dev
```

Production build + run:

```bash
pnpm build
pnpm --filter @bot/engine start
```

The engine starts, connects to Binance, subscribes to WebSocket ticker feeds, and begins aggregating candles and computing signals.

Check `/health` endpoint:

```bash
curl http://localhost:3000/health
```

## Running Modes

### Testnet (ccxt Binance sandbox)

```bash
EXECUTION_MODE=dry-run pnpm --filter @bot/engine dev
```

- Reads live Binance market data
- Evaluates signals (no risk/execution gates)
- Simulated fills for backtests only

### Live Testnet Orders

```bash
EXECUTION_MODE=live \
  BINANCE_TESTNET=true \
  pnpm --filter @bot/engine dev
```

- Uses Binance testnet futures endpoint
- Actual position management, real fills
- No capital at risk

### Live Production (restricted)

```bash
EXECUTION_MODE=live \
  BINANCE_TESTNET=false \
  BINANCE_API_KEY=<key> \
  BINANCE_API_SECRET=<secret> \
  pnpm --filter @bot/engine start
```

- Real money, real positions
- Restricted: 1 position, tier-1 symbols, $500–$1,000 capital, isolated margin
- Logs all decisions to Postgres for audit

## CLI Commands

Strategy comparison and promotion (after backtesting):

```bash
pnpm --filter @bot/engine run strategy compare \
  --v1 <version1> --v2 <version2> \
  --test-range 2025-01-01 2025-03-31
```

Backtest a strategy version:

```bash
pnpm --filter @bot/engine run strategy backtest \
  --version v2 \
  --test-range 2025-01-01 2025-03-31
```

Check operator auth tokens:

```bash
pnpm --filter @bot/engine run auth issue --role operator
pnpm --filter @bot/engine run auth revoke --jti <jti>
```

## Running Tests

Unit + integration tests (uses in-memory SQLite or Docker Postgres):

```bash
pnpm test
```

Engine tests only:

```bash
pnpm --filter @bot/engine test
```

Shared package tests:

```bash
pnpm --filter @bot/shared test
```

Watch mode:

```bash
pnpm --filter @bot/engine test -- --watch
```

## Project Status

**Completed Milestones (M0–M10):**

- **M0 — Foundation & scaffolding:** pnpm + Docker + NestJS 11 + TypeORM + event bus + halt-flag + money helpers.
- **M1 — Exchange & market data:** ccxt/Binance testnet, MarketDataModule, VWAP-deviation trigger, 251 tests, zero blockers.
- **M2 — Persistence & data model:** 13 domain-owned entities, 353 tests, reversible migrations, 90-day partitioned tick_aggregates, zero blockers.
- **M3 — Strategy engine:** 4 pure strategies v0–v3, registry + config-selected active version, orchestrator stamps event_id/flow_type/signal_score, 202 tests, zero blockers.
- **M4 — Risk management:** Bypass-proof risk gate, 3-slot position model, daily/weekly loss windows, market-stress halt, 700 tests, zero blockers.
- **M5 — Execution (testnet):** IdempotentExecutionModule, marketable-limit-IOC, post-only-maker, partial-fill handling, 898 tests, zero blockers.
- **M5.5 — Adversarial backfill:** 172 adversarial tests, 2 production bugs fixed, zero blockers, dev-qa-cycle validated.
- **M6 — Position management & reconciliation:** 8 implementation waves, state machine + reconciliation, crash recovery, funding/PnL, 851 focused tests, zero blockers.
- **M7 — Backtesting & performance:** Replay engine, fill simulator, Sharpe/Sortino/drawdown metrics, 82 new tests, zero blockers.
- **M8 — Strategy versioning & comparison:** Walk-forward OOS splits, paired circular-block bootstrap (n=10k, 95% CI), 12-criterion promotion gate, CLI suite, 264 focused tests, zero blockers.
- **M9 — Observability & control:** Startup schema validation, auth guard HS256 + revoked_jti, HaltController + audit, ReadApi REST, socket.io gateway, TelegramAlertSink, 1,967 tests passing, zero blockers.
- **M10 — Dashboard:** Vite + React 19 + TanStack Query, login endpoint (bootstrap-secret), read views + real-time WS, kill-switch UI, containerisation + nginx, 2,289 tests passing, zero blockers.

**Current (M11+):**

- **M11 — Go-live hardening:** Binance demo trading migration, auth rotation, multi-instance scaling, external reverse-proxy, full topology validation.
- M12 — Analysis MCP (read-only agentic analysis)
- M13 — Agentic weekly loop (strategy proposal + backtest feedback)
- M14 — CI review gate (automated checks)

See `docs/plans/` for detailed breakdowns per milestone.

## Trading-Safety Invariants

These rules are non-negotiable and enforced by architecture:

1. **No order path bypasses the risk gate.** Strategies never call the exchange API directly; all orders route through `RiskGateService`.
2. **Strategies are pure and deterministic** — no `Date.now()`, `Math.random()`, or I/O; live and backtest behavior is identical.
3. **No LLM in the live trade loop** — outer-loop proposals only; LLM suggests code improvements, never executes.
4. **Money is always `decimal`, never float** — prices, fees, PnL use `decimal.js`.
5. **Exchange keys never committed** — use environment variables, rotate regularly.
6. **Testnet first, then live at minimal size** — live starts at $500–$1,000, 1 position, tier-1 symbols only, isolated margin.
7. **VWAP trigger is a detector, not a direction** — flow classification empirically determines fade/follow/skip per regime.
8. **No daily profit target** — `skip` is a first-class, high-value output; most triggers should resolve to `skip`.
9. **Live caps are restricted** — $500–$1,000 capital, 1 position, tier-1 only, isolated margin; relax only after weeks of live edge matching backtest.

## Key Concepts

### Strategies

- **v0 — No-Trade Baseline:** Logs every VWAP trigger, never trades. Baseline for decision audit.
- **v1 — Exhaustion-Confirmed Mean Reversion:** Fade spike if preceding exhaustion confirmed; regime gate blocks in trending markets.
- **v2 — Momentum:** Follow spike; skip in range-bound regimes.
- **v3 — Flow-Classifying Hybrid Router:** Flow context (OI, funding, aggressor imbalance) determines fade vs follow vs skip (end-state target).

Active strategy selected via `ACTIVE_STRATEGY_VERSION_ID` env var; only v1 is approved for initial live deployment.

### Risk Gate

Central enforcer of position sizing, daily/weekly loss limits, market-stress halts, consecutive-loss backoffs, liquidity/funding/spread filters, and slot allocation (max 3: A+B for idiosyncratic, C for BTC-correlated single-position).

All order intents pass through `RiskGateService.evaluate()` before execution.

### Position State Machine

Positions flow through: `PENDING_OPEN` → `OPEN` → `CLOSING` → `CLOSED`. Reconciliation handles exchange/engine divergence and positions survive restarts.

### Backtesting

`BacktestRunnerService` replays stored 5-minute candles through the strategy with fill simulation:
- Tier-based slippage (maker-friendly vs aggressive)
- Latency and missed-fill models
- Intra-bar stop loss enforcement
- Funding replay
- Sharpe/Sortino/drawdown + regime breakdown

Strategies are deterministic, so backtest results reproduce live behavior given the same market data.

### Strategy Comparison

Walk-forward out-of-sample (OOS) splits + paired circular-block bootstrap (n=10,000, 95% CI) enable data-backed decisions on which strategy version to promote to live. ADR-0019 specifies the 12-criterion gate.

## Documentation

- **`docs/plans/00-overview.md`** — locked design decisions, core principles, architecture diagram, data model
- **`docs/plans/M*-*.md`** — milestone-by-milestone execution plans and outcomes
- **`docs/architecture/`** — module architecture, ADRs (Architectural Decision Records), schema diagram
- **`docs/best-practices/code-conventions.md`** — authoritative code style and module ownership (read before engine work)
- **`docs/best-practices/dev-qa-cycle.md`** — QA workflow and wave dispatch rules (read before any fix/QA task)
- **`docs/best-practices/testing.md`** — testing patterns and coverage expectations
- **`CLAUDE.md`** — internal team guidance on monorepo structure and hard rules

## Observability

- **Logs:** Structured JSON via Pino (stdout, alertable)
- **Postgres:** All decisions, positions, transactions, and account snapshots
- **Telegram (M9):** Real-time alerts on signal detection, position open/close, losses, halts, kill-switch
- **WebSocket/SSE (M9–M10):** Real-time live gateway (position updates, PnL ticks, decisions, halt state)
- **Dashboard (M10):** Vite + React SPA, authenticated (HS256 bearer), real-time positions + decisions + performance, kill-switch UI
- **Health check:** `GET /health` → liveness probe

## Deployment

The engine and dashboard are containerized and designed to run as an always-on stack. Recommended topology:

1. **Postgres:** Cloud-managed (AWS RDS, Google Cloud SQL) or self-hosted
2. **Engine:** Single container (no scale-to-zero), auto-restart on failure
3. **Dashboard:** Separate nginx-served React SPA, same docker-compose or CDN-deployed
4. **Authentication:** HS256 bearer tokens issued via `/v1/auth/login` (bootstrap-secret) or CLI (`pnpm engine auth issue`)

See `docs/plans/M11-go-live-hardening.md` for full topology and rollout plan (Binance demo trading, external reverse-proxy, multi-instance scaling).

## Troubleshooting

**Engine fails to start with "relation 'candles' does not exist"**

Migrations may not have run. Check Postgres:

```bash
pnpm --filter @bot/engine run migration:run
```

**Binance testnet auth fails**

Verify `BINANCE_API_KEY` and `BINANCE_API_SECRET` are set. Testnet credentials are separate from live. Check ccxt log output for details.

**Positions not persisting**

Ensure Postgres is running and `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` are correct. Check engine logs for persistence errors.

**Strategy evaluates but no orders placed**

Check `EXECUTION_MODE`:
- `dry-run` — signals only, no orders
- `live` — requires `BINANCE_TESTNET=true` (testnet) or live credentials + `BINANCE_TESTNET=false`

Review risk gate output in logs (`RiskGateService.evaluate()`) to see why orders were rejected (daily/weekly loss limit, consecutive-loss halt, etc.).

## Contributing

Follow the monorepo workflow in `CLAUDE.md` and `docs/best-practices/code-conventions.md`:

1. Create a feature branch
2. Implement changes in minimal, focused commits
3. Run tests: `pnpm test`
4. Lint: `pnpm lint:fix`
5. Submit PR with risk assessment and backtest results for strategy changes

## License

Proprietary. See LICENSE file.
