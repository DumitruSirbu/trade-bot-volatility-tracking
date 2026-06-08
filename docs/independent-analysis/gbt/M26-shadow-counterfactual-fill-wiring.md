# Independent Review - M26 Shadow Counterfactual Fill Wiring

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/M26-shadow-counterfactual-fill-wiring.md`  
**Date:** 2026-06-08

## Verdict

I approve M26's direction. The diagnosis is correct: shadow opens are routed through
`HistoricalFillAdapter`, but with `barHigh=entryPrice`, `barLow=entryPrice`, and `ticks=[]`, so every
limit-policy open is missed before the virtual ledger can open a position. Loading persisted
`tick_aggregates` is the right class of fix, and keeping this separate from M24/M25 is architecturally
clean.

I would not dispatch M26 as written. The plan's core idea is sound, but two contracts are still
ambiguous: which bar's ticks/price are the fill evidence, and where "missing tick data" is represented
in the existing shadow fill JSON. M7's backtest path does not simply "use the signal bar" in the way
M26 currently describes: it uses signal-bar ticks for the miss detector, but the entry reference is the
next bar open and the fill timestamp is next-bar-open + latency. M26 must choose whether shadow should
mirror M7 exactly or intentionally keep the current signal-close reference price. That choice affects
counterfactual validity.

## Must-Fix Before Dispatch

### H1 - Lock the shadow fill timing contract: M7 next-bar entry vs current shadow signal-bar entry

The plan says M26 should load `tick_aggregates` for `(symbol, entryCandleOpenTime)` and pass real
signal-bar evidence into `simulateShadowFill`. That fixes the empty-tick miss, but it does not make
shadow equivalent to M7 by itself.

M7 explicitly moved entry pricing to the next bar open:

```195:203:apps/engine/src/backtest/service/BacktestOrchestrator.ts
        // M7 R1a fix-3 (quant, ADR-0015 §6): the entry fills at the next bar's open. The
        // signal-bar VWAP×(1+dev%) figure was a reference price at signal close — using it
        // as the fill price is forward-look. When the signal bar is the last replay bar
        // for the symbol, no next bar exists and the orchestrator cannot construct a fill.
        if (ctx.nextBarOpen === null) {
            return null;
        }

        const entryPrice = ctx.nextBarOpen;
```

And M7's fill request uses that next-bar-derived intent:

```331:348:apps/engine/src/backtest/service/BacktestOrchestrator.ts
        return {
            eventId: event.eventId,
            symbol: event.symbol,
            side,
            intent: 'open',
            policy,
            limitPrice: intent.midAtTrigger,
            qty: decision.approvedSizing.qty,
            coinTier: event.coinTier,
            signalBarOpenMs: event.entryCandleOpenTime,
            // ...
            ticks: ctx.ticks,
            bookSnapshot: ctx.bookSnapshot,
```

Current shadow sizing/fill uses the reconstructed signal-bar reference price:

```227:248:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
        if (shouldSimulateFill && signal.tradeSide !== null && signal.proposedExit !== null) {
            const stopLossStr = signal.proposedExit.stopLossPrice.toFixed();
            const takeProfitStr = signal.proposedExit.takeProfitPrice.toFixed();
            const entryPriceStr = reconstructReferencePrice(stampedEvent).toFixed();
            // ...
                const qtyForLedger = this.deriveShadowQty(shadow, entryPriceStr, stopLossStr);
                const simulatedFill = this.simulateShadowFill(shadow, stampedEvent, signal.tradeSide, entryPriceStr, qtyForLedger);
```

Required plan change:

- State explicitly whether M26 aims for **M7 parity** or a distinct **live shadow at signal-close**
  model.
- If M7 parity is the goal, M26 must load or derive the next bar open and use it consistently for
  `entryPriceStr`, sizing, `limitPrice`, and fill timestamp assumptions. If no next bar/open is
  available, the shadow open should be declined/missing-data tagged, mirroring backtest's no-future-bar
  behavior.
- If signal-close shadow is intentional, remove "same source and shape M7 consumes" / "identical to
  backtest" language and document the known comparison gap. Otherwise shadow PnL and M7 PnL will be
  attributed to the same `event_id` while using different entry references.
- Add tests that pin the chosen contract: signal bar with next bar open available; final/no-next-bar
  case; and a case where signal-close reference and next-bar open materially differ.

Without this, M26 may produce virtual PnL, but it will not be clear whether that PnL is comparable to
M7 or to live paper.

### H2 - The tick window must match the fill timestamp, or misses are still temporally inconsistent

`HistoricalFillAdapter` converts `request.ticks` to shared tick snapshots and then calls the shared
core with `signalBarOpenMs`:

```63:81:apps/engine/src/backtest/fill/HistoricalFillAdapter.ts
    simulateFill(request: IFillRequest): IBacktestFill {
        const intentDto = this.buildIntent(request);
        const snapshot = this.buildSnapshotForFill(request);
        const seed = this.buildSeed();
        const tickSnapshots = this.toTickSnapshots(request.ticks);
        const orderTimeoutMs = this.resolveOrderTimeoutMs(request.policy);

        const result: ISimulatedFillCore = sharedApplyFill(
            snapshot,
            intentDto,
            request.coinTier,
            request.tierSlippageParams,
            seed,
            tickSnapshots,
            request.signalBarOpenMs,
            orderTimeoutMs,
            request.config.latencyMs,
        );
```

The shared core returns a fill timestamp at `signalBarOpenMs + 5m + latencyMs`:

```148:151:packages/shared/src/util/fillSimulatorCore.ts
    const CANDLE_5M_INTERVAL_MS = 5 * 60 * 1000;
    const nextBarOpenMs = signalBarOpenMs + CANDLE_5M_INTERVAL_MS;
    return nextBarOpenMs + latencyMs;
```

But `isMissedFill` filters ticks within `[signalBarOpenMs, signalBarOpenMs + orderTimeoutMs]`, not
the next-bar open window. That is existing M7 behavior, so M26 can choose to mirror it, but the plan
should not pretend this is simply "signal bar evidence for an order at order time." It is a specific
backtest contract.

Required plan change:

- Document which time interval is loaded into `ticks`:
  - existing M7 parity: load signal-bar ticks and accept the existing miss-detector window;
  - corrected event-time model: load next-bar-open ticks and adjust `signalBarOpenMs`/adapter behavior
    accordingly, which is a broader shared/backtest contract change.
- Add a reviewer/quant checkpoint specifically on this timing contract. The current plan's "same-tape
  parity" test is too vague.

My recommendation for M26: mirror M7 exactly for now, because changing the miss-detector timing would
be a larger ADR 0015/M7 contract change. But the plan should name that as intentional technical debt,
not hide it behind "real bar evidence" wording.

### H3 - Missing-data "tagging" is not representable in the current `ISimulatedFill` contract

M26 says absent ticks should stay missed and be tagged as missing-data/lowFidelity. The current shadow
fill JSON shape has no `missedReason`, `dataQuality`, or `missingData` field:

```5:22:packages/shared/src/interface/ISimulatedFill.ts
export interface ISimulatedFill {
    readonly entryPrice: string; // decimal
    readonly exitPrice: string | null; // null until close
    readonly slippageEntryPct: string; // decimal, signed
    readonly slippageExitPct: string | null;
    readonly slippageComponents: {
        readonly tierBase: string;
        readonly latency: string;
        readonly crossingSpread: string;
    };
    readonly missed: boolean; // true if simulator skipped the fill
    readonly forceClose: boolean; // true if closed by end-of-window rule
    readonly lowFidelity: boolean; // mirrors M7 IBacktestReport
    readonly closedAt: string | null; // ISO timestamp of simulated close
    readonly closeReason: 'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | null;
    readonly feeUsdtEntry?: string | null; // Entry-leg taker fee in USDT (decimal string). Null until depth-aware fill simulator populates it.
    readonly feeUsdtExit?: string | null; // Exit-leg taker fee in USDT (decimal string). Null until the close-side simulator is wired.
}
```

The Zod schema is similarly closed over that shape:

```7:24:packages/shared/src/schema/simulatedFillSchema.ts
export const simulatedFillSchema = z.object({
    entryPrice: z.string().trim().min(1, 'entryPrice cannot be empty'),
    exitPrice: z.string().trim().min(1).nullable(),
    slippageEntryPct: z.string().trim().min(1, 'slippageEntryPct cannot be empty'),
    slippageExitPct: z.string().trim().min(1).nullable(),
    slippageComponents: z.object({
        tierBase: z.string().trim().min(1, 'tierBase cannot be empty'),
        latency: z.string().trim().min(1, 'latency cannot be empty'),
        crossingSpread: z.string().trim().min(1, 'crossingSpread cannot be empty'),
    }),
    missed: z.boolean(),
    forceClose: z.boolean(),
    lowFidelity: z.boolean(),
    closedAt: z.string().trim().min(1).datetime().nullable(),
    closeReason: z.enum(['sl', 'tp', 'force_close', 'intra_bar_stop']).nullable(),
```

Required plan change:

- Pick one:
  - **Shared-contract option:** add `missedReason` or `dataQuality` to `ISimulatedFill` and
    `simulatedFillSchema` via `bot-shared-maintainer`, then update engine/read consumers.
  - **Engine-only option:** do not change the JSON contract; encode missing tick evidence outside
    `simulated_fill`, for example by setting `simulated_fill=null` with a `reject_reason`/new shadow
    reason if a suitable existing column can represent it, or by logging only and deferring durable
    tagging to M27.
- Update dispatch waves. If the shared-contract option is chosen, M26 is no longer engine-only.
- Add tests proving analysis can distinguish no-data misses from price-not-touched misses using the
  chosen representation.

As written, the plan promises a data-analysis feature that the current schema cannot store.

### H4 - One DB SELECT per shadow version per event can multiply load and create inconsistent reads

`runShadows` loops over every shadow version and `runOneShadow` would load the same symbol/bar ticks
for each shadow if the implementation follows the current plan literally:

```142:150:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
    async runShadows(event: IVolatilityDetectedEvent, nowMs: number): Promise<void> {
        for (const shadow of this.shadows) {
            try {
                await this.runOneShadow(shadow, event, nowMs);
            } catch (cause) {
```

That is wasteful and creates an unnecessary determinism surface if data lands late between shadow
versions. M7 explicitly loads ticks once per bar and threads them through:

```415:420:apps/engine/src/backtest/service/BacktestRunnerService.ts
        // Load ticks once per bar and thread through the exit + dispatch paths. Loading
        // multiple times within the same bar is both a perf cost and a determinism risk
        // (a single ORDER BY ts ASC traversal is the reference order).
        const ticks = await this.candleLoader.loadTicksForBar(ctx.symbol, bar.openTimeMs);
```

Required plan change:

- Load the tick evidence once per event in `runShadows`, then pass an immutable evidence object into
  each `runOneShadow` call.
- Add a test with multiple resolved shadows asserting the repository is called once per event, not once
  per shadow version.
- If missing-data tagging is emitted, ensure every shadow version sees the same missing-data verdict.

## Should-Fix Before Dispatch

### M1 - Define the exact tick query bounds

`TickAggregateRepository.findRange` uses TypeORM `Between`, which is inclusive on both ends:

```25:29:apps/engine/src/market-data/repository/TickAggregateRepository.ts
    async findRange(symbol: string, fromTs: Date, toTs: Date): Promise<TickAggregateEntity[]> {
        return this.repository.find({
            where: { symbol, ts: Between(fromTs, toTs) },
            order: { ts: 'ASC' },
        });
```

A 5-minute bar is usually `[barOpen, barOpen + 5m)`, not inclusive of the next bar's first tick. The
plan should state whether it will use `findRange` as-is, add a half-open repository method, or pass
`toTs = barOpen + 5m - 1ms`.

Recommended addition:

- Add a boundary test with ticks exactly at `barOpen`, `barOpen + 5m - 1s`, and `barOpen + 5m`.
- Ensure the next bar's first tick is not accidentally included when the chosen contract is signal-bar
  ticks.

### M2 - Real bar high/low should come from the same tick set, not a separate candle read

The plan allows high/low from ticks or from `candles`. For this milestone, using two sources can
create contradictions if tick persistence lags or aggregation differs.

Recommended addition:

- Derive `barHigh` and `barLow` from the loaded tick set when ticks exist.
- If ticks are absent, either keep `barHigh=barLow=entryPrice` for the conservative miss or mark the
  whole fill as missing-data; do not load candle high/low and still pass `ticks=[]`, because the
  detector will miss regardless and the mixed evidence is confusing.

### M3 - Module-boundary note should mention `MarketDataModule` export

The engine-only design A is feasible because `StrategyModule` already imports `MarketDataModule`, and
`MarketDataModule` exports `TickAggregateRepository`:

```27:33:apps/engine/src/strategy/StrategyModule.ts
@Module({
    imports: [
        TypeOrmModule.forFeature([StrategyVersionEntity, DecisionEntity, ComparisonReportEntity, ShadowDecisionEntity]),
        forwardRef(() => PositionModule),
        MarketDataModule,
```

```73:84:apps/engine/src/market-data/MarketDataModule.ts
    exports: [
        UniverseService,
        SymbolStateRegistry,
        MarketContextService,
        SubscriptionRetainer,
        InstrumentRepository,
        CandleRepository,
        TickAggregateRepository,
```

Recommended addition:

- State that the engine implementation should inject `TickAggregateRepository` from `MarketDataModule`;
  no direct `@InjectRepository(TickAggregateEntity)` in `StrategyModule` is needed.

### M4 - Shadow close simulation remains a known PnL limitation

M26 focuses on opening the virtual ledger. But shadow still closes reverse signals at the reconstructed
reference price, and close-side fill simulation is explicitly deferred:

```187:200:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
        // TODO (quant W4 review): `reconstructReferencePrice` is the entry-
        // price proxy used here as the close fill price. A dedicated
        // `intent: 'close'` simulation through HistoricalFillAdapter would be
        // more accurate but is out of scope for this wave.
        const existingPosition = shadow.ledger.findOpenPositionBySymbol(event.symbol);
        // ...
            const closePrice = reconstructReferencePrice(stampedEvent).toFixed();
            shadow.ledger.closeBySymbol(event.symbol, closePrice, nowMs, 'reverse_signal', `${event.eventId}:reverse`);
```

Recommended addition:

- Update the acceptance language from "shadow counterfactual PnL is available" to "entry-side shadow
  PnL becomes computable with known low-fidelity close limitations."
- Ask the quant reviewer to classify whether the remaining close proxy is acceptable for M11b
  comparison or needs a follow-up before promotion use.

## What Looks Good

- The root cause is correct: empty ticks force every limit-policy shadow open to miss.
- Reusing `HistoricalFillAdapter` rather than adding a second fill implementation is the right
  architectural boundary.
- Design A is the better default: the needed repository is already exported by `MarketDataModule`, so
  this can remain engine-only if missing-data tagging does not require a shared contract change.
- Keeping `bookSnapshot=null` and `lowFidelity=true` is honest; M26 should unlock fills, not pretend to
  solve depth-aware slippage.
- Missing market-data gaps should stay conservative. Do not synthesize shadow ticks just to produce PnL.
- The reviewer wave correctly includes quant, because this milestone changes whether shadow PnL can be
  used as evidence.

## Recommended Dispatch Adjustment

Before implementation, update M26 with these decisions:

1. Choose and document the fill timing contract: exact M7 parity with next-bar open recommended, unless
   the architect intentionally wants signal-close shadow semantics.
2. Define the tick query interval precisely and add half-open boundary tests.
3. Choose a durable representation for missing tick data. If it requires `ISimulatedFill` changes, add
   a `bot-shared-maintainer` wave and remove the "engine-only" claim.
4. Load tick evidence once per `event_id`, not once per shadow version.
5. Downgrade the acceptance claim from fully reliable shadow PnL to entry-unblocked low-fidelity
   counterfactual PnL with close-side limitations still documented.

With those edits, M26 becomes a valuable data unlock. Without them, it may produce non-missed shadow
fills that are hard to compare to M7/live paper and hard to distinguish from missing-data artifacts.
