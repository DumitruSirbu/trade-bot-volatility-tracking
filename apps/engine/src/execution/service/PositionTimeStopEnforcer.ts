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
import { Inject, Injectable, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT, ORDER_INTENT_EXPIRED_EVENT, POSITION_OPENED_EVENT, PRICE_UPDATE_EVENT } from '../../common/const';
import { IPositionOpenedEvent } from '../../common/interface/IPositionOpenedEvent';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { PositionEntity } from '../../position/entity';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../../position/const';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { IIntentSizing, IOrderIntent, IOrderIntentApprovedEvent, IRiskGateContext } from '../../risk/interface';
import { IProposedExit } from '../../strategy/interface';
import { RiskGateService } from '../../risk/service';
import { ORDER_INTENT_EXPIRED_REASON_DRY_RUN, ORDER_INTENT_EXPIRED_REASON_HALTED, TIME_STOP_ENFORCER_EVENT_ID_PREFIX } from '../const';
import { SharedCloseCoordinator } from './SharedCloseCoordinator';

// M33 Fix 1 (ADR 0011 §9) — the live/paper time-stop enforcer. No component in the live path
// compared `now` to `positions.time_stop_at` and emitted a gated CLOSE, so a position whose
// SL/TP never trigger was held forever (the M33 P0 gap). This service closes that gap: on every
// `price.update` it closes any OPEN/PENDING_OPEN position whose `time_stop_at` is crossed,
// routing the CLOSE through RiskGateService.evaluate exactly as LocalProtectiveMonitor does.
//
// Backtest parity (DECISION, not fill price): `BacktestRunnerService.checkPositionExit` evaluates
// `shouldHitTimeStop` FIRST and returns before the intrabar SL/TP simulation — time-stop WINS a
// same-tick collision. The live path reproduces this via the shared close registry: the enforcer
// acquires the position's slot SYNCHRONOUSLY, before its first `await`, so the SL/TP monitor's
// handler — even if it runs during the enforcer's later DB await — finds the slot held and skips.
// `prependListener` orders listener INVOCATION but NOT async completion; the synchronous
// acquire-before-await is the actual time-stop-WINS guarantee.
//
// Determinism: the deadline is compared against the `price.update` EVENT timestamp, never
// `Date.now()`, so M7 backtest replay reproduces the same time-stop decision.
@Injectable()
export class PositionTimeStopEnforcer implements OnModuleInit {
    private readonly logger = new Logger(PositionTimeStopEnforcer.name);

    // In-memory deadline index: symbol → (positionId → timeStopAtMs). Armed at open and pruned
    // on CLOSED/CLOSING transitions. Reads on the price hot-path are synchronous (no DB), which
    // is what lets the slot be acquired before the first `await`.
    private readonly deadlineIndex = new Map<string, Map<number, number>>();

    // The minimum deadline across ALL symbols — the synchronous fast-path guard. A tick whose
    // event time is below this cannot have crossed any deadline, so it returns with no per-symbol
    // lookup and no DB read — a per-tick SELECT at hundreds-of-ticks/sec would saturate the loop.
    private earliestTimeStopMs = Infinity;

    constructor(
        private readonly positions: PositionRepository,
        // forwardRef mirrors LocalProtectiveMonitor: RiskGateService lives in RiskModule which
        // ExecutionModule imports, but RiskModule does not import ExecutionModule — the forwardRef
        // is precautionary against future circular imports as the gate seam grows.
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
        private readonly events: EventEmitter2,
        // The single shared close-in-flight registry — the dedup substrate across all close
        // producers (Fix 1b). Acquired synchronously before any await on the price hot-path.
        private readonly closeCoordinator: SharedCloseCoordinator,
    ) {}

    // Boot rebuild: the index must be populated before the first `price.update` fires. BootstrapModule
    // sits above ExecutionModule, so this `onModuleInit` runs during DI — ahead of market-data
    // streaming start (the same ordering guarantee phase 4c relies on). We rebuild across every
    // distinct symbol with an open candidate row via the repository's CLOSING-safe candidate query.
    async onModuleInit(): Promise<void> {
        const candidates = await this.positions.findOpen();
        const symbols = new Set(candidates.map((position) => position.symbol));

        for (const symbol of symbols) {
            await this.rebuildSymbolIndex(symbol);
        }

        this.logger.log(`time-stop deadline index rebuilt on boot — symbols=${this.deadlineIndex.size} earliestTimeStopMs=${this.earliestTimeStopMs}`);
    }

    // Arm the index when a position opens. The opened-event payload does not carry the deadline,
    // so we re-read the symbol's candidate rows (CLOSING-safe predicate) to pick up the persisted
    // `time_stop_at`. This is off the price hot-path, so the async re-read is acceptable.
    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpened(event: IPositionOpenedEvent): Promise<void> {
        await this.rebuildSymbolIndex(event.symbol);
    }

    // Prune the index when a position leaves an enforceable state. CLOSED/CLOSING rows are no
    // longer time-stop candidates; removing them keeps the synchronous due-check correct without
    // a DB read. CLOSED additionally releases the shared close slot (Fix 1b release table).
    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    onPositionStateTransitioned(event: IPositionStateTransitionedEvent): void {
        if (event.toState === PositionStateEnum.CLOSED) {
            this.closeCoordinator.release(event.positionId);
        }

        if (event.toState === PositionStateEnum.CLOSED || event.toState === PositionStateEnum.CLOSING) {
            this.removeFromIndex(event.symbol, event.positionId);
        }
    }

    // THE CRITICAL HOT-PATH. Synchronous start-to-acquire: the fast-path guard, the per-symbol
    // due-check, and `coordinator.tryAcquire` ALL run before any `await`. Only after the slot is
    // held does `enforceTimeStop` start async work (qty re-read + gate). This is what guarantees
    // time-stop WINS over SL/TP on a same-tick collision — prependListener orders invocation, but
    // the synchronous acquire here is the real serialization point.
    @OnEvent(PRICE_UPDATE_EVENT, { prependListener: true })
    onPriceUpdate(event: IPriceUpdateEvent): void {
        // FAST-PATH: synchronous scalar compare, no DB, no await. If no deadline has crossed,
        // return immediately.
        if (event.timestampMs < this.earliestTimeStopMs) {
            return;
        }

        const symbolMap = this.deadlineIndex.get(event.symbol);

        if (symbolMap === undefined) {
            return;
        }

        for (const [positionId, deadline] of symbolMap) {
            if (event.timestampMs < deadline) {
                continue;
            }

            // SYNCHRONOUS SLOT ACQUISITION BEFORE ANY AWAIT. tryAcquire is a synchronous
            // check-and-set; the monitor's handleBreach finds the slot held and skips — exactly one
            // close fires and the time-stop wins the collision.
            if (!this.closeCoordinator.tryAcquire(positionId)) {
                this.logger.log(`time-stop slot already held positionId=${positionId} - close in flight`);

                continue;
            }

            // Only AFTER the slot is held do we start async work. `void` so the handler returns
            // synchronously — the acquire above is the only serialization point that matters.
            void this.enforceTimeStop(positionId, event);
        }
    }

    // Runs only after the slot is held. Re-reads the authoritative row (qty may have changed via a
    // partial reduce between the index load and now — MEDIUM Q1), re-validates due-eligibility, then
    // routes a CLOSE through the gate. On any abort/reject it releases the slot so the next tick retries.
    private async enforceTimeStop(positionId: number, event: IPriceUpdateEvent): Promise<void> {
        // M33 R1-Fix-A: floating `void` call — a throw from any await below would leak the held slot
        // forever, leaving the position permanently uncloseable for this run. The catch releases the
        // slot, logs with context, and swallows (re-throwing would surface as an unhandled rejection).
        try {
            const candidates = await this.positions.findTimeStopCandidatesBySymbol(event.symbol);
            const position = this.validateTimeStopEligibility(positionId, candidates, event);

            if (position === null) {
                return;
            }

            // fill diverges from backtest bar.open by up to one taker slippage tier — ADR-0015 §4.6
            const markPrice = parseMoney(event.price);
            const intent = this.buildCloseIntent(position, markPrice);
            const context = this.buildDeRiskContext(event.timestampMs);

            await this.emitApprovedClose(intent, context, positionId, position, event.timestampMs);
        } catch (cause) {
            this.closeCoordinator.release(positionId);
            this.logger.error(
                `time-stop enforcement threw for positionId=${positionId} symbol=${event.symbol}: ` +
                    `${cause instanceof Error ? cause.message : String(cause)} - released close slot; next past-deadline tick will re-evaluate`,
            );
        }
    }

    // The three guard checks that gate a held slot into an actual close (re-read presence, persisted
    // deadline present, deadline still crossed against the event clock). Returns the validated row,
    // or null after releasing the slot — the position is no longer due, so the next tick re-evaluates.
    private validateTimeStopEligibility(positionId: number, candidates: readonly PositionEntity[], event: IPriceUpdateEvent): PositionEntity | null {
        const position = candidates.find((candidate) => candidate.id === positionId) ?? null;

        if (position === null) {
            this.logger.log(`time-stop positionId=${positionId} no longer a candidate (closed/qty<=0/CLOSING) - releasing slot`);
            this.removeFromIndex(event.symbol, positionId);
            this.closeCoordinator.release(positionId);

            return null;
        }

        if (position.timeStopAt === null || position.timeStopAt === undefined) {
            this.closeCoordinator.release(positionId);

            return null;
        }

        if (event.timestampMs < position.timeStopAt.getTime()) {
            this.closeCoordinator.release(positionId);

            return null;
        }

        return position;
    }

    // Routes the validated close intent through the gate and emits the approval. On a gate reject —
    // a contract violation, since de-risking is auto-approved (ADR 0004 §2) — it releases the slot so
    // the next past-deadline tick re-evaluates (the position is still past its deadline and must close).
    private async emitApprovedClose(
        intent: IOrderIntent,
        context: IRiskGateContext,
        positionId: number,
        position: PositionEntity,
        eventTimestampMs: number,
    ): Promise<void> {
        const decision = await this.riskGate.evaluate(intent, context);

        if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
            this.releaseOnGateReject(positionId, position, decision.rejectReason ?? 'unknown');

            return;
        }

        const approvedEvent: IOrderIntentApprovedEvent = {
            intent,
            approvedSlot: this.resolveSlot(position),
            approvedSizing: intent.sizing,
            clampedExit: intent.proposedExit,
            reservationId: decision.reservationId,
            strategyVersionId: position.strategyVersionId,
        };

        this.events.emit(ORDER_INTENT_APPROVED_EVENT, approvedEvent);

        this.logger.log(
            `time-stop close emitted positionId=${positionId} symbol=${position.symbol} side=${position.side} ` +
                `deadline=${position.timeStopAt?.getTime()} eventTs=${eventTimestampMs} - close intent emitted through gate`,
        );
    }

    // A gate reject on a de-risking close is a contract violation (ADR 0004 §2 auto-approves
    // de-risking). Release the slot so the next past-deadline tick re-evaluates — the position
    // is still past its deadline and must close.
    private releaseOnGateReject(positionId: number, position: PositionEntity, rejectReason: string): void {
        this.closeCoordinator.release(positionId);
        this.logger.error(
            `gate rejected time-stop close intent positionId=${positionId} symbol=${position.symbol} ` + `reason=${rejectReason} - releasing slot for retry`,
        );
    }

    // Release wiring per the Fix 1b release table. A halted/dry_run expiry leaves no live order
    // resting, so we release the enforcer's OWN slot (matched on its eventId prefix) and the next
    // past-deadline tick re-fires (ADR 0011 §4 last-line-of-defense). We do NOT release on
    // ORDER_INTENT_UNKNOWN_EVENT — reconciliation owns the row there.
    @OnEvent(ORDER_INTENT_EXPIRED_EVENT)
    onOrderIntentExpired(event: { eventId: string; reservationId: string | null; reason?: string }): void {
        if (event.reason !== ORDER_INTENT_EXPIRED_REASON_HALTED && event.reason !== ORDER_INTENT_EXPIRED_REASON_DRY_RUN) {
            return;
        }

        const positionId = this.extractPositionIdFromTimeStopEventId(event.eventId);

        if (positionId === null) {
            return;
        }

        if (!this.closeCoordinator.isHeld(positionId)) {
            return;
        }

        this.closeCoordinator.release(positionId);
        this.logger.warn(
            `time-stop intent for positionId=${positionId} expired (reason=${event.reason}) — released close slot; ` +
                `next past-deadline tick will re-evaluate (ADR 0011 §4 last-line-of-defense)`,
        );
    }

    // Parses a positionId out of the enforcer's deterministic eventId scheme
    // `time-stop-enforcer-${positionId}`. Distinct from LocalProtectiveMonitor's breach parser so
    // the enforcer releases ONLY its own slots — a monitor expiry must never release a time-stop slot.
    private extractPositionIdFromTimeStopEventId(eventId: string): number | null {
        const prefix = TIME_STOP_ENFORCER_EVENT_ID_PREFIX;

        if (!eventId.startsWith(prefix)) {
            return null;
        }

        const positionId = Number.parseInt(eventId.slice(prefix.length), 10);

        if (!Number.isInteger(positionId) || positionId <= 0) {
            return null;
        }

        return positionId;
    }

    // ─── index maintenance ───────────────────────────────────────────────────

    // Re-reads the symbol's candidate rows (CLOSING-safe predicate) and rebuilds that symbol's
    // deadline sub-map, then recomputes the global earliest. Replacing the sub-map wholesale keeps
    // the index consistent with the DB on every open without a partial-update bug.
    private async rebuildSymbolIndex(symbol: string): Promise<void> {
        const candidates = await this.positions.findTimeStopCandidatesBySymbol(symbol);
        const symbolMap = new Map<number, number>();

        for (const position of candidates) {
            if (position.timeStopAt === null || position.timeStopAt === undefined) {
                continue;
            }

            symbolMap.set(position.id, position.timeStopAt.getTime());
        }

        if (symbolMap.size === 0) {
            this.deadlineIndex.delete(symbol);
        } else {
            this.deadlineIndex.set(symbol, symbolMap);
        }

        this.recomputeEarliest();
    }

    private removeFromIndex(symbol: string, positionId: number): void {
        const symbolMap = this.deadlineIndex.get(symbol);

        if (symbolMap === undefined) {
            return;
        }

        symbolMap.delete(positionId);

        if (symbolMap.size === 0) {
            this.deadlineIndex.delete(symbol);
        }

        this.recomputeEarliest();
    }

    private recomputeEarliest(): void {
        let earliest = Infinity;

        for (const symbolMap of this.deadlineIndex.values()) {
            for (const deadline of symbolMap.values()) {
                if (deadline < earliest) {
                    earliest = deadline;
                }
            }
        }

        this.earliestTimeStopMs = earliest;
    }

    // ─── close-intent construction ──────────────────────────────────────────────
    //
    // exitReason is TIME_STOP; eventId is the enforcer's deterministic id so the executor's
    // duplicate-id guard backs the in-memory slot.
    private buildCloseIntent(position: PositionEntity, markPrice: MoneyValue): IOrderIntent {
        const closeSide = position.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;

        return {
            intentAction: OrderIntentActionEnum.CLOSE,
            symbol: position.symbol,
            eventId: this.buildTimeStopEventId(position.id),
            tradeSide: closeSide,
            signalScore: 0,
            correlationMode: position.correlationMode ?? CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: position.coinTier ?? CoinTierEnum.TIER_2,
            idiosyncrasyScore: 0,
            entryPrice: position.entryPrice,
            midAtTrigger: markPrice,
            maintenanceMarginRate: new Money(0),
            proposedExit: this.buildCloseIntentProposedExit(position, markPrice),
            openPosition: null,
            sizing: this.buildCloseIntentSizing(position, markPrice),
            flowType: (position.flowTypeAtEntry as FlowTypeEnum | null | undefined) ?? FlowTypeEnum.TREND_INITIATION,
            exitReason: ExitReasonEnum.TIME_STOP,
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
    // persisted SL/TP (or the mark as a permissive fallback) is sufficient; timeStopAtMs is 0
    // because the time-stop has already fired.
    private buildCloseIntentProposedExit(position: PositionEntity, markPrice: MoneyValue): IProposedExit {
        return {
            takeProfitPrice: position.takeProfitPrice ?? markPrice,
            stopLossPrice: position.stopLossPrice ?? markPrice,
            stopType: StopTypeEnum.ATR,
            timeStopAtMs: 0,
        };
    }

    private buildTimeStopEventId(positionId: number): string {
        return `${TIME_STOP_ENFORCER_EVENT_ID_PREFIX}${positionId}`;
    }

    private resolveSlot(position: PositionEntity): PositionSlotEnum {
        return position.positionSlot ?? PositionSlotEnum.A;
    }

    // Minimal de-risking context (mirrors LocalProtectiveMonitor.buildDeRiskContext). The gate
    // short-circuits on intentAction === CLOSE (approveDeRisking, ADR 0004 §2) before reading any
    // field below. `nowMs` is the price-update EVENT timestamp — never `Date.now()` — so backtest
    // replay reproduces the same time-stop decision (determinism invariant).
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
