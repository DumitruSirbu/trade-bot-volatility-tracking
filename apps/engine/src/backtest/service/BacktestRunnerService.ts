import {
    CoinTierEnum,
    FlowTypeEnum,
    IBacktestConfig,
    IBacktestFill,
    IBacktestPosition,
    IBacktestReport,
    IBacktestTradeResult,
    IClosedBarTriggerInput,
    IStrategyParams,
    IVolatilityDetectedEvent,
    OrderPolicyEnum,
    RegimeLabelEnum,
    classifyFlowType,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { DecimalValue, Money, MoneyValue } from '../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../market-data/const/candleConsts';
import { BookSnapshotEntity, OpenInterestEntity, TickAggregateEntity } from '../../market-data/entity';
import { ICandle, IIndicatorSnapshot } from '../../market-data/interface';
import { BookSnapshotRepository } from '../../market-data/repository/BookSnapshotRepository';
import { InstrumentRepository } from '../../market-data/repository/InstrumentRepository';
import { OpenInterestRepository } from '../../market-data/repository/OpenInterestRepository';
import { evaluateTrigger } from '../../market-data/trigger';
import { resolveTriggerParams } from '../../market-data/utils';
import { DEFAULT_MAINTENANCE_MARGIN_RATE } from '../../risk/const/riskConsts';
import { IInstrumentConstraints } from '../../risk/interface';
import { ReservationLedger } from '../../risk/service';
import { IStrategy } from '../../strategy/interface';
import { StrategyRegistry } from '../../strategy/registry';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import { BacktestInstrumentAdapter } from '../adapter/BacktestInstrumentAdapter';
import { BacktestPositionAdapter } from '../adapter/BacktestPositionAdapter';
import { BacktestRiskStateAdapter } from '../adapter/BacktestRiskStateAdapter';
import { BACKTEST_WARMUP_BAR_COUNT } from '../const/backtestConsts';
import { FillSimulator, IFillRequest } from '../fill/FillSimulator';
import { simulateIntrabarStop } from '../fill/IntrabarStopSimulator';
import { ITierSlippageParams } from '../fill/TierSlippageModel';
import { assertNoLookAhead } from '../guard/CausalityGuard';
import { BacktestBook } from '../state/BacktestBook';
import { BacktestEquityCurve } from '../state/BacktestEquityCurve';
import { BacktestPnLLedger } from '../state/BacktestPnLLedger';
import { buildBacktestEvent } from './BacktestEventBuilder';
import { BacktestExecutionSink } from './BacktestExecutionSink';
import { BacktestOrchestrator, IBacktestOrchestratorContext } from './BacktestOrchestrator';
import { CandleLoader } from './CandleLoader';
import { FundingReplayLoader, IFundingEvent } from './FundingReplayLoader';
import { IndicatorStateBuilder } from './IndicatorStateBuilder';
import { MetricsComputer } from './MetricsComputer';
import { PointInTimeUniverse } from './PointInTimeUniverse';

// The BTC reference symbol used to source `btc5mMovePct` per bar. BTC reference is loaded
// independently of the universe so it can drive correlation classification even when BTC
// itself is not a tradable candidate on the replay window.
const BTC_REFERENCE_SYMBOL = 'BTCUSDT';

// Open-interest sampling cadence is sub-bar; for the deterministic replay we look up the
// most recent OI sample at-or-before the bar's open. A 1-hour window keeps the lookup
// bounded while comfortably covering Binance's 5-minute polling cadence.
const OI_LOOKBACK_WINDOW_MS = 60 * 60 * 1000;

// Mirrors the open-time stamping done by the orchestrator. Stashed by eventId so the
// runner can patch the per-trade report rows the sink produces at close (the sink does not
// own this metadata — see BacktestExecutionSink.applyCloseFill).
interface ITradeMetadata {
    readonly flowType: FlowTypeEnum;
    readonly regimeAtEntry: RegimeLabelEnum;
    readonly coinTier: CoinTierEnum;
    readonly strategyVersionId: number;
    // True when the BTC reference bar was missing at signal time. Trades stamped with this
    // flag get lowFidelity=true downstream because their correlation classification is
    // unreliable (btc5mMovePct defaulted to 0, indistinguishable from BTC being flat).
    readonly btcDataMissing: boolean;
}

// Per-symbol pre-loaded data the replay loop walks bar-by-bar. Eagerly loaded once per
// symbol so the inner loop is index-driven and deterministic.
interface ISymbolReplayData {
    readonly warmupBars: ICandle[];
    readonly replayBars: ICandle[];
    readonly oiByTsMs: Map<number, OpenInterestEntity>;
    readonly bookByBarOpenMs: Map<number, BookSnapshotEntity>;
    readonly fundingEvents: readonly IFundingEvent[];
}

// The main per-run orchestrator (ADR 0015 §2.5). Public entry: `run(config)`. Loads
// strategy + warm-up + replay data, walks bars per-symbol, dispatches each triggering bar
// to the BacktestOrchestrator, processes exits intra-bar, applies funding, and emits an
// IBacktestReport. No DI state survives across `run()` calls — book, ledger, adapters,
// reservation ledger and fill simulator are all constructed fresh per-run so a replay
// cannot leak state into the live container or into a sibling replay.
@Injectable()
export class BacktestRunnerService {
    private readonly logger = new Logger(BacktestRunnerService.name);

    constructor(
        private readonly strategyRegistry: StrategyRegistry,
        private readonly strategyVersionRepository: StrategyVersionRepository,
        private readonly instrumentRepository: InstrumentRepository,
        private readonly candleLoader: CandleLoader,
        private readonly indicatorStateBuilder: IndicatorStateBuilder,
        private readonly pointInTimeUniverse: PointInTimeUniverse,
        private readonly fundingReplayLoader: FundingReplayLoader,
        private readonly openInterestRepository: OpenInterestRepository,
        private readonly bookSnapshotRepository: BookSnapshotRepository,
        private readonly orchestrator: BacktestOrchestrator,
        private readonly metricsComputer: MetricsComputer,
    ) {}

    async run(config: IBacktestConfig): Promise<IBacktestReport> {
        const strategyVersion = await this.strategyVersionRepository.findById(config.strategyVersionId);

        if (strategyVersion === null) {
            throw new Error(`strategy_versions.id=${config.strategyVersionId} not found`);
        }

        const { strategy, params } = this.strategyRegistry.resolve(strategyVersion.name, strategyVersion.version, strategyVersion.params);

        const fromMs = utcDateToMs(config.fromUtcDate);
        const toMs = utcDateToMs(config.toUtcDate);

        if (toMs <= fromMs) {
            throw new Error(`config.toUtcDate must be after fromUtcDate (${config.fromUtcDate} → ${config.toUtcDate})`);
        }

        const runState = this.buildRunState(params);
        await this.seedInstruments(runState.book);

        const symbols = await this.pointInTimeUniverse.resolveForWindow(config.fromUtcDate, config.toUtcDate);
        const btcReferenceBars = await this.loadBtcReferenceBars(fromMs, toMs);

        const counters: IRunCounters = { skipped: 0, rejectedByGate: 0, missedFill: 0, lowFidelity: 0 };
        const tradeMetadata: Map<string, ITradeMetadata> = new Map();
        const dailyTierCache: Map<string, Map<string, CoinTierEnum>> = new Map();

        this.logger.log(`backtest run=${config.runLabel} version=${strategyVersion.name}:${strategyVersion.version} symbols=${symbols.length}`);

        for (const symbol of symbols) {
            const ctx: ISymbolReplayContext = {
                symbol,
                fromMs,
                toMs,
                config,
                strategy,
                params,
                strategyVersion: { name: strategyVersion.name, version: strategyVersion.version },
                btcReferenceBars,
                runState,
                counters,
                tradeMetadata,
                dailyTierCache,
            };
            await this.replaySymbol(ctx);
        }

        await this.forceCloseOpenPositions(config, runState, counters, tradeMetadata, toMs);

        return this.buildReport(config, strategyVersion, runState, counters);
    }

    // Any positions still open at end-of-window are force-closed at the last available bar's
    // close price using REDUCE_MARKET semantics (taker fees + slippage). This pins a
    // deterministic end-of-window NAV so the equity curve / drawdown / Sharpe account for
    // unrealised exposure instead of silently dropping it. Mirrors the live behavior of
    // squaring positions on session boundary.
    private async forceCloseOpenPositions(
        config: IBacktestConfig,
        runState: IRunState,
        counters: IRunCounters,
        tradeMetadata: Map<string, ITradeMetadata>,
        toMs: number,
    ): Promise<void> {
        const survivors = Array.from(runState.book.openPositions.values());

        for (const position of survivors) {
            await this.forceClosePosition(config, runState, counters, tradeMetadata, position, toMs);
        }
    }

    private async forceClosePosition(
        config: IBacktestConfig,
        runState: IRunState,
        counters: IRunCounters,
        tradeMetadata: Map<string, ITradeMetadata>,
        position: IBacktestPosition,
        toMs: number,
    ): Promise<void> {
        const lastBar = await this.loadLastBarBefore(position.symbol, toMs);
        const exitPrice = lastBar !== null ? new Money(lastBar.close) : new Money(position.entryPriceUsdt);
        const hitTsMs = lastBar !== null ? lastBar.openTimeMs : position.openedAtMs;
        const metadata = lookupTradeMetadata(tradeMetadata, position.positionId);
        const positionTier = resolveForceCloseTier(runState, position, metadata);

        const fillRequest: IFillRequest = {
            eventId: `${position.positionId}:force-close`,
            symbol: position.symbol,
            side: position.side,
            intent: 'close',
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: exitPrice,
            qty: new Money(position.qty),
            coinTier: positionTier,
            signalBarOpenMs: hitTsMs,
            barHigh: lastBar !== null ? new Money(lastBar.high) : exitPrice,
            barLow: lastBar !== null ? new Money(lastBar.low) : exitPrice,
            ticks: [],
            bookSnapshot: null,
            tierSlippageParams: runState.tierSlippageParams,
            config,
        };

        const fill = runState.fillSim.simulateFill(fillRequest);

        if (fill.missed) {
            return;
        }

        const grossPnl = this.computeGrossPnl(position, fill);
        const tradesBefore = runState.book.completedTrades.length;

        runState.sink.applyCloseFill(fill, grossPnl, 'time_stop');

        if (runState.book.completedTrades.length > tradesBefore) {
            const lastIndex = runState.book.completedTrades.length - 1;
            const trade = runState.book.completedTrades[lastIndex];

            const patched: IBacktestTradeResult = {
                ...trade,
                strategyVersionId: metadata !== null ? metadata.strategyVersionId : config.strategyVersionId,
                flowType: metadata !== null ? metadata.flowType : FlowTypeEnum.LOW_QUALITY_NOISE,
                regimeAtEntry: metadata !== null ? metadata.regimeAtEntry : RegimeLabelEnum.RANGING,
                coinTier: metadata !== null ? serializeCoinTier(metadata.coinTier) : trade.coinTier,
            };

            runState.book.completedTrades[lastIndex] = patched;

            if (trade.lowFidelity) {
                counters.lowFidelity += 1;
            }
        }
    }

    private async loadLastBarBefore(symbol: string, toMs: number): Promise<ICandle | null> {
        const bars = await this.candleLoader.loadFor5mWindow({
            symbol,
            fromMs: toMs - CANDLE_5M_INTERVAL_MS,
            toMs,
        });

        if (bars.length === 0) {
            return null;
        }

        return bars[bars.length - 1];
    }

    private buildRunState(params: IStrategyParams): IRunState {
        const book = new BacktestBook();
        const ledger = new BacktestPnLLedger();
        const sink = new BacktestExecutionSink(book, ledger);
        const positionAdapter = new BacktestPositionAdapter(book);
        const riskStateAdapter = new BacktestRiskStateAdapter(book);
        const instrumentAdapter = new BacktestInstrumentAdapter(book);
        const reservationLedger = new ReservationLedger();
        const fillSim = new FillSimulator();

        const tierSlippageParams: ITierSlippageParams = {
            slippage_tier1_pct: params.slippage_tier1_pct,
            slippage_tier2_pct: params.slippage_tier2_pct,
            slippage_tier3_pct: params.slippage_tier3_pct,
        };

        return {
            book,
            ledger,
            sink,
            positionAdapter,
            riskStateAdapter,
            instrumentAdapter,
            reservationLedger,
            fillSim,
            tierSlippageParams,
        };
    }

    // The risk gate reads instrument constraints through BacktestInstrumentAdapter, which
    // is backed by book.instruments. Pre-seed the entire snapshot so a missing row surfaces
    // as a deterministic null at the gate boundary instead of a silently fabricated value.
    private async seedInstruments(book: BacktestBook): Promise<void> {
        const rows = await this.instrumentRepository.findAllTradable();

        for (const row of rows) {
            const constraints: IInstrumentConstraints = {
                symbol: row.symbol,
                stepSize: row.stepSize,
                tickSize: row.tickSize,
                minNotional: row.minNotional,
                maintenanceMarginRate: new Money(DEFAULT_MAINTENANCE_MARGIN_RATE),
            };

            book.instruments.set(row.symbol, constraints);
        }
    }

    private async loadBtcReferenceBars(fromMs: number, toMs: number): Promise<Map<number, ICandle>> {
        const warmupFromMs = fromMs - BACKTEST_WARMUP_BAR_COUNT * CANDLE_5M_INTERVAL_MS;
        const bars = await this.candleLoader.loadFor5mWindow({ symbol: BTC_REFERENCE_SYMBOL, fromMs: warmupFromMs, toMs });
        const result: Map<number, ICandle> = new Map();

        for (const bar of bars) {
            result.set(bar.openTimeMs, bar);
        }

        return result;
    }

    private async replaySymbol(ctx: ISymbolReplayContext): Promise<void> {
        const data = await this.loadSymbolData(ctx);

        if (data.replayBars.length === 0) {
            return;
        }

        let window = this.indicatorStateBuilder.buildInitialWindow(data.warmupBars);
        const fundingCursor: IFundingCursor = { index: 0 };

        for (const bar of data.replayBars) {
            await this.processBar(ctx, bar, window, data, fundingCursor);
            window = this.indicatorStateBuilder.appendBar(window, bar);
        }
    }

    private async loadSymbolData(ctx: ISymbolReplayContext): Promise<ISymbolReplayData> {
        const warmupFromMs = ctx.fromMs - BACKTEST_WARMUP_BAR_COUNT * CANDLE_5M_INTERVAL_MS;

        const [warmupBars, replayBars, oiRows, bookRows, fundingEvents] = await Promise.all([
            this.candleLoader.loadFor5mWindow({ symbol: ctx.symbol, fromMs: warmupFromMs, toMs: ctx.fromMs }),
            this.candleLoader.loadFor5mWindow({ symbol: ctx.symbol, fromMs: ctx.fromMs, toMs: ctx.toMs }),
            this.openInterestRepository.findRange(ctx.symbol, new Date(warmupFromMs), new Date(ctx.toMs)),
            this.bookSnapshotRepository.findRange(ctx.symbol, new Date(ctx.fromMs), new Date(ctx.toMs)),
            this.fundingReplayLoader.loadForWindow([ctx.symbol], ctx.fromMs, ctx.toMs),
        ]);

        return {
            warmupBars,
            replayBars,
            oiByTsMs: buildOiIndex(oiRows),
            bookByBarOpenMs: buildBookIndex(bookRows),
            fundingEvents,
        };
    }

    private async processBar(
        ctx: ISymbolReplayContext,
        bar: ICandle,
        window: ICandle[],
        data: ISymbolReplayData,
        fundingCursor: IFundingCursor,
    ): Promise<void> {
        const utcDateString = msToUtcDate(bar.openTimeMs);
        // Load ticks once per bar and thread through the exit + dispatch paths. Loading
        // multiple times within the same bar is both a perf cost and a determinism risk
        // (a single ORDER BY ts ASC traversal is the reference order).
        const ticks = await this.candleLoader.loadTicksForBar(ctx.symbol, bar.openTimeMs);

        // Apply funding first: a funding event at the bar boundary settles before any
        // intra-bar stop, matching Binance's settlement order. Without this, a stop in the
        // current bar would skip a same-boundary funding charge for that position.
        this.applyFundingForBar(ctx, bar.openTimeMs, fundingCursor, data.fundingEvents);
        await this.handleOpenPositionsForBar(ctx, bar, utcDateString, data, ticks);

        const tier = await this.resolveTierAt(ctx, utcDateString);

        if (tier === null) {
            return;
        }

        const nextWindow = this.indicatorStateBuilder.appendBar(window, bar);

        // ADR-0015 §C2: cheap O(window) invariant that no future-relative bar leaked into
        // the window. Throws CausalityViolationException — a programming bug, fatal.
        assertNoLookAhead(nextWindow, bar.openTimeMs, CANDLE_5M_INTERVAL_MS);

        const snapshot = this.indicatorStateBuilder.computeSnapshot(ctx.symbol, nextWindow);

        if (snapshot === null) {
            return;
        }

        if (!this.passesTrigger(snapshot, tier)) {
            return;
        }

        await this.dispatchTriggerEvent(ctx, bar, snapshot, data, tier, utcDateString, ticks);
    }

    private passesTrigger(snapshot: IIndicatorSnapshot, tier: CoinTierEnum): boolean {
        const input: IClosedBarTriggerInput = {
            symbol: snapshot.symbol,
            vwapDeviationSigma: snapshot.vwapDeviationSigma,
            vwapDeviationPct: snapshot.vwapDeviationPct,
            volumeRatio: snapshot.volumeRatio,
        };

        return evaluateTrigger(input, resolveTriggerParams(tier)).fired;
    }

    private async dispatchTriggerEvent(
        ctx: ISymbolReplayContext,
        bar: ICandle,
        snapshot: IIndicatorSnapshot,
        data: ISymbolReplayData,
        tier: CoinTierEnum,
        utcDateString: string,
        ticks: TickAggregateEntity[],
    ): Promise<void> {
        const event = this.buildEvent(ctx, bar, snapshot, data, tier);
        // Track BTC data availability separately from btc5mMovePct (which defaults to 0
        // when missing) so the trade row can be marked lowFidelity for unreliable
        // correlation classification — see stampTradeMetadataIfFilled / patchTradeRow.
        const btcDataMissing = !ctx.btcReferenceBars.has(bar.openTimeMs);
        const bookSnapshot = data.bookByBarOpenMs.get(bar.openTimeMs) ?? null;
        // M7 R1a fix-3 (quant, ADR-0015 §6): entries fill at the next bar's open. If the
        // signal bar is the final replay bar for this symbol, nextBarOpen is null and the
        // orchestrator declines the intent (no future bar to fill against).
        const barIndex = data.replayBars.indexOf(bar);
        const nextBar = barIndex >= 0 && barIndex + 1 < data.replayBars.length ? data.replayBars[barIndex + 1] : null;
        const nextBarOpen = nextBar !== null ? new Money(nextBar.open) : null;
        const orchestratorContext = this.buildOrchestratorContext(ctx, ticks, bookSnapshot, utcDateString, nextBarOpen);

        const result = await this.orchestrator.processEvent(event, orchestratorContext);

        this.recordResultCounters(ctx.counters, result);
        this.stampTradeMetadataIfFilled(ctx, event, tier, result.filled, btcDataMissing);
    }

    private buildEvent(
        ctx: ISymbolReplayContext,
        bar: ICandle,
        snapshot: IIndicatorSnapshot,
        data: ISymbolReplayData,
        tier: CoinTierEnum,
    ): IVolatilityDetectedEvent {
        const oiNow = this.resolveOpenInterestAt(data.oiByTsMs, bar.openTimeMs);
        const oi5mAgo = this.resolveOpenInterestAt(data.oiByTsMs, bar.openTimeMs - CANDLE_5M_INTERVAL_MS);
        const oi15mAgo = this.resolveOpenInterestAt(data.oiByTsMs, bar.openTimeMs - 3 * CANDLE_5M_INTERVAL_MS);
        const oiChange5mPct = computeOiChangePct(oiNow, oi5mAgo);
        const oiChange15mPct = computeOiChangePct(oiNow, oi15mAgo);

        const bookSnapshot = data.bookByBarOpenMs.get(bar.openTimeMs) ?? null;
        const btcMovePct = this.resolveBtcMovePct(ctx.btcReferenceBars, bar.openTimeMs);
        const funding = resolveFundingRateAt(data.fundingEvents, bar.openTimeMs);

        return buildBacktestEvent(snapshot, bar.openTimeMs, {
            coinTier: tier,
            universeAgeHours: 0,
            coinVolumeRank: 0,
            oiValue: oiNow !== null ? oiNow.value : null,
            oiChange5mPct,
            oiChange15mPct,
            fundingRate: funding.rate,
            fundingRateAnnualized: funding.rateAnnualized,
            btc5mMovePct: btcMovePct,
            eth5mMovePct: 0,
            btc1mMovePct: 0,
            bidAskSpreadPct: 0,
            bookDepth10bpsUsdt: bookSnapshot !== null ? (bookSnapshot.depth10bps ?? null) : null,
            bookDepth50bpsUsdt: bookSnapshot !== null ? (bookSnapshot.depth50bps ?? null) : null,
            marketBreadth5mUpPct: 0,
            sameBarTriggerCount: 0,
            aggTradeBuyVolumeRatio: 0,
        });
    }

    private buildOrchestratorContext(
        ctx: ISymbolReplayContext,
        ticks: TickAggregateEntity[],
        bookSnapshot: BookSnapshotEntity | null,
        utcDateString: string,
        nextBarOpen: MoneyValue | null,
    ): IBacktestOrchestratorContext {
        return {
            book: ctx.runState.book,
            ledger: ctx.runState.ledger,
            sink: ctx.runState.sink,
            positionAdapter: ctx.runState.positionAdapter,
            riskStateAdapter: ctx.runState.riskStateAdapter,
            instrumentAdapter: ctx.runState.instrumentAdapter,
            reservationLedger: ctx.runState.reservationLedger,
            fillSim: ctx.runState.fillSim,
            ticks,
            bookSnapshot,
            strategy: ctx.strategy,
            params: ctx.params,
            strategyVersionId: ctx.config.strategyVersionId,
            tierSlippageParams: ctx.runState.tierSlippageParams,
            config: ctx.config,
            isInUniverse: true,
            utcDateString,
            allocatedCapitalUsdt: ctx.config.allocatedCapitalUsdt,
            nextBarOpen,
        };
    }

    private recordResultCounters(counters: IRunCounters, result: { skipped: boolean; rejectedByGate: boolean; missedFill: boolean }): void {
        if (result.skipped) {
            counters.skipped += 1;
        }

        if (result.rejectedByGate) {
            counters.rejectedByGate += 1;
        }

        if (result.missedFill) {
            counters.missedFill += 1;
        }
    }

    private stampTradeMetadataIfFilled(
        ctx: ISymbolReplayContext,
        event: IVolatilityDetectedEvent,
        tier: CoinTierEnum,
        filled: boolean,
        btcDataMissing: boolean,
    ): void {
        if (!filled) {
            return;
        }

        const flowType = classifyFlowType(event, ctx.params);

        // The orchestrator builds positionId as `${event.eventId}:${fill.tsMs}` — we don't
        // know fill.tsMs without re-running the simulator, so we key metadata by eventId
        // and recover it by stripping the trailing `:tsMs` suffix at close-time.
        ctx.tradeMetadata.set(event.eventId, {
            flowType,
            regimeAtEntry: event.regimeLabel,
            coinTier: tier,
            strategyVersionId: ctx.config.strategyVersionId,
            btcDataMissing,
        });
    }

    private async handleOpenPositionsForBar(
        ctx: ISymbolReplayContext,
        bar: ICandle,
        utcDateString: string,
        data: ISymbolReplayData,
        ticks: TickAggregateEntity[],
    ): Promise<void> {
        const openPositions = ctx.runState.book.openPositionList().filter((position) => position.symbol === ctx.symbol);

        for (const position of openPositions) {
            await this.checkPositionExit(ctx, position, bar, utcDateString, data, ticks);
        }
    }

    private async checkPositionExit(
        ctx: ISymbolReplayContext,
        position: IBacktestPosition,
        bar: ICandle,
        utcDateString: string,
        data: ISymbolReplayData,
        ticks: TickAggregateEntity[],
    ): Promise<void> {
        if (this.shouldHitTimeStop(position, bar)) {
            // computeFillTimestamp adds (CANDLE_5M_INTERVAL_MS + latencyMs) to signalBarOpenMs.
            // For a time-stop, the fill price is THIS bar's open and the fill ts must equal
            // bar.openTimeMs + latencyMs (same boundary, not next-bar). Pre-subtract one
            // interval so the latency model lands on this bar instead of the next.
            await this.closePosition(ctx, position, bar, 'time_stop', new Money(bar.open), bar.openTimeMs - CANDLE_5M_INTERVAL_MS, data, ticks);

            return;
        }

        const stopLoss = new Money(position.stopLossUsdt);
        const takeProfit = new Money(position.takeProfitUsdt);
        const stopResult = simulateIntrabarStop(position.side, stopLoss, takeProfit, ticks, bar.high, bar.low, bar.openTimeMs);

        if (stopResult.hit === null) {
            return;
        }

        const hitPrice = stopResult.hitPrice ?? (stopResult.hit === 'stop_loss' ? stopLoss : takeProfit);
        const hitTsMs = stopResult.hitTsMs ?? bar.openTimeMs;

        await this.closePosition(ctx, position, bar, stopResult.hit, hitPrice, hitTsMs, data, ticks);
    }

    private shouldHitTimeStop(position: IBacktestPosition, bar: ICandle): boolean {
        if (position.timeStopAtMs === null) {
            return false;
        }

        return bar.openTimeMs >= position.timeStopAtMs;
    }

    private async closePosition(
        ctx: ISymbolReplayContext,
        position: IBacktestPosition,
        bar: ICandle,
        exitReason: IBacktestTradeResult['exitReason'],
        exitPrice: MoneyValue,
        hitTsMs: number,
        data: ISymbolReplayData,
        ticks: TickAggregateEntity[],
    ): Promise<void> {
        const positionTier = this.resolvePositionTier(ctx, position);

        const fillRequest: IFillRequest = {
            eventId: `${position.positionId}:close`,
            symbol: position.symbol,
            side: position.side,
            intent: 'close',
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: exitPrice,
            qty: new Money(position.qty),
            coinTier: positionTier,
            signalBarOpenMs: hitTsMs,
            barHigh: new Money(bar.high),
            barLow: new Money(bar.low),
            ticks,
            bookSnapshot: data.bookByBarOpenMs.get(bar.openTimeMs) ?? null,
            tierSlippageParams: ctx.runState.tierSlippageParams,
            config: ctx.config,
        };

        const fill = ctx.runState.fillSim.simulateFill(fillRequest);

        if (fill.missed) {
            // REDUCE_MARKET should not miss in the live policy matrix; if simulated as
            // missed, leave the position open and try again on the next bar.
            return;
        }

        const grossPnl = this.computeGrossPnl(position, fill);
        const tradesBefore = ctx.runState.book.completedTrades.length;

        ctx.runState.sink.applyCloseFill(fill, grossPnl, exitReason);

        if (ctx.runState.book.completedTrades.length > tradesBefore) {
            this.patchTradeRow(ctx, position);
            // M7 R1a fix-4 (logic): mirror the live cycle by writing realized PnL into the
            // per-day risk_state row the gate reads. Without this update the daily and
            // weekly loss-limit checks see zero PnL forever and can never reject an entry.
            await this.updateRiskStateAfterClose(ctx, fill);
        }
    }

    // M7 R1a fix-4 (logic, ADR 0004 §6). After a close fill is recorded into the book, fold
    // its net PnL into the day's risk_state entry so RiskGateService.checkLossWindows reads
    // it on the next gate evaluation. The date key comes from fill.tsMs (the canonical close
    // timestamp). Uses the same upsert path the live gate's mutation primitives use.
    private async updateRiskStateAfterClose(ctx: ISymbolReplayContext, closeFill: IBacktestFill): Promise<void> {
        const closeDateString = msToUtcDate(closeFill.tsMs);
        const existing = await ctx.runState.riskStateAdapter.getDay(closeDateString);
        const tradeCount = ctx.runState.book.completedTrades.length;
        const lastTrade = tradeCount > 0 ? ctx.runState.book.completedTrades[tradeCount - 1] : null;
        const netPnl = lastTrade !== null ? new Money(lastTrade.netPnlUsdt) : new Money(0);

        const currentPnl: MoneyValue = existing !== null ? existing.realizedPnlDay : new Money(0);
        const currentCount = existing !== null ? existing.tradesCount : 0;

        await ctx.runState.riskStateAdapter.upsertDay({
            date: closeDateString,
            realizedPnlDay: currentPnl.plus(netPnl),
            // Preserve halt and exposure state — only PnL + trade count change on close.
            // Full-row overwrite of isHalted/haltReason/openExposure would silently clear
            // a market-stress halt previously written by the gate for the same day.
            openExposure: existing !== null ? existing.openExposure : new Money(0),
            tradesCount: currentCount + 1,
            isHalted: existing !== null ? existing.isHalted : false,
            haltReason: existing !== null ? existing.haltReason : null,
        });
    }

    private resolvePositionTier(ctx: ISymbolReplayContext, position: IBacktestPosition): CoinTierEnum {
        const constraints = ctx.runState.book.instruments.get(position.symbol);

        if (constraints === undefined) {
            return CoinTierEnum.TIER_3;
        }

        // The orchestrator stamped tier into the open-time event metadata; recover it via
        // the original eventId. Falling back to TIER_3 keeps slippage conservative if the
        // stamp is missing (forced low-fidelity exit accounting on a stale entry).
        const metadata = this.findTradeMetadata(ctx, position.positionId);

        return metadata !== null ? metadata.coinTier : CoinTierEnum.TIER_3;
    }

    private computeGrossPnl(position: IBacktestPosition, fill: IBacktestFill): MoneyValue {
        const entry = new Money(position.entryPriceUsdt);
        const exit = new Money(fill.priceUsdt);
        const qty = new Money(fill.qty);

        if (position.side === 'long') {
            return exit.minus(entry).times(qty);
        }

        return entry.minus(exit).times(qty);
    }

    private patchTradeRow(ctx: ISymbolReplayContext, position: IBacktestPosition): void {
        const lastIndex = ctx.runState.book.completedTrades.length - 1;
        const trade = ctx.runState.book.completedTrades[lastIndex];
        const metadata = this.findTradeMetadata(ctx, position.positionId);

        const patched: IBacktestTradeResult = {
            ...trade,
            strategyVersionId: metadata !== null ? metadata.strategyVersionId : ctx.config.strategyVersionId,
            flowType: metadata !== null ? metadata.flowType : FlowTypeEnum.LOW_QUALITY_NOISE,
            regimeAtEntry: metadata !== null ? metadata.regimeAtEntry : RegimeLabelEnum.RANGING,
            coinTier: metadata !== null ? serializeCoinTier(metadata.coinTier) : trade.coinTier,
            // Missing BTC reference at entry makes correlation classification unreliable
            // (btc5mMovePct=0 is indistinguishable from BTC being flat). Mark as low-fidelity.
            lowFidelity: trade.lowFidelity || (metadata !== null && metadata.btcDataMissing),
        };

        ctx.runState.book.completedTrades[lastIndex] = patched;

        if (patched.lowFidelity) {
            ctx.counters.lowFidelity += 1;
        }
    }

    private findTradeMetadata(ctx: ISymbolReplayContext, positionId: string): ITradeMetadata | null {
        const lastColon = positionId.lastIndexOf(':');

        if (lastColon === -1) {
            return null;
        }

        const eventId = positionId.slice(0, lastColon);

        return ctx.tradeMetadata.get(eventId) ?? null;
    }

    private async resolveTierAt(ctx: ISymbolReplayContext, utcDateString: string): Promise<CoinTierEnum | null> {
        let dailyMap = ctx.dailyTierCache.get(utcDateString);

        if (dailyMap === undefined) {
            dailyMap = await this.pointInTimeUniverse.resolveAt(utcDateString);
            ctx.dailyTierCache.set(utcDateString, dailyMap);
        }

        return dailyMap.get(ctx.symbol) ?? null;
    }

    private resolveOpenInterestAt(oiByTsMs: Map<number, OpenInterestEntity>, barOpenMs: number): OpenInterestEntity | null {
        const exact = oiByTsMs.get(barOpenMs);

        if (exact !== undefined) {
            return exact;
        }

        for (let ts = barOpenMs - CANDLE_5M_INTERVAL_MS; ts >= barOpenMs - OI_LOOKBACK_WINDOW_MS; ts -= CANDLE_5M_INTERVAL_MS) {
            const found = oiByTsMs.get(ts);

            if (found !== undefined) {
                return found;
            }
        }

        return null;
    }

    private resolveBtcMovePct(btcBars: Map<number, ICandle>, barOpenMs: number): number {
        const btcBar = btcBars.get(barOpenMs);

        if (btcBar === undefined) {
            return 0;
        }

        const open = new Money(btcBar.open);

        if (open.isZero()) {
            return 0;
        }

        return new Money(btcBar.close).minus(open).dividedBy(open).times(100).toNumber();
    }

    private applyFundingForBar(ctx: ISymbolReplayContext, barOpenMs: number, cursor: IFundingCursor, events: readonly IFundingEvent[]): void {
        const barEndMs = barOpenMs + CANDLE_5M_INTERVAL_MS;

        // Inclusive upper bound: a funding event landing exactly at barEndMs (e.g. 08:00 UTC
        // on a 5m boundary) settles within this bar rather than being deferred to the next,
        // matching Binance's settlement semantics at the boundary instant.
        while (cursor.index < events.length && events[cursor.index].tsMs <= barEndMs) {
            this.applyFundingEvent(ctx, events[cursor.index]);
            cursor.index += 1;
        }
    }

    private applyFundingEvent(ctx: ISymbolReplayContext, fundingEvent: IFundingEvent): void {
        for (const position of ctx.runState.book.openPositionList()) {
            if (position.symbol !== fundingEvent.symbol) {
                continue;
            }

            if (fundingEvent.tsMs < position.openedAtMs) {
                continue;
            }

            const notional = new Money(position.entryNotionalUsdt);
            const cashflow = this.fundingReplayLoader.computeCashflow(notional, fundingEvent.rate, position.side);
            ctx.runState.sink.applyFundingCashflow(position.positionId, cashflow);
        }
    }

    private buildReport(
        config: IBacktestConfig,
        strategyVersion: { name: string; version: number },
        runState: IRunState,
        counters: IRunCounters,
    ): IBacktestReport {
        const startingCapital = new Money(config.allocatedCapitalUsdt);
        const equityCurveBuilder = new BacktestEquityCurve(startingCapital);
        const curve = equityCurveBuilder.build(runState.book.completedTrades, new Map());
        const drawdown = equityCurveBuilder.computeDrawdown(curve);

        return this.metricsComputer.compute({
            strategyVersionId: config.strategyVersionId,
            strategyName: strategyVersion.name,
            strategyVersion: strategyVersion.version,
            fromUtcDate: config.fromUtcDate,
            toUtcDate: config.toUtcDate,
            runLabel: config.runLabel,
            trades: runState.book.completedTrades,
            equityCurve: curve,
            maxDrawdownPct: drawdown.maxDrawdownPct,
            maxDrawdownDurationDays: drawdown.maxDrawdownDurationDays,
            skippedTriggerCount: counters.skipped,
            rejectedByGateCount: counters.rejectedByGate,
            missedLimitFillCount: counters.missedFill,
            lowFidelityTradeCount: counters.lowFidelity,
        });
    }
}

// Per-run instance bundle. Constructed by `buildRunState` and threaded through the symbol
// loop unchanged — all replay mutation flows through this surface so nothing leaks into DI.
interface IRunState {
    readonly book: BacktestBook;
    readonly ledger: BacktestPnLLedger;
    readonly sink: BacktestExecutionSink;
    readonly positionAdapter: BacktestPositionAdapter;
    readonly riskStateAdapter: BacktestRiskStateAdapter;
    readonly instrumentAdapter: BacktestInstrumentAdapter;
    readonly reservationLedger: ReservationLedger;
    readonly fillSim: FillSimulator;
    readonly tierSlippageParams: ITierSlippageParams;
}

interface IRunCounters {
    skipped: number;
    rejectedByGate: number;
    missedFill: number;
    lowFidelity: number;
}

interface ISymbolReplayContext {
    readonly symbol: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly config: IBacktestConfig;
    readonly strategy: IStrategy;
    readonly params: IStrategyParams;
    readonly strategyVersion: { name: string; version: number };
    readonly btcReferenceBars: Map<number, ICandle>;
    readonly runState: IRunState;
    readonly counters: IRunCounters;
    readonly tradeMetadata: Map<string, ITradeMetadata>;
    readonly dailyTierCache: Map<string, Map<string, CoinTierEnum>>;
}

interface IFundingCursor {
    index: number;
}

function utcDateToMs(utcDate: string): number {
    const parsed = new Date(`${utcDate}T00:00:00.000Z`);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid UTC date string: ${utcDate}`);
    }

    return parsed.getTime();
}

function msToUtcDate(ms: number): string {
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function buildOiIndex(rows: OpenInterestEntity[]): Map<number, OpenInterestEntity> {
    const result: Map<number, OpenInterestEntity> = new Map();

    for (const row of rows) {
        result.set(row.ts.getTime(), row);
    }

    return result;
}

// Bucket book snapshots into the 5m bar boundary they fall within. If multiple snapshots
// land in the same bar (M1 records around every decision), the latest one wins because it
// best represents the book at the trigger boundary.
function buildBookIndex(rows: BookSnapshotEntity[]): Map<number, BookSnapshotEntity> {
    const result: Map<number, BookSnapshotEntity> = new Map();

    for (const row of rows) {
        const barOpenMs = Math.floor(row.ts.getTime() / CANDLE_5M_INTERVAL_MS) * CANDLE_5M_INTERVAL_MS;
        result.set(barOpenMs, row);
    }

    return result;
}

function serializeCoinTier(tier: CoinTierEnum): IBacktestTradeResult['coinTier'] {
    if (tier === CoinTierEnum.TIER_1) {
        return 'tier1';
    }

    if (tier === CoinTierEnum.TIER_2) {
        return 'tier2';
    }

    return 'tier3';
}

// Pure helper for force-close metadata recovery: position ids carry the originating
// eventId as the prefix (`${eventId}:${fill.tsMs}`). The map is keyed by eventId so we
// strip the trailing `:tsMs` suffix to find it.
function lookupTradeMetadata(map: Map<string, ITradeMetadata>, positionId: string): ITradeMetadata | null {
    const lastColon = positionId.lastIndexOf(':');

    if (lastColon === -1) {
        return null;
    }

    return map.get(positionId.slice(0, lastColon)) ?? null;
}

// Forced-close tier resolution: prefer the open-time stamped tier; fall back to TIER_3
// (conservative slippage) when the book has no instrument row OR the metadata is missing.
function resolveForceCloseTier(runState: IRunState, position: IBacktestPosition, metadata: ITradeMetadata | null): CoinTierEnum {
    if (runState.book.instruments.get(position.symbol) === undefined) {
        return CoinTierEnum.TIER_3;
    }

    return metadata !== null ? metadata.coinTier : CoinTierEnum.TIER_3;
}

// Open-interest delta as a percent: (current - prior) / prior * 100. Returns 0 when either
// side is missing or the prior is zero (the metric is undefined without a non-zero baseline).
function computeOiChangePct(current: OpenInterestEntity | null, prior: OpenInterestEntity | null): number {
    if (current === null || prior === null) {
        return 0;
    }

    const priorVal = new Money(prior.value);

    if (priorVal.isZero()) {
        return 0;
    }

    return new Money(current.value).minus(priorVal).dividedBy(priorVal).times(100).toNumber();
}

// Most-recent funding event at-or-before barOpenMs. Annualized = 8h rate × 3 ticks/day ×
// 365 days. Events are loaded ASC; scanning from the end finds the latest qualifying event
// in O(k) on average for a tight per-symbol replay window.
function resolveFundingRateAt(events: readonly IFundingEvent[], barOpenMs: number): { rate: number; rateAnnualized: number } {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].tsMs <= barOpenMs) {
            const rate = decimalToNumber(events[i].rate);

            return { rate, rateAnnualized: rate * 3 * 365 };
        }
    }

    return { rate: 0, rateAnnualized: 0 };
}

// IFundingEvent.rate is typed as DecimalValue but DB reads and test fixtures may surface
// it as a string. Funnel everything through Money so the conversion is uniform before
// exporting a JS number for the event payload (live source surfaces a JS number too).
function decimalToNumber(value: DecimalValue): number {
    return new Money(value).toNumber();
}
