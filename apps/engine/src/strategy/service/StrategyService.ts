import {
    classifyFlowType,
    computeSignalScore,
    CorrelationModeEnum,
    IMarketSnapshot,
    IStrategyParams,
    IVolatilityDetectedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    RejectReasonEnum,
    SignalActionEnum,
    SkipReasonEnum,
} from '@bot/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT, VOLATILITY_DETECTED_EVENT } from '../../common/const';
import { Money } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { UniverseMembershipRepository } from '../../market-data/repository/UniverseMembershipRepository';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import {
    IApprovedRiskDecision,
    IOrderIntent,
    IOrderIntentApprovedEvent,
    IRiskDecision,
    IRiskGateContext,
    IRiskLimits,
    isApprovedOpening,
} from '../../risk/interface';
import { InstrumentPortAdapter, OpenPositionsPortAdapter, PositionSizer, RiskGateService, RiskStatePortAdapter } from '../../risk/service';
import { reconstructReferencePrice } from '../utils';
import { CANDLE_INTERVAL_MS } from '../const';
import { StrategyConfigException } from '../exception';
import { buildMarketSnapshot } from '../mapper';
import { IOpenPositionState, IProposedExit, ISignal, IStrategy } from '../interface';
import { DecisionRepository } from '../repository/DecisionRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { StrategyRegistry } from '../registry';

// A buffered correlated OPEN candidate awaiting same-bar single-candidate selection (ADR
// 0004 §4). Correlated opens are NOT gated immediately; they queue per bar window and the
// highest-scoring one is submitted at the bar-close boundary, the rest rejected.
interface IBufferedCandidate {
    readonly event: IVolatilityDetectedEvent;
    readonly snapshot: IMarketSnapshot;
    readonly signal: ISignal;
    readonly intent: IOrderIntent;
}

// An OPEN signal narrowed to its non-null trade fields (a strategy OPEN always carries both).
interface IOpenSignal extends ISignal {
    readonly tradeSide: PositionSideEnum;
    readonly proposedExit: IProposedExit;
}

// The orchestrator (ADR 0003 §6/§7 + ADR 0004 §1/§4). Per trigger it classifies
// flow_type + signal_score, runs the active strategy, then — M4 — synchronously routes the
// outcome through the risk gate: idiosyncratic intents go straight through; BTC-correlated
// opens are buffered by bar window and flushed (single best candidate) at the deterministic
// bar-close boundary. It stamps the gate verdict onto the snapshot, persists ONE
// authoritative decision, and on approval emits order.intent.approved (the M5 seam).
@Injectable()
export class StrategyService implements OnModuleInit {
    private readonly logger = new Logger(StrategyService.name);

    private activeStrategy!: IStrategy;
    private activeParams!: IStrategyParams;
    private activeStrategyVersionId!: number;

    // Per-bar correlated-open buffer (ADR 0004 §4). In-memory, per-orchestrator state — a
    // restart loses at most one bar's pending correlated entries (the safe outcome).
    private readonly correlatedBuffer = new Map<number, IBufferedCandidate[]>();

    constructor(
        private readonly config: AppConfigService,
        private readonly registry: StrategyRegistry,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly positions: PositionRepository,
        private readonly decisions: DecisionRepository,
        private readonly events: EventEmitter2,
        private readonly riskGate: RiskGateService,
        private readonly sizer: PositionSizer,
        private readonly riskStatePort: RiskStatePortAdapter,
        private readonly openPositionsPort: OpenPositionsPortAdapter,
        private readonly instrumentPort: InstrumentPortAdapter,
        private readonly universe: UniverseMembershipRepository,
    ) {}

    async onModuleInit(): Promise<void> {
        const versionId = this.config.activeStrategyVersionId;
        const row = await this.strategyVersions.findById(versionId);

        if (row === null) {
            throw new StrategyConfigException(`ACTIVE_STRATEGY_VERSION_ID=${versionId} matches no strategy_versions row`);
        }

        const resolved = this.registry.resolve(row.name, row.version, row.params);
        this.activeStrategy = resolved.strategy;
        this.activeParams = resolved.params;
        this.activeStrategyVersionId = row.id;

        this.logger.log(`Active strategy ${row.name}:${row.version} (id=${row.id}, direction=${row.direction}) resolved`);
    }

    @OnEvent(VOLATILITY_DETECTED_EVENT)
    async onVolatilityDetected(event: IVolatilityDetectedEvent): Promise<void> {
        const nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS;

        await this.flushClosedBars(event.entryCandleOpenTime);

        const flowType = classifyFlowType(event, this.activeParams);
        const signalScore = computeSignalScore(event, this.activeParams, flowType);
        const stampedEvent: IVolatilityDetectedEvent = { ...event, flowType };
        const snapshot = buildMarketSnapshot({ event: stampedEvent, params: this.activeParams, flowType, signalScore });
        const openPosition = await this.loadOpenPositionState(event.symbol);

        const signal = this.activeStrategy.evaluate({ event: stampedEvent, snapshot, openPosition, params: this.activeParams, nowMs });

        await this.route(stampedEvent, snapshot, signal, openPosition, nowMs);
    }

    // Routes the strategy outcome (ADR 0004 §1/§4). A non-open signal is recorded as-is. An
    // ADD onto an existing position is out of M4 scope (see resolveIntentAction) and rejected.
    // A correlated OPEN is buffered; every other OPEN goes through the gate immediately.
    private async route(
        event: IVolatilityDetectedEvent,
        snapshot: IMarketSnapshot,
        signal: ISignal,
        openPosition: IOpenPositionState | null,
        nowMs: number,
    ): Promise<void> {
        if (!this.isOpenSignal(signal)) {
            await this.recordSkip(event, snapshot, signal);

            return;
        }

        // ADD-to-existing-position is out of M4 scope: PositionSizer always sizes a fresh full
        // position, so executing an ADD would duplicate exposure. Reject it as not-best /
        // out-of-scope rather than silently double-sizing (ADR 0004 §8; revisit when scaling
        // logic lands). Skip with a documented reason so the decision is recorded.
        if (openPosition !== null) {
            await this.recordOpenSkip(event, snapshot, signal, SkipReasonEnum.OUT_OF_SCOPE);

            return;
        }

        const intent = await this.buildOrderIntent(event, snapshot, signal);

        if (intent === null) {
            await this.recordOpenSkip(event, snapshot, signal, SkipReasonEnum.MOVE_OUT_OF_BAND);

            return;
        }

        if (snapshot.correlation_mode === CorrelationModeEnum.CORRELATED) {
            this.bufferCorrelated(event, snapshot, signal, intent);

            return;
        }

        await this.gateAndPersist(event, snapshot, signal, intent, nowMs);
    }

    private isOpenSignal(signal: ISignal): signal is IOpenSignal {
        return signal.action === SignalActionEnum.OPEN && signal.tradeSide !== null && signal.proposedExit !== null;
    }

    // Build the concrete IOrderIntent: ATR sizing (PositionSizer) + slot-request context. A
    // missing instrument or a below-min-notional / funding-suppressed / invalid-input size
    // returns null so the caller records the pre-gate decision (ADR 0004 §8: below-min is
    // skipped, not bumped up). The instrument also supplies the maintenance-margin rate the
    // gate's SL-inside-liquidation check needs.
    private async buildOrderIntent(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: IOpenSignal): Promise<IOrderIntent | null> {
        const instrument = await this.instrumentPort.findConstraints(event.symbol);

        if (instrument === null) {
            return null;
        }

        const entryPrice = reconstructReferencePrice(event);

        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: this.activeParams.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: this.activeParams.funding_rate_suppress_threshold,
            instrument,
        });

        if (sizingResult.kind !== 'sized') {
            return null;
        }

        // midAtTrigger contract (ADR 0005 §2): the trigger-time book mid, used by the
        // executor for IOC limit-price math. The persisted source of truth is
        // book_snapshots.mid_at_trigger, keyed on event_id. Until M2 ships that column
        // explicitly, we anchor on the reconstructed reference price (closed-bar VWAP-
        // deviation projection); both live and backtest read from the same persisted
        // surface so parity is preserved. Distinct from entryPrice (bar close) so SL/TP
        // distance math and IOC microstructure math do not get cross-wired.
        const midAtTrigger = entryPrice;

        return {
            intentAction: OrderIntentActionEnum.OPEN,
            symbol: event.symbol,
            eventId: event.eventId,
            tradeSide: signal.tradeSide,
            signalScore: signal.signalScore,
            correlationMode: snapshot.correlation_mode,
            coinTier: event.coinTier,
            idiosyncrasyScore: event.idiosyncrasyScore,
            entryPrice,
            midAtTrigger,
            maintenanceMarginRate: instrument.maintenanceMarginRate,
            proposedExit: signal.proposedExit,
            openPosition: null,
            sizing: sizingResult.sizing,
            flowType: signal.flowType,
        };
    }

    private bufferCorrelated(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal, intent: IOrderIntent): void {
        const bar = event.entryCandleOpenTime;
        const candidates = this.correlatedBuffer.get(bar) ?? [];
        candidates.push({ event, snapshot, signal, intent });
        this.correlatedBuffer.set(bar, candidates);

        this.logger.debug(`buffered correlated candidate ${event.symbol} bar=${bar} score=${signal.signalScore.toFixed(1)}`);
    }

    // Flush every buffered bar that has now closed (ADR 0004 §4): a later bar's first event
    // means the prior bar is closed. Submit the single highest-scoring candidate to the gate;
    // reject all others btc_correlated_not_best_candidate.
    private async flushClosedBars(currentBar: number): Promise<void> {
        const closedBars = [...this.correlatedBuffer.keys()].filter((bar) => bar < currentBar).sort((left, right) => left - right);

        for (const bar of closedBars) {
            await this.flushBar(bar);
        }
    }

    private async flushBar(bar: number): Promise<void> {
        const candidates = this.correlatedBuffer.get(bar) ?? [];
        this.correlatedBuffer.delete(bar);

        if (candidates.length === 0) {
            return;
        }

        const sorted = [...candidates].sort((left, right) => this.compareCandidates(left, right));
        const [best, ...rest] = sorted;
        const nowMs = bar + CANDLE_INTERVAL_MS;

        await this.gateAndPersist(best.event, best.snapshot, best.signal, best.intent, nowMs);

        for (const loser of rest) {
            await this.recordRejection(loser.event, loser.snapshot, loser.signal, RejectReasonEnum.BTC_CORRELATED_NOT_BEST_CANDIDATE);
        }
    }

    // Highest signalScore first; ties broken by symbol ascending (deterministic, ADR 0004 §4).
    private compareCandidates(left: IBufferedCandidate, right: IBufferedCandidate): number {
        if (right.signal.signalScore !== left.signal.signalScore) {
            return right.signal.signalScore - left.signal.signalScore;
        }

        return left.event.symbol.localeCompare(right.event.symbol);
    }

    private async gateAndPersist(
        event: IVolatilityDetectedEvent,
        snapshot: IMarketSnapshot,
        signal: ISignal,
        intent: IOrderIntent,
        nowMs: number,
    ): Promise<void> {
        const context = await this.buildGateContext(event.symbol, snapshot, nowMs);
        const decision = await this.riskGate.evaluate(intent, context);
        const stampedSnapshot = this.stampGateVerdict(snapshot, decision);

        await this.recordGateDecision(event, stampedSnapshot, signal, intent, decision);

        if (isApprovedOpening(decision)) {
            this.emitApproval(intent, decision);
        }
    }

    private async buildGateContext(symbol: string, snapshot: IMarketSnapshot, nowMs: number): Promise<IRiskGateContext> {
        const utcDateString = new Date(nowMs).toISOString().slice(0, 10);
        const belowUniverseFloor = (await this.universe.findOpenMembership(symbol)) === null;

        return {
            nowMs,
            utcDateString,
            snapshot,
            params: this.activeParams,
            strategyVersionId: this.activeStrategyVersionId,
            belowUniverseFloor,
            limits: this.resolveRiskLimits(),
            riskState: this.riskStatePort,
            openPositions: this.openPositionsPort,
            instruments: this.instrumentPort,
            // Fail-safe default: the model-divergence kill switch is OFF until M9 feeds the
            // realized-vs-modeled slippage / win-loss divergence verdict (docs/plans/M9-observability-control.md).
            modelDivergenceDetected: false,
        };
    }

    // The operator control surface (HIGH): the gate reads limits from AppConfigService, not
    // hardcoded riskConsts. riskConsts remain backtest/defaults only.
    private resolveRiskLimits(): IRiskLimits {
        return {
            dailyLossLimitUsdt: new Money(this.config.dailyLossLimitUsdt),
            weeklyLossLimitUsdt: new Money(this.config.weeklyLossLimitUsdt),
            maxExposurePerCoinUsdt: new Money(this.config.maxExposurePerCoinUsdt),
            maxSameDirectionExposureUsdt: new Money(this.config.maxSameDirectionExposureUsdt),
            cooldownAfterLossMs: this.config.cooldownAfterLossMs,
        };
    }

    // Overwrite the M3 snapshot placeholder slot with the gate's real verdict (ADR 0004 §4).
    private stampGateVerdict(snapshot: IMarketSnapshot, decision: IRiskDecision): IMarketSnapshot {
        if (decision.approvedSlot === null) {
            return snapshot;
        }

        return { ...snapshot, position_slot: decision.approvedSlot };
    }

    private emitApproval(intent: IOrderIntent, decision: IApprovedRiskDecision): void {
        const payload: IOrderIntentApprovedEvent = {
            intent,
            approvedSlot: decision.approvedSlot,
            approvedSizing: decision.approvedSizing,
            clampedExit: decision.clampedExit,
            reservationId: decision.reservationId,
            strategyVersionId: this.activeStrategyVersionId,
        };

        this.events.emit(ORDER_INTENT_APPROVED_EVENT, payload);
    }

    private async recordGateDecision(
        event: IVolatilityDetectedEvent,
        snapshot: IMarketSnapshot,
        signal: ISignal,
        intent: IOrderIntent,
        decision: IRiskDecision,
    ): Promise<void> {
        const reason = decision.rejectReason !== null ? decision.rejectReason : signal.reason;

        await this.persistDecision(event, snapshot, signal, intent.intentAction, reason);

        this.logger.log(
            `gate ${event.symbol} v=${this.activeStrategyVersionId} action=${intent.intentAction} outcome=${decision.outcome} ` +
                `slot=${decision.approvedSlot ?? '-'} reason=${reason}`,
        );
    }

    private async recordSkip(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal): Promise<void> {
        await this.persistDecision(event, snapshot, signal, signal.action, signal.reason);

        this.logger.log(
            `decision ${event.symbol} v=${this.activeStrategyVersionId} action=${signal.action} ` +
                `side=${signal.tradeSide ?? '-'} flow=${signal.flowType} score=${signal.signalScore.toFixed(1)} reason=${signal.reason}`,
        );
    }

    private async recordOpenSkip(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal, reason: SkipReasonEnum): Promise<void> {
        await this.persistDecision(event, snapshot, signal, SignalActionEnum.SKIP, reason);

        this.logger.log(`pre-gate skip ${event.symbol} v=${this.activeStrategyVersionId} reason=${reason}`);
    }

    private async recordRejection(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal, reason: RejectReasonEnum): Promise<void> {
        await this.persistDecision(event, snapshot, signal, OrderIntentActionEnum.OPEN, reason);

        this.logger.log(`gate ${event.symbol} v=${this.activeStrategyVersionId} action=open outcome=rejected reason=${reason}`);
    }

    private async persistDecision(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal, action: string, reason: string): Promise<void> {
        await this.decisions.record({
            symbol: event.symbol,
            strategyVersionId: this.activeStrategyVersionId,
            ts: new Date(event.entryCandleOpenTime + CANDLE_INTERVAL_MS),
            eventId: event.eventId,
            signalType: signal.signalType,
            marketSnapshot: snapshot,
            action,
            reason,
        });
    }

    private async loadOpenPositionState(symbol: string): Promise<IOpenPositionState | null> {
        const open = await this.positions.findOpenBySymbol(symbol);

        if (open.length === 0) {
            return null;
        }

        return this.toOpenPositionState(open[0]);
    }

    // Frozen readonly snapshot carrying only what a strategy may legitimately read; the
    // strategy never touches TypeORM (ADR 0003 §1).
    private toOpenPositionState(position: PositionEntity): IOpenPositionState {
        return Object.freeze({
            side: position.side,
            entryPrice: position.entryPrice,
            qty: position.qty,
            entryNotional: position.entryNotional,
            strategyVersionId: position.strategyVersionId,
            positionSlot: position.positionSlot ?? null,
            openedAtMs: position.openedAt.getTime(),
            timeStopAtMs: position.timeStopAt?.getTime() ?? null,
        });
    }
}
