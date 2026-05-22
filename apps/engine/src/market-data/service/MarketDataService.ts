import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { IClosedBarTriggerInput, IPriceUpdateEvent, ITriggerResult } from '@bot/shared';

import { PRICE_UPDATE_EVENT, VOLATILITY_DETECTED_EVENT } from '../../common/const';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { sanitizeExchangeError } from '../../exchange/utils';
import { APPROACHING_TRIGGER_FRACTION, BAR_CLOSE_SWEEP_MS, BREADTH_WINDOW_5M_MS, CANDLE_5M_INTERVAL_MS, OI_CHANGE_15M_MS, OI_CHANGE_5M_MS } from '../const';
import { computeIdiosyncrasyScore, computeIndicatorSnapshot, computeRegimeLabel } from '../indicator';
import { EXCHANGE_CLIENT, IExchangeClient, ITickerSnapshot } from '../../exchange/interface';
import { IEscalationBaseline, IFlowLiquidityContext, IIndicatorSnapshot } from '../interface';
import { toVolatilityDetectedEvent } from '../marketData.mapper';
import { SymbolMarketState } from '../state';
import { evaluateTrigger } from '../trigger';
import { resolveTriggerParams } from '../utils';
import { DepthAggressorService } from './DepthAggressorService';
import { DeviationCalibrationService } from './DeviationCalibrationService';
import { FlowPollService } from './FlowPollService';
import { MarketContextService } from './MarketContextService';
import { SymbolStateRegistry } from './SymbolStateRegistry';
import { UniverseService } from './UniverseService';

// The market-data orchestrator. Drives the single !ticker@arr socket, aggregates
// candles, and on each CLOSED 5-min bar recomputes indicators → evaluates the
// shared trigger → enriches and emits events (ADR §4 ordering: close → recompute
// → evaluate → emit). Emits price.update per tick and volatility.detected when the
// trigger fires. No DB writes, no orders (M1). The forming candle is never read.
//
// A 5-min bar can graduate via TWO paths: a tick crossing the bucket boundary
// (handleTicker) or, for a symbol that went quiet, the wall-clock sweep safety net
// (sweepBarCloses). BOTH paths funnel every closed bar through the single authority
// handleClosedBars (close -> recompute -> evaluate -> emit -> calibrate), and
// SymbolCandleState's bucket watermark guarantees each (symbol, bucket) graduates
// EXACTLY ONCE. The M7 backtest closes on kline boundaries and feeds the same body,
// so live and replay produce identical events.
@Injectable()
export class MarketDataService implements OnApplicationBootstrap {
    private readonly logger = new Logger(MarketDataService.name);

    private readonly previousQuoteVolume = new Map<string, MoneyValue>();

    private readonly escalationBaselines = new Map<string, IEscalationBaseline>();

    private streaming = false;

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly eventEmitter: EventEmitter2,
        private readonly universe: UniverseService,
        private readonly registry: SymbolStateRegistry,
        private readonly context: MarketContextService,
        private readonly depthAggressor: DepthAggressorService,
        private readonly flowPoll: FlowPollService,
        private readonly calibration: DeviationCalibrationService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.universe.loadTradableSymbols();

        // Seed the universe from a REST full-snapshot — a single !ticker@arr socket
        // frame can be partial and would yield wrong tiers/ranks at startup (ADR §2).
        const seed = await this.exchangeClient.fetchTickers();

        this.universe.refresh(seed, Date.now());
        this.streaming = true;
        void this.streamTickers();
        this.logger.log('Market-data stream started on single !ticker@arr subscription');
    }

    // Wall-clock bar-close SAFETY NET: graduates the forming 5-min candle of any
    // symbol that went quiet and did not tick across its bucket boundary, so its bar
    // still closes on schedule. Active symbols close on the tick path instead; the
    // bucket watermark in SymbolCandleState makes this idempotent (never double-close).
    // Whatever this closes is routed through the same handleClosedBars authority.
    @Interval(BAR_CLOSE_SWEEP_MS)
    sweepBarCloses(): void {
        const nowMs = Date.now();
        const closed: IIndicatorSnapshot[] = [];

        for (const state of this.registry.all()) {
            const snapshot = this.closeBarIfElapsed(state, nowMs);

            if (snapshot !== null) {
                closed.push(snapshot);
            }
        }

        this.handleClosedBars(closed);
    }

    private closeBarIfElapsed(state: SymbolMarketState, nowMs: number): IIndicatorSnapshot | null {
        const closedBar = state.closeElapsedBars(nowMs);

        if (closedBar === null) {
            return null;
        }

        return this.processClosedBar(state);
    }

    private async streamTickers(): Promise<void> {
        while (this.streaming) {
            try {
                const tickers = await this.exchangeClient.watchTickers();

                this.handleTickerBatch(tickers);
            } catch (cause) {
                // ccxt.pro reconnects internally; log and continue the consume loop.
                this.logger.warn(`watchTickers iteration failed, retrying: ${sanitizeExchangeError(cause)}`);
            }
        }
    }

    // Ticks fold OHLCV into the forming candle and update price/escalation. When a
    // tick crosses the 5-min boundary it ALSO graduates a bar; every bar graduated
    // across the batch is accumulated and routed through the single handleClosedBars
    // authority as ONE cross-sectional batch — mirroring how sweepBarCloses batches —
    // so sameBarTriggerCount counts ALL active symbols that closed the same bucket in
    // this pass, not just one. This is the primary close path; the sweep is only the
    // quiet-symbol net.
    //
    // LIMITATION: sameBarTriggerCount is computed per close pass, so a tick batch and
    // a concurrent sweep that graduate the same logical bar boundary in separate
    // passes count their fires independently. Unifying them would require buffering
    // across passes against the bucket boundary; out of scope for this fix.
    private handleTickerBatch(tickers: ITickerSnapshot[]): void {
        const closed: IIndicatorSnapshot[] = [];

        for (const ticker of tickers) {
            const snapshot = this.handleTicker(ticker);

            if (snapshot !== null) {
                closed.push(snapshot);
            }
        }

        this.handleClosedBars(closed);
    }

    // Folds the tick, emits price.update, manages escalation, and — if this tick
    // graduated a 5-min bar — returns that bar's recomputed snapshot for the caller
    // to batch into handleClosedBars. Returns null when no bar closed on this tick.
    private handleTicker(ticker: ITickerSnapshot): IIndicatorSnapshot | null {
        const entry = this.universe.getEntry(ticker.symbol);

        if (entry === null || ticker.last === null) {
            return null;
        }

        const price = parseMoney(ticker.last);

        this.emitPriceUpdate(ticker.symbol, price, ticker.timestampMs);

        const state = this.registry.getOrCreate(ticker.symbol, entry.tier);
        const volumeDelta = this.deriveVolumeDelta(ticker);
        const closedBar = state.ingestTick(price, volumeDelta, ticker.timestampMs);
        const snapshot = closedBar !== null ? this.processClosedBar(state) : null;

        this.manageEscalation(ticker.symbol, state, price);

        return snapshot;
    }

    // Single recompute per closed bar (ADR §4): build the snapshot once here, cache a
    // cheap escalation baseline from it, and return it for trigger evaluation/emit.
    private processClosedBar(state: SymbolMarketState): IIndicatorSnapshot {
        const snapshot = computeIndicatorSnapshot({
            symbol: state.symbol,
            closedBars: state.candles5m.getClosedBars(),
            sessionBars: state.getSessionBars(),
            eventAnchoredVwap: state.getEventAnchoredVwap(),
        });

        this.escalationBaselines.set(state.symbol, this.toEscalationBaseline(snapshot));

        return snapshot;
    }

    // SINGLE AUTHORITY for the post-close sequence (ADR §4): evaluate the trigger for
    // each symbol that closed a bar, count same-bar triggers, emit volatility.detected
    // for those that fired, then record every closed bar for calibration. BOTH close
    // paths (tick and sweep) route here, so every graduated bar — active or quiet — is
    // evaluated, emitted, and calibrated identically. The ITriggerResult from this pass
    // is threaded into the emit so the side is never recomputed (ADR §3 ordering).
    private handleClosedBars(snapshots: IIndicatorSnapshot[]): void {
        const firedResults: { snapshot: IIndicatorSnapshot; result: ITriggerResult }[] = [];

        for (const snapshot of snapshots) {
            const result = this.evaluate(snapshot);

            if (result !== null && result.fired) {
                firedResults.push({ snapshot, result });
            }
        }

        const sameBarTriggerCount = firedResults.length;

        for (const { snapshot, result } of firedResults) {
            this.emitVolatilityDetected(snapshot, result, sameBarTriggerCount);
        }

        for (const snapshot of snapshots) {
            this.calibration.record(snapshot.symbol, snapshot.vwapDeviationPct);
        }
    }

    private evaluate(snapshot: IIndicatorSnapshot): ITriggerResult | null {
        const entry = this.universe.getEntry(snapshot.symbol);

        if (entry === null) {
            return null;
        }

        return evaluateTrigger(this.toTriggerInput(snapshot), resolveTriggerParams(entry.tier));
    }

    private emitVolatilityDetected(snapshot: IIndicatorSnapshot, result: ITriggerResult, sameBarTriggerCount: number): void {
        const entry = this.universe.getEntry(snapshot.symbol);

        if (entry === null) {
            return;
        }

        // Time base for the enriched payload is the CLOSED bar's close time, never
        // wall-clock — this is what makes the enrichment reproducible in backtest.
        const barCloseTimeMs = snapshot.closedBarOpenTimeMs + CANDLE_5M_INTERVAL_MS;

        const event = toVolatilityDetectedEvent({
            snapshot,
            side: result.side,
            coinTier: entry.tier,
            coinVolumeRank: entry.volumeRank,
            symbolUniverseAgeHours: this.universe.universeAgeHours(snapshot.symbol, barCloseTimeMs),
            regimeLabel: computeRegimeLabel(snapshot.adx14, snapshot.adxDiPlus, snapshot.adxDiMinus),
            btc5mMovePct: this.context.btc5mMovePct(barCloseTimeMs),
            btc1mMovePct: this.context.btc1mMovePct(barCloseTimeMs),
            eth5mMovePct: this.context.eth5mMovePct(barCloseTimeMs),
            // Idiosyncrasy compares the coin's bar-aligned move against BTC's move over
            // the SAME bar-to-bar horizon (not the rolling tape window) so the safety
            // filter is unbiased and reproducible.
            idiosyncrasyScore: computeIdiosyncrasyScore(this.context.btc5mBarMovePct(), snapshot.fiveMinMovePct),
            marketBreadth5mUpPct: this.context.breadth(barCloseTimeMs).upPct5m,
            sameBarTriggerCount,
            flow: this.assembleFlowContext(snapshot.symbol, barCloseTimeMs),
        });

        this.eventEmitter.emit(VOLATILITY_DETECTED_EVENT, event);
        this.logger.log(
            `volatility.detected ${event.symbol} side=${event.side} σ=${event.vwapDeviationSigma.toFixed(2)} ` +
                `dev=${event.vwapDeviationPct.toFixed(2)}% volRatio=${event.volumeRatio.toFixed(2)} ` +
                `tier=${event.coinTier} regime=${event.regimeLabel} flow=${event.flowType}`,
        );
    }

    private assembleFlowContext(symbol: string, barCloseTimeMs: number): IFlowLiquidityContext {
        const state = this.registry.get(symbol);

        if (state === null) {
            return this.emptyFlowContext();
        }

        return {
            openInterest: state.latestOpenInterest(),
            openInterestChange5mPct: state.openInterestChangePct(OI_CHANGE_5M_MS, barCloseTimeMs),
            openInterestChange15mPct: state.openInterestChangePct(OI_CHANGE_15M_MS, barCloseTimeMs),
            fundingRate: state.getFundingRate(),
            fundingRateAnnualized: state.getFundingRateAnnualized(),
            aggTradeBuyVolumeRatio: state.aggressorBuyRatio(BREADTH_WINDOW_5M_MS, barCloseTimeMs),
            bidAskSpreadPct: state.getSpreadPct(),
            bookDepth10bpsUsdt: state.getBookDepth10bpsUsdt(),
            bookDepth50bpsUsdt: state.getBookDepth50bpsUsdt(),
        };
    }

    private emptyFlowContext(): IFlowLiquidityContext {
        return {
            openInterest: null,
            openInterestChange5mPct: null,
            openInterestChange15mPct: null,
            fundingRate: null,
            fundingRateAnnualized: null,
            aggTradeBuyVolumeRatio: null,
            bidAskSpreadPct: null,
            bookDepth10bpsUsdt: null,
            bookDepth50bpsUsdt: null,
        };
    }

    // "Approaching trigger" is computed from already-streamed ticker data only: the
    // latest streamed price against the cached closed-bar baseline (cheap partial-σ),
    // never a full per-tick recompute and never the deep data it gates (ADR §2).
    private manageEscalation(symbol: string, state: SymbolMarketState, price: MoneyValue): void {
        const baseline = this.escalationBaselines.get(symbol);

        if (baseline === undefined) {
            return;
        }

        const params = resolveTriggerParams(state.getTier());
        const partialSigma = this.partialSigma(price, baseline);
        const approaching =
            Math.abs(partialSigma) >= params.vwapSigmaTrigger * APPROACHING_TRIGGER_FRACTION ||
            baseline.volumeRatio >= params.volumeRatioMin * APPROACHING_TRIGGER_FRACTION;

        this.applyEscalation(symbol, state, approaching);
    }

    // Approximate σ of the streamed price from the cached closed-bar VWAP/σ baseline.
    private partialSigma(price: MoneyValue, baseline: IEscalationBaseline): number {
        if (baseline.vwap20bar.isZero() || baseline.sigmaPctPerUnit === 0) {
            return 0;
        }

        const deviationPct = price.minus(baseline.vwap20bar).dividedBy(baseline.vwap20bar).times(100).toNumber();

        return deviationPct / baseline.sigmaPctPerUnit;
    }

    private toEscalationBaseline(snapshot: IIndicatorSnapshot): IEscalationBaseline {
        const sigmaPctPerUnit = snapshot.vwapDeviationSigma === 0 ? 0 : snapshot.vwapDeviationPct / snapshot.vwapDeviationSigma;

        return {
            vwap20bar: snapshot.vwap20bar,
            sigmaPctPerUnit,
            volumeRatio: snapshot.volumeRatio,
        };
    }

    private applyEscalation(symbol: string, state: SymbolMarketState, approaching: boolean): void {
        if (approaching && !state.isEscalated()) {
            state.setEscalated(true);
            this.depthAggressor.start(symbol);
            void this.flowPoll.pollOpenInterestForSymbol(symbol);

            return;
        }

        if (!approaching && state.isEscalated()) {
            state.setEscalated(false);
            this.depthAggressor.stop(symbol);
        }
    }

    private emitPriceUpdate(symbol: string, price: MoneyValue, timestampMs: number): void {
        const event: IPriceUpdateEvent = { symbol, price: price.toFixed(), timestampMs };

        this.eventEmitter.emit(PRICE_UPDATE_EVENT, event);
    }

    // !ticker@arr reports cumulative 24h quote volume, not per-tick volume. The
    // positive change between consecutive ticks approximates the volume traded
    // since the last tick — deterministic and good enough for 5m aggregation.
    private deriveVolumeDelta(ticker: ITickerSnapshot): MoneyValue {
        if (ticker.quoteVolume === null) {
            return new Money(0);
        }

        const current = parseMoney(ticker.quoteVolume);
        const previous = this.previousQuoteVolume.get(ticker.symbol);

        this.previousQuoteVolume.set(ticker.symbol, current);

        if (previous === undefined) {
            return new Money(0);
        }

        const delta = current.minus(previous);

        return delta.isNegative() ? new Money(0) : delta;
    }

    private toTriggerInput(snapshot: IIndicatorSnapshot): IClosedBarTriggerInput {
        return {
            symbol: snapshot.symbol,
            vwapDeviationSigma: snapshot.vwapDeviationSigma,
            vwapDeviationPct: snapshot.vwapDeviationPct,
            volumeRatio: snapshot.volumeRatio,
        };
    }
}
