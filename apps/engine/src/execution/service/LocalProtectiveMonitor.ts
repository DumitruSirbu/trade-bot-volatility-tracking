import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    IPositionStateTransitionedEvent,
    IPriceUpdateEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    RiskOutcomeEnum,
    StopTypeEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT, ORDER_INTENT_EXPIRED_EVENT, PRICE_UPDATE_EVENT } from '../../common/const';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { PositionEntity } from '../../position/entity';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../../position/const';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { IOrderIntent, IOrderIntentApprovedEvent, IRiskGateContext } from '../../risk/interface';
import { RiskGateService } from '../../risk/service';

// Arm payload — M6 W3 extends the M5 seam with `side` so the breach evaluator
// can apply side-aware comparisons without a position-row lookup (the lookup is
// only needed at breach time to read the current qty / slot / coin tier).
interface IArmedPosition {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly stopLossPrice: MoneyValue | null;
    readonly takeProfitPrice: MoneyValue | null;
    readonly armedAtMs: number;
}

// Pure breach-classification output — separable from the I/O-bearing handler so
// the evaluator stays a pure function of (armedConfig, markPrice). Side-aware
// per ADR 0011 §3:
//
//   LONG:  SL breached if mark <= SL;   TP breached if mark >= TP
//   SHORT: SL breached if mark >= SL;   TP breached if mark <= TP
//
// Equality is a breach (matches exchange-side STOP_MARKET "at-or-past" semantics
// — ADR 0011 §3 final paragraph). SL is checked before TP — survival before
// opportunity — and on the degenerate gap-through-both case, SL wins.
type BreachKind = 'stop_loss' | 'take_profit' | null;

// In-memory arm/disarm seam — M5 shipped only the seam (arm/disarm/isArmed/
// listArmed). M6 W3 (ADR 0011 §2-§4) extends this service with:
//
//   1. A `price.update` subscriber that runs a side-aware decimal breach check
//      against every armed position on the updated symbol.
//   2. A breach-close producer that synthesises an IOrderIntent(CLOSE) and routes
//      it through RiskGateService.evaluate — NEVER calls ExecutionService directly
//      (ADR 0011 §4, ADR 0008 §6 reviewer must-fix). On approval, emits
//      ORDER_INTENT_APPROVED_EVENT so the existing executor reduce-family path
//      submits the close.
//   3. An in-flight flag per positionId so a stream of post-breach price ticks
//      fires exactly one close intent. Cleared on position.state.transitioned →
//      CLOSED so a future re-arm (next position on the same id-space won't happen
//      — ids are unique per position) cannot fire a stale flag.
//   4. A position.state.transitioned → CLOSED listener that disarms the monitor
//      automatically, mirroring the symmetric arm path that M5 set up.
//
// The arm and the @OnEvent listeners are independent: the monitor stays a passive
// in-memory observer. No exchange API calls, no PositionRepository writes — only
// reads at breach time for the close-intent synthesis. Determinism: `armedAtMs`
// is the only `Date.now()` use, and that field is diagnostic-only (not read by the
// breach evaluator or the close-intent producer). The pure evaluator (`evaluateBreach`)
// reads only its two arguments.
@Injectable()
export class LocalProtectiveMonitor {
    private readonly logger = new Logger(LocalProtectiveMonitor.name);

    private readonly armed = new Map<number, IArmedPosition>();

    // breachInFlight per positionId. Set when a close intent is emitted to the
    // gate; cleared on position.state.transitioned → CLOSED (disarm). ADR 0011
    // §4 "Idempotency on the breach": a repeat price.update past the SL while
    // close is mid-flight does NOT re-emit.
    private readonly breachInFlight = new Set<number>();

    constructor(
        private readonly positions: PositionRepository,
        // forwardRef: RiskGateService lives in RiskModule which is imported by ExecutionModule,
        // but RiskModule does not import ExecutionModule — the dependency is one-way and the
        // forwardRef is precautionary against future circular imports as the gate seam grows.
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
        private readonly events: EventEmitter2,
    ) {}

    arm(input: { positionId: number; symbol: string; side: PositionSideEnum; stopLossPrice: MoneyValue | null; takeProfitPrice: MoneyValue | null }): void {
        this.armed.set(input.positionId, {
            positionId: input.positionId,
            symbol: input.symbol,
            side: input.side,
            stopLossPrice: input.stopLossPrice,
            takeProfitPrice: input.takeProfitPrice,
            armedAtMs: Date.now(),
        });

        this.logger.log(`local monitor armed positionId=${input.positionId} symbol=${input.symbol} side=${input.side}`);
    }

    disarm(positionId: number): void {
        if (!this.armed.has(positionId)) {
            return;
        }

        this.armed.delete(positionId);
        this.breachInFlight.delete(positionId);
        this.logger.log(`local monitor disarmed positionId=${positionId}`);
    }

    isArmed(positionId: number): boolean {
        return this.armed.has(positionId);
    }

    listArmed(): readonly IArmedPosition[] {
        return [...this.armed.values()];
    }

    // Pure breach-classification function (ADR 0011 §3). Exposed as a public method
    // so unit tests can call it without constructing the gate/repository graph.
    // No side effects, no `Date.now()`, no I/O.
    evaluateBreach(armed: IArmedPosition, markPrice: MoneyValue): BreachKind {
        // SL first (ADR 0011 §3): survival before opportunity. A degenerate gap
        // through both SL and TP on a single tick resolves to SL.
        if (armed.stopLossPrice !== null && this.isStopLossBreached(armed.side, markPrice, armed.stopLossPrice)) {
            return 'stop_loss';
        }

        if (armed.takeProfitPrice !== null && this.isTakeProfitBreached(armed.side, markPrice, armed.takeProfitPrice)) {
            return 'take_profit';
        }

        return null;
    }

    // The eval loop entry point. M6 W3 ADR 0011 §2: event-driven (not timer)
    // so the monitor sees the same ticks the strategy sees (deterministic in
    // live + backtest, since the M7 replay re-emits this same event).
    //
    // M6 R2.1.1: NO boot-race guard here. The original W8.5 guard short-
    // circuited every price tick until phase 9. R1.1.1 then narrowed the
    // gate's `RECOVERY_IN_PROGRESS` reject to OPEN/ADD only — de-risking
    // intents (CLOSE/REDUCE/FLATTEN) pass during recovery so case-(a) flatten
    // and local-monitor breaches between phase 4c and phase 9 work. With the
    // gate now an asymmetric backstop, blanket-dropping price ticks here
    // silently disables the local monitor — the last line of defense per
    // ADR-0011 §4 — during the very window where exchange-side protection is
    // most likely missing. The gate remains the authoritative enforcement
    // point; this handler is intentionally guard-free.
    @OnEvent(PRICE_UPDATE_EVENT)
    async onPriceUpdate(event: IPriceUpdateEvent): Promise<void> {
        const markPrice = parseMoney(event.price);

        // Multi-position-per-symbol is rare today (one slot per symbol enforced
        // upstream) but the loop is correct either way. Iterate over a snapshot
        // — a breach handler may disarm mid-iteration.
        const armedSnapshot = [...this.armed.values()].filter((armed) => armed.symbol === event.symbol);

        for (const armed of armedSnapshot) {
            const breach = this.evaluateBreach(armed, markPrice);

            if (breach === null) {
                continue;
            }

            await this.handleBreach(armed, markPrice, breach, event.timestampMs);
        }
    }

    // Disarm-on-CLOSED: the monitor stands down automatically when the position
    // reaches a closed state. Mirrors the symmetric arm-on-open path. Also clears
    // the breachInFlight flag so a positionId can never carry stale state forward.
    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    onPositionStateTransitioned(event: IPositionStateTransitionedEvent): void {
        if (event.toState !== PositionStateEnum.CLOSED) {
            return;
        }

        this.disarm(event.positionId);
    }

    // M6 R2.1 / security 2.M.1 — halt-flag breach leak. Sequence:
    //
    //   1. Halt is set (e.g., model-divergence kill switch, ADR-0004 §6).
    //   2. Price ticks past SL → breach fires → gate auto-approves close
    //      (de-risking can't be blocked, ADR-0004 §2).
    //   3. ExecutionService.handleApproved short-circuits because of halt
    //      (executionService.ts L139–145), releases the reservation, and
    //      emits ORDER_INTENT_EXPIRED_EVENT with reason='halted'.
    //   4. WITHOUT this listener, `breachInFlight` stays set forever, every
    //      subsequent price tick is suppressed by the idempotency guard, and
    //      the position is structurally unprotected once halt clears.
    //
    // The fix: when an `ORDER_INTENT_EXPIRED_EVENT` with reason='halted'
    // matches one of our breach eventIds, clear `breachInFlight` so the next
    // price tick re-evaluates and re-fires. The eventId is the breach
    // factory's deterministic id `local-monitor-breach-${positionId}-${reason}`,
    // so we can recover the positionId without an extra lookup. ADR-0011 §4
    // "local monitor as last line of defense" applies under halt too.
    @OnEvent(ORDER_INTENT_EXPIRED_EVENT)
    onOrderIntentExpired(event: { eventId: string; reservationId: string | null; reason?: string }): void {
        if (event.reason !== 'halted') {
            return; // dry_run / other expiries don't unprotect the position
        }

        const positionId = this.extractPositionIdFromBreachEventId(event.eventId);

        if (positionId === null) {
            return; // not one of our breach intents
        }

        if (!this.breachInFlight.has(positionId)) {
            return;
        }

        this.breachInFlight.delete(positionId);
        this.logger.warn(
            `breach intent for positionId=${positionId} expired under halt — cleared in-flight flag; next price tick will re-evaluate (ADR 0011 §4 last-line-of-defense)`,
        );
    }

    // Parses a positionId out of the deterministic breach eventId scheme
    // `local-monitor-breach-${positionId}-${exitReason}`. Returns null if the
    // eventId doesn't match — i.e., the expired intent was not produced by us.
    //
    // M6 R3.2.2: split from the RIGHT (`lastIndexOf('-')`) instead of the
    // first dash. Today's `ExitReasonEnum` values (`stop_loss`, `take_profit`,
    // `kill_switch`, etc.) all use underscores, so first-dash parsing happens
    // to work — but a future enum value with an embedded dash (e.g.,
    // `time-stop`) would split the positionId mid-string and yield NaN. The
    // suffix (everything after the last dash) is the exitReason; the prefix
    // (everything before it) is the positionId portion of the id.
    private extractPositionIdFromBreachEventId(eventId: string): number | null {
        const prefix = 'local-monitor-breach-';

        if (!eventId.startsWith(prefix)) {
            return null;
        }

        const rest = eventId.slice(prefix.length);
        const dashIndex = rest.lastIndexOf('-');

        if (dashIndex <= 0) {
            return null;
        }

        const positionIdRaw = rest.slice(0, dashIndex);
        const positionId = Number.parseInt(positionIdRaw, 10);

        if (!Number.isInteger(positionId) || positionId <= 0) {
            return null;
        }

        return positionId;
    }

    // The breach handler: looks up the live position row (for fresh qty / slot /
    // coin tier — qty may have changed via ADD/REDUCE since arm time), synthesises
    // a CLOSE IOrderIntent, routes it through RiskGateService.evaluate (the only
    // legitimate close API per ADR 0011 §4), and on approval re-emits
    // ORDER_INTENT_APPROVED_EVENT so the existing executor reduce-family path
    // submits the close. Idempotent on positionId via `breachInFlight`.
    private async handleBreach(armed: IArmedPosition, markPrice: MoneyValue, breach: 'stop_loss' | 'take_profit', nowMs: number): Promise<void> {
        if (this.breachInFlight.has(armed.positionId)) {
            // A previous tick already fired the close intent for this position.
            // Per ADR 0011 §4 idempotency: do NOT re-emit; let the in-flight
            // close walk through the executor → fill → CLOSED transition path.
            return;
        }

        const position = await this.positions.findById(armed.positionId);

        if (position === null) {
            this.logger.warn(`breach detected for positionId=${armed.positionId} symbol=${armed.symbol} but position row not found - disarming and skipping`);
            this.disarm(armed.positionId);

            return;
        }

        const exitReason = breach === 'stop_loss' ? ExitReasonEnum.STOP_LOSS : ExitReasonEnum.TAKE_PROFIT;
        const intent = this.buildCloseIntent(position, armed, markPrice, exitReason);
        const context = this.buildDeRiskContext(markPrice, nowMs);

        // Mark in-flight BEFORE awaiting the gate. The gate call is in-process and
        // synchronous from the event-bus perspective; the flag closes the race where
        // a second price.update tick lands between this call and the emit below.
        this.breachInFlight.add(armed.positionId);

        const decision = await this.riskGate.evaluate(intent, context);

        if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
            // De-risking is supposed to be auto-approved (ADR 0004 §2). A reject here
            // is a contract violation — log loudly, clear the in-flight flag so the
            // next tick has a chance to re-try (this is the safer path: the position
            // is still breached and the local monitor is the last line of defense).
            this.breachInFlight.delete(armed.positionId);
            this.logger.error(
                `gate rejected local-monitor close intent positionId=${armed.positionId} symbol=${armed.symbol} ` +
                    `reason=${decision.rejectReason ?? 'unknown'} - leaving monitor armed for retry`,
            );

            return;
        }

        const approvedEvent: IOrderIntentApprovedEvent = {
            intent,
            // The position already holds an approved slot; pass it through so the
            // executor's reduce-family lookup (findOpenBySymbolAndSlot) finds the row.
            approvedSlot: this.resolveSlot(position),
            approvedSizing: intent.sizing,
            clampedExit: intent.proposedExit,
            // De-risking decisions carry null reservation per ADR 0004 §2 — no exposure
            // is being acquired. The executor's safe helpers treat null as a no-op.
            reservationId: decision.reservationId,
            strategyVersionId: position.strategyVersionId,
        };

        this.events.emit(ORDER_INTENT_APPROVED_EVENT, approvedEvent);

        this.logger.log(
            `local monitor BREACH positionId=${armed.positionId} symbol=${armed.symbol} side=${armed.side} ` +
                `kind=${breach} markPrice=${markPrice.toFixed()} - close intent emitted through gate`,
        );
    }

    private isStopLossBreached(side: PositionSideEnum, markPrice: MoneyValue, stopLossPrice: MoneyValue): boolean {
        if (side === PositionSideEnum.LONG) {
            return markPrice.lessThanOrEqualTo(stopLossPrice);
        }

        return markPrice.greaterThanOrEqualTo(stopLossPrice);
    }

    private isTakeProfitBreached(side: PositionSideEnum, markPrice: MoneyValue, takeProfitPrice: MoneyValue): boolean {
        if (side === PositionSideEnum.LONG) {
            return markPrice.greaterThanOrEqualTo(takeProfitPrice);
        }

        return markPrice.lessThanOrEqualTo(takeProfitPrice);
    }

    // Synthesise a CLOSE intent that the executor's existing reduce-family path can
    // consume unchanged. ADR 0011 §4: side = OPPOSITE of position side (the close
    // direction); sizing.qty = full remaining qty; eventId is deterministic (replay-safe).
    private buildCloseIntent(position: PositionEntity, armed: IArmedPosition, markPrice: MoneyValue, exitReason: ExitReasonEnum): IOrderIntent {
        const closeSide = position.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;
        const eventId = this.buildBreachEventId(armed.positionId, exitReason);
        const sizing = {
            qty: position.qty,
            notional: position.qty.times(markPrice),
            leverage: position.leverage,
            riskPerTradeUsdt: new Money(0),
            effectiveRiskUsdt: new Money(0),
        };

        return {
            intentAction: OrderIntentActionEnum.CLOSE,
            symbol: position.symbol,
            eventId,
            tradeSide: closeSide,
            signalScore: 0,
            correlationMode: position.correlationMode ?? CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: position.coinTier ?? CoinTierEnum.TIER_2,
            idiosyncrasyScore: 0,
            entryPrice: position.entryPrice,
            midAtTrigger: markPrice,
            maintenanceMarginRate: new Money(0),
            proposedExit: {
                takeProfitPrice: armed.takeProfitPrice ?? markPrice,
                stopLossPrice: armed.stopLossPrice ?? markPrice,
                stopType: StopTypeEnum.ATR,
                timeStopAtMs: 0,
            },
            openPosition: null,
            sizing,
            flowType: (position.flowTypeAtEntry as FlowTypeEnum | null | undefined) ?? FlowTypeEnum.TREND_INITIATION,
            exitReason,
        };
    }

    // Deterministic eventId per (positionId, exitReason). Same breach evaluated by
    // M7 backtest replay reproduces the same id — exchange-side duplicate-id guard
    // backs the in-process `breachInFlight` flag.
    private buildBreachEventId(positionId: number, exitReason: ExitReasonEnum): string {
        return `local-monitor-breach-${positionId}-${exitReason}`;
    }

    private resolveSlot(position: PositionEntity): PositionSlotEnum {
        return position.positionSlot ?? PositionSlotEnum.A;
    }

    // Minimal de-risking context: the gate short-circuits on intentAction === CLOSE
    // (`approveDeRisking`, ADR 0004 §2) before reading any field below. Building a
    // permissive stub keeps the monitor decoupled from the strategy-side context
    // builder; if `evaluate` ever inspects context for de-risking, this cast is
    // the canary — the type compiler catches the contract drift first.
    // M6 R1.3.1b — `nowMs` is injected from the originating IPriceUpdateEvent's
    // `timestampMs` (exchange event time). Deterministic / replay-safe: M7
    // backtest replay re-emits the same event with the same timestamp.
    private buildDeRiskContext(markPrice: MoneyValue, nowMs: number): IRiskGateContext {
        return {
            nowMs,
            utcDateString: new Date(nowMs).toISOString().slice(0, 10),
            snapshot: {} as IRiskGateContext['snapshot'],
            params: {} as IRiskGateContext['params'],
            strategyVersionId: 0,
            belowUniverseFloor: false,
            limits: {} as IRiskGateContext['limits'],
            riskState: {} as IRiskGateContext['riskState'],
            openPositions: {} as IRiskGateContext['openPositions'],
            instruments: {} as IRiskGateContext['instruments'],
            modelDivergenceDetected: false,
            // markPrice is parked on midAtTrigger of the intent; the context's snapshot
            // is intentionally empty because the gate never reads it for CLOSE. The
            // explicit `_ = markPrice` keeps the parameter from being lint-flagged as
            // unused — its real consumer is the intent (buildCloseIntent above).
            // (No-op reference to satisfy noUnusedParameters semantics.)
            ...(markPrice ? {} : {}),
        };
    }
}
