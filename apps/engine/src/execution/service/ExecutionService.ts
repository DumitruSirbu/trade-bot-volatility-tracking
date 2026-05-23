import {
    ExitReasonEnum,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStatusEnum,
    ProtectiveOrderTypeEnum,
    StrategyDirectionEnum,
    TransactionTypeEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import {
    AuditFailureReasonEnum,
    ORDER_AUDIT_PERSIST_FAILED_EVENT,
    ORDER_INTENT_APPROVED_EVENT,
    ORDER_INTENT_EXPIRED_EVENT,
    ORDER_INTENT_FAILED_EVENT,
    ORDER_INTENT_UNKNOWN_EVENT,
    ORDER_PROTECTIVE_FALLBACK_EVENT,
    POSITION_CLOSED_EVENT,
    POSITION_OPENED_EVENT,
} from '../../common/const';
import { IOrderIntentUnknownEvent, IPositionClosedEvent } from '../../common/interface';
import { HaltFlagService } from '../../common/service';
import { formatMoney, Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { TransactionRepository } from '../../position/repository/TransactionRepository';
import { IOrderIntent, IOrderIntentApprovedEvent } from '../../risk/interface';
import { RiskGateService } from '../../risk/service';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import { MAX_PERMANENT_RETRY_ATTEMPTS, MAX_REDUCE_REMAINDER_ATTEMPTS } from '../const';
import { SubmitStateEnum } from '../enum';
import { IFillSummary, IOrderPlanInternal, IProtectiveAttachResult, IProtectiveFallbackEvent } from '../interface';
import { ClientOrderIdFactory } from './ClientOrderIdFactory';
import { ExchangeOrderSubmitter } from './ExchangeOrderSubmitter';
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

@Injectable()
export class ExecutionService {
    private readonly logger = new Logger(ExecutionService.name);

    // Cache strategyVersionId -> direction. The gate's approved event already carries the
    // versionId; the direction is a stable field on the StrategyVersionEntity row.
    private readonly strategyDirectionCache = new Map<number, StrategyDirectionEnum>();

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly policyRouter: OrderPolicyRouter,
        private readonly clientOrderIdFactory: ClientOrderIdFactory,
        private readonly submitter: ExchangeOrderSubmitter,
        private readonly fillAccumulator: FillAccumulator,
        private readonly protectiveAttacher: ProtectiveOrderAttacher,
        private readonly localProtectiveMonitor: LocalProtectiveMonitor,
        private readonly positions: PositionRepository,
        private readonly transactions: TransactionRepository,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly riskGate: RiskGateService,
        private readonly haltFlag: HaltFlagService,
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly events: EventEmitter2,
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

        if (this.haltFlag.isHalted()) {
            this.logger.warn(`halt flag set (${this.haltFlag.getReason() ?? 'no-reason'}); short-circuiting eventId=${event.intent.eventId}`);
            this.releaseReservationSafely(event.reservationId);
            this.events.emit(ORDER_INTENT_EXPIRED_EVENT, { eventId: event.intent.eventId, reservationId: event.reservationId, reason: 'halted' });

            return;
        }

        await this.executeLive(event, plan);
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
        this.events.emit(ORDER_INTENT_EXPIRED_EVENT, { eventId: event.intent.eventId, reservationId: event.reservationId, reason: 'dry_run' });
    }

    private async executeLive(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal): Promise<void> {
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

        await this.openOrAddPositionAndAttachProtection(event, plan, submitResult);
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
        const reduceEscalation: IOrderIntentUnknownEvent = {
            eventId: event.intent.eventId,
            reservationId: event.reservationId,
            state: submitResult.state,
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
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, missingPositionEvent);

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
            };
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, driftEvent);
        }

        const filledQtyForPnl = isDrift ? position.qty : fillSummary.filledQty;
        // Round-5 #3: full-close detection compares the position's local qty against the
        // fill qty directly. Any fill >= position.qty zeroes the position (drift clamps
        // to position.qty). Avoids the rounding-residual phantom OPEN row left by an
        // arithmetic-difference check (e.g. newQty = 1e-30 would have read as still-open).
        const isClosingFill = position.qty.lessThanOrEqualTo(fillSummary.filledQty);
        const clampedQty = isClosingFill ? new Money(0) : newQty;

        position.qty = clampedQty;

        // Round-4 #1: when the position is fully closed by this fill, transition the row
        // to CLOSED with closed_at / exit_reason / realized_pnl stamped, and disarm the
        // local protective monitor. Emit POSITION_CLOSED_EVENT so M6/M9 can subscribe.
        if (isClosingFill) {
            const exitReason = this.exitReasonForIntent(event.intent.intentAction);
            const realizedPnl = this.computeRealizedPnl(position.side, position.entryPrice, fillSummary.avgFillPrice, filledQtyForPnl, fillSummary.feeTotal);

            position.status = PositionStatusEnum.CLOSED;
            position.closedAt = new Date();
            position.exitPrice = fillSummary.avgFillPrice;
            position.exitReason = exitReason;
            position.realizedPnl = realizedPnl;

            // Round-5 #2 (ADR 0008 §2, symmetric disarm). disarm is an in-memory map write
            // that cannot fail — fire it immediately after the in-memory CLOSED mutation
            // and BEFORE any awaited I/O (save / recordTerminal / emit). Closes the window
            // where the monitor could observe a stale OPEN snapshot and fire a breach on a
            // position that is logically already closed.
            this.localProtectiveMonitor.disarm(position.id);
        }

        await this.positions.save(position);

        await this.transactions.recordTerminal({
            positionId: position.id,
            type: this.intentActionToTransactionType(event.intent.intentAction),
            side: event.intent.tradeSide,
            price: fillSummary.avgFillPrice,
            // Round-5 #1: on drift the audit ledger row must reflect the qty actually
            // decremented from the local position (clamped), not the raw exchange-reported
            // filled qty — otherwise the ledger and the position row disagree. The raw
            // exchange qty stays in the ORDER_INTENT_UNKNOWN_EVENT payload above for M6.
            qty: filledQtyForPnl,
            fee: fillSummary.feeTotal,
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });

        if (isClosingFill) {
            const closedEvent: IPositionClosedEvent = {
                positionId: position.id,
                symbol: position.symbol,
                side: position.side,
                exitReason: position.exitReason,
                realizedPnl: position.realizedPnl,
                closedAt: position.closedAt,
            };
            this.events.emit(POSITION_CLOSED_EVENT, closedEvent);

            this.logger.log(
                `position ${position.id} ${position.symbol} CLOSED exitReason=${position.exitReason ?? 'n/a'} ` +
                    `realizedPnl=${position.realizedPnl === null || position.realizedPnl === undefined ? 'n/a' : formatMoney(position.realizedPnl)} ` +
                    `exit=${formatMoney(fillSummary.avgFillPrice)}`,
            );

            return;
        }

        this.logger.log(
            `reduce applied positionId=${position.id} ${event.intent.symbol} -${formatMoney(fillSummary.filledQty)} ` +
                `@ ${formatMoney(fillSummary.avgFillPrice)} (qty now ${formatMoney(position.qty)})`,
        );
    }

    // Round-4 #1: REDUCE that zeros → SIGNAL; CLOSE → SIGNAL; FLATTEN → KILL_SWITCH.
    private exitReasonForIntent(action: OrderIntentActionEnum): ExitReasonEnum {
        if (action === OrderIntentActionEnum.FLATTEN) {
            return ExitReasonEnum.KILL_SWITCH;
        }

        return ExitReasonEnum.SIGNAL;
    }

    // Round-4 #1: realized PnL on close. Long: (exit - entry) * qty - fees.
    // Short: (entry - exit) * qty - fees. Fees subtracted from gross PnL.
    private computeRealizedPnl(side: PositionSideEnum, entryPrice: MoneyValue, exitPrice: MoneyValue, qty: MoneyValue, fees: MoneyValue): MoneyValue {
        const priceDelta = side === PositionSideEnum.LONG ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);

        return priceDelta.times(qty).minus(fees);
    }

    // Submit + recover + cancel-on-timeout loop. attemptN advances ONLY on RETRIABLE-class
    // rejects (ADR 0006 §4 / must-fix #8). TERMINAL short-circuits; UNKNOWN routes through
    // the recover-by-clientOrderId path. Honors the halt flag between attempts (must-fix #6).
    private async runSubmitStateMachine(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal): Promise<ILiveSubmitResult> {
        for (let attemptN = 0; attemptN <= MAX_PERMANENT_RETRY_ATTEMPTS; attemptN++) {
            if (this.haltFlag.isHalted()) {
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
        if (this.haltFlag.isHalted()) {
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
    ): Promise<void> {
        const fillSummary = submitResult.fillSummary;

        if (fillSummary === null) {
            return;
        }

        const isOpenIntent = event.intent.intentAction === OrderIntentActionEnum.OPEN;
        const positionRow = isOpenIntent
            ? await this.createPositionFromFill(event, plan, fillSummary)
            : await this.applyAddToExistingPosition(event, fillSummary);

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
        if (isOpenIntent) {
            this.localProtectiveMonitor.arm({
                positionId: positionRow.id,
                symbol: positionRow.symbol,
                stopLossPrice: event.clampedExit.stopLossPrice,
                takeProfitPrice: event.clampedExit.takeProfitPrice,
            });
        }

        await this.recordEntryTransaction(positionRow.id, event, submitResult, fillSummary);

        if (!isOpenIntent) {
            // SL/TP on an ADD are not re-anchored by default (ADR 0007 §3); the existing
            // position keeps its exchange-side protection. POSITION_OPENED_EVENT is not
            // re-emitted for adds.
            this.confirmReservationSafely(event.reservationId);
            this.logger.log(
                `position ${positionRow.id} ${positionRow.symbol} ADDed +${formatMoney(fillSummary.filledQty)} @ ${formatMoney(fillSummary.avgFillPrice)}`,
            );

            return;
        }

        const attachResult = await this.protectiveAttacher.attach({
            eventId: event.intent.eventId,
            positionSlot: event.approvedSlot,
            symbol: event.intent.symbol,
            tradeSide: event.intent.tradeSide,
            stopLossPrice: event.clampedExit.stopLossPrice,
            takeProfitPrice: event.clampedExit.takeProfitPrice,
        });

        await this.applyProtectiveAttachResult(positionRow, attachResult, event);

        this.confirmReservationSafely(event.reservationId);
        this.events.emit(POSITION_OPENED_EVENT, { positionId: positionRow.id, symbol: positionRow.symbol });
    }

    // Weighted-average entry on ADD (ADR 0007 §3 + must-fix #4). Uses the slot-scoped
    // lookup (round-3 must-fix #13) — the ADD targets the exact slot the gate approved,
    // never an arbitrary `findOpenBySymbol(...)[0]` which would pick the wrong leg if two
    // slots on the same symbol were ever open simultaneously.
    private async applyAddToExistingPosition(event: IOrderIntentApprovedEvent, fillSummary: IFillSummary): Promise<PositionEntity> {
        const positionRow = await this.positions.findOpenBySymbolAndSlot(event.intent.symbol, event.approvedSlot);

        if (positionRow === null) {
            this.logger.error(`ADD on ${event.intent.symbol} but no open position - falling back to creating one`);

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
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });

        this.logger.log(
            `transaction recorded positionId=${positionId} clientOrderId=${submitResult.clientOrderId} ` +
                `qty=${formatMoney(fillSummary.filledQty)} avgPrice=${formatMoney(fillSummary.avgFillPrice)}`,
        );
    }

    private async createPositionFromFill(event: IOrderIntentApprovedEvent, plan: IOrderPlanInternal, fillSummary: IFillSummary): Promise<PositionEntity> {
        const stopDistance = event.clampedExit.stopLossPrice.minus(fillSummary.avgFillPrice).abs();
        const stopDistancePct = stopDistance.dividedBy(fillSummary.avgFillPrice).times(100);

        return this.positions.createOpen({
            symbol: event.intent.symbol,
            strategyVersionId: event.strategyVersionId,
            side: event.intent.tradeSide,
            status: PositionStatusEnum.OPEN,
            leverage: event.approvedSizing.leverage,
            entryPrice: fillSummary.avgFillPrice,
            qty: fillSummary.filledQty,
            entryNotional: fillSummary.filledNotional,
            openedAt: new Date(),
            coinTier: event.intent.coinTier,
            positionSlot: event.approvedSlot,
            correlationMode: event.intent.correlationMode,
            timeStopAt: new Date(event.clampedExit.timeStopAtMs),
            slippageModelPct: plan.slippageCapPct,
            stopGapPct: stopDistancePct,
            flowTypeAtEntry: event.intent.flowType,
        });
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
            this.events.emit(ORDER_INTENT_UNKNOWN_EVENT, { eventId: event.intent.eventId, reservationId: event.reservationId, state: submitResult.state });
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
