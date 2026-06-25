import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RiskOutcomeEnum,
    StopTypeEnum,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT, ORDER_INTENT_EXPIRED_EVENT } from '../../common/const';
import { Money, MoneyValue } from '../../common/utils/money';
import { PositionEntity } from '../../position/entity';
import { IIntentSizing, IOrderIntent, IOrderIntentApprovedEvent, IRiskGateContext } from '../../risk/interface';
import { RiskGateService } from '../../risk/service';
import { ORDER_INTENT_EXPIRED_REASON_DRY_RUN, ORDER_INTENT_EXPIRED_REASON_HALTED, SYNTHETIC_CLOSE_EVENT_ID_PREFIX } from '../const';
import { SharedCloseCoordinator } from './SharedCloseCoordinator';

// All the data needed to synthesise + emit one fill-acceptance FLATTEN unwind. Grouped into a
// single request object so the public/private methods stay inside the ≤2-argument convention.
interface ISyntheticCloseRequest {
    positionRow: PositionEntity;
    side: PositionSideEnum;
    markPrice: MoneyValue;
    exitReason: ExitReasonEnum;
    slot: PositionSlotEnum;
    strategyVersionId: number;
}

// M38 D2 (ADR 0045 §6) — the third copy of the `acquire close slot → buildCloseIntent →
// gate-evaluate (auto-approved de-risk) → emit ORDER_INTENT_APPROVED_EVENT` pattern triggered
// the DRY rule (3+ occurrences), so it is extracted here. LocalProtectiveMonitor.executeBreachClose
// and ReconciliationService.flattenAdoptedForeignPosition keep their existing copies this
// milestone (carry-over refactor per the ADR — extraction must not balloon the diff); only the
// new D2 fill-acceptance unwind consumes this service.
//
// It is a service (not a bare util) because it depends on SharedCloseCoordinator, RiskGateService,
// and the event emitter — all injected. It owns the slot-acquire → build → gate → emit →
// slot-leak/throw handling so a doomed open fill is force-closed through the existing reduce-family
// finalize, yielding one CLEAN CLOSED positions row (FORCE_CLOSE) with DB and exchange in agreement.
@Injectable()
export class FillAcceptanceUnwindService {
    private readonly logger = new Logger(FillAcceptanceUnwindService.name);

    constructor(
        private readonly closeCoordinator: SharedCloseCoordinator,
        private readonly riskGate: RiskGateService,
        private readonly events: EventEmitter2,
    ) {}

    // Emit a synthetic FLATTEN close for an already-filled position that must be unwound (D2
    // reject). Acquires the shared close slot, builds a de-risking FLATTEN intent, runs it
    // through the gate (auto-approved), and emits the approved event for the executor's
    // reduce-family path. On gate-reject or any throw the slot is released and the method
    // returns — never rethrows (the caller still finalizes its own reservation).
    async emitSyntheticClose(request: ISyntheticCloseRequest): Promise<void> {
        const positionRow = request.positionRow;

        if (!this.closeCoordinator.tryAcquire(positionRow.id)) {
            this.logger.warn(`synthetic close skipped positionId=${positionRow.id} symbol=${positionRow.symbol} - close already in flight (shared registry)`);

            return;
        }

        try {
            const intent = this.buildFlattenIntent(request);
            const context = this.buildDeRiskContext();
            const decision = await this.riskGate.evaluate(intent, context);

            if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
                this.closeCoordinator.release(positionRow.id);
                this.logger.error(
                    `synthetic close gate rejected positionId=${positionRow.id} symbol=${positionRow.symbol} ` +
                        `reason=${decision.rejectReason ?? 'unknown'} - released close slot; row left for reconciliation`,
                );

                return;
            }

            this.buildAndEmitApprovedCloseEvent(intent, request, decision.reservationId);
        } catch (cause) {
            this.closeCoordinator.release(positionRow.id);
            this.logger.error(
                `synthetic close threw for positionId=${positionRow.id} symbol=${positionRow.symbol}: ` +
                    `${cause instanceof Error ? cause.message : String(cause)} - released close slot; row left for reconciliation`,
            );
        }
    }

    // Release wiring per the Fix 1b release table. A halted/dry_run expiry leaves no live order
    // resting, so if the emitted synthetic FLATTEN expired we MUST release our own slot — otherwise
    // the close-coordinator slot is held forever and the position can never be re-closed. Matched
    // on the synthetic-close eventId prefix so we release ONLY our own held slot, never another
    // producer's (enforcer / monitor / reconciliation). Other expiry reasons leave a resting order,
    // so they are ignored. The row is left for reconciliation.
    @OnEvent(ORDER_INTENT_EXPIRED_EVENT)
    onOrderIntentExpired(event: { eventId: string; reservationId: string | null; reason?: string }): void {
        if (event.reason !== ORDER_INTENT_EXPIRED_REASON_HALTED && event.reason !== ORDER_INTENT_EXPIRED_REASON_DRY_RUN) {
            return;
        }

        const positionId = this.extractPositionIdFromEventId(event.eventId);

        if (positionId === null) {
            return;
        }

        if (!this.closeCoordinator.isHeld(positionId)) {
            return;
        }

        this.closeCoordinator.release(positionId);
        this.logger.warn(
            `synthetic-close intent for positionId=${positionId} expired (reason=${event.reason}) — released close slot; ` + `row left for reconciliation`,
        );
    }

    // Parses a positionId out of the deterministic synthetic-close eventId scheme
    // `synthetic-close-${positionId}-${exitReason}`. Returns null if the eventId doesn't match —
    // i.e., the expired intent was not produced by us. Splits from the RIGHT (`lastIndexOf('-')`)
    // so an exitReason with embedded characters never splits the positionId mid-string.
    private extractPositionIdFromEventId(eventId: string): number | null {
        if (!eventId.startsWith(SYNTHETIC_CLOSE_EVENT_ID_PREFIX)) {
            return null;
        }

        const rest = eventId.slice(SYNTHETIC_CLOSE_EVENT_ID_PREFIX.length);
        const dashIndex = rest.lastIndexOf('-');

        if (dashIndex <= 0) {
            return null;
        }

        const id = Number(rest.slice(0, dashIndex));

        return Number.isFinite(id) ? id : null;
    }

    // Builds the approved event from an already-gated intent and emits it on the executor's
    // reduce-family path. The reservation is null for de-risking actions (ADR 0004 §2) — the
    // executor's safe helpers treat null as a no-op.
    private buildAndEmitApprovedCloseEvent(intent: IOrderIntent, request: ISyntheticCloseRequest, reservationId: string | null): void {
        const approvedEvent: IOrderIntentApprovedEvent = {
            intent,
            approvedSlot: request.slot,
            approvedSizing: intent.sizing,
            clampedExit: intent.proposedExit,
            reservationId,
            strategyVersionId: request.strategyVersionId,
        };
        this.events.emit(ORDER_INTENT_APPROVED_EVENT, approvedEvent);

        this.logger.warn(
            `synthetic FLATTEN positionId=${request.positionRow.id} symbol=${request.positionRow.symbol} side=${request.side} ` +
                `exitReason=${request.exitReason} markPrice=${request.markPrice.toFixed()} - close intent emitted through gate`,
        );
    }

    // Synthesise a FLATTEN IOrderIntent the executor's reduce-family path consumes unchanged.
    // closeSide = OPPOSITE of the position side (the close direction); sizing.qty = full remaining
    // qty valued at the mark; risk fields zero (a de-risking close acquires no exposure). The
    // proposedExit is a permissive stub — the gate short-circuits on de-risking actions without
    // reading SL/TP — and explicitly declares tpRebaseEligible=false / atrDistance=null.
    private buildFlattenIntent(request: ISyntheticCloseRequest): IOrderIntent {
        const position = request.positionRow;
        const closeSide = request.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;
        const eventId = `${SYNTHETIC_CLOSE_EVENT_ID_PREFIX}${position.id}-${request.exitReason}`;

        return {
            intentAction: OrderIntentActionEnum.FLATTEN,
            symbol: position.symbol,
            eventId,
            tradeSide: closeSide,
            signalScore: 0,
            correlationMode: position.correlationMode ?? CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: position.coinTier ?? CoinTierEnum.TIER_2,
            idiosyncrasyScore: 0,
            entryPrice: position.entryPrice,
            referencePrice: position.entryPrice,
            midAtTrigger: request.markPrice,
            maintenanceMarginRate: new Money(0),
            proposedExit: {
                takeProfitPrice: request.markPrice,
                stopLossPrice: request.markPrice,
                stopType: StopTypeEnum.ATR,
                timeStopAtMs: 0,
                tpRebaseEligible: false,
                atrDistance: null,
            },
            openPosition: null,
            sizing: this.buildSizing(request),
            flowType: (position.flowTypeAtEntry as FlowTypeEnum | null | undefined) ?? FlowTypeEnum.TREND_INITIATION,
            exitReason: request.exitReason,
        };
    }

    private buildSizing(request: ISyntheticCloseRequest): IIntentSizing {
        const { positionRow, markPrice } = request;

        return {
            qty: positionRow.qty,
            notional: positionRow.qty.times(markPrice),
            leverage: positionRow.leverage,
            riskPerTradeUsdt: new Money(0),
            effectiveRiskUsdt: new Money(0),
        };
    }

    private buildDeRiskContext(): IRiskGateContext {
        const nowMs = Date.now();

        return {
            nowMs,
            utcDateString: new Date(nowMs).toISOString().slice(0, 10),
            // The gate short-circuits `approveDeRisking` (ADR 0004 §2) for FLATTEN intents
            // before reading any context field below. These stubs are never inspected; the
            // `as` casts are safe at this boundary — update if `approveDeRisking` ever
            // begins reading context fields.
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
