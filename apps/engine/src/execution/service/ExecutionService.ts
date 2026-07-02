import {
    ExchangeEnvironmentEnum,
    ExitReasonEnum,
    IExchangeOverfillDriftEvent,
    IMarketSnapshot,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    QtyAdjustmentReasonEnum,
    StrategyDirectionEnum,
    TransactionTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import {
    AuditFailureReasonEnum,
    EXCHANGE_OVERFILL_DRIFT_EVENT,
    ORDER_AUDIT_PERSIST_FAILED_EVENT,
    ORDER_INTENT_APPROVED_EVENT,
    ORDER_INTENT_EXPIRED_EVENT,
    ORDER_INTENT_FAILED_EVENT,
    ORDER_INTENT_UNKNOWN_EVENT,
    ORDER_PROTECTIVE_FALLBACK_EVENT,
    POSITION_CLOSED_EVENT,
    POSITION_OPENED_EVENT,
} from '../../common/const';
import { IOrderIntentUnknownEvent, IPositionClosedEvent, IPositionOpenedEvent } from '../../common/interface';
import { HaltFlagService } from '../../common/service';
import { DecimalValue, formatMoney, Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { TransactionRepository } from '../../position/repository/TransactionRepository';
import { PositionInstrumentor, PositionService } from '../../position/service';
import { computeFillCashflow } from '../../position/util/pnlMath';
import { IOrderIntent, IOrderIntentApprovedEvent } from '../../risk/interface';
import { RiskStateRepository } from '../../risk/repository/RiskStateRepository';
import { RiskGateService } from '../../risk/service';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import {
    ENTRY_AUDIT_PERSIST_FAILED_REASON,
    FILL_ACCEPTANCE_REJECTED,
    MAX_PERMANENT_RETRY_ATTEMPTS,
    MAX_REDUCE_REMAINDER_ATTEMPTS,
    MAX_SIGNAL_DRIFT_PCT,
    ORDER_INTENT_EXPIRED_REASON_DRY_RUN,
    ORDER_INTENT_EXPIRED_REASON_HALTED,
    PENDING_OPEN_PROMOTE_EVENT_CLASS,
    PENDING_PROMOTE_FAILED_REASON,
    REDUCE_ON_FLAT_POSITION_REASON,
} from '../const';
import { SubmitStateEnum } from '../enum';
import { IFillSummary, IOrderPlanInternal, IProtectiveAttachResult, IProtectiveFallbackEvent } from '../interface';
import { evaluateFillDrift, rebaseMomentumTakeProfit } from '../utils';
import { ClientOrderIdFactory } from './ClientOrderIdFactory';
import { ExchangeOrderSubmitter } from './ExchangeOrderSubmitter';
import { FillAcceptanceUnwindService } from './FillAcceptanceUnwindService';
import { FillAccumulator } from './FillAccumulator';
import { LocalProtectiveMonitor } from './LocalProtectiveMonitor';
import { OrderPolicyRouter } from './OrderPolicyRouter';
import { ProtectiveOrderAttacher } from './ProtectiveOrderAttacher';

// The ONLY consumer of `order.intent.approved` events that places orders on the exchange.
// Strategies, controllers, the dashboard, and (future) M6 reconciliation never call ccxt's
// createOrder directly (ADR 0005/0006 reviewer must-fix). This service:
//
//   1. Routes the intent through OrderPolicyRouter (pure, ADR 0005 §1) using flowType
//      carried on the intent (NO resolveFlowType heuristic — must-fix #2).
//   2. Honors HaltFlagService on every retry hop, releasing the reservation and emitting
//      ORDER_INTENT_EXPIRED_EVENT with reason='halted' (must-fix #6).
//   3. Mints a deterministic clientOrderId (ADR 0006 §1) and runs the submit/recover/cancel
//      state machine (§2/§3). attemptN advances ONLY on RETRIABLE classified rejects;
//      TERMINAL short-circuits to ABORTED; UNKNOWN routes through recover-by-clientOrderId
//      (must-fix #8).
//   4. Branches awaitPolicyTimeout per OrderPolicyEnum (must-fix #7):
//        - IOC: fetch terminal state, no cancel call (exchange auto-cancels).
//        - POST_ONLY_MAKER: cancel + classify; no remainder reevaluate; no chase.
//        - REDUCE_MARKET: retry remainder under attemptN++ up to MAX_REDUCE_REMAINDER_ATTEMPTS.
//   5. Pegs POST_ONLY_MAKER limit price to live best-bid/best-ask before submit (must-fix #9).
//   6. Folds fills via FillAccumulator (ADR 0007 §1). Branches on intentAction for ADD
//      with weighted-avg entry, OPEN with fresh row (must-fix #4).
//   7. Arms LocalProtectiveMonitor SYNCHRONOUSLY between positions.insert and
//      protectiveAttacher.attach — UNCONDITIONALLY (must-fix #13 / ADR 0008 §2).
//   8. Persists one transactions row per terminal (ADR 0006 §5) including zero-fill audit
//      rows for missed entries (must-fix #14, enabled by migration 20260524020000).

// Inputs to the fill-acceptance guard (M38 D2). Grouped into one context object so the guard
// and its extracted unwind helper stay inside the ≤2-argument convention.
interface IFillAcceptanceContext {
    event: IOrderIntentApprovedEvent;
    positionRow: PositionEntity;
    fillSummary: IFillSummary;
    // M48 (ADR 0045 §D2.9) — the actual armed TP at fill time (rebased to the fill price for
    // tpRebaseEligible fills; the frozen signal-anchored TP otherwise). The geometry R:R leg
    // anchors to this value, not clampedExit.takeProfitPrice.
    resolvedTakeProfitPrice: MoneyValue;
}

@Injectable()
export class ExecutionService {
    private readonly logger = new Logger(ExecutionService.name);

    // Cache strategyVersionId -> direction. The gate's approved event already carries the
    // versionId; the direction is a stable field on the StrategyVersionEntity row.
    private readonly strategyDirectionCache = new Map<number, StrategyDirectionEnum>();

    // M45 D4. Per-positionId reentrancy guard on the close-fill application path, mirroring the
    // LocalProtectiveMonitor breach-in-flight contract (add on entry, delete in finally). Two
    // reduce fills resolving a close on the SAME position concurrently would each run the
    // promote → CLOSING → finalize → POSITION_CLOSED sequence, double-finalizing the row. The
    // SharedCloseCoordinator dedups close-intent EMISSION across producers; this guards the
    // executor's APPLICATION of those fills. A loser returns early WITHOUT releasing slot or
    // reservation — the winning caller owns the close lifecycle and its release.
    private readonly closingInFlight = new Set<number>();

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly policyRouter: OrderPolicyRouter,
        private readonly clientOrderIdFactory: ClientOrderIdFactory,
        private readonly submitter: ExchangeOrderSubmitter,
        private readonly fillAccumulator: FillAccumulator,
        private readonly protectiveAttacher: ProtectiveOrderAttacher,
        private readonly localProtectiveMonitor: LocalProtectiveMonitor,
        private readonly positions: PositionRepository,
        private readonly positionService: PositionService,
        private readonly transactions: TransactionRepository,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly riskGate: RiskGateService,
        private readonly haltFlag: HaltFlagService,
        private readonly fillAcceptanceUnwind: FillAcceptanceUnwindService,
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly events: EventEmitter2,
        private readonly riskState: RiskStateRepository,
        // M47 Task 5a (tech-debt M7) — seeded synchronously at open time so the entry-window
        // peak-excursion ticks are captured, not dropped by the async seed-timing race.
        // forwardRef: ExecutionModule imports PositionModule via forwardRef (a real cycle).
        // Placed last to keep the existing positional constructor order stable for callers.
        @Inject(forwardRef(() => PositionInstrumentor))
        private readonly positionInstrumentor: PositionInstrumentor,
    ) {}

    @OnEvent(ORDER_INTENT_APPROVED_EVENT)
    async onOrderIntentApproved(event: IOrderIntentApprovedEvent): Promise<void> {
        try {
            await this.handleApproved(event);
        } catch (cause) {
            this.logger.error(`unhandled execution failure for event=${event.intent.eventId}: ${this.describe(cause)}`);
            this.releaseReservationSafely(event.reservationId);
        }
    }

    private async handleApproved(event: IOrderIntentApprovedEvent): Promise<void> {
        // M6 R1.3.1c — single boundary capture for the `openedAt` stamp of any new
        // position row inserted by this intent (createPositionFromFill below). The
        // event itself does not carry a timestamp today; capturing once here keeps
        // the value stable across the submit-state-machine lifetime of one intent
        // (deterministic from the test harness's frozen-clock perspective).
        const nowMs = Date.now();
        const direction = await this.resolveDirection(event.strategyVersionId);
        const plan = this.policyRouter.plan({
            intent: event.intent,
            strategyDirection: direction,
            maxSlippageOfSlPct: null,
        });

        this.logger.log(
            `execute intent eventId=${event.intent.eventId} symbol=${event.intent.symbol} action=${event.intent.intentAction} ` +
                `slot=${event.approvedSlot} policy=${plan.policy} flowType=${event.intent.flowType} timeoutMs=${plan.timeoutMs} ` +
                `dryRun=${!this.appConfig.isExecutionLive}`,
        );

        if (!this.appConfig.isExecutionLive) {
            await this.handleDryRun(event, plan);

            return;
        }

        // ADR 0046 §2.1: a halt blocks new risk only — OPEN/ADD aborts here; REDUCE/CLOSE/FLATTEN
        // execute under halt so protective exits (time-stop, SL, M38 unwind, operator flatten)
        // survive to CLOSED. `isOpenOrAddIntent` is the single, uniform halt-scoping authority.
        if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(event.intent.intentAction)) {
            this.logger.warn(`halt flag set (${this.haltFlag.getReason() ?? 'no-reason'}); short-circuiting eventId=${event.intent.eventId}`);
            this.releaseReservationSafely(event.reservationId);
            this.events.emit(ORDER_INTENT_EXPIRED_EVENT, {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                reason: ORDER_INTENT_EXPIRED_REASON_HALTED,
            });

            return;
        }

        await this.executeLive(event, plan, nowMs);
    }

    // Dry-run path: records a zero-qty audit row in `transactions` (now possible per ADR 0007
    // §3 nullable position_id + CHECK constraint, migration 20260524020000) and releases the
    // reservation. The gate's approval has done its job; this preserves the audit trail
    // (every approved event shows up in `transactions`) without touching the exchange.
    private async handleDryRun(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal): Promise<void> {
        const clientOrderId = this.clientOrderIdFactory.build({
            eventId: event.intent.eventId,
            positionSlot: event.approvedSlot,
            intentAction: event.intent.intentAction,
            attemptN: 0,
        });

        await this.recordZeroFillAuditRow(event, clientOrderId);

        this.logger.log(`dry-run: clientOrderId=${clientOrderId} plan=${plan.policy}@${formatMoney(plan.limitPrice)} audit row persisted`);
        this.releaseReservationSafely(event.reservationId);
        this.events.emit(ORDER_INTENT_EXPIRED_EVENT, {
            eventId: event.intent.eventId,
            reservationId: event.reservationId,
            reason: ORDER_INTENT_EXPIRED_REASON_DRY_RUN,
        });
    }

    private async executeLive(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal, nowMs: number): Promise<void> {
        const submitResult = await this.runSubmitStateMachine(event, plan);

        // Branch on intent action class BEFORE routing into the open/add path. A reduce-family
        // intent (REDUCE / CLOSE / FLATTEN — or any future non-OPEN/ADD enum value) must NEVER
        // fall through to `openOrAddPositionAndAttachProtection` — that would create a phantom
        // OPEN row from a de-risking intent (round-3 must-fix #1). Round-4 #6 inverts the
        // whitelist: only OPEN/ADD reach the open/add path; everything else is reduce-family
        // and escalates via ORDER_INTENT_UNKNOWN_EVENT on non-clean terminals.
        if (!this.isOpenOrAddIntent(event.intent.intentAction)) {
            await this.handleReduceTerminal(event, submitResult);
            this.fillAccumulator.forget(submitResult.clientOrderId);

            return;
        }

        if (submitResult.fillSummary === null) {
            this.logger.log(
                `no-fill terminal eventId=${event.intent.eventId} symbol=${event.intent.symbol} ` +
                    `state=${submitResult.state} attemptN=${submitResult.attemptN} clientOrderId=${submitResult.clientOrderId}`,
            );
            await this.handleNoFill(event, submitResult);
            this.fillAccumulator.forget(submitResult.clientOrderId);

            return;
        }

        await this.openOrAddPositionAndAttachProtection(event, plan, submitResult, nowMs);
        this.fillAccumulator.forget(submitResult.clientOrderId);
    }

    // Inverted whitelist (round-4 #6): true ONLY for OPEN and ADD. Any future enum value
    // (or an unknown action) is treated as reduce-family by the caller, which routes through
    // M6 escalation rather than producing a phantom OPEN row.
    private isOpenOrAddIntent(action: OrderIntentActionEnum): boolean {
        return action === OrderIntentActionEnum.OPEN || action === OrderIntentActionEnum.ADD;
    }

    // Reduce-family terminal handler (round-3 must-fix #1 + #4). The single rule: a reduce
    // intent NEVER falls into the open/add path. Behaviour by terminal state:
    //   - FILLED with a fill summary  → apply decrement, write REDUCE/CLOSE transactions
    //                                    row, release reservation (clean exit; no escalation).
    //   - Anything else (partial fill in RECONCILE_REQUIRED, zero-fill CANCELLED / ABORTED /
    //     REJECTED / RECONCILE_REQUIRED) → apply any decrement we can, then emit
    //     ORDER_INTENT_UNKNOWN_EVENT so M6 owns the residual. Not exiting is the worst-case
    //     outcome the system tolerates (ADR 0007 §4); M6's drift policy / local monitor own
    //     the recovery path.
    private async handleReduceTerminal(event: IOrderIntentApprovedEvent, submitResult: ILiveSubmitResult): Promise<void> {
        const fillSummary = submitResult.fillSummary;

        if (fillSummary !== null) {
            await this.applyReduceFillToPosition(event, submitResult, fillSummary);
        }

        const isCleanFill = submitResult.state === SubmitStateEnum.FILLED && fillSummary !== null;

        if (isCleanFill) {
            this.logger.log(
                `reduce-family clean fill eventId=${event.intent.eventId} symbol=${event.intent.symbol} ` +
                    `action=${event.intent.intentAction} filled=${formatMoney(fillSummary.filledQty)}`,
            );
            this.releaseReservationSafely(event.reservationId);

            return;
        }

        // Reduce-family no-fills + partial-then-cancelled always escalate to M6 reconciliation
        // regardless of submit state (round-3 must-fix #4). Not exiting is worse than slippage.
        // M6 R2.1.3: stamp positionId so the reconciler can move the row to RECONCILING
        // (ADR-0010 §1f step 1). Best-effort lookup by (symbol, slot); null when the row is gone.
        const positionForRecon = await this.positions.findOpenBySymbolAndSlot(event.intent.symbol, event.approvedSlot);
        const reduceEscalation: IOrderIntentUnknownEvent = {
            eventId: event.intent.eventId,
            reservationId: event.reservationId,
            state: submitResult.state,
            positionId: positionForRecon?.id ?? null,
        };
        this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, reduceEscalation);

        this.logger.warn(
            `reduce-family terminal escalated to M6 eventId=${event.intent.eventId} symbol=${event.intent.symbol} ` +
                `action=${event.intent.intentAction} state=${submitResult.state} filled=${fillSummary === null ? '0' : formatMoney(fillSummary.filledQty)}`,
        );

        this.releaseReservationSafely(event.reservationId);
    }

    private async applyReduceFillToPosition(event: IOrderIntentApprovedEvent, submitResult: ILiveSubmitResult, fillSummary: IFillSummary): Promise<void> {
        const slot = event.approvedSlot;
        const position = await this.positions.findOpenBySymbolAndSlot(event.intent.symbol, slot);

        if (position === null) {
            // Round-4 #7: missing-position is a reconciliation signal, not a no-op. Emit
            // ORDER_INTENT_UNKNOWN_EVENT so M6's reconciler takes ownership; log error-level
            // in LIVE (matches the audit-event escalation pattern from round 3).
            const message = `reduce fill on ${event.intent.symbol} slot=${slot} but no open position - escalating to M6 reconciliation`;

            if (this.appConfig.isExecutionLive) {
                this.logger.error(message);
            } else {
                this.logger.warn(message);
            }

            const missingPositionEvent: IOrderIntentUnknownEvent = {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                reason: 'missing_position',
                positionId: null,
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, missingPositionEvent);

            return;
        }

        // M31 Defect 1 (flat-row guard). A reduce fill against an already-flat row (qty <= 0)
        // means the position was finalized/zeroed by a prior path; writing another close tx
        // would double-book the ledger. Escalate to M6 reconciliation and abort without any
        // write (no second close row, no qty mutation).
        if (position.qty.lessThanOrEqualTo(0)) {
            this.logger.warn(
                `reduce fill on already-flat positionId=${position.id} ${event.intent.symbol} slot=${slot} ` +
                    `qty=${formatMoney(position.qty)} - skipping double-close, escalating to M6`,
            );
            const flatRowEvent: IOrderIntentUnknownEvent = {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                reason: REDUCE_ON_FLAT_POSITION_REASON,
                positionId: position.id,
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, flatRowEvent);
            this.releaseReservationSafely(event.reservationId);

            return;
        }

        const newQty = position.qty.minus(fillSummary.filledQty);

        // Round-4 #3: a negative remainder means exchange-vs-local drift (filled qty exceeds
        // local position qty). Do not silently clamp — emit ORDER_INTENT_UNKNOWN_EVENT with
        // reason='drift' so M6 reconciles. Then still clamp to 0 so the row is consistent.
        const isDrift = newQty.lessThan(0);

        if (isDrift) {
            this.logger.error(
                `reduce fill drift positionId=${position.id} ${event.intent.symbol} ` +
                    `localQty=${formatMoney(position.qty)} filled=${formatMoney(fillSummary.filledQty)} - escalating to M6`,
            );
            const driftEvent: IOrderIntentUnknownEvent = {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                reason: 'drift',
                positionId: position.id,
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, driftEvent);

            // M6 R1.2.3 (ADR 0012 §5c). The exchange filled MORE than we asked for —
            // the clamp keeps the position-row arithmetic consistent (qty → 0) but
            // an analytic / alerting consumer needs the precise gap. Emit a dedicated
            // overfill-drift event with the expected vs. actual qty so M9 alerting
            // can fire and M8 can attribute the residual.
            const overfillEvent: IExchangeOverfillDriftEvent = {
                positionId: position.id,
                symbol: event.intent.symbol,
                clientOrderId: submitResult.clientOrderId,
                expectedQty: position.qty.toFixed(),
                actualFilledQty: fillSummary.filledQty.toFixed(),
                clampGapQty: fillSummary.filledQty.minus(position.qty).toFixed(),
                detectedAtMs: Date.now(),
            };
            this.events.emit(EXCHANGE_OVERFILL_DRIFT_EVENT, overfillEvent);
        }

        const filledQtyForPnl = isDrift ? position.qty : fillSummary.filledQty;
        // Round-5 #3: full-close detection compares the position's local qty against the
        // fill qty directly. Any fill >= position.qty zeroes the position (drift clamps
        // to position.qty). Avoids the rounding-residual phantom OPEN row left by an
        // arithmetic-difference check (e.g. newQty = 1e-30 would have read as still-open).
        const isClosingFill = position.qty.lessThanOrEqualTo(fillSummary.filledQty);
        const clampedQty = isClosingFill ? new Money(0) : newQty;

        // M45 D4. Closing-fill reentrancy guard. A second reduce fill resolving a close on the
        // SAME position before the first finalizes would re-run promote → CLOSING → finalize →
        // POSITION_CLOSED, double-finalizing the row. The loser returns early WITHOUT releasing
        // the reservation — the winning caller owns the close lifecycle and its release. Mirrors
        // LocalProtectiveMonitor's breach-in-flight contract (add on entry, delete in finally).
        // Partial reduces are intentionally unguarded: they are legitimate sequential decrements,
        // not a double-finalize hazard.
        if (isClosingFill) {
            if (this.closingInFlight.has(position.id)) {
                this.logger.warn(`closing fill for positionId=${position.id} ${event.intent.symbol} already in flight — skipping reentrant finalize`);

                return;
            }

            this.closingInFlight.add(position.id);

            try {
                await this.applyClosingFill(event, submitResult, fillSummary, position, clampedQty, filledQtyForPnl);
            } finally {
                this.closingInFlight.delete(position.id);
            }

            return;
        }

        await this.applyPartialReduceFill(event, submitResult, fillSummary, position, clampedQty, filledQtyForPnl);
    }

    // Closing-fill application (ADR 0012 §5 + ADR 0009 §6.1). Promotes a PENDING_OPEN row before
    // any irreversible write, stamps qty=0 + disarms the monitor, records the close transaction,
    // then atomically finalizes CLOSING → CLOSED and emits POSITION_CLOSED. Runs under the
    // closingInFlight guard — see applyReduceFillToPosition.
    private async applyClosingFill(
        event: IOrderIntentApprovedEvent,
        submitResult: ILiveSubmitResult,
        fillSummary: IFillSummary,
        position: PositionEntity,
        clampedQty: MoneyValue,
        filledQtyForPnl: MoneyValue,
    ): Promise<void> {
        // M31 Defect 1 (ADR 0009 §6.3 — two-step promote through `open`). A monitor-breach or
        // kill-switch close can land on a row still in PENDING_OPEN (the protective monitor is
        // armed during PENDING_OPEN per ADR 0008 §2). The state graph deliberately forbids
        // pending_open -> closing (positionStateGraph.ts), so the row must be promoted
        // pending_open -> open BEFORE any irreversible write. This guard runs at the TOP of the
        // closing-fill block: if the promote throws, NOTHING is committed (no qty=0, no disarm,
        // no close tx) — a clean abort that escalates to M6 rather than leaving a flat,
        // close-tx'd, non-terminal zombie row.
        if (position.state === PositionStateEnum.PENDING_OPEN) {
            try {
                await this.promotePendingOpenBeforeClose(event, submitResult, position);
            } catch {
                return;
            }
        }

        position.qty = clampedQty;

        // Round-5 #2 (ADR 0008 §2, symmetric disarm). disarm is an in-memory map write
        // that cannot fail — fire it immediately after the in-memory qty=0 stamp and
        // BEFORE any awaited I/O (save / recordTerminal / finalize). Closes the window
        // where the monitor could observe a stale OPEN snapshot and fire a breach on a
        // position that is logically already closed.
        this.localProtectiveMonitor.disarm(position.id);

        // The CLOSING-fill path keeps the inline qty=0 save because the subsequent finalize
        // bundles close-side fields (closedAt / exitPrice / exitReason / realizedPnl) into the
        // SAME UPDATE as the CLOSED state transition (ADR 0012 §5 + ADR 0009 §6.1 dual-write
        // atomicity).
        await this.positions.save(position);

        // Write the close transaction row FIRST so finalizeRealizedPnl can aggregate the
        // per-fill cashflow into realizedPnl (ADR 0012 §5).
        const txType = this.intentActionToTransactionType(event.intent.intentAction);
        const cashflow = this.isReduceOrCloseType(txType)
            ? computeFillCashflow(position.side, position.entryPrice, fillSummary.avgFillPrice, filledQtyForPnl)
            : new Money(0);

        await this.transactions.recordTerminal({
            positionId: position.id,
            type: txType,
            side: event.intent.tradeSide,
            price: fillSummary.avgFillPrice,
            // Round-5 #1: on drift the audit ledger row must reflect the qty actually
            // decremented from the local position (clamped), not the raw exchange-reported
            // filled qty — otherwise the ledger and the position row disagree. The raw
            // exchange qty stays in the ORDER_INTENT_UNKNOWN_EVENT payload above for M6.
            qty: filledQtyForPnl,
            fee: fillSummary.feeTotal,
            cashflow,
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });

        const nowMs = Date.now();
        const exitReason = this.exitReasonForIntent(event.intent.intentAction, event.intent.exitReason);

        await this.positionService.transition(position.id, PositionStateEnum.CLOSING, {
            nowMs,
            eventClass: 'execution.reduce.fill.terminal',
        });

        // finalize does CLOSING -> CLOSED with realizedPnl + exitPrice + closedAt
        // bundled into a single atomic UPDATE per ADR 0012 §5. realizedPnl is the
        // aggregate of (SUM cashflow over reduce/close) - (SUM fee over non-funding)
        // + (SUM cashflow over funding) — fee-net AND funding-net by construction.
        const finalized = await this.positionService.finalizeRealizedPnl(position.id, exitReason, {
            nowMs,
            eventClass: 'execution.reduce.fill.terminal',
        });

        const closedEvent: IPositionClosedEvent = {
            positionId: finalized.id,
            symbol: finalized.symbol,
            side: finalized.side,
            exitReason: finalized.exitReason,
            realizedPnl: finalized.realizedPnl ?? null,
            closedAt: finalized.closedAt ?? new Date(nowMs),
            entryPrice: finalized.entryPrice,
            exitPrice: finalized.exitPrice ?? null,
            leverage: finalized.leverage,
            strategyVersionId: finalized.strategyVersionId,
            openedAt: finalized.openedAt,
            // M34 (ADR 0004 §3) — carry the slot so the SlotReleaseListener can free the
            // (symbol, slot) reservation. Read from the pre-finalize `position` row (the
            // slot is immutable across the close finalize, and reading the in-scope row
            // avoids depending on whether finalize re-projects the column).
            positionSlot: position.positionSlot ?? null,
        };
        this.events.emit(POSITION_CLOSED_EVENT, closedEvent);

        this.logger.log(
            `position ${position.id} ${position.symbol} CLOSED exitReason=${finalized.exitReason ?? 'n/a'} ` +
                `realizedPnl=${finalized.realizedPnl === null || finalized.realizedPnl === undefined ? 'n/a' : formatMoney(finalized.realizedPnl)} ` +
                `exit=${formatMoney(fillSummary.avgFillPrice)}`,
        );
    }

    // Partial-reduce application (ADR 0009 §6.1b). Decrements qty through PositionService.adjustQty
    // (single qty-axis writer, emits position.qty.adjusted), records the REDUCE transaction with
    // its cashflow, then persists the lowered residual notional onto risk_state (M45 D3b — no
    // lifecycle event fires on a partial reduce, so the accounting listener never recomputes).
    private async applyPartialReduceFill(
        event: IOrderIntentApprovedEvent,
        submitResult: ILiveSubmitResult,
        fillSummary: IFillSummary,
        position: PositionEntity,
        clampedQty: MoneyValue,
        filledQtyForPnl: MoneyValue,
    ): Promise<void> {
        await this.positionService.adjustQty(position.id, clampedQty, QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: Date.now() });

        // On non-closing partial reduces the row's cashflow is recorded too — M8 reads
        // SUM(cashflow) across the position's lifetime, partial reduces included (ADR 0012 §5).
        const txType = this.intentActionToTransactionType(event.intent.intentAction);
        const cashflow = this.isReduceOrCloseType(txType)
            ? computeFillCashflow(position.side, position.entryPrice, fillSummary.avgFillPrice, filledQtyForPnl)
            : new Money(0);

        await this.transactions.recordTerminal({
            positionId: position.id,
            type: txType,
            side: event.intent.tradeSide,
            price: fillSummary.avgFillPrice,
            qty: filledQtyForPnl,
            fee: fillSummary.feeTotal,
            cashflow,
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });

        this.logger.log(
            `reduce applied positionId=${position.id} ${event.intent.symbol} -${formatMoney(fillSummary.filledQty)} ` +
                `@ ${formatMoney(fillSummary.avgFillPrice)} (qty now ${formatMoney(clampedQty)})`,
        );

        // M45 D3b: a partial reduce lowers residual notional but does not emit POSITION_CLOSED
        // (only the closing-fill path does), so the accounting listener never recomputes —
        // persist open_exposure here so risk_state does not lag until the next open/close.
        await this.recomputeRiskStateAccountingForToday('partial_reduce');
    }

    // M31 Defect 1 (ADR 0009 §6.3). Promote a PENDING_OPEN row to OPEN before a closing fill
    // commits any irreversible write. Resolves cleanly on success (or when the source state was
    // already promotable); THROWS when the promote fails — in which case it has already escalated
    // to M6 (ORDER_INTENT_UNKNOWN_EVENT) and released the reservation, and the caller aborts the
    // closing-fill path with nothing committed. Throwing (not returning a bool) keeps this a pure
    // command per CQS; the caller's try/catch owns the abort path.
    private async promotePendingOpenBeforeClose(event: IOrderIntentApprovedEvent, submitResult: ILiveSubmitResult, position: PositionEntity): Promise<void> {
        try {
            const promoted = await this.positionService.transition(position.id, PositionStateEnum.OPEN, {
                nowMs: Date.now(),
                eventClass: PENDING_OPEN_PROMOTE_EVENT_CLASS,
            });
            // Keep the in-memory row aligned with the DB promote — the closing-fill path saves
            // this entity before CLOSING; a stale PENDING_OPEN here reverts the promote and
            // blocks pending_open → closing (fill-acceptance FLATTEN unwind regression).
            position.state = promoted.state;
        } catch (cause) {
            this.logger.error(
                `pending_open promote failed positionId=${position.id} sourceState=${position.state}: ${this.describe(cause)} - escalating to M6`,
            );
            const promoteFailedEvent: IOrderIntentUnknownEvent = {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                reason: PENDING_PROMOTE_FAILED_REASON,
                positionId: position.id,
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, promoteFailedEvent);
            this.releaseReservationSafely(event.reservationId);

            throw cause;
        }
    }

    // ADR 0012 §1: cashflow is only populated for reduce/close fills (open/add are
    // exposure increases, not cash movements). The funding case has its own write
    // site in PositionService.recordFunding.
    private isReduceOrCloseType(txType: TransactionTypeEnum): boolean {
        return txType === TransactionTypeEnum.REDUCE || txType === TransactionTypeEnum.CLOSE;
    }

    // Exit reason mapping. Precedence (top wins):
    //   1. Explicit intent.exitReason (ADR 0011 §4) — W3 LocalProtectiveMonitor stamps
    //      STOP_LOSS / TAKE_PROFIT on breach-synthesized CLOSE intents. Strategy-
    //      originated closes leave it undefined and fall through to (2)/(3).
    //   2. M6 R1.2.1 (ADR 0012 §5b table) — FLATTEN action's reason is
    //      halt-conditional. Operator-issued flatten (no kill-switch) records as
    //      MANUAL; flatten triggered while HaltFlagService.isHalted() is true
    //      (e.g., model-divergence kill switch from ADR 0004 §6) records as
    //      KILL_SWITCH. The halt primitive is the canonical "this close happened
    //      because the operator/system stopped us" signal.
    //   3. CLOSE / REDUCE default → SIGNAL (strategy-driven exit).
    private exitReasonForIntent(action: OrderIntentActionEnum, intentExitReason: ExitReasonEnum | undefined): ExitReasonEnum {
        if (intentExitReason !== undefined) {
            return intentExitReason;
        }

        if (action === OrderIntentActionEnum.FLATTEN) {
            return this.haltFlag.isHalted() ? ExitReasonEnum.KILL_SWITCH : ExitReasonEnum.MANUAL;
        }

        return ExitReasonEnum.SIGNAL;
    }

    // M45 D3b. ADD and partial-reduce change a position's residual notional but emit NEITHER
    // POSITION_OPENED_EVENT nor POSITION_CLOSED_EVENT, so RiskStateLifecycleListener never
    // recomputes and `risk_state.open_exposure` goes stale until the next open/close. This
    // mirrors that listener's Option-R recompute (ADR 0014 §4a): re-derive the full UTC-day
    // rollup from the authoritative position rows and upsert via the column-scoped writer (halt
    // columns untouched). Idempotent by construction — a duplicate call re-derives the same
    // totals, so it cannot double-book. Fire-and-forget semantics match the listener: a failure
    // is logged at error level and never rethrown, so it cannot abort the fill-application path.
    private async recomputeRiskStateAccountingForToday(trigger: 'add' | 'partial_reduce'): Promise<void> {
        const utcDayStart = this.currentUtcDayStart();
        const utcDateString = utcDayStart.toISOString().slice(0, 10);

        try {
            const { openExposure } = await this.positions.findLiveRiskAggregates();
            const { realizedPnlDay, tradesCount } = await this.positions.findClosedTodayAggregates(utcDayStart);

            await this.riskState.upsertAccountingForDay(utcDateString, { openExposure, realizedPnlDay, tradesCount });

            this.logger.log(
                `risk_state recompute (${trigger}): date=${utcDateString} open_exposure=${openExposure.toFixed()} ` +
                    `realized_pnl_day=${realizedPnlDay.toFixed()} trades_count=${tradesCount}`,
            );
        } catch (cause) {
            this.logger.error(`risk_state recompute failed (${trigger}): date=${utcDateString} cause=${this.describe(cause)}`);
        }
    }

    // Midnight of the current UTC day. Explicit UTC arithmetic — never CURRENT_DATE
    // (session-timezone dependent near midnight) or Date#toDateString (local-zone). Mirrors
    // RiskStateLifecycleListener#currentUtcDayStart.
    private currentUtcDayStart(): Date {
        const now = new Date();

        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }

    // Submit + recover + cancel-on-timeout loop. attemptN advances ONLY on RETRIABLE-class
    // rejects (ADR 0006 §4 / must-fix #8). TERMINAL short-circuits; UNKNOWN routes through
    // the recover-by-clientOrderId path. Honors the halt flag between attempts (must-fix #6).
    private async runSubmitStateMachine(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal): Promise<ILiveSubmitResult> {
        for (let attemptN = 0; attemptN <= MAX_PERMANENT_RETRY_ATTEMPTS; attemptN++) {
            // ADR 0046 §2.1: same predicate as the :163 entry gate — `isOpenOrAddIntent` is the
            // uniform halt-scoping authority. Keeps the two gates consistent: an intent permitted
            // at :163 is not aborted here, so a de-risking close reaches submitter.submit under halt.
            if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(event.intent.intentAction)) {
                return this.buildResult(SubmitStateEnum.ABORTED, this.idForAttempt(event, attemptN), attemptN, null, 'halted');
            }

            const clientOrderId = this.idForAttempt(event, attemptN);
            const outcome = await this.submitOnce(event.intent, plan, event.approvedSlot, clientOrderId, attemptN);

            if (outcome.terminal) {
                return outcome.result;
            }
        }

        return this.buildResult(
            SubmitStateEnum.RECONCILE_REQUIRED,
            this.idForAttempt(event, MAX_PERMANENT_RETRY_ATTEMPTS),
            MAX_PERMANENT_RETRY_ATTEMPTS,
            null,
            'permanent retry budget exhausted',
        );
    }

    private idForAttempt(event: IOrderIntentApprovedEvent, attemptN: number): string {
        return this.clientOrderIdFactory.build({
            eventId: event.intent.eventId,
            positionSlot: event.approvedSlot,
            intentAction: event.intent.intentAction,
            attemptN,
        });
    }

    // One submit/recover/cancel cycle. Returns terminal when the attempt has a result the
    // caller can act on; non-terminal when the caller should advance attemptN (RETRIABLE).
    private async submitOnce(
        intent: IOrderIntent,
        plan: IOrderPlanInternal,
        slot: PositionSlotEnum,
        clientOrderId: string,
        attemptN: number,
    ): Promise<ISubmitAttempt> {
        const limitPrice = await this.resolveLimitPrice(intent, plan);

        if (limitPrice === null) {
            // Maker book peg detected a would-cross condition (must-fix #9): treat as missed
            // entry, do NOT resubmit. The same-id is preserved so a stray race resolves via
            // recover-by-clientOrderId — but we structurally cannot fill.
            this.logger.warn(`post-only would cross book at submit ${intent.symbol} ${clientOrderId} - missed entry, no resubmit`);

            return { terminal: true, result: this.buildResult(SubmitStateEnum.CANCELLED, clientOrderId, attemptN, null, 'post_only_would_cross') };
        }

        const submitResult = await this.submitter.submit({
            clientOrderId,
            symbol: intent.symbol,
            tradeSide: intent.tradeSide,
            policy: plan.policy,
            limitPrice: plan.policy === OrderPolicyEnum.REDUCE_MARKET ? null : formatMoney(limitPrice),
            amount: formatMoney(intent.sizing.qty),
            reduceOnly: plan.reduceOnly,
            closePosition: false,
        });

        if (submitResult.state === SubmitStateEnum.UNKNOWN) {
            return this.recoverFromUnknown(intent, plan, slot, clientOrderId, attemptN);
        }

        if (submitResult.state === SubmitStateEnum.OPEN) {
            return this.awaitPolicyTimeout(intent, plan, slot, clientOrderId, attemptN);
        }

        if (submitResult.state === SubmitStateEnum.REJECTED) {
            // Branch on classified reject class — never on substring (must-fix #1 + #8).
            if (submitResult.rejectClass === 'RETRIABLE') {
                return { terminal: false, result: this.buildResult(SubmitStateEnum.REJECTED, clientOrderId, attemptN, null, submitResult.venueMessage) };
            }

            // TERMINAL or fallback: short-circuit to ABORTED so the reservation releases
            // and no further retry consumes the budget.
            return { terminal: true, result: this.buildResult(SubmitStateEnum.ABORTED, clientOrderId, attemptN, null, submitResult.venueMessage) };
        }

        const fillSummary = submitResult.snapshot === null ? null : this.fillAccumulator.toSummary(submitResult.snapshot);
        const exchangeOrderId = submitResult.snapshot?.exchangeOrderId ?? null;

        return {
            terminal: true,
            result: { state: submitResult.state, fillSummary, attemptN, clientOrderId, exchangeOrderId, errorMessage: submitResult.venueMessage },
        };
    }

    // ADR 0005 §2 + must-fix #9. For POST_ONLY_MAKER we peg to the live book's same-side
    // best price; if the precomputed plan limit price would cross (would take, not make),
    // we treat as missed entry and do not resubmit. For IOC/REDUCE_MARKET we use the plan.
    private async resolveLimitPrice(intent: IOrderIntent, plan: IOrderPlanInternal): Promise<MoneyValue | null> {
        if (plan.policy !== OrderPolicyEnum.POST_ONLY_MAKER) {
            return plan.limitPrice;
        }

        const book = await this.fetchBookOrNull(intent.symbol);

        if (book === null) {
            // Can't peg without the book; fall back to plan price (router already returned
            // midAtTrigger). The submitter's GTX flag rejects crossing at the exchange.
            return plan.limitPrice;
        }

        const bestBid = book.bestBid;
        const bestAsk = book.bestAsk;

        if (bestBid === null || bestAsk === null) {
            return plan.limitPrice;
        }

        const isLongSide = intent.tradeSide === PositionSideEnum.LONG;
        const sameSide = isLongSide ? bestBid : bestAsk;
        const crossSide = isLongSide ? bestAsk : bestBid;
        const wouldCross = isLongSide ? plan.limitPrice.greaterThanOrEqualTo(crossSide) : plan.limitPrice.lessThanOrEqualTo(crossSide);

        if (wouldCross) {
            return null;
        }

        return sameSide;
    }

    private async fetchBookOrNull(symbol: string): Promise<{ bestBid: MoneyValue | null; bestAsk: MoneyValue | null } | null> {
        try {
            const book = await this.exchangeClient.watchOrderBook(symbol);
            const bidLevel = book.bids[0];
            const askLevel = book.asks[0];

            return {
                bestBid: bidLevel === undefined ? null : new Money(bidLevel.price),
                bestAsk: askLevel === undefined ? null : new Money(askLevel.price),
            };
        } catch (cause) {
            this.logger.warn(`book fetch for peg failed ${symbol}: ${this.describe(cause)}`);

            return null;
        }
    }

    private async recoverFromUnknown(
        intent: IOrderIntent,
        plan: IOrderPlanInternal,
        slot: PositionSlotEnum,
        clientOrderId: string,
        attemptN: number,
    ): Promise<ISubmitAttempt> {
        const recovered = await this.submitter.recover(intent.symbol, clientOrderId);

        if (recovered === null) {
            return { terminal: true, result: this.buildResult(SubmitStateEnum.RECONCILE_REQUIRED, clientOrderId, attemptN, null, 'recovery exhausted') };
        }

        const state = this.classifyRecoveredStatus(recovered.status);
        const fillSummary = this.fillAccumulator.toSummary(recovered);

        if (state === SubmitStateEnum.OPEN) {
            return this.awaitPolicyTimeout(intent, plan, slot, clientOrderId, attemptN);
        }

        return { terminal: true, result: { state, fillSummary, attemptN, clientOrderId, exchangeOrderId: recovered.exchangeOrderId, errorMessage: null } };
    }

    private classifyRecoveredStatus(status: string): SubmitStateEnum {
        if (status === 'open') {
            return SubmitStateEnum.OPEN;
        }

        if (status === 'closed') {
            return SubmitStateEnum.FILLED;
        }

        if (status === 'canceled' || status === 'expired') {
            return SubmitStateEnum.CANCELLED;
        }

        if (status === 'rejected') {
            return SubmitStateEnum.REJECTED;
        }

        return SubmitStateEnum.UNKNOWN;
    }

    // Per-policy branching (ADR 0007 §4 / must-fix #7).
    private async awaitPolicyTimeout(
        intent: IOrderIntent,
        plan: IOrderPlanInternal,
        slot: PositionSlotEnum,
        clientOrderId: string,
        attemptN: number,
    ): Promise<ISubmitAttempt> {
        await this.sleep(plan.timeoutMs);

        if (plan.policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC) {
            return this.resolveIocTerminal(intent, clientOrderId, attemptN);
        }

        if (plan.policy === OrderPolicyEnum.POST_ONLY_MAKER) {
            return this.resolveMakerTerminal(intent, clientOrderId, attemptN);
        }

        return this.resolveReduceTerminal(intent, plan, slot, clientOrderId, attemptN);
    }

    // IOC: exchange auto-cancels; we fetch the terminal state — never cancel.
    private async resolveIocTerminal(intent: IOrderIntent, clientOrderId: string, attemptN: number): Promise<ISubmitAttempt> {
        const snapshot = await this.submitter.fetchByClientId(intent.symbol, clientOrderId);
        const fillSummary = snapshot === null ? null : this.fillAccumulator.toSummary(snapshot);
        const state = fillSummary === null ? SubmitStateEnum.CANCELLED : SubmitStateEnum.PARTIAL;

        return {
            terminal: true,
            result: { state, fillSummary, attemptN, clientOrderId, exchangeOrderId: snapshot?.exchangeOrderId ?? null, errorMessage: null },
        };
    }

    // Maker: cancel + classify; do NOT re-evaluate the remainder; no chase (ADR 0007 §4).
    private async resolveMakerTerminal(intent: IOrderIntent, clientOrderId: string, attemptN: number): Promise<ISubmitAttempt> {
        const cancelled = await this.submitter.cancelByClientId(intent.symbol, clientOrderId);
        const snapshot = cancelled ?? (await this.submitter.fetchByClientId(intent.symbol, clientOrderId));
        const fillSummary = snapshot === null ? null : this.fillAccumulator.toSummary(snapshot);
        const state = fillSummary === null ? SubmitStateEnum.CANCELLED : SubmitStateEnum.PARTIAL;

        return {
            terminal: true,
            result: { state, fillSummary, attemptN, clientOrderId, exchangeOrderId: snapshot?.exchangeOrderId ?? null, errorMessage: null },
        };
    }

    // REDUCE_MARKET: retry remainder under attemptN++ up to MAX_REDUCE_REMAINDER_ATTEMPTS;
    // exhaust → escalate via ORDER_INTENT_UNKNOWN_EVENT (must-fix #5 / ADR 0007 §4).
    private async resolveReduceTerminal(
        intent: IOrderIntent,
        plan: IOrderPlanInternal,
        slot: PositionSlotEnum,
        clientOrderId: string,
        attemptN: number,
    ): Promise<ISubmitAttempt> {
        // Halt-flag gate at the top of every recursive hop (round-3 must-fix #3). When halt
        // fires mid-reduce-remainder, return CANCELLED with whatever has already filled so
        // executeLive routes through the reduce-class escalation path (must-fix #1) — never
        // continue placing more orders against a halted engine.
        // ADR 0046 §2.1: same halt-scoping predicate as :163/:565 via `isOpenOrAddIntent`. NOTE:
        // `event` is NOT in scope here — this method takes `intent` directly, so the predicate
        // reads `intent.intentAction`. This path only ever runs for REDUCE_MARKET, so scoping it
        // to OPEN/ADD stops aborting the de-risking close: the reduce remainder proceeds under halt.
        if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(intent.intentAction)) {
            this.logger.warn(`halt flag set during reduce remainder ${intent.symbol} clientOrderId=${clientOrderId} - aborting recursion`);
            const haltedSnapshot = await this.submitter.fetchByClientId(intent.symbol, clientOrderId);
            const haltedFillSummary = haltedSnapshot === null ? null : this.fillAccumulator.toSummary(haltedSnapshot);

            return {
                terminal: true,
                result: {
                    state: SubmitStateEnum.CANCELLED,
                    fillSummary: haltedFillSummary,
                    attemptN,
                    clientOrderId,
                    exchangeOrderId: haltedSnapshot?.exchangeOrderId ?? null,
                    errorMessage: 'halted',
                },
            };
        }

        const cancelled = await this.submitter.cancelByClientId(intent.symbol, clientOrderId);
        const snapshot = cancelled ?? (await this.submitter.fetchByClientId(intent.symbol, clientOrderId));
        const fillSummary = snapshot === null ? null : this.fillAccumulator.toSummary(snapshot);

        if (fillSummary === null) {
            return {
                terminal: true,
                result: {
                    state: SubmitStateEnum.CANCELLED,
                    fillSummary: null,
                    attemptN,
                    clientOrderId,
                    exchangeOrderId: snapshot?.exchangeOrderId ?? null,
                    errorMessage: null,
                },
            };
        }

        const remainder = intent.sizing.qty.minus(fillSummary.filledQty);

        if (remainder.lessThanOrEqualTo(0)) {
            return {
                terminal: true,
                result: {
                    state: SubmitStateEnum.FILLED,
                    fillSummary,
                    attemptN,
                    clientOrderId,
                    exchangeOrderId: snapshot?.exchangeOrderId ?? null,
                    errorMessage: null,
                },
            };
        }

        if (attemptN + 1 >= MAX_REDUCE_REMAINDER_ATTEMPTS) {
            this.logger.error(`reduce remainder budget exhausted ${intent.symbol} clientOrderId=${clientOrderId} remainder=${formatMoney(remainder)}`);

            return {
                terminal: true,
                result: {
                    state: SubmitStateEnum.RECONCILE_REQUIRED,
                    fillSummary,
                    attemptN,
                    clientOrderId,
                    exchangeOrderId: snapshot?.exchangeOrderId ?? null,
                    errorMessage: 'reduce_remainder_budget_exhausted',
                },
            };
        }

        // Recurse on the remainder with a fresh clientOrderId at attemptN+1.
        const nextAttempt = attemptN + 1;
        const nextClientOrderId = this.clientOrderIdFactory.build({
            eventId: intent.eventId,
            positionSlot: slot,
            intentAction: intent.intentAction,
            attemptN: nextAttempt,
        });
        const nextIntent: IOrderIntent = { ...intent, sizing: { ...intent.sizing, qty: remainder } };

        this.logger.warn(`reduce remainder retry ${intent.symbol} attempt=${nextAttempt} remainder=${formatMoney(remainder)}`);

        return this.submitOnce(nextIntent, plan, slot, nextClientOrderId, nextAttempt);
    }

    private buildResult(
        state: SubmitStateEnum,
        clientOrderId: string,
        attemptN: number,
        exchangeOrderId: string | null,
        errorMessage: string | null,
    ): ILiveSubmitResult {
        return { state, fillSummary: null, attemptN, clientOrderId, exchangeOrderId, errorMessage };
    }

    // OPEN: create a fresh position row. ADD: locate the existing position by symbol/slot,
    // apply ADR 0007 §3 weighted-avg entry formula, increment qty + entry_notional, leave
    // SL/TP untouched unless explicitly overridden (must-fix #4).
    private async openOrAddPositionAndAttachProtection(
        event: IOrderIntentApprovedEvent,
        plan: IOrderPlanInternal,
        submitResult: ILiveSubmitResult,
        nowMs: number,
    ): Promise<void> {
        const fillSummary = submitResult.fillSummary;

        if (fillSummary === null) {
            return;
        }

        const isOpenIntent = event.intent.intentAction === OrderIntentActionEnum.OPEN;

        // M38 D1 (ADR 0045): rebase the momentum TP anchor from the signal-time reference price
        // to the actual fill price BEFORE createPositionFromFill, so the persisted take_profit
        // (:1137), the arm (:928), and the attach (:952) all use the SAME value. SL is never
        // rebased. Mean-reversion / null atrDistance falls back to the frozen geometry (the
        // tpEligible backstop and D2 reject cover the wrong-side case).
        const resolvedTakeProfitPrice: MoneyValue =
            event.clampedExit.tpRebaseEligible && event.clampedExit.atrDistance !== null
                ? rebaseMomentumTakeProfit(event.clampedExit, fillSummary.avgFillPrice, event.intent.tradeSide)
                : event.clampedExit.takeProfitPrice;

        const positionRow = isOpenIntent
            ? await this.createPositionFromFill(event, plan, fillSummary, nowMs, resolvedTakeProfitPrice)
            : await this.applyAddToExistingPosition(event, fillSummary);

        if (isOpenIntent && (await this.rejectAndUnwindIfUnacceptable({ event, positionRow, fillSummary, resolvedTakeProfitPrice }))) {
            return;
        }

        // Step ordering per ADR 0008 §2 (round-3 must-fix #2 + round-4 #2): arm the LOCAL
        // monitor SYNCHRONOUSLY immediately after the OPEN-path createPositionFromFill
        // returns and BEFORE any awaited I/O — including the transaction-record insert and
        // the exchange-side attach. `arm` is an in-memory map write that cannot fail; this
        // closes the crash-between-insert-and-arm window structurally. Disarm only happens
        // on exchange-side attach success.
        //
        // Round-4 #2: arm ONLY on OPEN. ADD against an already-protected position must not
        // re-arm (that would double-watch and risk double-exit on breach) — the existing
        // protection state stays untouched. ADR 0007 §3 also forbids re-anchoring SL/TP on
        // ADD, so neither arm nor attach is re-run on this path.
        // arm order is intentional per ADR 0008 §2 — do NOT move recordEntryTransaction before arm
        // without an ADR 0008 §2 amendment and architect sign-off

        if (isOpenIntent) {
            this.localProtectiveMonitor.arm({
                positionId: positionRow.id,
                symbol: positionRow.symbol,
                side: event.intent.tradeSide,
                stopLossPrice: event.clampedExit.stopLossPrice,
                takeProfitPrice: resolvedTakeProfitPrice,
            });

            // M47 Task 5a (tech-debt M7) — close the async seed-timing race. Register the symbol
            // in the instrumentor's positionsBySymbol index SYNCHRONOUSLY here, after
            // createPositionFromFill returns its freshly-written in-memory row and BEFORE the first
            // downstream await (recordEntryTransactionOrEscalate). Any PRICE_UPDATE_EVENT arriving
            // during the subsequent awaits then finds the symbol indexed and is captured, not
            // silently dropped. applyEntryTick seeds mfe_pct=0/mae_pct=0 (signed pct, not price) as
            // the entry-instant excursion sample. The async onPositionOpenedEvent handler stays for
            // the adoption-ack / reconcile-recover recovery paths (it is now idempotent re-seed).
            this.positionInstrumentor.onPositionOpened(positionRow);
            this.positionInstrumentor.applyEntryTick(positionRow);
        }

        await this.recordEntryTransactionOrEscalate(positionRow.id, event, submitResult, fillSummary);

        if (!isOpenIntent) {
            // SL/TP on an ADD are not re-anchored by default (ADR 0007 §3); the existing
            // position keeps its exchange-side protection. POSITION_OPENED_EVENT is not
            // re-emitted for adds.
            this.confirmReservationSafely(event.reservationId);
            this.logger.log(
                `position ${positionRow.id} ${positionRow.symbol} ADDed +${formatMoney(fillSummary.filledQty)} @ ${formatMoney(fillSummary.avgFillPrice)}`,
            );

            // M45 D3b: an ADD increases residual notional but emits no lifecycle event, so the
            // accounting listener never recomputes — persist open_exposure here so risk_state
            // does not lag the position until the next open/close.
            await this.recomputeRiskStateAccountingForToday('add');

            return;
        }

        const attachResult = await this.protectiveAttacher.attach({
            eventId: event.intent.eventId,
            positionSlot: event.approvedSlot,
            symbol: event.intent.symbol,
            tradeSide: event.intent.tradeSide,
            stopLossPrice: event.clampedExit.stopLossPrice,
            takeProfitPrice: resolvedTakeProfitPrice,
        });

        await this.applyProtectiveAttachResult(positionRow, attachResult, event);

        // M6 W1.5 (ADR 0009 §3 / §4 / §6.1a): entry rows are inserted at PENDING_OPEN
        // (createPositionFromFill below). The transition to OPEN fires ONLY after the
        // protective layer has settled — either exchange-side attach acked (monitor
        // disarmed inside applyProtectiveAttachResult) or local fallback engaged (monitor
        // remains armed). The §1 state-meanings table is the contract: a position must
        // never be observable in OPEN without protection. The eventClass is set per
        // ADR 0009 §4 row 2: protective.attached on exchange-side, protective.local_fallback_engaged
        // on fallback. The single transition() write is atomic on both columns (state +
        // status) per ADR 0009 §1 / §6.1 dual-write contract.
        const transitionEventClass =
            attachResult.protectiveOrderType === ProtectiveOrderTypeEnum.EXCHANGE_SIDE ? 'protective.attached' : 'protective.local_fallback_engaged';
        await this.positionService.transition(positionRow.id, PositionStateEnum.OPEN, {
            nowMs: Date.now(),
            eventClass: transitionEventClass,
        });

        this.confirmReservationSafely(event.reservationId);

        const openedEvent: IPositionOpenedEvent = {
            positionId: positionRow.id,
            symbol: positionRow.symbol,
            side: positionRow.side,
            leverage: positionRow.leverage,
            entryPrice: positionRow.entryPrice,
            entryNotional: positionRow.entryNotional,
            strategyVersionId: positionRow.strategyVersionId,
        };
        this.events.emit(POSITION_OPENED_EVENT, openedEvent);
    }

    // M38 D2 (ADR 0045): fill-acceptance guard. Evaluated on a confirmed full OPEN fill, AFTER
    // createPositionFromFill (the PENDING_OPEN row exists) and BEFORE the synchronous arm — so a
    // doomed position never arms (ADR 0008 §2 window stays closed for surviving positions). The
    // drift value is logged on every evaluation. On reject the position is unwound via a synthetic
    // FLATTEN (one CLEAN CLOSED row, FORCE_CLOSE) and the PENDING reservation is released; the caller skips
    // arm/attach/transition/POSITION_OPENED_EVENT. Returns true when the fill was rejected.
    private async rejectAndUnwindIfUnacceptable(ctx: IFillAcceptanceContext): Promise<boolean> {
        const { event, positionRow, fillSummary } = ctx;
        const driftResult = evaluateFillDrift({
            clampedExit: event.clampedExit,
            avgFillPrice: fillSummary.avgFillPrice,
            side: event.intent.tradeSide,
            entrySnapshot: event.entrySnapshot,
            maxDriftPct: MAX_SIGNAL_DRIFT_PCT,
            geometryParams: event.geometryParams, // M48 — stamped on OPEN approvals; drives the geometry-integrity leg
            referencePrice: event.intent.referencePrice, // M48 — signal-calibrated anchor for the slFloor PCT leg
            resolvedTakeProfitPrice: ctx.resolvedTakeProfitPrice, // M48 — actual armed TP (rebased for momentum) for the R:R leg
        });

        this.logger.log(
            `fill-acceptance drift positionId=${positionRow.id} symbol=${event.intent.symbol} ` +
                `driftPct=${driftResult.driftPct?.toFixed(4) ?? 'n/a'} shouldReject=${driftResult.shouldReject} reason=${driftResult.reason ?? 'none'}`,
        );

        this.logGeometryAnchorDrift(ctx);

        if (!driftResult.shouldReject) {
            return false;
        }

        await this.unwindRejectedFill(ctx, driftResult.reason);

        return true;
    }

    // M48 D2.12 (ADR 0045) — GEOMETRY_ANCHOR_DRIFT observability. Logs how far the actual fill
    // diverged from the reconstructed signal reference, in ATR units (regime-independent canary for
    // how unreliable reconstructReferencePrice is in live) and absolute %. LOG ONLY — never gates.
    private logGeometryAnchorDrift(ctx: IFillAcceptanceContext): void {
        const { event, positionRow, fillSummary } = ctx;

        if (event.entrySnapshot === undefined || event.geometryParams === undefined || event.entrySnapshot.atr_14 === undefined) {
            return;
        }

        const fill = new Money(fillSummary.avgFillPrice);
        const ref = new Money(event.intent.referencePrice);
        const absDriftPct = fill.minus(ref).abs().dividedBy(ref).times(100);
        const atrDrift = fill.minus(ref).abs().dividedBy(new Money(event.entrySnapshot.atr_14));

        this.logger.log(
            `GEOMETRY_ANCHOR_DRIFT positionId=${positionRow.id} symbol=${event.intent.symbol} flowType=${event.intent.flowType} ` +
                `driftPct=${absDriftPct.toFixed(4)} atrUnits=${atrDrift.toFixed(4)}`,
        );
    }

    // Unwind a rejected open fill via a synthetic FLATTEN (one CLEAN CLOSED row, FORCE_CLOSE).
    // Release the OPEN reservation immediately — it is still PENDING and must not be CONFIRMED
    // (that would phantom-occupy the slot if the synthetic close fails). A successful unwind
    // releases the slot again via POSITION_CLOSED_EVENT (idempotent). The caller skips
    // arm/attach/transition/POSITION_OPENED_EVENT.
    private async unwindRejectedFill(ctx: IFillAcceptanceContext, reason?: string): Promise<void> {
        const { event, positionRow, fillSummary } = ctx;

        this.logger.warn(
            `fill-acceptance ${FILL_ACCEPTANCE_REJECTED} positionId=${positionRow.id} symbol=${event.intent.symbol} ` +
                `reason=${reason} - unwinding via FLATTEN`,
        );

        await this.fillAcceptanceUnwind.emitSyntheticClose({
            positionRow,
            side: event.intent.tradeSide,
            markPrice: fillSummary.avgFillPrice,
            exitReason: ExitReasonEnum.FORCE_CLOSE,
            slot: event.approvedSlot,
            strategyVersionId: event.strategyVersionId,
        });
        this.releaseReservationSafely(event.reservationId);
    }

    // Weighted-average entry on ADD (ADR 0007 §3 + must-fix #4). Uses the slot-scoped
    // lookup (round-3 must-fix #13) — the ADD targets the exact slot the gate approved,
    // never an arbitrary `findOpenBySymbol(...)[0]` which would pick the wrong leg if two
    // slots on the same symbol were ever open simultaneously.
    private async applyAddToExistingPosition(event: IOrderIntentApprovedEvent, fillSummary: IFillSummary): Promise<PositionEntity> {
        const positionRow = await this.positions.findOpenBySymbolAndSlot(event.intent.symbol, event.approvedSlot);

        if (positionRow === null) {
            this.logger.error(`ADD on ${event.intent.symbol} but no open position - falling back to creating one`);

            // Fallback path — no nowMs is plumbed here (this is a recovery branch from
            // a corrupted ADD that couldn't find its parent OPEN; the row gets created
            // fresh). Capture once at the boundary, same pattern as handleApproved.
            return this.createPositionFromFill(
                event,
                {
                    policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                    limitPrice: fillSummary.avgFillPrice,
                    timeoutMs: 0,
                    slippageCapPct: new Money(0),
                    reduceOnly: false,
                },
                fillSummary,
                Date.now(),
                // ADD recovery-fallback keeps the frozen geometry (no D1 rebase on the ADD path,
                // ADR 0007 §3).
                event.clampedExit.takeProfitPrice,
            );
        }

        const oldQty = positionRow.qty;
        const oldEntry = positionRow.entryPrice;
        const newQty = oldQty.plus(fillSummary.filledQty);
        const newEntryPrice = oldQty.times(oldEntry).plus(fillSummary.filledQty.times(fillSummary.avgFillPrice)).dividedBy(newQty);
        const newEntryNotional = positionRow.entryNotional.plus(fillSummary.filledNotional);

        positionRow.qty = newQty;
        positionRow.entryPrice = newEntryPrice;
        positionRow.entryNotional = newEntryNotional;

        return this.positions.save(positionRow);
    }

    // M31 Defect 2 (fail-loud on missing entry transaction). recordTerminal already swallows
    // duplicate-key as an idempotent no-op (TransactionRepository), so any throw here is a
    // NON-duplicate persist failure — an OPEN/ADD that filled but whose audit row never landed.
    // That is the survival-class invariant ("every fill shows up in transactions") breaking, so
    // escalate the same way the zero-fill path does: error log + ORDER_AUDIT_PERSIST_FAILED_EVENT
    // (operator alert, M9) + ORDER_INTENT_UNKNOWN_EVENT (M6 owns the unaudited row) — never leave
    // an unprotected/unaudited live position silently un-escalated. Arm ordering is unchanged
    // (ADR 0008 §2); this is a fail-loud wrapper only.
    private async recordEntryTransactionOrEscalate(
        positionId: number,
        event: IOrderIntentApprovedEvent,
        submitResult: ILiveSubmitResult,
        fillSummary: IFillSummary,
    ): Promise<void> {
        try {
            await this.recordEntryTransaction(positionId, event, submitResult, fillSummary);
        } catch (cause) {
            this.logger.error(
                `entry transaction persist failed positionId=${positionId} clientOrderId=${submitResult.clientOrderId} ` +
                    `eventId=${event.intent.eventId}: ${this.describe(cause)} - escalating to M6/M9`,
            );
            this.events.emit(ORDER_AUDIT_PERSIST_FAILED_EVENT, {
                eventId: event.intent.eventId,
                clientOrderId: submitResult.clientOrderId,
                symbol: event.intent.symbol,
                intentAction: event.intent.intentAction,
                auditFailureReason: this.classifyAuditFailure(cause),
            });
            const persistFailedEvent: IOrderIntentUnknownEvent = {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                reason: ENTRY_AUDIT_PERSIST_FAILED_REASON,
                positionId,
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, persistFailedEvent);
        }
    }

    private async recordEntryTransaction(
        positionId: number,
        event: IOrderIntentApprovedEvent,
        submitResult: ILiveSubmitResult,
        fillSummary: IFillSummary,
    ): Promise<void> {
        await this.transactions.recordTerminal({
            positionId,
            type: this.intentActionToTransactionType(event.intent.intentAction),
            side: event.intent.tradeSide,
            price: fillSummary.avgFillPrice,
            qty: fillSummary.filledQty,
            fee: fillSummary.feeTotal,
            // Open/add fills carry no realized cashflow (ADR 0012 §1). Written explicitly
            // as Money(0) — the `transactions.cashflow` column is `numeric NOT NULL` and the
            // decimal transformer serializes an absent property to null, rejecting the INSERT.
            cashflow: new Money(0),
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });

        this.logger.log(
            `transaction recorded positionId=${positionId} clientOrderId=${submitResult.clientOrderId} ` +
                `qty=${formatMoney(fillSummary.filledQty)} avgPrice=${formatMoney(fillSummary.avgFillPrice)}`,
        );
    }

    // M6 R1.3.1c — `nowMs` is injected (was `new Date()`). The plumbed value is
    // captured once at the `handleApproved` boundary so the `openedAt` stamp is
    // deterministic across the submit lifetime of one intent.
    private async createPositionFromFill(
        event: IOrderIntentApprovedEvent,
        plan: IOrderPlanInternal,
        fillSummary: IFillSummary,
        nowMs: number,
        // M38 D1 (ADR 0045): the resolved (rebased for momentum, frozen otherwise) TP to persist.
        // Computed once in the caller so the persisted value matches the armed/attached value.
        takeProfitPriceOverride: MoneyValue,
    ): Promise<PositionEntity> {
        const stopDistance = event.clampedExit.stopLossPrice.minus(fillSummary.avgFillPrice).abs();
        const stopDistancePct = stopDistance.dividedBy(fillSummary.avgFillPrice).times(100);

        // M6 W1.5 (ADR 0009 §6.1a + §1 dual-write): new rows enter at PENDING_OPEN.
        // `state` and `status` (the deprecated alias projected per §1's table:
        // pending_open → status='open') travel together in a single INSERT here — the
        // repository's `createOpen` builder issues one TypeORM `save`, satisfying the
        // §6.1 atomic single-write contract. The position remains in PENDING_OPEN until
        // the protective layer is confirmed, at which point openOrAddPositionAndAttachProtection
        // calls PositionService.transition(OPEN, ...) above. The local monitor is armed
        // in the caller BEFORE this returns to the protective-attach step, so a crash in
        // the PENDING_OPEN window still leaves the row protected via the local monitor
        // arm (ADR 0008 §2 synchronous-arm sequence; W8 boot recovery picks up any
        // PENDING_OPEN rows left after restart).
        return this.positions.createOpen({
            symbol: event.intent.symbol,
            strategyVersionId: event.strategyVersionId,
            side: event.intent.tradeSide,
            state: PositionStateEnum.PENDING_OPEN,
            leverage: event.approvedSizing.leverage,
            entryPrice: fillSummary.avgFillPrice,
            qty: fillSummary.filledQty,
            entryNotional: fillSummary.filledNotional,
            openedAt: new Date(nowMs),
            coinTier: event.intent.coinTier,
            positionSlot: event.approvedSlot,
            correlationMode: event.intent.correlationMode,
            triggerSource: event.intent.triggerSource ?? null,
            timeStopAt: new Date(event.clampedExit.timeStopAtMs),
            // M33 Task 5 (GBT H3): persist the clamped SL/TP at INSERT time — not only at
            // applyProtectiveAttachResult. The local monitor's arm is in-memory; a crash between
            // this PENDING_OPEN insert and the protective attach would lose that arm with no
            // persisted prices to re-arm from on boot, breaking the "guaranteed to close through
            // declared exits" invariant for that window. Writing the clamped exits here makes every
            // non-closed row re-armable by phase 4c (EngineBootstrapService).
            stopLossPrice: event.clampedExit.stopLossPrice,
            takeProfitPrice: takeProfitPriceOverride,
            slippageModelPct: plan.slippageCapPct,
            stopGapPct: stopDistancePct,
            flowTypeAtEntry: event.intent.flowType,
            ...this.mapEntrySnapshotColumns(event.entrySnapshot),
        });
    }

    // The entry-time analysis columns are written ONCE, at open, from the
    // evaluation-time snapshot frozen on the approval event (NOT a fill-time re-read) so
    // backtest replay reproduces identical rows. Absent on close/reduce/flatten approvals
    // and on the ADD recovery-fallback (entrySnapshot is undefined there), where the mapper
    // returns an empty object and leaves the columns untouched.
    private mapEntrySnapshotColumns(snapshot: IMarketSnapshot | undefined): Partial<{
        vwapAtEntry: MoneyValue;
        atrAtEntry: MoneyValue;
        vwapDeviationAtEntry: DecimalValue;
        idiosyncrasyAtEntry: DecimalValue;
        signalScoreAtEntry: DecimalValue;
        openInterestAtEntry: MoneyValue;
        oiChange5mAtEntry: DecimalValue;
        fundingAnnualizedAtEntry: DecimalValue;
        bookDepth10bpsAtEntry: MoneyValue;
        spreadAtEntryPct: DecimalValue;
        vwapAnchorType: VwapAnchorTypeEnum;
        symbolUniverseAgeHours: DecimalValue;
    }> {
        if (snapshot === undefined) {
            return {};
        }

        try {
            return {
                vwapAtEntry: new Money(snapshot.vwap_session),
                atrAtEntry: new Money(snapshot.atr_14),
                vwapDeviationAtEntry: new Money(snapshot.vwap_deviation_pct),
                idiosyncrasyAtEntry: new Money(snapshot.idiosyncrasy_score),
                signalScoreAtEntry: new Money(snapshot.signal_score),
                openInterestAtEntry: new Money(snapshot.open_interest),
                oiChange5mAtEntry: new Money(snapshot.open_interest_change_5m_pct),
                fundingAnnualizedAtEntry: new Money(snapshot.funding_rate_annualized),
                bookDepth10bpsAtEntry: new Money(snapshot.book_depth_10bps_usdt),
                spreadAtEntryPct: new Money(snapshot.bid_ask_spread_pct),
                vwapAnchorType: snapshot.vwap_anchor_type,
                symbolUniverseAgeHours: new Money(snapshot.symbol_universe_age_hours),
            };
        } catch {
            return {};
        }
    }

    private async applyProtectiveAttachResult(
        positionRow: PositionEntity,
        attachResult: IProtectiveAttachResult,
        event: IOrderIntentApprovedEvent,
    ): Promise<void> {
        positionRow.protectiveOrderType = attachResult.protectiveOrderType;
        await this.positions.save(positionRow);

        if (attachResult.protectiveOrderType === ProtectiveOrderTypeEnum.LOCAL_FALLBACK) {
            const fallbackEvent: IProtectiveFallbackEvent = {
                positionId: positionRow.id,
                symbol: positionRow.symbol,
                stopLossPrice: event.clampedExit.stopLossPrice,
                takeProfitPrice: event.clampedExit.takeProfitPrice,
                errorMessage: attachResult.errorMessage,
            };

            this.events.emit(ORDER_PROTECTIVE_FALLBACK_EVENT, fallbackEvent);
            this.logger.warn(`position ${positionRow.id} ${positionRow.symbol} on LOCAL_FALLBACK protection: ${attachResult.errorMessage ?? 'attach failed'}`);

            return;
        }

        // ADR 0008 §7 — in paper mode there is no exchange matching engine to fire the
        // STOP_MARKET / TAKE_PROFIT_MARKET orders, so an `exchange_side` attach must NOT
        // disarm the local monitor — it stays the SL/TP enforcer (parity with backtest
        // IntrabarStopSimulator). `protective_order_type` is still set to `exchange_side`
        // above for audit/dashboard accuracy; only the disarm is suppressed in paper.
        if (this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            this.logger.log(`position ${positionRow.id} ${positionRow.symbol} EXCHANGE_SIDE in paper - local monitor kept armed (ADR 0008 §7)`);

            return;
        }

        // Exchange-side success: disarm the local monitor. The local layer stands down for
        // this position; the exchange's STOP_MARKET / TAKE_PROFIT_MARKET orders are now the
        // first line of defense (ADR 0008 §2).
        this.localProtectiveMonitor.disarm(positionRow.id);
        this.logger.log(`position ${positionRow.id} ${positionRow.symbol} protected EXCHANGE_SIDE (SL+TP at mark price); local monitor disarmed`);
    }

    private async handleNoFill(event: IOrderIntentApprovedEvent, submitResult: ILiveSubmitResult): Promise<void> {
        // Persist the zero-fill audit row (ADR 0006 §1 / must-fix #14). Nullable position_id
        // + CHECK constraint allows this only for qty=0 OPEN/ADD per migration 20260524020000.
        if (event.intent.intentAction === OrderIntentActionEnum.OPEN || event.intent.intentAction === OrderIntentActionEnum.ADD) {
            await this.recordZeroFillAuditRow(event, submitResult.clientOrderId);
        }

        if (submitResult.state === SubmitStateEnum.ABORTED || submitResult.state === SubmitStateEnum.REJECTED) {
            this.events.emit(ORDER_INTENT_FAILED_EVENT, { eventId: event.intent.eventId, reservationId: event.reservationId, state: submitResult.state });
        } else if (submitResult.state === SubmitStateEnum.RECONCILE_REQUIRED) {
            // OPEN/ADD escalation — no position row exists yet (the entry never filled).
            // positionId is null so the reconciler skips the transition step; the
            // exposure-reservation TTL sweep is the authoritative cleanup path here.
            //
            // M6 R3.1.2 (doc-only). If the OPEN actually filled silently on the
            // exchange (network glitch, ack lost), the next reconciliation tick
            // observes the foreign exchange position via case-(a)
            // `EXCHANGE_NOT_IN_DB` and either adopts it (dev/test default) or
            // flattens it (live policy). The null-positionId path here is
            // intentionally a no-op for the row-state axis; the case-(a) sweep
            // is the recovery contract for silently-filled OPEN/ADD entries.
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, {
                eventId: event.intent.eventId,
                reservationId: event.reservationId,
                state: submitResult.state,
                positionId: null,
            });
        } else {
            this.events.emit(ORDER_INTENT_EXPIRED_EVENT, { eventId: event.intent.eventId, reservationId: event.reservationId, state: submitResult.state });
        }

        this.releaseReservationSafely(event.reservationId);
    }

    private async recordZeroFillAuditRow(event: IOrderIntentApprovedEvent, clientOrderId: string): Promise<void> {
        if (event.intent.intentAction !== OrderIntentActionEnum.OPEN && event.intent.intentAction !== OrderIntentActionEnum.ADD) {
            return;
        }

        try {
            await this.transactions.recordTerminal({
                positionId: null,
                type: this.intentActionToTransactionType(event.intent.intentAction),
                side: event.intent.tradeSide,
                price: new Money(0),
                qty: new Money(0),
                fee: new Money(0),
                cashflow: new Money(0),
                clientOrderId,
                exchangeOrderId: null,
            });
        } catch (cause) {
            // The audit trail is a survival-class invariant in live operation: every approved
            // intent must show up in `transactions`. In LIVE we escalate to error-level and
            // emit a dedicated event (round-3 minor #12) so an operator alert can fire from
            // M9. Dry-run keeps warn-level — the audit row there is defensive, not protective.
            const description = this.describe(cause);

            if (this.appConfig.isExecutionLive) {
                // Round-4 #4: keep the verbose description in logs only; the wire payload
                // exposes a classified enum so downstream alerting cannot leak raw error prose.
                const auditFailureReason = this.classifyAuditFailure(cause);
                this.logger.error(`zero-fill audit row insert failed (LIVE) clientOrderId=${clientOrderId} eventId=${event.intent.eventId}: ${description}`);
                this.events.emit(ORDER_AUDIT_PERSIST_FAILED_EVENT, {
                    eventId: event.intent.eventId,
                    clientOrderId,
                    symbol: event.intent.symbol,
                    intentAction: event.intent.intentAction,
                    auditFailureReason,
                });
            } else {
                this.logger.warn(`zero-fill audit row insert failed (dry-run) clientOrderId=${clientOrderId}: ${description}`);
            }
        }
    }

    private intentActionToTransactionType(action: OrderIntentActionEnum): TransactionTypeEnum {
        if (action === OrderIntentActionEnum.OPEN) {
            return TransactionTypeEnum.OPEN;
        }

        if (action === OrderIntentActionEnum.ADD) {
            return TransactionTypeEnum.ADD;
        }

        if (action === OrderIntentActionEnum.REDUCE) {
            return TransactionTypeEnum.REDUCE;
        }

        return TransactionTypeEnum.CLOSE;
    }

    private async resolveDirection(strategyVersionId: number): Promise<StrategyDirectionEnum> {
        const cached = this.strategyDirectionCache.get(strategyVersionId);

        if (cached !== undefined) {
            return cached;
        }

        const row = await this.strategyVersions.findById(strategyVersionId);
        const direction = row?.direction ?? StrategyDirectionEnum.MEAN_REVERSION;
        this.strategyDirectionCache.set(strategyVersionId, direction);

        return direction;
    }

    private releaseReservationSafely(reservationId: string | null): void {
        if (reservationId === null) {
            return;
        }

        try {
            this.riskGate.releaseReservation(reservationId);
        } catch (cause) {
            this.logger.warn(`reservation ${reservationId} release failed: ${this.describe(cause)}`);
        }
    }

    private confirmReservationSafely(reservationId: string | null): void {
        if (reservationId === null) {
            return;
        }

        try {
            this.riskGate.confirmReservation(reservationId);
        } catch (cause) {
            this.logger.warn(`reservation ${reservationId} confirm failed: ${this.describe(cause)}`);
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    // Round-4 #4: classify DB-write failures into a closed enum for the wire payload.
    // The verbose error description stays in `logger.error` only — never on the bus.
    private classifyAuditFailure(cause: unknown): AuditFailureReasonEnum {
        if (!(cause instanceof Error)) {
            return AuditFailureReasonEnum.UNKNOWN;
        }

        const message = cause.message.toLowerCase();

        if (message.includes('unique') || message.includes('duplicate key')) {
            return AuditFailureReasonEnum.DB_UNIQUE_VIOLATION;
        }

        if (
            message.includes('econnrefused') ||
            message.includes('connection terminated') ||
            message.includes('connection lost') ||
            message.includes('connection') ||
            message.includes('timeout')
        ) {
            return AuditFailureReasonEnum.DB_UNAVAILABLE;
        }

        return AuditFailureReasonEnum.UNKNOWN;
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return cause.message;
        }

        return String(cause);
    }
}

interface ILiveSubmitResult {
    readonly state: SubmitStateEnum;
    readonly fillSummary: IFillSummary | null;
    readonly attemptN: number;
    readonly clientOrderId: string;
    readonly exchangeOrderId: string | null;
    readonly errorMessage: string | null;
}

interface ISubmitAttempt {
    readonly terminal: boolean;
    readonly result: ILiveSubmitResult;
}
