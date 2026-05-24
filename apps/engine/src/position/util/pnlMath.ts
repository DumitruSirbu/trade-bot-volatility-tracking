import { PositionSideEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';

// ADR 0012 §4 — the SINGLE definition of the unrealized-PnL formula in the
// engine (§7 reviewer rule: "Two definitions of unrealized PnL anywhere in
// the codebase is must-fix. One formula, one helper, one caller."). Every
// caller (M9 dashboard projection, the M4 model-divergence metric, the M7
// account_snapshots writer) consumes this function — adding a second
// definition is a reviewer must-fix.
//
//   priceTerm    = side === LONG  ? qty * (markPrice - entryPrice)
//                                 : qty * (entryPrice - markPrice)
//   fundingPnl   = settled funding (from SUM(transactions.cashflow type=funding))
//                + accrued funding (estimated next-settlement amount, signed per ADR 0012 §1a)
//   total        = priceTerm - feesPaid + fundingPnl
//
// All inputs arrive as MoneyValue (decimal.js); no float math touches the path.
// `feesPaid` is subtracted from the price term (entry-side fees count against
// unrealized PnL per ADR 0012 §4 — "the dashboard equity matches reality").

export interface IUnrealizedPnlInputs {
    readonly side: PositionSideEnum;
    readonly qty: MoneyValue;
    readonly entryPrice: MoneyValue;
    readonly markPrice: MoneyValue;
    readonly feesPaid: MoneyValue;
    // Settled funding rows aggregate (sum of transactions.cashflow type=funding).
    // Signed: positive = received, negative = paid (ADR 0012 §1a).
    readonly settledFunding: MoneyValue;
    // Predicted-pro-rated next settlement amount (ADR 0012 §4a). Signed same as
    // settledFunding. Callers pass zero when no accrual estimate is available
    // (the dashboard tolerates the 0.0001-of-notional miss per §4a).
    readonly accruedFunding: MoneyValue;
}

export interface IUnrealizedPnlBreakdown {
    readonly pricePnl: MoneyValue;
    readonly fundingPnl: MoneyValue;
    readonly total: MoneyValue;
}

export function computeUnrealizedPnl(inputs: IUnrealizedPnlInputs): IUnrealizedPnlBreakdown {
    const priceDelta = inputs.side === PositionSideEnum.LONG ? inputs.markPrice.minus(inputs.entryPrice) : inputs.entryPrice.minus(inputs.markPrice);
    const priceTerm = priceDelta.times(inputs.qty);

    // ADR 0012 §6 split: `unrealized_pnl_price` is the priceTerm net of fees;
    // `unrealized_pnl_funding` is settled + accrued. Both feed the snapshot writer
    // independently so M8 can attribute equity drift per source.
    const pricePnl = priceTerm.minus(inputs.feesPaid);
    const fundingPnl = inputs.settledFunding.plus(inputs.accruedFunding);
    const total = pricePnl.plus(fundingPnl);

    return { pricePnl, fundingPnl, total };
}

// Side-aware cashflow attribution for a single reduce/close fill (ADR 0012 §5
// "The `cashflow` per `reduce/close` row is computed at fill time as the
// side-aware price delta times fill qty"). Used by ExecutionService when
// writing the terminal-fill transaction row so the cashflow column carries
// the per-fill PnL component (entry-side fees stay in the `fee` column;
// `finalizeRealizedPnl` aggregates both at close).
//
//   LONG:  (exitPrice - entryPrice) * qty
//   SHORT: (entryPrice - exitPrice) * qty
//
// Always returns a signed MoneyValue (positive = realized gain, negative = loss).
export function computeFillCashflow(side: PositionSideEnum, entryPrice: MoneyValue, exitPrice: MoneyValue, qty: MoneyValue): MoneyValue {
    const delta = side === PositionSideEnum.LONG ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);

    return delta.times(qty);
}

// ADR 0012 §5: `exitPrice = vol-weighted-avg(transactions.price WHERE type IN
// {reduce, close})`. Pure aggregation over an already-loaded fill list — the
// caller supplies the list so this stays I/O free and reuseable from
// PositionService.finalizeRealizedPnl AND any future analytic path.
//
// Returns null when there are no qualifying fills (defensive — a CLOSED row
// with zero reduce/close fills is pathological but possible after a
// reconciliation-driven close where the exchange-side fills never landed
// locally; ADR 0010 §1b explicitly allows null exit_price there).
export function computeVolumeWeightedExitPrice(fills: ReadonlyArray<{ price: MoneyValue; qty: MoneyValue }>): MoneyValue | null {
    if (fills.length === 0) {
        return null;
    }

    let totalQty = new Money(0);
    let weightedPriceSum = new Money(0);

    for (const fill of fills) {
        totalQty = totalQty.plus(fill.qty);
        weightedPriceSum = weightedPriceSum.plus(fill.price.times(fill.qty));
    }

    if (totalQty.isZero()) {
        return null;
    }

    return weightedPriceSum.dividedBy(totalQty);
}
