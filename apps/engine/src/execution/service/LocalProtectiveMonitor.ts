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
import { IIntentSizing, IOrderIntent, IOrderIntentApprovedEvent, IRiskGateContext } from '../../risk/interface';
import { IProposedExit } from '../../strategy/interface';
import { RiskGateService } from '../../risk/service';
import { LOCAL_MONITOR_BREACH_EVENT_ID_PREFIX, ORDER_INTENT_EXPIRED_REASON_DRY_RUN, ORDER_INTENT_EXPIRED_REASON_HALTED } from '../const';
import { BreachKindEnum } from '../enum';
import { SharedCloseCoordinator } from './SharedCloseCoordinator';

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
    // M37 D3.1 — TP arming-tick guard. The TP monitor must NOT fire on a position whose entry fill
    // landed AT or PAST the TP level (a `take_profit` label requires a realized gain net of cost; an
    // instant-fire produces a 0-min hold / MFE=0.00 / net-negative close mislabeled as take_profit —
    // the EDGE/ZEC/ALLO defect). `tpEligible` starts false and flips true on the FIRST observed tick
    // where TP is NOT already breached — i.e. price was on the pre-target side at least once. Only
    // then can a later cross-up be a genuine take-profit run. SL is never gated (survival first), so
    // a position armed past TP still closes correctly via SL or the time-stop enforcer. The flag is
    // mutated in place on the armed entry (the Map holds the same object reference).
    tpEligible: boolean;
}

// Breach classification (`BreachKindEnum`, execution/enum) is side-aware per ADR 0011 §3:
//   LONG:  SL breached if mark <= SL;   TP breached if mark >= TP
//   SHORT: SL breached if mark >= SL;   TP breached if mark <= TP
// Equality is a breach (exchange-side STOP_MARKET "at-or-past" semantics, §3 final paragraph),
// and on the degenerate gap-through-both case SL wins — survival before opportunity.

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

    constructor(
        private readonly positions: PositionRepository,
        // forwardRef: RiskGateService lives in RiskModule which is imported by ExecutionModule,
        // but RiskModule does not import ExecutionModule — the dependency is one-way and the
        // forwardRef is precautionary against future circular imports as the gate seam grows.
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
        private readonly events: EventEmitter2,
        // M33 Fix 1b (ADR 0011 §9) — the shared close-in-flight registry replaces the prior
        // per-monitor `breachInFlight` set. It is the single dedup substrate across ALL close
        // producers, so a same-tick collision with the time-stop enforcer or the reconciliation
        // flatten emits exactly one close. `handleBreach` skips when the slot is already held.
        private readonly closeCoordinator: SharedCloseCoordinator,
    ) {}

    arm(input: { positionId: number; symbol: string; side: PositionSideEnum; stopLossPrice: MoneyValue | null; takeProfitPrice: MoneyValue | null }): void {
        this.armed.set(input.positionId, {
            positionId: input.positionId,
            symbol: input.symbol,
            side: input.side,
            stopLossPrice: input.stopLossPrice,
            takeProfitPrice: input.takeProfitPrice,
            armedAtMs: Date.now(),
            // M37 D3.1: TP starts ineligible — it arms only after the first tick observed on the
            // pre-target side of the TP level (see `evaluateBreach`).
            tpEligible: false,
        });

        this.logger.log(`local monitor armed positionId=${input.positionId} symbol=${input.symbol} side=${input.side}`);
    }

    disarm(positionId: number): void {
        if (!this.armed.has(positionId)) {
            return;
        }

        // M33 Fix 1b: `disarm` clears ONLY the SL/TP arm state — it does NOT release
        // the shared close slot. `applyReduceFillToPosition` disarms BEFORE the durable CLOSED
        // write; releasing the slot here would let a later tick emit a second close. The slot
        // is released only on the locked outcomes (CLOSED, gate-reject, halted/dry_run expiry).
        this.armed.delete(positionId);
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
    //
    // M37 D3.1: TP is gated on `armed.tpEligible` — a TP breach is suppressed until the position has
    // observed at least one tick on the pre-target side of the TP level (the eligibility transition is
    // owned by `onPriceUpdate`, the command path, so this stays a pure query per CQS). SL is never
    // gated: survival before opportunity, and a degenerate gap through both still resolves to SL.
    evaluateBreach(armed: IArmedPosition, markPrice: MoneyValue): BreachKindEnum | null {
        if (armed.stopLossPrice !== null && this.isStopLossBreached(armed.side, markPrice, armed.stopLossPrice)) {
            return BreachKindEnum.STOP_LOSS;
        }

        if (armed.tpEligible && armed.takeProfitPrice !== null && this.isTakeProfitBreached(armed.side, markPrice, armed.takeProfitPrice)) {
            return BreachKindEnum.TAKE_PROFIT;
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
            // M37 D3.1: flip TP eligibility BEFORE evaluating. A tick on the pre-target side of the TP
            // level (TP not breached) proves the position was not opened at/past its TP, so a later
            // cross-up is a genuine take-profit run. This is the command-path mutation that keeps
            // `evaluateBreach` a pure query.
            this.updateTakeProfitEligibility(armed, markPrice);

            const breach = this.evaluateBreach(armed, markPrice);

            if (breach === null) {
                continue;
            }

            await this.handleBreach(armed, markPrice, breach, event.timestampMs);
        }
    }

    // M37 D3.1 arming-tick transition. Once `tpEligible` is true it stays true (a position that ran
    // favorably then pulled back to entry is still TP-eligible). It flips true the first time a tick
    // is observed where TP is NOT already breached — i.e. price is on the pre-target side. If the very
    // first observed tick is already at/past TP (entry filled at/past the target), the flag stays false
    // and that instant TP fire is suppressed; the position closes via SL or the time-stop enforcer with
    // a correct exit label, never a 0-min/MFE-0.00 `take_profit`.
    private updateTakeProfitEligibility(armed: IArmedPosition, markPrice: MoneyValue): void {
        if (armed.tpEligible || armed.takeProfitPrice === null) {
            return;
        }

        if (!this.isTakeProfitBreached(armed.side, markPrice, armed.takeProfitPrice)) {
            armed.tpEligible = true;

            return;
        }

        this.logger.warn(
            `local monitor TP suppressed on arming tick positionId=${armed.positionId} symbol=${armed.symbol} side=${armed.side} ` +
                `markPrice=${markPrice.toFixed()} tp=${armed.takeProfitPrice.toFixed()} - entry filled at/past TP; ` +
                `awaiting a pre-target tick before TP can fire (M37 D3.1)`,
        );
    }

    // Disarm-on-CLOSED: the monitor stands down automatically when the position
    // reaches a closed state. Mirrors the symmetric arm-on-open path. The CLOSED
    // terminal also releases the shared close slot per the Fix 1b release table —
    // this is the load-bearing release for the monitor's own breach closes.
    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    onPositionStateTransitioned(event: IPositionStateTransitionedEvent): void {
        if (event.toState !== PositionStateEnum.CLOSED) {
            return;
        }

        this.closeCoordinator.release(event.positionId);
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
    // The fix: when an `ORDER_INTENT_EXPIRED_EVENT` with reason ∈ {'halted','dry_run'}
    // matches one of our breach eventIds, release the shared close slot so the next
    // price tick re-evaluates and re-fires. No live order is resting on either expiry
    // reason (Fix 1b release table), so re-emit is correct and harmless. The eventId is
    // the breach factory's deterministic id `local-monitor-breach-${positionId}-${reason}`,
    // so we can recover the positionId without an extra lookup. ADR-0011 §4 "local monitor
    // as last line of defense" applies under halt too.
    @OnEvent(ORDER_INTENT_EXPIRED_EVENT)
    onOrderIntentExpired(event: { eventId: string; reservationId: string | null; reason?: string }): void {
        if (event.reason !== ORDER_INTENT_EXPIRED_REASON_HALTED && event.reason !== ORDER_INTENT_EXPIRED_REASON_DRY_RUN) {
            return; // other expiries don't unprotect the position
        }

        const positionId = this.extractPositionIdFromBreachEventId(event.eventId);

        if (positionId === null) {
            return; // not one of our breach intents
        }

        if (!this.closeCoordinator.isHeld(positionId)) {
            return;
        }

        this.closeCoordinator.release(positionId);
        this.logger.warn(
            `breach intent for positionId=${positionId} expired (reason=${event.reason}) — released close slot; ` +
                `next price tick will re-evaluate (ADR 0011 §4 last-line-of-defense)`,
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
        const prefix = LOCAL_MONITOR_BREACH_EVENT_ID_PREFIX;

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
    private async handleBreach(armed: IArmedPosition, markPrice: MoneyValue, breach: BreachKindEnum, nowMs: number): Promise<void> {
        // M33 Fix 1b reciprocal guard: acquire the shared close slot BEFORE any await. If a
        // time-stop (or any other producer) already holds it this tick, skip emitting — exactly
        // one close fires and the time-stop wins the collision (ADR 0011 §9). `tryAcquire` is a
        // synchronous check-and-set, so it also closes the race where a second price.update tick
        // lands between this call and the emit below (the prior `breachInFlight` semantics).
        if (!this.closeCoordinator.tryAcquire(armed.positionId)) {
            return;
        }

        // Slot is held synchronously above; the awaited lookup → gate → emit body runs as a
        // floating void (matching the time-stop enforcer's pattern). executeBreachClose owns the
        // try/catch slot-release safety net for everything past this point.
        void this.executeBreachClose(armed, markPrice, breach, nowMs);
    }

    // Runs only after the close slot is held. M33 R1-Fix-A: an unexpected throw from `findById` or
    // the gate evaluate would leak the slot forever — the position becomes structurally unprotected
    // for this run. The try/catch releases the slot on any throw, logs with context, and returns;
    // the next price tick re-evaluates the still-armed breach. The conditional releases inside the
    // try body remain correct as-is.
    private async executeBreachClose(armed: IArmedPosition, markPrice: MoneyValue, breach: BreachKindEnum, nowMs: number): Promise<void> {
        try {
            const position = await this.positions.findById(armed.positionId);

            if (position === null) {
                this.logger.warn(
                    `breach detected for positionId=${armed.positionId} symbol=${armed.symbol} but position row not found - disarming and skipping`,
                );
                this.closeCoordinator.release(armed.positionId);
                this.disarm(armed.positionId);

                return;
            }

            const exitReason = breach === BreachKindEnum.STOP_LOSS ? ExitReasonEnum.STOP_LOSS : ExitReasonEnum.TAKE_PROFIT;
            const intent = this.buildCloseIntent(position, armed, markPrice, exitReason);
            const context = this.buildDeRiskContext(nowMs);

            const decision = await this.riskGate.evaluate(intent, context);

            if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
                // De-risking is supposed to be auto-approved (ADR 0004 §2). A reject here
                // is a contract violation — log loudly, release the close slot so the
                // next tick has a chance to re-try (this is the safer path: the position
                // is still breached and the local monitor is the last line of defense).
                this.closeCoordinator.release(armed.positionId);
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
        } catch (cause) {
            this.closeCoordinator.release(armed.positionId);
            this.logger.error(
                `local-monitor breach handling threw for positionId=${armed.positionId} symbol=${armed.symbol}: ` +
                    `${cause instanceof Error ? cause.message : String(cause)} - released close slot; next price tick will re-evaluate`,
            );
        }
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
            proposedExit: this.buildCloseIntentProposedExit(armed, markPrice),
            openPosition: null,
            sizing: this.buildCloseIntentSizing(position, markPrice),
            flowType: (position.flowTypeAtEntry as FlowTypeEnum | null | undefined) ?? FlowTypeEnum.TREND_INITIATION,
            exitReason,
        };
    }

    // Full-close sizing: the entire remaining qty, valued at the mark. Risk fields are zero — a
    // de-risking close acquires no exposure, so it carries no per-trade risk budget (ADR 0004 §2).
    private buildCloseIntentSizing(position: PositionEntity, markPrice: MoneyValue): IIntentSizing {
        return {
            qty: position.qty,
            notional: position.qty.times(markPrice),
            leverage: position.leverage,
            riskPerTradeUsdt: new Money(0),
            effectiveRiskUsdt: new Money(0),
        };
    }

    // The gate short-circuits on intentAction === CLOSE without reading these targets, so the
    // armed SL/TP (or the mark as a permissive fallback) is sufficient; timeStopAtMs is 0.
    private buildCloseIntentProposedExit(armed: IArmedPosition, markPrice: MoneyValue): IProposedExit {
        return {
            takeProfitPrice: armed.takeProfitPrice ?? markPrice,
            stopLossPrice: armed.stopLossPrice ?? markPrice,
            stopType: StopTypeEnum.ATR,
            timeStopAtMs: 0,
            // M38 D1 (ADR 0045): a close intent is never rebased — it is a de-risking exit, not an open.
            tpRebaseEligible: false,
            atrDistance: null,
        };
    }

    // Deterministic eventId per (positionId, exitReason). Same breach evaluated by
    // M7 backtest replay reproduces the same id — exchange-side duplicate-id guard
    // backs the in-process `breachInFlight` flag.
    private buildBreachEventId(positionId: number, exitReason: ExitReasonEnum): string {
        return `${LOCAL_MONITOR_BREACH_EVENT_ID_PREFIX}${positionId}-${exitReason}`;
    }

    private resolveSlot(position: PositionEntity): PositionSlotEnum {
        return position.positionSlot ?? PositionSlotEnum.A;
    }

    // Minimal de-risking context: the gate short-circuits on intentAction === CLOSE
    // (`approveDeRisking`, ADR 0004 §2) before reading any field below. Building a
    // permissive stub keeps the monitor decoupled from the strategy-side context
    // builder; if `evaluate` ever inspects context for de-risking, this cast is
    // the canary — the type compiler catches the contract drift first. The mark price
    // is carried on the intent's `midAtTrigger`, so the context does not need it.
    // M6 R1.3.1b — `nowMs` is injected from the originating IPriceUpdateEvent's
    // `timestampMs` (exchange event time). Deterministic / replay-safe: M7
    // backtest replay re-emits the same event with the same timestamp.
    private buildDeRiskContext(nowMs: number): IRiskGateContext {
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
        };
    }
}
