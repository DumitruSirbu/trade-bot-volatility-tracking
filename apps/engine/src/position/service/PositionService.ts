import {
    CorrelationModeEnum,
    ExitReasonEnum,
    IPositionStateTransitionedEvent,
    PositionSideEnum,
    PositionStateEnum,
    QtyAdjustmentReasonEnum,
    TransactionTypeEnum,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { IMyTradeSnapshot } from '../../exchange/interface';
import { IInsertOrderGroupInput, IRecordReconciledFillsInput } from '../interface';
import {
    POSITION_QTY_ADJUSTED_EVENT,
    POSITION_STATE_TRANSITIONED_EVENT,
    RECONCILED_FILL_FEE_CURRENCY,
    RECONCILED_PNL_DIVERGENCE_ABS_THRESHOLD,
    RECONCILED_PNL_DIVERGENCE_REL_THRESHOLD,
    isLegalTransition,
} from '../const';
import { PositionEntity, TransactionEntity } from '../entity';
import {
    IllegalAdoptionAckPayloadException,
    IllegalClosePayloadException,
    IllegalQtyAdjustmentException,
    IllegalStateTransitionException,
    PositionNotFoundException,
} from '../exception';
import { PositionRepository } from '../repository/PositionRepository';
import { TransactionRepository } from '../repository/TransactionRepository';
import { computeFillCashflow, computeVolumeWeightedExitPrice } from '../util/pnlMath';

// R1.3.3 mechanical move: const/exception declarations relocated. Re-exports
// preserved here so the established public import path
// `from '..../service/PositionService'` keeps working for callers (tests +
// other services). The canonical definition sites are `position/const/` and
// `position/exception/`; this barrel line is the migration shim.
export { POSITION_QTY_ADJUSTED_EVENT } from '../const';
export { IllegalAdoptionAckPayloadException, IllegalClosePayloadException, IllegalQtyAdjustmentException } from '../exception';

// Context the caller carries through a transition. nowMs comes from the injected
// clock (ADR 0004 §7 / ADR 0009 §6 invariant 5) so backtests replay identical
// transition timestamps. eventClass is the producer-side label (e.g.
// 'protective.attached', 'fill.recorded.terminal') and is stamped into the
// emitted IPositionStateTransitionedEvent.eventClass for downstream consumers.
export interface IPositionTransitionContext {
    readonly nowMs: number;
    readonly eventClass: string;
}

// M6 W5 (ADR 0012 §5). Optional close-side payload bundled into the
// `transition(... CLOSED, ...)` UPDATE so the row's terminal fields land in the
// SAME write as the state. ADR 0009 §6.1 dual-write atomicity: a CLOSED row must
// never observe NULL `exit_reason`. Required on transitions TO CLOSED, rejected
// for any other target state (callers compose qty mutations via adjustQty per CQS).
//
// `realizedPnl` and `exitPrice` are nullable for the RECONCILED_MISSING fallback.
// Post-M49 (ADR 0010 §1b/§1f amendment) the reconciler first attempts
// `fetchMyTrades` and records the recovered closing fills via
// `recordReconciledClosingFills`, so finalize normally yields real values; null is
// expected ONLY when that fetch is unavailable (empty result or fetch failure). The
// exit_reason still persists atomically in either case.
export interface IPositionClosePayload {
    readonly exitReason: ExitReasonEnum;
    readonly realizedPnl: MoneyValue | null;
    readonly exitPrice: MoneyValue | null;
    readonly closedAtMs: number;
}

// M6 W4b (ADR 0009 §6.1b). Context for `adjustQty` — separate from the transition
// context because qty-mutations do NOT change `state` (CQS: combining state + qty
// mutation would force `transition` to do two things). Shared shape (nowMs) so
// both paths plug into the same injected clock.
export interface IPositionAdjustQtyContext {
    readonly nowMs: number;
}

// `IPositionQtyAdjustedEvent` describes the payload emitted on
// `POSITION_QTY_ADJUSTED_EVENT`. Co-located with the producing service; the
// shape is engine-internal (not a shared cross-package contract today).
export interface IPositionQtyAdjustedEvent {
    readonly positionId: number;
    readonly oldQty: string;
    readonly newQty: string;
    readonly reason: QtyAdjustmentReasonEnum;
    readonly adjustedAtMs: number;
}

// M6 R1.2.2 (ADR 0014 §4a revised). Optional adoption-ack payload bundled into
// the `transition(MANUAL_ADOPTED_UNMANAGED → OPEN, ...)` UPDATE. Operator-ack
// promotes a foreign-adopted position into the slot model; ADR §4a prescribes a
// conservative `correlationMode = CORRELATED` (slot C, single-correlated cap)
// since the bot has no idiosyncrasy snapshot for a position it didn't open.
// Rejected for any target state other than OPEN.
export interface IPositionAdoptionAckPayload {
    readonly correlationMode: CorrelationModeEnum;
}

// M6 W5 (ADR 0012 §1). Inputs for `recordFunding` — the single writer for live
// funding rows (from the reconciliation tick) AND backtest funding events
// (M7+). Same code path, same row shape; the cashflow column carries the funding
// amount (signed per ADR 0012 §1a). The `clientOrderId` is the dedupe key —
// `funding-${positionId}-${fundingTimeMs}` — combined with the existing
// `uq_transactions_client_order_id` unique constraint, a re-poll produces zero
// duplicate rows.
export interface IRecordFundingInputs {
    readonly positionId: number;
    readonly side: PositionSideEnum;
    readonly symbol: string;
    readonly cashflow: MoneyValue;
    readonly fundingTimeMs: number;
    readonly markPrice: MoneyValue;
    readonly qty: MoneyValue;
    readonly exchangeOrderId: string | null;
}

// M49 (ADR 0010 §1b/§1f amendment, Option A). One aggregated closing order, built
// from its N partial fills: VWAP price + summed qty/fee so the ledger's unique
// constraints never silently drop a partial (B1). `exchangeRealizedPnl` is the sum
// of Binance's per-trade `realizedPnl` over the order's partials (the M2 probe input).
// `lastFillAtMs` is the chronological anchor — the latest-closing order drains the
// position to zero (recorded as CLOSE; the rest as REDUCE).
export interface IReconciledOrderGroup {
    readonly orderId: string;
    readonly qty: MoneyValue;
    readonly vwapPrice: MoneyValue;
    readonly feeUsdt: MoneyValue;
    readonly exchangeRealizedPnl: MoneyValue;
    readonly lastFillAtMs: number;
}

// Mutable per-order accumulator used only inside `aggregateFillsByOrder`. Kept
// separate from the readonly `IReconciledOrderGroup` so the aggregation result is
// immutable to callers.
interface IMutableReconciledOrderGroup {
    readonly orderId: string;
    qty: MoneyValue;
    weightedPriceSum: MoneyValue;
    feeUsdt: MoneyValue;
    exchangeRealizedPnl: MoneyValue;
    lastFillAtMs: number;
}

// PositionService is the SINGLE write API for position state (ADR 0009 §2 / §6
// invariant 1). All callers must route through transition(). Direct
// repository.update({state: ...}) outside this service is a reviewer must-fix.
//
// DB-first ordering (ADR 0009 §2 / §6 invariant 2): row write → event emit.
// A crash between row write and event emit is recoverable on boot from the row;
// the reverse is not. The in-memory cache lands in W2/W8 (boot pipeline + retainer);
// for W1 the row IS the cache.
@Injectable()
export class PositionService {
    private readonly logger = new Logger(PositionService.name);

    constructor(
        private readonly positions: PositionRepository,
        private readonly transactions: TransactionRepository,
        private readonly events: EventEmitter2,
    ) {}

    // Single mutation API for the position state machine. Validates the move against
    // the ADR 0009 §3 graph; throws IllegalStateTransitionException for any illegal
    // arrow (including transitions out of CLOSED, which is terminal). PositionNotFoundException
    // for an unknown positionId.
    //
    // On success: writes positions.state atomically via repository.save, then emits
    // POSITION_STATE_TRANSITIONED_EVENT carrying the IPositionStateTransitionedEvent
    // payload. Returns the persisted row.
    async transition(
        positionId: number,
        toState: PositionStateEnum,
        context: IPositionTransitionContext,
        closePayload?: IPositionClosePayload,
        adoptionAckPayload?: IPositionAdoptionAckPayload,
    ): Promise<PositionEntity> {
        if (closePayload !== undefined && toState !== PositionStateEnum.CLOSED) {
            throw new IllegalClosePayloadException(positionId, toState);
        }

        const position = await this.positions.findById(positionId);

        if (!position) {
            throw new PositionNotFoundException(positionId);
        }

        const fromState = position.state;

        if (!isLegalTransition(fromState, toState)) {
            this.logger.warn(`rejecting illegal transition positionId=${positionId} ${fromState} -> ${toState} eventClass=${context.eventClass}`);

            throw new IllegalStateTransitionException(positionId, fromState, toState);
        }

        // M6 R1.2.2: adoption-ack payload is only legal on the operator-ack arrow
        // MANUAL_ADOPTED_UNMANAGED → OPEN. Reject anywhere else (e.g., a caller
        // accidentally passing it on PENDING_OPEN → OPEN would silently rewrite
        // correlationMode on a strategy-opened position).
        if (adoptionAckPayload !== undefined) {
            if (fromState !== PositionStateEnum.MANUAL_ADOPTED_UNMANAGED || toState !== PositionStateEnum.OPEN) {
                throw new IllegalAdoptionAckPayloadException(positionId, fromState, toState);
            }
        }

        position.state = toState;

        // ADR 0009 §6.1: close-side fields land in the same UPDATE as the state.
        // A CLOSED row without exit_reason is a reviewer must-fix (ADR 0012 §7).
        if (closePayload !== undefined) {
            position.exitReason = closePayload.exitReason;
            position.realizedPnl = closePayload.realizedPnl;
            position.exitPrice = closePayload.exitPrice;
            position.closedAt = new Date(closePayload.closedAtMs);
        }

        // M6 R1.2.2 (ADR 0014 §4a revised): operator-ack assigns correlationMode
        // atomically with the state flip. Conservative default is CORRELATED
        // (slot C, single-correlated cap) — the bot has no idiosyncrasy snapshot
        // for a position it did not open, so it stays in the correlated cap until
        // it closes.
        if (adoptionAckPayload !== undefined) {
            position.correlationMode = adoptionAckPayload.correlationMode;
        }

        const saved = await this.positions.save(position);

        // R1.3.4 — payload now carries symbol + exitReason + realizedPnl so
        // downstream listeners (PositionLifecycleRetentionListener) can act
        // without a second DB round-trip. Values are read off the just-saved
        // entity to honor ADR 0009 §6.1 dual-write atomicity: the same row
        // state that landed in the DB is what reaches the bus. realizedPnl is
        // serialized as a decimal-as-string per the shared package's money
        // serialization rule.
        const payload: IPositionStateTransitionedEvent = {
            positionId,
            fromState,
            toState,
            transitionedAtMs: context.nowMs,
            eventClass: context.eventClass,
            symbol: saved.symbol,
            exitReason: saved.exitReason ?? null,
            realizedPnl: saved.realizedPnl === null || saved.realizedPnl === undefined ? null : saved.realizedPnl.toFixed(),
        };

        this.events.emit(POSITION_STATE_TRANSITIONED_EVENT, payload);

        this.logger.log(`position state transitioned positionId=${positionId} ${fromState} -> ${toState} eventClass=${context.eventClass}`);

        return saved;
    }

    // M6 W4b (ADR 0009 §6.1b). The single qty-mutation API. Mirrors `transition()`'s
    // DB-first-then-event ordering so a crash between DB write and event emit is
    // recoverable from the row (the reverse is not).
    //
    // Does NOT change `state` — that is CQS by design. Combining state + qty mutation
    // would force `transition` to do two things; instead, callers that need both perform
    // them as separate sequential calls (e.g., ExecutionService.applyReduceFillToPosition
    // on a closing fill: adjustQty(0, LATE_FILL_RESOLVED) then transition(CLOSED, ...)).
    //
    // Throws PositionNotFoundException for an unknown positionId. Throws
    // IllegalQtyAdjustmentException for negative / NaN / non-finite qty — these are
    // contract violations (the gate's sizing always produces a non-negative qty).
    async adjustQty(positionId: number, newQty: MoneyValue, reason: QtyAdjustmentReasonEnum, context: IPositionAdjustQtyContext): Promise<PositionEntity> {
        if (newQty.isNaN() || !newQty.isFinite() || newQty.isNegative()) {
            this.logger.warn(`rejecting illegal qty adjustment positionId=${positionId} requested=${newQty.toFixed()} reason=${reason}`);

            throw new IllegalQtyAdjustmentException(positionId, newQty.toFixed());
        }

        const position = await this.positions.findById(positionId);

        if (!position) {
            throw new PositionNotFoundException(positionId);
        }

        const oldQty = position.qty;
        position.qty = newQty;

        const saved = await this.positions.save(position);

        const payload: IPositionQtyAdjustedEvent = {
            positionId,
            oldQty: oldQty.toFixed(),
            newQty: newQty.toFixed(),
            reason,
            adjustedAtMs: context.nowMs,
        };

        this.events.emit(POSITION_QTY_ADJUSTED_EVENT, payload);

        this.logger.log(`position qty adjusted positionId=${positionId} ${oldQty.toFixed()} -> ${newQty.toFixed()} reason=${reason}`);

        return saved;
    }

    // M6 W5 (ADR 0012 §1, §3). Single writer for funding cashflows — live (from
    // ReconciliationService's tick) AND backtest (M7+ replay). Inserts ONE
    // `transactions` row per funding event with `type=FUNDING`, `cashflow` signed
    // per the venue, `fee=0` (§1b: funding is NOT an exchange fee), and a
    // deterministic `clientOrderId` so a re-poll cannot double-insert.
    //
    // Idempotency: relies on `uq_transactions_client_order_id`. The repository's
    // `recordTerminal` catches the unique-violation and returns the existing row
    // so a duplicate replay is a clean no-op. Returns the persisted row.
    async recordFunding(inputs: IRecordFundingInputs): Promise<TransactionEntity> {
        const clientOrderId = `funding-${inputs.positionId}-${inputs.fundingTimeMs}`;

        const row = await this.transactions.recordTerminal({
            positionId: inputs.positionId,
            type: TransactionTypeEnum.FUNDING,
            side: inputs.side,
            price: inputs.markPrice,
            qty: inputs.qty,
            fee: new Money(0),
            cashflow: inputs.cashflow,
            clientOrderId,
            exchangeOrderId: inputs.exchangeOrderId,
            createdAt: new Date(inputs.fundingTimeMs),
        });

        this.logger.log(
            `funding recorded positionId=${inputs.positionId} symbol=${inputs.symbol} ` +
                `cashflow=${inputs.cashflow.toFixed()} fundingTimeMs=${inputs.fundingTimeMs} clientOrderId=${clientOrderId}`,
        );

        return row;
    }

    // M49 (ADR 0010 §1b/§1f amendment, Option A). Records the exchange-side closing
    // fills the bot never captured locally into the position's ledger, so the
    // unchanged `finalizeRealizedPnl` aggregate (ADR 0012 §5) then produces real
    // `realized_pnl` / `exit_price` / `fees` instead of nulls.
    //
    // Binance `/fapi/v1/userTrades` returns ONE row per partial fill; all partials of
    // one closing order share `orderId`. This method aggregates per `orderId` into a
    // single ledger row (VWAP price, summed qty, USDT-only fee) so the unique
    // constraints never silently drop the 2nd–Nth partial (B1). Dedup is on
    // `exchange_order_id` (B2) — catching an executor REDUCE already recorded for the
    // same order without any cross-clock timestamp comparison. The synthetic
    // `client_order_id` (`reconciled-{positionId}-{orderId}`) keeps each row uniquely
    // addressable, modelled on the `funding-…` precedent.
    //
    // `side` is the POSITION side (LONG/SHORT) — it drives the cashflow sign via
    // `computeFillCashflow`, the same convention the normal reduce path uses, so the
    // §5 formula is reused unchanged. Money is Decimal end-to-end.
    async recordReconciledClosingFills(input: IRecordReconciledFillsInput): Promise<void> {
        if (input.fills.length === 0) {
            return;
        }

        const orderGroups = this.aggregateFillsByOrder(input.positionId, input.fills);

        let insertedCashflow = new Money(0);
        let insertedExchangeRealizedPnl = new Money(0);
        let insertedCount = 0;

        for (let index = 0; index < orderGroups.length; index++) {
            // The chronologically last order drains the position to zero (CLOSE); the rest are REDUCE.
            const resolvedType = index === orderGroups.length - 1 ? TransactionTypeEnum.CLOSE : TransactionTypeEnum.REDUCE;
            const inserted = await this.insertOrderGroupIfNew({
                positionId: input.positionId,
                group: orderGroups[index],
                resolvedType,
                side: input.side,
                entryPrice: input.entryPrice,
            });

            if (inserted === null) {
                continue;
            }

            insertedCashflow = insertedCashflow.plus(inserted.cashflow);
            insertedExchangeRealizedPnl = insertedExchangeRealizedPnl.plus(inserted.exchangeRealizedPnl);
            insertedCount++;
        }

        if (insertedCount > 0) {
            this.crossCheckReconciledFillPnl(input.positionId, insertedCashflow, insertedExchangeRealizedPnl);
        }
    }

    // Records one aggregated closing order into the ledger, unless it is already
    // present (B2 dedup on `exchange_order_id`). Returns the inserted row's cashflow +
    // exchange-reported realizedPnl for the caller's M2 probe accumulation, or null
    // when the order was skipped as a duplicate. `resolvedType` (computed by the
    // caller) is the transaction type — CLOSE for the chronologically last, draining
    // order; REDUCE for the rest.
    private async insertOrderGroupIfNew(input: IInsertOrderGroupInput): Promise<{ cashflow: MoneyValue; exchangeRealizedPnl: MoneyValue } | null> {
        const { positionId, group, resolvedType, side, entryPrice } = input;
        const existing = await this.transactions.findByExchangeOrderId(group.orderId);

        if (existing !== null) {
            this.logger.debug(`reconciled fill skipped (already in ledger) positionId=${positionId} exchangeOrderId=${group.orderId}`);

            return null;
        }

        const cashflow = computeFillCashflow(side, entryPrice, group.vwapPrice, group.qty);

        await this.transactions.recordTerminal({
            positionId,
            type: resolvedType,
            side,
            price: group.vwapPrice,
            qty: group.qty,
            fee: group.feeUsdt,
            cashflow,
            clientOrderId: `reconciled-${positionId}-${group.orderId}`,
            exchangeOrderId: group.orderId,
            createdAt: new Date(group.lastFillAtMs),
        });

        this.logger.log(
            `reconciled closing fill recorded positionId=${positionId} exchangeOrderId=${group.orderId} type=${resolvedType} ` +
                `qty=${group.qty.toFixed()} vwapPrice=${group.vwapPrice.toFixed()} fee=${group.feeUsdt.toFixed()} cashflow=${cashflow.toFixed()}`,
        );

        return { cashflow, exchangeRealizedPnl: group.exchangeRealizedPnl };
    }

    // Ordered by the order's latest fill time so the chronologically last order is the
    // draining CLOSE. VWAP = SUM(price·amount) / SUM(amount); fee sums USDT-denominated
    // partials only (H2 guard). All math is Decimal.
    private aggregateFillsByOrder(positionId: number, fills: readonly IMyTradeSnapshot[]): ReadonlyArray<IReconciledOrderGroup> {
        const groups = new Map<string, IMutableReconciledOrderGroup>();

        for (const fill of fills) {
            const group = groups.get(fill.orderId) ?? this.createOrderGroup(fill.orderId);
            groups.set(fill.orderId, group);

            const amount = parseMoney(fill.amount);
            const price = parseMoney(fill.price);

            group.qty = group.qty.plus(amount);
            group.weightedPriceSum = group.weightedPriceSum.plus(price.times(amount));
            group.feeUsdt = group.feeUsdt.plus(this.feeForPnl(positionId, fill));
            group.exchangeRealizedPnl = group.exchangeRealizedPnl.plus(parseMoney(fill.realizedPnl));
            group.lastFillAtMs = Math.max(group.lastFillAtMs, fill.timestampMs);
        }

        return [...groups.values()]
            .map((group) => ({
                orderId: group.orderId,
                qty: group.qty,
                // A zero-qty order is pathological (it would not drain anything); fall
                // back to the raw weighted sum so a divide-by-zero never throws.
                vwapPrice: group.qty.isZero() ? group.weightedPriceSum : group.weightedPriceSum.dividedBy(group.qty),
                feeUsdt: group.feeUsdt,
                exchangeRealizedPnl: group.exchangeRealizedPnl,
                lastFillAtMs: group.lastFillAtMs,
            }))
            .sort((left, right) => left.lastFillAtMs - right.lastFillAtMs);
    }

    private createOrderGroup(orderId: string): IMutableReconciledOrderGroup {
        return {
            orderId,
            qty: new Money(0),
            weightedPriceSum: new Money(0),
            feeUsdt: new Money(0),
            exchangeRealizedPnl: new Money(0),
            lastFillAtMs: 0,
        };
    }

    // H2 fee-currency guard. Only USDT-denominated fees count toward USDT PnL; any
    // other (or null) currency is dropped to zero-for-PnL and WARN-flagged so the
    // operator can reconcile manually. Returns the fee as Decimal.
    private feeForPnl(positionId: number, fill: IMyTradeSnapshot): MoneyValue {
        if (fill.feeCurrency === RECONCILED_FILL_FEE_CURRENCY) {
            return parseMoney(fill.fee);
        }

        this.logger.warn(
            `non-USDT reconciled fill fee ignored for PnL positionId=${positionId} exchangeOrderId=${fill.orderId} ` +
                `feeCurrency=${fill.feeCurrency ?? 'null'} fee=${fill.fee}`,
        );

        return new Money(0);
    }

    // M2 realized-PnL integrity probe. Compares the locally computed fill cashflow
    // against the sum of Binance's per-trade `realizedPnl`. WARNs on material
    // divergence (> 1% relative OR > $0.10 absolute); the stored value stays the
    // ledger-derived aggregate (ADR 0012 §5) — this is a free cross-check, not a
    // correction.
    private crossCheckReconciledFillPnl(positionId: number, computedFillPnl: MoneyValue, exchangeRealizedPnl: MoneyValue): void {
        const absoluteDivergence = computedFillPnl.minus(exchangeRealizedPnl).abs();
        const absoluteThreshold = new Money(RECONCILED_PNL_DIVERGENCE_ABS_THRESHOLD);
        const relativeThreshold = exchangeRealizedPnl.abs().times(RECONCILED_PNL_DIVERGENCE_REL_THRESHOLD);

        const exceedsAbsolute = absoluteDivergence.greaterThan(absoluteThreshold);
        const exceedsRelative = !exchangeRealizedPnl.isZero() && absoluteDivergence.greaterThan(relativeThreshold);

        if (exceedsAbsolute || exceedsRelative) {
            this.logger.warn(
                `reconciled fill PnL divergence positionId=${positionId} ` +
                    `computedFillPnl=${computedFillPnl.toFixed()} exchangeRealizedPnl=${exchangeRealizedPnl.toFixed()} ` +
                    `absDivergence=${absoluteDivergence.toFixed()} (ledger-derived value retained per ADR 0012 §5)`,
            );
        }
    }

    // M6 W5 (ADR 0012 §5). Realized PnL + exit reason finalization at the
    // closing → closed boundary. Aggregates from the existing `transactions`
    // rows — never re-derives from entry/exit prices at finalize time (§7
    // reviewer rule: "recomputing from entry/exit prices at finalize time is
    // must-fix"). Calls `transition(... CLOSED, ctx, closePayload)` so the
    // realizedPnl + exitReason + exitPrice + closedAt land in the SAME UPDATE
    // as the state — preserving ADR 0009 §6.1 dual-write atomicity.
    //
    //   fillPnl       = SUM(cashflow WHERE type IN {reduce, close})
    //   feesPaid      = SUM(fee     WHERE type != funding)
    //   fundingPaid   = SUM(cashflow WHERE type = funding)
    //   realizedPnl   = fillPnl - feesPaid + fundingPaid
    //   exitPrice     = vol-weighted-avg(price WHERE type IN {reduce, close})
    //
    // Caller is responsible for the CLOSING → CLOSED ordering: a position in
    // OPEN must first transition to CLOSING via the executor's reduce/close
    // path (ADR 0009 §3); finalize then performs CLOSING → CLOSED with the
    // aggregate bundled in. The current state must therefore be CLOSING — but
    // the transition graph itself enforces this (CLOSED has no out-edge; OPEN →
    // CLOSED is illegal). RECONCILED_MISSING is the one exception: case (b)
    // walks OPEN → CLOSING → CLOSED in a single tick and finalize is called
    // for the CLOSING → CLOSED leg.
    //
    // Post-M49 (ADR 0010 §1b/§1f amendment): for RECONCILED_MISSING the reconciler
    // calls `recordReconciledClosingFills` BEFORE finalize, so the ledger normally
    // carries real closing rows and the aggregate below yields non-null
    // realized_pnl / exit_price / fees. The null-when-no-closing-fills branch is now
    // the fallback ONLY when the `fetchMyTrades` recovery returns nothing or fails —
    // it is no longer the normal RECONCILED_MISSING outcome.
    async finalizeRealizedPnl(positionId: number, exitReason: ExitReasonEnum, context: IPositionTransitionContext): Promise<PositionEntity> {
        const txs = await this.transactions.findByPosition(positionId);
        const aggregate = this.aggregatePnl(txs);
        const exitPrice = computeVolumeWeightedExitPrice(aggregate.closingFills);

        const closePayload: IPositionClosePayload = {
            exitReason,
            realizedPnl: aggregate.hasClosingFills ? aggregate.realizedPnl : null,
            exitPrice,
            closedAtMs: context.nowMs,
        };

        const saved = await this.transition(positionId, PositionStateEnum.CLOSED, context, closePayload);

        this.logger.log(
            `position finalized positionId=${positionId} exitReason=${exitReason} ` +
                `realizedPnl=${closePayload.realizedPnl === null ? 'n/a' : closePayload.realizedPnl.toFixed()} ` +
                `exitPrice=${closePayload.exitPrice === null ? 'n/a' : closePayload.exitPrice.toFixed()} ` +
                `(fillPnl=${aggregate.fillPnl.toFixed()} fees=${aggregate.feesPaid.toFixed()} funding=${aggregate.fundingPaid.toFixed()})`,
        );

        return saved;
    }

    // Pure aggregation over the position's transaction ledger. ADR 0012 §5
    // formula; kept private so the §7 "one helper" rule is enforced by API
    // surface — external callers consume finalize / computeUnrealizedPnl.
    private aggregatePnl(transactions: ReadonlyArray<TransactionEntity>): {
        readonly fillPnl: MoneyValue;
        readonly feesPaid: MoneyValue;
        readonly fundingPaid: MoneyValue;
        readonly realizedPnl: MoneyValue;
        readonly closingFills: ReadonlyArray<{ price: MoneyValue; qty: MoneyValue }>;
        readonly hasClosingFills: boolean;
    } {
        let fillPnl = new Money(0);
        let feesPaid = new Money(0);
        let fundingPaid = new Money(0);
        const closingFills: { price: MoneyValue; qty: MoneyValue }[] = [];

        for (const tx of transactions) {
            if (tx.type === TransactionTypeEnum.FUNDING) {
                fundingPaid = fundingPaid.plus(tx.cashflow);
                // ADR 0012 §1b: funding rows carry fee=0 by contract; defensive
                // skip so a venue that ever surfaces a non-zero fee on a funding
                // row does not pollute feesPaid.
                continue;
            }

            feesPaid = feesPaid.plus(tx.fee);

            if (tx.type === TransactionTypeEnum.REDUCE || tx.type === TransactionTypeEnum.CLOSE) {
                fillPnl = fillPnl.plus(tx.cashflow);
                closingFills.push({ price: tx.price, qty: tx.qty });
            }
        }

        const realizedPnl = fillPnl.minus(feesPaid).plus(fundingPaid);

        return { fillPnl, feesPaid, fundingPaid, realizedPnl, closingFills, hasClosingFills: closingFills.length > 0 };
    }
}
