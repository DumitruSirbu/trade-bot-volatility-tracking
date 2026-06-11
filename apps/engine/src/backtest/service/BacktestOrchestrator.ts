import {
    classifyFlowType,
    computeSignalScore,
    CorrelationModeEnum,
    FlowTypeEnum,
    IBacktestConfig,
    IBacktestPosition,
    IStrategyParams,
    IVolatilityDetectedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    SignalActionEnum,
    StrategyDirectionEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { Money, MoneyValue } from '../../common/utils/money';
import { TickAggregateEntity, BookSnapshotEntity } from '../../market-data/entity';
import { CANDLE_5M_INTERVAL_MS } from '../../market-data/const/candleConsts';
import {
    COOLDOWN_AFTER_LOSS_MS,
    DAILY_LOSS_LIMIT_USDT,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../risk/const/riskConsts';
import { IApprovedRiskDecision, IOrderIntent, IRiskGateContext, isApprovedOpening } from '../../risk/interface';
import { PositionSizer, ReservationLedger, RiskGateService } from '../../risk/service';
import { buildMarketSnapshot } from '../../strategy/mapper';
import { IOpenPositionState, IStrategy, ISignal } from '../../strategy/interface';
import { BacktestInstrumentAdapter } from '../adapter/BacktestInstrumentAdapter';
import { BacktestPositionAdapter } from '../adapter/BacktestPositionAdapter';
import { BacktestRiskStateAdapter } from '../adapter/BacktestRiskStateAdapter';
import { BACKTEST_ORDER_POLICY_ROUTER } from '../const/backtestTokens';
import { HistoricalFillAdapter, IFillRequest } from '../fill/HistoricalFillAdapter';
import { type ITierSlippageParams } from '@bot/shared';
import { IOrderPolicyRouter } from '../interface';
import { BacktestBook } from '../state/BacktestBook';
import { BacktestPnLLedger } from '../state/BacktestPnLLedger';
import { BacktestExecutionSink } from './BacktestExecutionSink';

// Per-event composition root for the backtest replay (ADR 0015 §2.5). Mirrors live
// StrategyService.route() one-to-one — classify flow + score, build snapshot, run the
// active strategy, gate-check, simulate fill, record — but reads/writes ONLY the in-memory
// IBacktestOrchestratorContext bundle. No DB, no events. The same RiskGateService and
// PositionSizer drive both paths so the gate logic stays bypass-proof and the sizing math
// stays identical across live and replay.
//
// ADD (signal onto an existing open position) is out of scope here just as it is in live
// M4: PositionSizer always sizes a fresh full position, so executing an ADD would double
// the exposure. The orchestrator records it as a skip and moves on.

// Everything one event needs that is bound to ONE backtest run (not the engine lifetime).
// The runner constructs this per-run; nothing here is registered with NestJS DI so a
// replay cannot leak state into the live container.
export interface IBacktestOrchestratorContext {
    readonly book: BacktestBook;
    readonly ledger: BacktestPnLLedger;
    readonly sink: BacktestExecutionSink;
    readonly positionAdapter: BacktestPositionAdapter;
    readonly riskStateAdapter: BacktestRiskStateAdapter;
    readonly instrumentAdapter: BacktestInstrumentAdapter;
    readonly reservationLedger: ReservationLedger;
    readonly fillSim: HistoricalFillAdapter;
    readonly ticks: TickAggregateEntity[];
    readonly bookSnapshot: BookSnapshotEntity | null;
    readonly strategy: IStrategy;
    readonly params: IStrategyParams;
    readonly strategyVersionId: number;
    readonly tierSlippageParams: ITierSlippageParams;
    readonly config: IBacktestConfig;
    readonly isInUniverse: boolean;
    readonly utcDateString: string;
    readonly allocatedCapitalUsdt: string;
    // M7 R1a fix-3 (quant, ADR-0015 §6): entries fill at `nextBarOpen + latencyMs`.
    // The orchestrator uses this open as the reference entry price (replaces the prior
    // signal-bar VWAP-derived figure). `null` when the signal bar is the last replay bar
    // for the symbol — in that case no fill can occur and `buildOrderIntent` returns null.
    readonly nextBarOpen: MoneyValue | null;
}

// The orchestrator's verdict for one event. Exactly one of the four booleans is true (the
// states are mutually exclusive); the runner aggregates the counts into IBacktestReport.
export interface IOrchestratorResult {
    readonly skipped: boolean;
    readonly rejectedByGate: boolean;
    readonly missedFill: boolean;
    readonly filled: boolean;
}

const SKIPPED: IOrchestratorResult = Object.freeze({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
const REJECTED: IOrchestratorResult = Object.freeze({ skipped: false, rejectedByGate: true, missedFill: false, filled: false });
const MISSED: IOrchestratorResult = Object.freeze({ skipped: false, rejectedByGate: false, missedFill: true, filled: false });
const FILLED: IOrchestratorResult = Object.freeze({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });

@Injectable()
export class BacktestOrchestrator {
    private readonly logger = new Logger(BacktestOrchestrator.name);

    constructor(
        private readonly riskGate: RiskGateService,
        private readonly sizer: PositionSizer,
        // M8 W1: order-policy routing is the live `OrderPolicyRouter` by default so backtest
        // routing matches live byte-for-byte. The DI token is loose-typed (`IOrderPolicyRouter`)
        // so tests can substitute a single-policy fake without dragging ExecutionModule into
        // the replay container. Live router has no I/O — see OrderPolicyRouter doc comment.
        @Inject(BACKTEST_ORDER_POLICY_ROUTER) private readonly policyRouter: IOrderPolicyRouter,
    ) {}

    async processEvent(event: IVolatilityDetectedEvent, ctx: IBacktestOrchestratorContext): Promise<IOrchestratorResult> {
        const nowMs = event.entryCandleOpenTime + CANDLE_5M_INTERVAL_MS;
        const flowType = classifyFlowType(event, ctx.params);
        const signalScore = computeSignalScore(event, ctx.params, flowType);
        const stampedEvent: IVolatilityDetectedEvent = { ...event, flowType };
        const snapshot = buildMarketSnapshot({ event: stampedEvent, params: ctx.params, flowType, signalScore });

        const openPosition = this.loadOpenPosition(event.symbol, ctx.book);
        const signal = ctx.strategy.evaluate({ event: stampedEvent, snapshot, openPosition, params: ctx.params, nowMs });

        if (!this.isOpenSignal(signal)) {
            return SKIPPED;
        }

        if (openPosition !== null) {
            // ADD onto an existing position is out of scope (matches live StrategyService).
            return SKIPPED;
        }

        if (signal.tradeSide === null || signal.proposedExit === null) {
            return SKIPPED;
        }

        const intent = await this.buildOrderIntent(stampedEvent, signal, ctx);

        if (intent === null) {
            return SKIPPED;
        }

        const gateContext = this.buildGateContext(stampedEvent, snapshot, nowMs, ctx);
        // M7 R1a fix-1 (security): thread the per-run reservation ledger so the gate never
        // mutates the DI singleton during a backtest replay.
        const decision = await this.riskGate.evaluate(intent, gateContext, ctx.reservationLedger);

        if (!isApprovedOpening(decision)) {
            return REJECTED;
        }

        return this.simulateAndRecord(stampedEvent, signal, decision, intent, ctx);
    }

    private isOpenSignal(signal: ISignal): boolean {
        return signal.action === SignalActionEnum.OPEN;
    }

    // Locate the (at most one) open position for this symbol in the in-memory book and
    // surface it as the strategy's IOpenPositionState. ADD/REDUCE/CLOSE branches read this
    // exactly the way live StrategyService.loadOpenPositionState does.
    private loadOpenPosition(symbol: string, book: BacktestBook): IOpenPositionState | null {
        for (const position of book.openPositions.values()) {
            if (position.symbol === symbol) {
                return this.toOpenPositionState(position);
            }
        }

        return null;
    }

    private toOpenPositionState(position: IBacktestPosition): IOpenPositionState {
        return Object.freeze({
            side: position.side === 'long' ? PositionSideEnum.LONG : PositionSideEnum.SHORT,
            entryPrice: new Money(position.entryPriceUsdt),
            qty: new Money(position.qty),
            entryNotional: new Money(position.entryNotionalUsdt),
            // The backtest does not persist strategy_versions.id onto IBacktestPosition;
            // surface it via the active run's id so strategy reads stay consistent.
            strategyVersionId: -1,
            positionSlot: position.slot,
            openedAtMs: position.openedAtMs,
            timeStopAtMs: position.timeStopAtMs,
        });
    }

    private async buildOrderIntent(event: IVolatilityDetectedEvent, signal: ISignal, ctx: IBacktestOrchestratorContext): Promise<IOrderIntent | null> {
        const instrument = await ctx.instrumentAdapter.findConstraints(event.symbol);

        if (instrument === null) {
            return null;
        }

        if (signal.tradeSide === null || signal.proposedExit === null) {
            return null;
        }

        // M7 R1a fix-3 (quant, ADR-0015 §6): the entry fills at the next bar's open. The
        // signal-bar VWAP×(1+dev%) figure was a reference price at signal close — using it
        // as the fill price is forward-look. When the signal bar is the last replay bar
        // for the symbol, no next bar exists and the orchestrator cannot construct a fill.
        if (ctx.nextBarOpen === null) {
            return null;
        }

        const entryPrice = ctx.nextBarOpen;

        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(ctx.allocatedCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: ctx.params.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: ctx.params.funding_rate_suppress_threshold,
            maxExposurePerCoinUsdt: new Money(MAX_EXPOSURE_PER_COIN_USDT),
            instrument,
        });

        if (sizingResult.kind !== 'sized') {
            return null;
        }

        return {
            intentAction: OrderIntentActionEnum.OPEN,
            symbol: event.symbol,
            eventId: event.eventId,
            tradeSide: signal.tradeSide,
            signalScore: signal.signalScore,
            // The backtest treats every event as idiosyncratic at the intent layer; the
            // gate's snapshot still carries the canonical correlation_mode from the
            // mapper, and the slot manager resolves the slot from that. Keeping the
            // intent's correlationMode aligned avoids divergence inside the gate's slot
            // logic (it reads intent.correlationMode for the BTC slot check).
            correlationMode: this.resolveCorrelationMode(event, ctx.params),
            coinTier: event.coinTier,
            idiosyncrasyScore: event.idiosyncrasyScore,
            entryPrice,
            midAtTrigger: entryPrice,
            maintenanceMarginRate: instrument.maintenanceMarginRate,
            proposedExit: signal.proposedExit,
            openPosition: null,
            sizing: sizingResult.sizing,
            flowType: signal.flowType,
        };
    }

    // Mirrors the threshold logic in buildMarketSnapshot: if the BTC 5m move clears the
    // params-defined correlation threshold, the event is BTC-correlated (slot C); otherwise
    // it is idiosyncratic (slot A/B eligibility resolved by the gate's slot manager).
    private resolveCorrelationMode(event: IVolatilityDetectedEvent, params: IStrategyParams): CorrelationModeEnum {
        if (Math.abs(event.btc5mMovePct) >= params.btc_correlated_move_threshold_pct) {
            return CorrelationModeEnum.CORRELATED;
        }

        return CorrelationModeEnum.IDIOSYNCRATIC;
    }

    private buildGateContext(
        event: IVolatilityDetectedEvent,
        snapshot: ReturnType<typeof buildMarketSnapshot>,
        nowMs: number,
        ctx: IBacktestOrchestratorContext,
    ): IRiskGateContext {
        return {
            nowMs,
            utcDateString: ctx.utcDateString,
            snapshot,
            params: ctx.params,
            strategyVersionId: ctx.strategyVersionId,
            belowUniverseFloor: !ctx.isInUniverse,
            limits: {
                dailyLossLimitUsdt: new Money(DAILY_LOSS_LIMIT_USDT),
                weeklyLossLimitUsdt: new Money(WEEKLY_LOSS_LIMIT_USDT),
                maxExposurePerCoinUsdt: new Money(MAX_EXPOSURE_PER_COIN_USDT),
                maxSameDirectionExposureUsdt: new Money(MAX_SAME_DIRECTION_EXPOSURE_USDT),
                cooldownAfterLossMs: COOLDOWN_AFTER_LOSS_MS,
            },
            riskState: ctx.riskStateAdapter,
            openPositions: ctx.positionAdapter,
            instruments: ctx.instrumentAdapter,
            modelDivergenceDetected: false,
        };
    }

    private async simulateAndRecord(
        event: IVolatilityDetectedEvent,
        signal: ISignal,
        decision: IApprovedRiskDecision,
        intent: IOrderIntent,
        ctx: IBacktestOrchestratorContext,
    ): Promise<IOrchestratorResult> {
        const fillRequest = this.buildFillRequest(event, intent, decision, ctx);
        const fill = ctx.fillSim.simulateFill(fillRequest);

        if (fill.missed) {
            // Approved by the gate but the simulator missed the fill window — release the
            // reservation the gate took so it doesn't leak into subsequent bars.
            ctx.reservationLedger.releaseReservation(decision.reservationId);

            return MISSED;
        }

        const position = this.buildPosition(event, signal, decision, fill, ctx);
        ctx.sink.applyOpenFill(fill, position, ctx.utcDateString);

        // The reservation moves from PENDING to CONFIRMED at the moment of fill. Live M5
        // confirms via FillAccumulator; the backtest confirms inline since the fill is
        // single-shot in this slice.
        ctx.reservationLedger.confirmReservation(decision.reservationId);

        this.logger.debug(`fill ${event.symbol} slot=${decision.approvedSlot} qty=${fill.qty} px=${fill.priceUsdt}`);

        return FILLED;
    }

    private buildFillRequest(
        event: IVolatilityDetectedEvent,
        intent: IOrderIntent,
        decision: IApprovedRiskDecision,
        ctx: IBacktestOrchestratorContext,
    ): IFillRequest {
        // M8 W1: route through the (injected) live OrderPolicyRouter so backtest fee +
        // missed-fill-timeout semantics match live for every (action, direction, tier, flow)
        // combination. v3 (HYBRID) has no row in the matrix — the orchestrator resolves the
        // router leg from the signal's flowType before calling, per ADR 0005 §1 / matrix
        // comment ("the orchestrator resolves the router leg before calling here").
        const strategyDirection = this.resolveStrategyDirection(ctx.strategy.direction, intent.flowType);
        const plan = this.policyRouter.plan({ intent, strategyDirection, maxSlippageOfSlPct: null });
        const policy = plan.policy;

        const side = intent.tradeSide === PositionSideEnum.LONG ? 'long' : 'short';

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
            // Bar-extreme inputs are sourced from tick aggregates by the runner; absent a
            // dedicated bar-OHLC bundle here, project from the reference price. The
            // intra-bar miss check primarily consumes the tick stream; this fallback is
            // safe because IOC's miss condition is tick-driven.
            barHigh: intent.midAtTrigger,
            barLow: intent.midAtTrigger,
            ticks: ctx.ticks,
            bookSnapshot: ctx.bookSnapshot,
            tierSlippageParams: ctx.tierSlippageParams,
            config: ctx.config,
        };
    }

    private buildPosition(
        event: IVolatilityDetectedEvent,
        signal: ISignal,
        decision: IApprovedRiskDecision,
        fill: ReturnType<HistoricalFillAdapter['simulateFill']>,
        _ctx: IBacktestOrchestratorContext,
    ): IBacktestPosition {
        if (signal.proposedExit === null) {
            // Defensive narrowing — checked before reaching here.
            throw new Error('buildPosition called with null proposedExit');
        }

        const fillPrice = new Money(fill.priceUsdt);
        const fillQty = new Money(fill.qty);
        const entryNotional = fillPrice.times(fillQty);

        return {
            positionId: `${event.eventId}:${fill.tsMs}`,
            symbol: event.symbol,
            side: signal.tradeSide === PositionSideEnum.LONG ? 'long' : 'short',
            slot: this.mapSlot(decision.approvedSlot),
            entryPriceUsdt: fill.priceUsdt,
            qty: fill.qty,
            entryNotionalUsdt: entryNotional.toFixed(8),
            leverage: decision.approvedSizing.leverage.toFixed(4),
            stopLossUsdt: decision.clampedExit.stopLossPrice.toFixed(18),
            takeProfitUsdt: decision.clampedExit.takeProfitPrice.toFixed(18),
            openedAtMs: fill.tsMs,
            timeStopAtMs: decision.clampedExit.timeStopAtMs,
            maxAdverseExcursionPct: '0',
            maxFavorableExcursionPct: '0',
            accumulatedFundingUsdt: '0',
        };
    }

    // Resolve the OrderPolicyRouter's `strategyDirection` argument from the active strategy.
    // v0/v1 are MEAN_REVERSION, v2 is MOMENTUM, v3 is HYBRID. HYBRID has no rows in the
    // policy matrix; the orchestrator must pick a concrete leg from the signal's flow_type
    // (ADR 0005 §1 / orderPolicyMatrix line 149–151). Mapping:
    //   FORCED_EXHAUSTION              → MEAN_REVERSION (fade the cascade)
    //   TREND_INITIATION, CATALYST_RISK → MOMENTUM       (follow the new-money / catalyst leg)
    //   else                            → MEAN_REVERSION (conservative default; matches the
    //                                                     skip-first culture — maker, no take)
    private resolveStrategyDirection(direction: StrategyDirectionEnum, flowType: FlowTypeEnum): StrategyDirectionEnum {
        if (direction !== StrategyDirectionEnum.HYBRID) {
            return direction;
        }

        if (flowType === FlowTypeEnum.TREND_INITIATION || flowType === FlowTypeEnum.CATALYST_RISK) {
            return StrategyDirectionEnum.MOMENTUM;
        }

        return StrategyDirectionEnum.MEAN_REVERSION;
    }

    private mapSlot(slot: PositionSlotEnum): IBacktestPosition['slot'] {
        switch (slot) {
            case PositionSlotEnum.A:
                return 'A';
            case PositionSlotEnum.B:
                return 'B';
            case PositionSlotEnum.C:
                return 'C';
        }
    }
}
