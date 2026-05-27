# ADR 0015 — BacktestModule

**Status:** Accepted (M7 design wave)
**Numbering note:** the M7 plan referenced "ADR-0013-backtest-module.md", but `0013-position-instrumentation.md` already shipped in M6. This ADR slots into the next free index (0014 = crash-recovery is taken) and follows the existing lowercase `NNNN-title.md` convention.
**Depends on:** ADR 0002 (persistence), 0003 (strategy), 0004 (risk), 0005 (execution order policy), 0009 (position state machine), 0012 (funding & PnL).
**Related:** `docs/plans/M7-backtesting.md`, `docs/architecture/live-vs-backtest-contract.md`.

## 1. Context

The locked core invariant of this engine is: **the same strategy code runs live and in backtest** (`docs/plans/00-overview.md` — Core principle). Live, the flow is:

```
MarketData → StrategyService.evaluate → RiskGateService → ExecutionModule
              (pure, deterministic)      (port-driven)     (real ccxt)
```

Backtest must reproduce that path bit-for-bit at the strategy and gate layers, replacing only the I/O edges:
- Real exchange WS → replayed 5-min `candles` (+ `tick_aggregates` for intrabar, `book_snapshots` for depth, `funding_rates` for cashflow, `open_interest` for OI-aware logic).
- Real exchange orders → a fill simulator.
- DB-backed risk ports → in-memory adapters.
- DB writes (positions/transactions/decisions) → in-memory state, discarded at run end.

Determinism is non-negotiable: the strategy is already pure (`IStrategyInput` is fully reconstructable from closed-bar data + `nowMs = entryCandleOpenTime + CANDLE_INTERVAL_MS`), the risk gate is already port-driven, and the reservation ledger is already in-memory live (`IReservationLedgerPort` doc-comment: "Same in-memory implementation live and in backtest"). The remaining design work is the **replay harness**: how candles become events, how indicator state is reconstructed, how look-ahead is structurally impossible, and how in-memory risk-port adapters get wired without polluting the live DI graph.

## 2. Decision summary

1. The backtest **reuses live code without forking**: `StrategyService.evaluate` and `RiskGateService.evaluate` are called unchanged. Only the orchestrator boundary, the ports, and the execution sink are replaced.
2. Indicator state is reconstructed by **feeding stored bars into the existing `SymbolMarketState` / `SymbolCandleState`** classes. No parallel indicator implementation exists in `BacktestModule`.
3. The **causality guard** is a per-symbol invariant: at the moment the strategy is called for trigger event `e`, the closed-bar window contains only bars with `openTime + interval ≤ e.entryCandleOpenTime + interval`, and `nowMs` is bar-close-derived. The guard is a runtime assertion inside the BacktestOrchestrator, not a defence-in-depth wrapper on the strategy.
4. The **risk ports are in-memory** in backtest. `BacktestRunner` constructs `BacktestPositionAdapter`, `BacktestReservationLedgerAdapter`, `BacktestInstrumentAdapter`, `BacktestRiskStateAdapter` itself — **not via NestJS DI** — so the live DI graph never sees them and there is no risk of an in-memory adapter leaking into the live process. `RiskGateService` and `PositionSizer` ARE resolved from DI (they are pure orchestrating services), but they receive the in-memory ports through the per-call `IRiskGateContext`, which is already how the live path threads them (see `StrategyService.buildGateContext`).
5. **No writes** to `positions`, `transactions`, `decisions`, `account_snapshots`, `risk_state`. All replay state is in-memory and flushed into the in-memory `IBacktestReport` returned by the run.
6. The fill simulator is composed: a mandatory `TierSlippageModel` (floor), an optional `DepthAwareSlippageExtension`, a `MissedFillModel` (for limit policies), a `LatencyModel`, an `IntrabarStopSimulator` that drives stop/TP/liquidation hit decisions from `tick_aggregates`.
7. **Fees, funding, and slippage are computed by code shared with live** (M5/M6). The cost model is imported, not re-derived.
8. The entry point is **`BacktestRunnerService.run(config: IBacktestConfig): Promise<IBacktestReport>`**, exposed as a NestJS provider for M8 programmatic use AND as a NestJS standalone CLI command (`apps/engine/src/backtest/cli/RunBacktestCommand.ts`).

## 3. Module directory layout

```
apps/engine/src/backtest/
├── BacktestModule.ts                          # Nest module; exports BacktestRunnerService, registers CLI
├── cli/
│   └── RunBacktestCommand.ts                  # `pnpm engine backtest --version=N --from=YYYY-MM-DD --to=YYYY-MM-DD`
├── service/
│   ├── BacktestRunnerService.ts               # Entry point; orchestrates load → replay → aggregate
│   ├── BacktestOrchestrator.ts                # The per-event boundary; mirrors StrategyService routing
│   ├── CandleReplayDriver.ts                  # Pulls bars from CandleLoader in chronological order
│   ├── CausalityGuard.ts                      # Runtime invariant: no same-bar / future-bar leakage
│   ├── IndicatorReplayBuilder.ts              # Feeds bars into SymbolMarketState; emits IVolatilityDetectedEvent
│   ├── UniverseReplayLoader.ts                # universe_membership point-in-time resolver
│   ├── FundingReplayLoader.ts                 # funding_rates → scheduled cashflow events
│   └── MetricsComputer.ts                     # IBacktestTradeResult[] → IBacktestReport
├── adapter/
│   ├── BacktestPositionAdapter.ts             # implements IOpenPositionsPort (in-memory)
│   ├── BacktestReservationLedgerAdapter.ts    # implements IReservationLedgerPort (already in-memory live)
│   ├── BacktestInstrumentAdapter.ts           # implements IInstrumentPort (seeded snapshot)
│   ├── BacktestRiskStateAdapter.ts            # implements IRiskStatePort (in-memory map)
│   └── BacktestExecutionSink.ts               # consumes ORDER_INTENT_APPROVED_EVENT → fill simulator
├── loader/
│   ├── ICandleLoader.ts                       # interface; backtest reads candles via this seam
│   ├── DbCandleLoader.ts                      # default; reads candles + tick_aggregates + book_snapshots
│   ├── ITickAggregateLoader.ts                # sub-minute path loader for intrabar simulation
│   └── IBookSnapshotLoader.ts                 # depth lookup keyed (symbol, ts)
├── fill/
│   ├── FillSimulator.ts                       # composes the four models below
│   ├── TierSlippageModel.ts                   # mandatory floor (Tier 1/2/3 from strategy_versions.params)
│   ├── DepthAwareSlippageExtension.ts         # spread/depth/stress/adverse-selection components
│   ├── MissedFillModel.ts                     # limit-order cancel-timeout simulation
│   ├── LatencyModel.ts                        # signal-to-fill ms offset
│   └── IntrabarStopSimulator.ts               # 1s/aggTrade path for SL/TP/liquidation
├── state/
│   ├── BacktestBook.ts                        # the in-memory positions + reservations + risk_state book
│   ├── BacktestPnLLedger.ts                   # gross/fees/funding/slippage accumulators
│   └── BacktestEquityCurve.ts                 # daily mark-to-market series
├── interface/
│   ├── IBacktestRunner.ts                     # the shape BacktestRunnerService implements
│   └── (engine-internal MoneyValue-carrying shapes; the cross-boundary ones live in @bot/shared)
└── const/
    └── backtestConsts.ts                      # defaults; the cost-model imports point to executionConsts
```

`BacktestModule` lives sibling-to `RiskModule`/`ExecutionModule` and depends on `StrategyModule`, `RiskModule` (for the gate service + sizer), `CommonModule`, and `MarketDataModule` (for `SymbolMarketState` + `computeIndicatorSnapshot`). `BacktestModule` is **not imported by `AppModule` in live mode** — it is registered only when the CLI command runs or when an integration test wires it explicitly. This keeps live startup free of the in-memory adapter providers entirely.

**M12 invocation note.** The runner remains under `apps/engine/src/backtest/` after the M12 W2 adjudication (see ADR 0033 §2.5). The MCP `run_backtest` tool invokes it out-of-process via `pnpm --filter @bot/engine backtest run`, preserving the MCP↔engine address-space boundary. No file moves into `packages/analysis/` were performed.

## 4. How the replay works

### 4.1 Candle loading

`ICandleLoader` is the single seam through which the backtest reads historical bars:

```text
ICandleLoader.streamClosedBars(
  symbols: string[],
  fromMs: number,
  toMs: number
): AsyncIterable<{ symbol: string; bar: ICandle }>
```

The default `DbCandleLoader` reads `candles WHERE interval='5m' AND open_time BETWEEN ?? AND ??` in chronological order, keyset-paginated over `open_time` so memory stays flat for multi-month replays. Symbols are resolved per UTC day from `UniverseReplayLoader` (point-in-time membership), not from "everything that exists today" (no survivorship bias — M7 plan task: Point-in-time universe).

`CandleReplayDriver` merges streams into a single chronologically-ordered event tape and drives `IndicatorReplayBuilder` one bar at a time.

### 4.2 Indicator reconstruction — reuses live code

**Decision:** the backtest constructs one `SymbolMarketState` per active symbol and calls `ingestTick(close, volume, openTime + intervalMs - 1)` once per loaded bar — exactly mirroring how a live tick stream graduates into closed bars. `closeElapsedBars` is never called in backtest (the M1 wall-clock net path) because bars arrive on their kline boundary; this matches the comment on `SymbolCandleState.closeFormingIfElapsed` ("backtest never calls it").

This means:
- VWAP (session + 20-bar + 24h + event-anchored), ATR(14), ADX(14), RSI(14), Bollinger, volume ratio, sigma-deviation distance, `fiveMinMovePct` — **all computed by `computeIndicatorSnapshot` unchanged**. There is no parallel indicator implementation in `BacktestModule`. Any drift between live and backtest indicator math is structurally impossible.
- Funding rate / OI / depth are seeded from their respective tables via `SymbolMarketState.setFunding/recordOpenInterest/setDepth` at the bar boundary closest to (and not after) the bar's close time — same setters the live path uses.
- Regime label (ADX-based) is reproduced for free, satisfying the M7 "Regime labels reproduced" task.

`IndicatorReplayBuilder` emits `IVolatilityDetectedEvent` payloads on the same trigger predicate the live `MarketDataModule` uses, so the strategy sees the identical event shape it sees live.

### 4.3 The causality guard

**Invariant:** for every call to `strategy.evaluate(input)`, `input.snapshot.closedBarOpenTimeMs === input.event.entryCandleOpenTime`, and the underlying `SymbolMarketState.candles5m.getClosedBars()` contains no bar whose `openTimeMs > input.event.entryCandleOpenTime`.

`CausalityGuard.assertPreEvaluate(symbolState, event)` runs in debug builds and in every M7 test; in release builds the check is retained as a cheap last-bar-openTime equality. This is a structural invariant — `SymbolCandleState`'s forming/closed separation already enforces no-look-ahead at the data layer; the guard makes the property auditable and produces a labelled failure if the replay driver accidentally feeds a same-bar or future-bar update before evaluation. **Entry fills are stamped at `nextBar.openTimeMs + latencyMs`, never at the signal bar's close or extreme** (M7 plan task: Causality / look-ahead guard).

### 4.4 Point-in-time universe

`UniverseReplayLoader.symbolsActiveOn(utcDate: string): Promise<Array<{ symbol: string; tier: CoinTierEnum }>>` reads from `universe_membership` with the standard `entered_at <= date AND (left_at IS NULL OR left_at > date)` predicate. Symbols delisted within the replay window remain in the tape for their valid sub-range; the loader fails closed if `universe_membership` has gaps in the requested range (operator-flagged data quality, not a silent skip).

### 4.5 In-memory port adapters

The four risk ports are reimplemented in `apps/engine/src/backtest/adapter/`:

- **`BacktestPositionAdapter` implements `IOpenPositionsPort`** — backed by a `Map<symbol, IBacktestPosition>` inside `BacktestBook`. `findOpen` snapshots the map; `findClosedOnUtcDay` / `findLastCloseForSymbol` read from the closed-position log; `countOpenedOnUtcDayForSymbol` counts entries in the open log.
- **`BacktestReservationLedgerAdapter` implements `IReservationLedgerPort`** — already in-memory live (`ReservationLedger` is just a `Map`); the backtest adapter is essentially the same class with a separate instance per run. To avoid divergence we will reuse the live `ReservationLedger` class verbatim and only re-construct it inside `BacktestBook`.
- **`BacktestInstrumentAdapter` implements `IInstrumentPort`** — seeded once at run start from the `instruments` table snapshot at `toUtcDate`. Maintenance margin rate, tick size, step size, min notional carried through.
- **`BacktestRiskStateAdapter` implements `IRiskStatePort`** — backed by an in-memory `Map<utcDate, IRiskStateDay>`. `upsertDay` updates the map; `sumRealizedPnlBetween` iterates the map's date range; daily/weekly loss limits engage exactly as live.

These adapters are **instantiated by `BacktestRunnerService.run` in plain TypeScript** (`new BacktestPositionAdapter(book)` etc.) and passed into `IRiskGateContext`. They are deliberately not Nest providers — there is no `@Injectable()` decorator and no module-level binding. This guarantees:
1. The live `RiskModule` continues to bind `OpenPositionsPortAdapter` etc. as the only providers for those tokens.
2. A future engineer cannot accidentally make a backtest adapter the live binding.
3. Each `BacktestRunnerService.run` call gets a fresh book — runs are isolated.

`RiskGateService` and `PositionSizer` ARE DI-resolved (they are pure orchestrating services). They receive the in-memory ports per-call through `IRiskGateContext.openPositions / instruments / riskState`, just as the live path does. **The gate's decision logic is byte-identical between live and backtest.**

### 4.6 Fill simulator

```
FillSimulator.simulate(intent, context):
  1. LatencyModel:        signal-to-fill offset → tFill = nextBarOpenMs + latencyMs
  2. MissedFillModel:     if orderPolicy ∈ {limit_*} and intrabar path never touched the limit
                          price within cancel timeout → return MISSED (qty=0, no PnL)
  3. TierSlippageModel:   base slippage = strategy_versions.params.slippage_tier{1,2,3}_pct
                          in the adverse direction for the side
  4. DepthAwareSlippageExtension (when enabled AND book_snapshots row exists for tFill):
                          slippage = base_tier
                                   + spread_component
                                   + volatility_component
                                   + depth_component
                                   + market_stress_component
                                   + adverse_selection_component
                          else: depthAware=false → mark trade lowFidelity=true on result
  5. Final fill price = referencePrice * (1 ± slippage_pct)
                        NEVER at the signal bar's high/low extreme (causality guard already
                        enforces this — entry references next-bar open, not signal-bar close).
```

`IntrabarStopSimulator` handles exit-side fills. Given an open position, it iterates `tick_aggregates` between `openedAtMs` and the next 5-min bar close (or until SL/TP/time-stop fires, whichever first):
- Hits SL when intrabar path crosses `stopLoss` (mark-price proxy = trade price; consistent with M6 mark-vs-last gating because real L2 mark isn't available historically).
- Hits TP when path crosses `takeProfit`.
- Hits time-stop when `tsMs >= timeStopAtMs`.
- Hits liquidation when path crosses the maintenance-margin-derived liquidation price (same formula as M5 `PositionSizer` uses for the SL-inside-liquidation clamp).
- If no tick_aggregates rows exist for the bar (sparse pre-M2 history), the simulator falls back to bar-extreme heuristics and flags the trade `lowFidelity=true`.

### 4.7 Shared cost model

Fees, funding, and PnL identities are **imported from the execution/position modules**, not re-derived:
- **Taker / maker fee bps:** read from `strategy_versions.params` (the same source the live order-policy router uses; ADR 0005). The `FillSimulator` looks up the maker-vs-taker resolution by mapping the intent's `flowType` + intent action through the live order-policy matrix (`executionConsts`). Cross-cutting risk C5 in `00-overview.md` calls this out as a must-fix on divergence; the CI smoke (M14) will pin the shared import.
- **Funding:** `FundingReplayLoader` reads `funding_rates` rows for the replay window and emits scheduled cashflow events at each `funding_time` for every position open at that instant. The cashflow calculation is the live `PositionService` `applyFunding(position, rate)` method — imported, not re-implemented (ADR 0012).
- **PnL identity:** `netPnl = grossPnl - fees - |fundingPaid| - slippageCost`, the same identity live M6 records on close.

**Fidelity disclosure:** when `book_snapshots` rows are missing for a trigger window, the run flags `lowFidelity=true` on each affected trade and the report's `lowFidelityTradeCount` aggregates them. Per the M7 plan: "if historical L2 depth is unavailable, the backtest can only REJECT bad strategies, not PROVE live fill quality." The operator policy (not engine-enforced) is that versions whose edge depends on low-fidelity trades do not graduate to live.

### 4.8 Metrics computer

Input: the closed `IBacktestTradeResult[]` stream plus the daily mark-to-market equity curve `IBacktestEquityPoint[]`.

Output: `IBacktestReport` with the pinned definitions from `docs/plans/M7-backtesting.md` task "Metrics with pinned definitions":
- All trade-level metrics computed on **net PnL** (after fees + funding + slippage).
- Win rate, profit factor, trade count, avg hold time, regime / flow / symbol breakdown.
- **Max drawdown = peak-to-trough on the daily mark-to-market equity curve, expressed as %**, plus drawdown duration in days.
- **Sharpe and Sortino on daily-resampled equity returns, annualized with `√365`** (crypto trades 24/7/365). Sortino MAR target = 0.
- Per-trade `returnPct` series emitted for downstream M8 same-event comparison.

### 4.9 The entry point

```
BacktestRunnerService.run(config: IBacktestConfig): Promise<IBacktestReport>
```

Wired two ways:
1. **NestJS provider** — `BacktestRunnerService` is injectable, callable from M8 comparison harness.
2. **CLI command** — `apps/engine/src/backtest/cli/RunBacktestCommand.ts` parses `--version`, `--from`, `--to`, `--capital`, `--latency`, `--depth-aware`, `--run-label`, builds an `IBacktestConfig`, bootstraps a minimal Nest application context (no live ExchangeModule, no live MarketDataModule WS subscription), calls `BacktestRunnerService.run`, and writes the `IBacktestReport` to stdout / a JSON file.

## 5. Live-vs-backtest equivalence claim

Surface-by-surface:

| Concern | Live | Backtest |
|---|---|---|
| Strategy evaluation | `StrategyService.evaluate(input)` | same call, same code, same `IStrategyInput` |
| Indicator math | `computeIndicatorSnapshot` via `SymbolMarketState` | same call, same state class |
| `nowMs` | `entryCandleOpenTime + CANDLE_INTERVAL_MS` | identical |
| Risk gate | `RiskGateService.evaluate(intent, context)` | same call, same code |
| Reservation ledger | `ReservationLedger` (in-memory `Map`) | same class, fresh instance |
| Position state read | `OpenPositionsPortAdapter` (TypeORM) | `BacktestPositionAdapter` (in-memory `Map`) |
| Instrument metadata | `InstrumentPortAdapter` (TypeORM) | `BacktestInstrumentAdapter` (seeded snapshot) |
| Risk state | `RiskStatePortAdapter` (TypeORM) | `BacktestRiskStateAdapter` (in-memory `Map`) |
| Order policy / fees | `executionConsts` matrix | same import |
| Funding cashflow | `PositionService.applyFunding` (ADR 0012) | same function, fed by replayed `funding_rates` |
| Execution | ccxt order placement | `FillSimulator` |
| Persistence | TypeORM writes | nothing — in-memory book only |

The only surfaces with distinct code paths are: (a) port adapters; (b) execution; (c) persistence. None of those carry decision logic.

## 6. Consequences

**Positive**
- Strategy and gate code cannot drift between live and backtest — they are the same code path.
- The in-memory ports cannot leak into the live DI graph because they are not Nest providers.
- Indicator reconstruction is free (re-uses `SymbolMarketState`) so the indicator-parity test from M7 ("a known intra-session spike triggers identically in replay and live") is straightforward.
- Fidelity gap is explicit (`lowFidelity` flag, `lowFidelityTradeCount` in report) rather than silent.

**Negative**
- `BacktestModule` is tightly coupled to `MarketDataModule` (uses `SymbolMarketState` directly). A future refactor of state internals must consider both call sites.
- The fill simulator's depth-aware path is only as good as the `book_snapshots` history, which is sparse pre-M5 (cross-cutting risk C6 in `00-overview.md`). The mitigation is the explicit fidelity flag, not better data.
- Funding replay requires every `funding_rates` row in the window; a gap is a hard run-failure (operator-visible), not a silent skip.
- The CLI bootstraps a Nest context; cold start cost is paid per run. For M8's many-version comparison the bootstrap is shared across runs (one context, many `run(config)` calls).

## 7. Alternatives considered

1. **Fork the strategy interface and run a backtest-specific path.** Rejected — directly violates the core invariant. The entire reason `IStrategyInput` is structured the way it is (closed-bar inputs only, injected `nowMs`) is so this fork is unnecessary.
2. **Re-implement indicators inside `BacktestModule` for a "performance win".** Rejected — the live indicator pipeline is already O(n) per bar and operates on small windows (`CLOSED_BAR_WINDOW_SIZE`); the only "win" would be a guaranteed drift bug.
3. **Wire the in-memory adapters as Nest providers, swapped by an env flag.** Rejected — a flag-driven binding is one merge accident away from putting an in-memory position store in front of live order routing. Instantiating the adapters as plain objects inside `BacktestRunnerService.run` makes the swap structurally impossible at the DI layer.
4. **Persist backtest decisions/positions to the real tables under a `is_backtest=true` flag.** Rejected for M7 — would couple replay throughput to DB write capacity, would pollute the live analytics queries every reader currently writes, and would force every existing repository to grow an `is_backtest` predicate. M8's comparison harness can persist a per-run report row separately if/when needed; the per-trade detail in `IBacktestReport.trades` is sufficient for now.
5. **Use synthetic 5-min bars constructed from `tick_aggregates` instead of stored `candles`.** Rejected — the live path consumes graduated bars from `SymbolCandleState`, and the stored `candles` rows are exactly those graduated bars. Reconstructing from ticks would (a) be slower and (b) introduce a reconstruction step that has no live analogue. `tick_aggregates` is used only for **intrabar** stop/TP simulation, which is where it adds fidelity.
6. **Random-sample slippage from a per-tier distribution.** Rejected — the strategy is required to be deterministic, and a randomised fill simulator would break the "repeated runs return identical metrics" property in the M7 Definition of Done. Tier slippage is a deterministic function of (tier, side, params); depth-aware extension is a deterministic function of the persisted `book_snapshots` row.

## 8. Out of scope (deferred / handled elsewhere)

- **Same-event multi-version simulation** (M7 plan task) — composes `BacktestRunnerService.run` over `{v0, v1, v2, v3}` for the same `event_id`-keyed tape; handled by the M8 comparison harness, not by `BacktestModule` directly.
- **Stress-period test set / robustness gates** — operator-curated configs (lists of `IBacktestConfig`); enforced as test fixtures, not engine logic.
- **The `positions.status` drop migration** (M7 W0 carry-over) — schema work, not architecture.
