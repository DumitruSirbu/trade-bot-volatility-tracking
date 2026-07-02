import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExchangeEnvironmentEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    IMarketSnapshot,
    IMomentumParams,
    IStrategyParams,
    IUniverseRebalanceDueEvent,
    momentumParamsSchema,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RebalanceTriggerSourceEnum,
    RegimeLabelEnum,
    RiskOutcomeEnum,
    StopTypeEnum,
    UNIVERSE_REBALANCE_DUE_EVENT,
    UniverseEntry,
    VwapAnchorTypeEnum,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { MS_PER_MINUTE, ORDER_INTENT_APPROVED_EVENT } from '../../common/const';
import { Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { ATR_PERIOD } from '../../market-data/const';
import { PRICE_TAPE_RETENTION_MS } from '../../market-data/const/candleConsts';
import { computeAtr } from '../../market-data/indicator/computeAtr';
import { CandleRepository } from '../../market-data/repository/CandleRepository';
import { UniverseMembershipRepository } from '../../market-data/repository/UniverseMembershipRepository';
import { SymbolStateRegistry } from '../../market-data/service/SymbolStateRegistry';
import { UniverseService } from '../../market-data/service/UniverseService';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { IOrderIntent, IOrderIntentApprovedEvent, IRiskDecision, IRiskGateContext, IRiskLimits } from '../../risk/interface';
import { InstrumentPortAdapter, OpenPositionsPortAdapter, PositionSizer, RiskGateService, RiskStatePortAdapter } from '../../risk/service';
import { DecisionRepository } from '../repository/DecisionRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { XMomPortfolioStrategy } from '../strategies/XMomPortfolioStrategy';

// Persisted 5m candle interval key for the cold-boot lookback fallback (no shared const exists;
// backtest/CandleLoader carries the same local literal).
const CANDLE_INTERVAL_5M = '5m';

// Neutral market-breadth value (= MARKET_BREADTH_NEUTRAL_PCT) used in the synthesized momentum
// snapshot so the risk gate's breadth-stress leg never engages on fabricated data. Kept local so
// the strategy layer does not reach into risk/const for a bare scalar.
const MOMENTUM_NEUTRAL_BREADTH_PCT = 50;

const MOMENTUM_NEUTRAL_BUY_FLOW_RATIO = 0.5;

const MOMENTUM_NEUTRAL_RSI = 50;

// ATR period for momentum stop sizing: 24h of 5m bars (12 bars/h × 24h).
const MOMENTUM_ATR_PERIOD = 288;

// Per-rebalance leg context threaded through the open/close leg builders (ADR 0048 M50c). Groups
// the three values every leg of a single rebalance shares — the rebalance instant, its trigger
// provenance, and the resolved momentum params — so the leg methods take one cohesive object
// instead of 2-3 loose scalars. `symbol`/`rank`/`position` stay separate: they vary per leg.
interface IRebalanceLegContext {
    readonly nowMs: number;
    readonly triggerSource: RebalanceTriggerSourceEnum;
    readonly params: IMomentumParams;
}

// The M50 rebalance orchestrator (ADR 0048 §2.3). On each UNIVERSE_REBALANCE_DUE_EVENT it builds
// the universe snapshot, calls the pure ranking core (via XMomPortfolioStrategy), diffs the
// selection against open momentum positions, and routes every leg through the UNCHANGED risk gate
// → execution seam (ORDER_INTENT_APPROVED_EVENT). It never bypasses the gate and never calls the
// exchange directly. Closes precede opens (ADR 0048 §2.4) and a single in-flight flag guards
// against overlapping rebalances (§2.5). Paper-only: any non-paper env is a logged no-op (§2.6).
@Injectable()
export class MomentumOrchestratorService {
    private readonly logger = new Logger(MomentumOrchestratorService.name);

    private isRebalancing = false;

    private cachedVersionId: number | null = null;

    private activeVersionId!: number;

    private activeParams!: IMomentumParams;

    constructor(
        private readonly config: AppConfigService,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly universe: UniverseService,
        private readonly symbolStates: SymbolStateRegistry,
        private readonly candles: CandleRepository,
        private readonly positions: PositionRepository,
        private readonly riskGate: RiskGateService,
        private readonly instrumentPort: InstrumentPortAdapter,
        private readonly sizer: PositionSizer,
        private readonly riskStatePort: RiskStatePortAdapter,
        private readonly openPositionsPort: OpenPositionsPortAdapter,
        private readonly universeMembership: UniverseMembershipRepository,
        private readonly decisions: DecisionRepository,
        private readonly strategy: XMomPortfolioStrategy,
        private readonly events: EventEmitter2,
    ) {}

    @OnEvent(UNIVERSE_REBALANCE_DUE_EVENT)
    async onRebalanceDue(event: IUniverseRebalanceDueEvent): Promise<void> {
        if (this.config.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            this.logger.warn(`rebalance ignored — exchangeEnv=${this.config.exchangeEnv} (momentum path is paper-only)`);

            return;
        }

        if (this.isRebalancing) {
            this.logger.warn('rebalance_overlap_skipped — a prior rebalance is still in flight');

            return;
        }

        this.isRebalancing = true;

        try {
            if (!(await this.resolveActiveVersion())) {
                return;
            }

            await this.rebalance(event.nowMs, event.triggerSource);
        } catch (cause) {
            this.logger.error(`rebalance failed: ${formatErrorCause(cause)}`);
        } finally {
            this.isRebalancing = false;
        }
    }

    // Load + cache the active portfolio version. Reloads only when the configured id changes
    // (a config change + restart in practice). Returns false when the path is dormant / unresolved.
    private async resolveActiveVersion(): Promise<boolean> {
        const versionId = this.config.activePortfolioStrategyVersionId;

        if (versionId === null) {
            return false;
        }

        if (this.cachedVersionId === versionId) {
            return true;
        }

        const row = await this.strategyVersions.findById(versionId);

        if (row === null) {
            this.logger.warn(`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID=${versionId} matches no strategy_versions row`);

            return false;
        }

        this.activeParams = momentumParamsSchema.parse(row.params);
        this.activeVersionId = row.id;
        this.cachedVersionId = row.id;

        return true;
    }

    private async rebalance(nowMs: number, triggerSource: RebalanceTriggerSourceEnum): Promise<void> {
        const params = this.activeParams;
        const context: IRebalanceLegContext = { nowMs, triggerSource, params };
        const universe = await this.buildUniverse(params, nowMs);
        const selection = this.strategy.selectUniverse({ universe, params, nowMs });
        const ranked = selection.ranked;
        const rankedSymbols = new Set(ranked.map((entry) => entry.symbol));

        const openPositions = (await this.positions.findOpen()).filter((position) => position.strategyVersionId === this.activeVersionId);
        const openSymbols = new Set(openPositions.map((position) => position.symbol));

        this.logger.log(
            `rebalance reason=${selection.reason} ranked=${ranked.length} retained_target=${params.top_n} open=${[...openSymbols].join(',') || '-'}`,
        );

        // ADR 0050 §2.2 step 1 — definite de-rank closes (symbol absent from ranked entirely).
        const definiteCloses = openPositions
            .filter((position) => !rankedSymbols.has(position.symbol))
            .sort((left, right) => left.symbol.localeCompare(right.symbol));

        for (const position of definiteCloses) {
            await this.processClose(position, context);
        }

        const survivingOpenSymbols = new Set(openPositions.filter((position) => rankedSymbols.has(position.symbol)).map((position) => position.symbol));
        const retained = new Set<string>();
        let filled = 0;

        // ADR 0050 §2.2 step 2 — cascade walk: hold-or-open in rank order until top_n fills.
        for (const entry of ranked) {
            if (filled >= params.top_n) {
                break;
            }

            if (survivingOpenSymbols.has(entry.symbol)) {
                retained.add(entry.symbol);
                filled++;

                continue;
            }

            const approved = await this.processOpen(entry.symbol, entry.rank, context);

            if (approved) {
                retained.add(entry.symbol);
                filled++;
            }
        }

        // ADR 0050 §2.2 step 3 — residual de-rank closes (ranked but not retained after the walk).
        const residualCloses = openPositions
            .filter((position) => rankedSymbols.has(position.symbol) && !retained.has(position.symbol))
            .sort((left, right) => left.symbol.localeCompare(right.symbol));

        for (const position of residualCloses) {
            await this.processClose(position, context);
        }
    }

    // Join membership (UniverseService) with a per-symbol trailing return (ADR 0048 §5). Symbols
    // whose return cannot be resolved (in-memory tape too short AND persisted candles insufficient)
    // are excluded by the builder before the pure core sees them.
    private async buildUniverse(params: IMomentumParams, nowMs: number): Promise<UniverseEntry[]> {
        const entries: UniverseEntry[] = [];

        for (const membership of this.universe.getEntries()) {
            const trailingReturnPct = await this.resolveTrailingReturn(membership.symbol, params, nowMs);

            if (trailingReturnPct === null) {
                continue;
            }

            entries.push({ symbol: membership.symbol, trailingReturnPct, tier: toTierNumber(membership.tier) });
        }

        return entries;
    }

    private async resolveTrailingReturn(symbol: string, params: IMomentumParams, nowMs: number): Promise<number | null> {
        if (params.lookback_ms <= PRICE_TAPE_RETENTION_MS) {
            const state = this.symbolStates.get(symbol);

            if (state !== null) {
                const move = state.movePctOverWindow(params.lookback_ms, nowMs);

                if (move !== null && Number.isFinite(move)) {
                    return move;
                }
            }
        }

        return this.resolveTrailingReturnFromCandles(symbol, params, nowMs);
    }

    // Cold-boot fallback (ADR 0048 §5 coverage note): the in-memory tape may not span lookback_ms,
    // so source the lookback close from the persisted 5m candles. Returns null when fewer than two
    // bars are available in the window.
    private async resolveTrailingReturnFromCandles(symbol: string, params: IMomentumParams, nowMs: number): Promise<number | null> {
        const from = new Date(nowMs - params.lookback_ms);
        const to = new Date(nowMs);
        const bars = await this.candles.findRange(symbol, CANDLE_INTERVAL_5M, from, to);

        if (bars.length < 2) {
            return null;
        }

        const first = bars[0].close;
        const last = bars[bars.length - 1].close;

        if (first.isZero()) {
            return null;
        }

        return last.minus(first).dividedBy(first).times(100).toNumber();
    }

    private async processClose(position: PositionEntity, context: IRebalanceLegContext): Promise<void> {
        const { nowMs, params } = context;
        const state = this.symbolStates.get(position.symbol);
        const midAtTrigger = state?.candles5m.getLatestClosedBar()?.close ?? position.entryPrice;
        const intent = this.buildMomentumCloseIntent(position, midAtTrigger, context);
        const snapshot = this.buildMomentumSnapshot(position.symbol, position.entryPrice, new Money(0), position.coinTier ?? CoinTierEnum.TIER_2, 0, nowMs);

        await this.evaluateAndEmit(intent, snapshot, position.positionSlot ?? null, nowMs, params);
    }

    private async processOpen(symbol: string, rank: number, context: IRebalanceLegContext): Promise<boolean> {
        const { nowMs, params } = context;
        const intent = await this.buildMomentumOpenIntent(symbol, rank, context);

        if (intent === null) {
            this.logger.log(`momentum open skipped ${symbol} — no price/ATR/instrument/sizing`);

            return false;
        }

        const atr14 = intent.proposedExit.atrDistance ?? new Money(0);
        const snapshot = this.buildMomentumSnapshot(symbol, intent.entryPrice, atr14, intent.coinTier, intent.signalScore, nowMs);

        return this.evaluateAndEmit(intent, snapshot, null, nowMs, params);
    }

    // Long-only momentum open (ADR 0048 §3). Returns null (a logged skip) on any missing input —
    // no price bar, insufficient bars for ATR, unknown instrument, or a non-sized order.
    private async buildMomentumOpenIntent(symbol: string, rank: number, context: IRebalanceLegContext): Promise<IOrderIntent | null> {
        const { nowMs, params, triggerSource } = context;
        const state = this.symbolStates.get(symbol);
        const latestBar = state?.candles5m.getLatestClosedBar() ?? null;

        if (state === null || latestBar === null) {
            return null;
        }

        const entryPrice = latestBar.close;
        const atrBars = await this.candles.findRange(symbol, CANDLE_INTERVAL_5M, new Date(nowMs - params.lookback_ms), new Date(nowMs));

        if (atrBars.length < 2) {
            return null;
        }

        const atr24h = computeAtr(atrBars, Math.min(atrBars.length - 1, MOMENTUM_ATR_PERIOD));

        if (atr24h.lessThanOrEqualTo(0)) {
            return null;
        }

        const instrument = await this.instrumentPort.findConstraints(symbol);

        if (instrument === null) {
            return null;
        }

        const stopDistance = atr24h.times(params.xmom_atr_stop_multiplier);
        const stopLossPrice = entryPrice.minus(stopDistance);
        const takeProfitPrice = entryPrice.plus(stopDistance.times(params.xmom_min_rr));

        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
            atr14: atr24h,
            atrStopMultiplier: params.xmom_atr_stop_multiplier,
            entryPrice,
            stopLossPrice,
            tradeSide: PositionSideEnum.LONG,
            // Momentum does not apply funding suppression (long-only follow; funding-fade rules are
            // VWAP-path-specific). Zero rate + zero threshold neutralize the sizer's funding cut.
            fundingRate: 0,
            fundingRateAnnualized: 0,
            fundingRateSuppressThreshold: 0,
            maxExposurePerCoinUsdt: new Money(this.config.maxExposurePerCoinUsdt),
            instrument,
        });

        if (sizingResult.kind !== 'sized') {
            return null;
        }

        const coinTier = this.universe.getEntry(symbol)?.tier ?? CoinTierEnum.TIER_2;

        return {
            intentAction: OrderIntentActionEnum.OPEN,
            symbol,
            // triggerSource is appended so the decision row is queryable by manual-vs-scheduled
            // without a schema change (eventId is a free-text, indexed column) — ADR 0048 §10.
            eventId: `xmom-open-${symbol}-${nowMs}-${triggerSource}`,
            tradeSide: PositionSideEnum.LONG,
            // rank 1 → 100, rank 2 → 50, … — deterministic, monotonic in rank (ADR 0048 §3).
            signalScore: Math.round(100 / rank),
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier,
            idiosyncrasyScore: 1,
            entryPrice,
            referencePrice: entryPrice,
            midAtTrigger: entryPrice,
            maintenanceMarginRate: instrument.maintenanceMarginRate,
            proposedExit: {
                takeProfitPrice,
                stopLossPrice,
                stopType: StopTypeEnum.ATR,
                // Momentum hold is time-driven at the rebalance cadence, not bar-driven. The 2×
                // margin is a safety net: the time-stop enforcer must never fire before the next
                // rebalance boundary, else a still-ranked winner is closed then reopened (double fees).
                timeStopAtMs: nowMs + params.rebalance_interval_ms * 2,
                tpRebaseEligible: false,
                atrDistance: atr24h,
            },
            openPosition: null,
            sizing: sizingResult.sizing,
            flowType: FlowTypeEnum.TREND_INITIATION,
            // ADR 0048 M50c: rides the intent → executor → positions.trigger_source so the analysis
            // surfaces can fence manual rebalances out of the primary calibration aggregation.
            triggerSource,
        };
    }

    // De-rank close intent — the exact ReconciliationService.buildCloseIntent blueprint. Risk-
    // reducing, so the gate auto-approves it and it passes under a halt (ADR 0048 §2.3 / ADR 0046).
    private buildMomentumCloseIntent(position: PositionEntity, midAtTrigger: MoneyValue, context: IRebalanceLegContext): IOrderIntent {
        const { nowMs, triggerSource } = context;
        const closeSide = position.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;

        return {
            intentAction: OrderIntentActionEnum.CLOSE,
            symbol: position.symbol,
            // triggerSource appended for manual-vs-scheduled queryability without a schema change.
            eventId: `xmom-close-${position.id}-${nowMs}-${triggerSource}`,
            tradeSide: closeSide,
            signalScore: 0,
            correlationMode: position.correlationMode ?? CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: position.coinTier ?? CoinTierEnum.TIER_2,
            idiosyncrasyScore: 0,
            entryPrice: position.entryPrice,
            referencePrice: position.entryPrice,
            midAtTrigger,
            maintenanceMarginRate: new Money(0),
            proposedExit: {
                takeProfitPrice: midAtTrigger,
                stopLossPrice: midAtTrigger,
                stopType: StopTypeEnum.ATR,
                timeStopAtMs: 0,
                tpRebaseEligible: false,
                atrDistance: null,
            },
            openPosition: null,
            sizing: {
                qty: position.qty,
                notional: position.qty.times(midAtTrigger),
                leverage: position.leverage,
                riskPerTradeUsdt: new Money(0),
                effectiveRiskUsdt: new Money(0),
            },
            flowType: FlowTypeEnum.TREND_INITIATION,
            exitReason: ExitReasonEnum.MANUAL,
        };
    }

    // Route one leg through the unchanged gate, persist a decision row, and — on approval — emit the
    // executor seam. Command flow only; the gate reserves/decides, execution places the order.
    private async evaluateAndEmit(
        intent: IOrderIntent,
        snapshot: IMarketSnapshot,
        positionSlotFallback: PositionSlotEnum | null,
        nowMs: number,
        params: IMomentumParams,
    ): Promise<boolean> {
        const gateStrategyParams = this.buildGateStrategyParams(params);
        const context = await this.buildGateContext(intent.symbol, snapshot, nowMs, gateStrategyParams);
        const decision = await this.riskGate.evaluate(intent, context);

        await this.persistDecision(intent, snapshot, decision, nowMs);

        if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
            this.logger.log(`momentum ${intent.intentAction} ${intent.symbol} not approved reason=${decision.rejectReason ?? 'unknown'}`);

            return false;
        }

        this.emitApproval(intent, snapshot, decision, positionSlotFallback, gateStrategyParams);

        return true;
    }

    private emitApproval(
        intent: IOrderIntent,
        snapshot: IMarketSnapshot,
        decision: IRiskDecision,
        positionSlotFallback: PositionSlotEnum | null,
        gateStrategyParams: IStrategyParams,
    ): void {
        const isOpen = intent.intentAction === OrderIntentActionEnum.OPEN;

        const payload: IOrderIntentApprovedEvent = {
            intent,
            approvedSlot: decision.approvedSlot ?? positionSlotFallback ?? PositionSlotEnum.A,
            approvedSizing: decision.approvedSizing ?? intent.sizing,
            clampedExit: decision.clampedExit ?? intent.proposedExit,
            reservationId: decision.reservationId,
            entrySnapshot: isOpen ? snapshot : undefined,
            strategyVersionId: this.activeVersionId,
            // M48 fill-anchored geometry needs the versioned geometry params stamped at approval.
            // Only opening approvals carry it (de-risking closes never re-run geometry).
            geometryParams: isOpen
                ? {
                      min_rr: gateStrategyParams.min_rr,
                      atr_floor_multiplier: gateStrategyParams.atr_floor_multiplier,
                      entry_pct_floor: gateStrategyParams.entry_pct_floor,
                  }
                : undefined,
        };

        this.events.emit(ORDER_INTENT_APPROVED_EVENT, payload);
        this.logger.log(`momentum ${intent.intentAction} ${intent.symbol} approved slot=${payload.approvedSlot}`);
    }

    private async buildGateContext(symbol: string, snapshot: IMarketSnapshot, nowMs: number, gateStrategyParams: IStrategyParams): Promise<IRiskGateContext> {
        const belowUniverseFloor = (await this.universeMembership.findOpenMembership(symbol)) === null;

        return {
            nowMs,
            utcDateString: new Date(nowMs).toISOString().slice(0, 10),
            snapshot,
            params: gateStrategyParams,
            strategyVersionId: this.activeVersionId,
            belowUniverseFloor,
            limits: this.resolveRiskLimits(),
            riskState: this.riskStatePort,
            openPositions: this.openPositionsPort,
            instruments: this.instrumentPort,
            modelDivergenceDetected: false,
        };
    }

    // Operator-level risk limits — identical resolution to StrategyService.resolveRiskLimits, so
    // momentum shares the same loss/exposure/cooldown caps as the VWAP path (ADR 0047 §2.4).
    private resolveRiskLimits(): IRiskLimits {
        return {
            dailyLossLimitUsdt: new Money(this.config.dailyLossLimitUsdt),
            weeklyLossLimitUsdt: new Money(this.config.weeklyLossLimitUsdt),
            maxExposurePerCoinUsdt: new Money(this.config.maxExposurePerCoinUsdt),
            maxSameDirectionExposureUsdt: new Money(this.config.maxSameDirectionExposureUsdt),
            cooldownAfterLossMs: this.config.cooldownAfterLossMs,
        };
    }

    // Synthesizes the IStrategyParams the gate reads for a momentum leg (see class + report notes).
    // The gate's contract is IStrategyParams (VWAP-shaped); momentum has no such row, so the leg-
    // relevant fields are set explicitly: time_stop_minutes spans the rebalance cadence (else a 24h
    // momentum time-stop would fail checkTimeStop), OI/funding-fade rules are disabled (long-only),
    // and the stress-leg params are inert (M28: stress engages on engine consts, not these). The
    // REAL money limits ride on context.limits, not here.
    private buildGateStrategyParams(params: IMomentumParams): IStrategyParams {
        return {
            vwap_window_bars: 20,
            vwap_sigma_trigger: 2,
            volume_ratio_min: 1,
            atr_period: ATR_PERIOD,
            atr_stop_multiplier: params.xmom_atr_stop_multiplier,
            time_stop_minutes: Math.ceil(params.rebalance_interval_ms / MS_PER_MINUTE),
            idiosyncrasy_min_score: 0,
            btc_correlated_move_threshold_pct: 1,
            max_open_positions: this.config.maxOpenPositions,
            max_btc_correlated_positions: 1,
            tier1_min_abs_move_pct: 0.1,
            tier2_min_abs_move_pct: 0.1,
            tier3_min_abs_move_pct: 0.1,
            tier1_max_abs_move_pct: 100,
            tier2_max_abs_move_pct: 100,
            tier3_max_abs_move_pct: 100,
            funding_rate_suppress_threshold: 1,
            candle_interval: CANDLE_INTERVAL_5M,
            slippage_tier1_pct: 0.05,
            slippage_tier2_pct: 0.05,
            slippage_tier3_pct: 0.05,
            require_oi_available: false,
            oi_rising_skip: false,
            consecutive_loss_halt: 3,
            max_trades_per_symbol_per_day: 5,
            max_trades_per_bar_universe: 50,
            stress_btc_1m_shock_pct: 1,
            stress_eth_1m_shock_pct: 1,
            stress_breadth_pct: MOMENTUM_NEUTRAL_BREADTH_PCT,
            stress_same_bar_trigger_count: 20,
            structural_stop_wick_buffer_pct: 0.1,
            structural_stop_hard_cap_pct: 5,
            min_rr: params.xmom_min_rr,
            entry_pct_floor: 0.3,
            atr_floor_multiplier: 1,
            max_tp_dist_factor: 5,
        };
    }

    // A gate-safe momentum market snapshot. Per-coin liquidity fields (spread/depth/OI/funding) are
    // sourced from the live SymbolMarketState so the gate's REAL per-coin depth/spread safety runs;
    // global-stress fields are neutral so momentum is not gated on fabricated market-wide stress.
    private buildMomentumSnapshot(
        symbol: string,
        entryPrice: MoneyValue,
        atr14: MoneyValue,
        coinTier: CoinTierEnum,
        signalScore: number,
        nowMs: number,
    ): IMarketSnapshot {
        const state = this.symbolStates.get(symbol);
        const price = entryPrice.toFixed();

        return {
            vwap_session: price,
            vwap_20bar: price,
            vwap_deviation_pct: 0,
            vwap_deviation_sigma: 0,
            volume_ratio: 1,
            volume_20bar_avg: '0',
            atr_14: atr14.toFixed(),
            adx_14: 0,
            adx_di_plus: 0,
            adx_di_minus: 0,
            rsi_14: MOMENTUM_NEUTRAL_RSI,
            bollinger_upper: price,
            bollinger_lower: price,
            bollinger_pct_b: 0.5,
            btc_5m_move_pct: 0,
            idiosyncrasy_score: 1,
            funding_rate: state?.getFundingRate() ?? 0,
            funding_rate_annualized: state?.getFundingRateAnnualized() ?? 0,
            bid_ask_spread_pct: state?.getSpreadPct() ?? 0,
            estimated_slippage_pct: 0,
            coin_tier: coinTier,
            coin_volume_rank: this.universe.getEntry(symbol)?.volumeRank ?? 0,
            correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
            signal_score: signalScore,
            position_slot: PositionSlotEnum.A,
            active_positions_count: 0,
            regime_label: RegimeLabelEnum.TRENDING_UP,
            entry_candle_open_time: nowMs,
            open_interest: (state?.latestOpenInterest() ?? new Money(0)).toFixed(),
            open_interest_change_5m_pct: 0,
            open_interest_change_15m_pct: 0,
            agg_trade_buy_volume_ratio: MOMENTUM_NEUTRAL_BUY_FLOW_RATIO,
            market_breadth_5m_up_pct: MOMENTUM_NEUTRAL_BREADTH_PCT,
            same_bar_trigger_count: 0,
            book_depth_10bps_usdt: (state?.getBookDepth10bpsUsdt() ?? new Money(0)).toFixed(),
            book_depth_50bps_usdt: (state?.getBookDepth50bpsUsdt() ?? new Money(0)).toFixed(),
            vwap_anchor_type: VwapAnchorTypeEnum.SESSION,
            symbol_universe_age_hours: 0,
            btc_1m_move_pct: 0,
            eth_5m_move_pct: 0,
            flow_type: FlowTypeEnum.TREND_INITIATION,
        };
    }

    private async persistDecision(intent: IOrderIntent, snapshot: IMarketSnapshot, decision: IRiskDecision, nowMs: number): Promise<void> {
        const approved = decision.outcome === RiskOutcomeEnum.APPROVED;

        await this.decisions.record({
            symbol: intent.symbol,
            strategyVersionId: this.activeVersionId,
            ts: new Date(nowMs),
            eventId: intent.eventId,
            signalType: intent.flowType,
            marketSnapshot: snapshot,
            gateAllowed: approved,
            tradeSide: intent.tradeSide,
            stopLoss: (decision.clampedExit ?? intent.proposedExit).stopLossPrice.toFixed(),
            takeProfit: (decision.clampedExit ?? intent.proposedExit).takeProfitPrice.toFixed(),
            qty: (decision.approvedSizing ?? intent.sizing).qty.toFixed(),
            notional: (decision.approvedSizing ?? intent.sizing).notional.toFixed(),
            leverage: (decision.approvedSizing ?? intent.sizing).leverage.toFixed(),
            haltReasonDetail: decision.haltReasonDetail,
            haltRelaxActive: this.config.paperRelaxConsecutiveLossHalt,
            action: intent.intentAction,
            reason: decision.rejectReason ?? intent.intentAction,
        });
    }
}

// tier1/2/3 → 1/2/3 for the shared UniverseEntry.tier scalar (the ranking core carries the tier
// as a number; membership stores it as CoinTierEnum). The core does not rank on tier today.
function toTierNumber(tier: CoinTierEnum): number {
    if (tier === CoinTierEnum.TIER_1) {
        return 1;
    }

    if (tier === CoinTierEnum.TIER_2) {
        return 2;
    }

    return 3;
}

function formatErrorCause(cause: unknown): string {
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
