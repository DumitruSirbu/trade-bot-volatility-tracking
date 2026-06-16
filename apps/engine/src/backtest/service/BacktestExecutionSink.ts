import { IBacktestFill, IBacktestPosition, IBacktestTradeResult } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';
import { BacktestBook } from '../state/BacktestBook';
import { BacktestPnLLedger } from '../state/BacktestPnLLedger';

// Mirrors live M5/M6 surface: the place where a fill is reconciled into in-memory state.
// In the backtest, "state" is the BacktestBook (open positions, completed trades) plus
// the BacktestPnLLedger (cost accumulators). NO risk-gate or DB calls happen here — the
// orchestrator (W4) is responsible for gate calls; the sink only records OUTPUTS.
//
// Plain class (no DI). Constructed per-run by BacktestRunnerService alongside the book
// and ledger so nothing leaks into the live container.
export class BacktestExecutionSink {
    constructor(
        private readonly book: BacktestBook,
        private readonly ledger: BacktestPnLLedger,
    ) {}

    // OPEN: a fill produced a new position. Registers the position in the book, opens its
    // PnL accumulator, records the open fee + open-leg slippage cost, and increments the
    // per-day-per-symbol overtrading counter so the gate sees consistent state.
    applyOpenFill(fill: IBacktestFill, position: IBacktestPosition, dateString: string): void {
        this.book.openPositions.set(position.positionId, position);
        this.book.incrementOpenedOnDay(position.symbol, dateString);
        // M37 W2: retain the open leg's book-input provenance so the trade row can flag
        // low-fidelity when EITHER leg used the tier-floor fallback (see buildTradeResult).
        this.book.recordOpenFillDepthAware(position.positionId, fill.depthAware);

        const entryNotional = new Money(position.entryNotionalUsdt);
        this.ledger.open(position.positionId, position.symbol, entryNotional);

        const accumulator = this.ledger.get(position.positionId);
        if (accumulator === null) {
            return;
        }
        accumulator.addFee(new Money(fill.feeUsdt));
        accumulator.addSlippage(Number(fill.slippagePct), this.fillNotional(fill));
    }

    // CLOSE: a reduce/close fill emptied the position. Records the close fee + close-leg
    // slippage cost, snapshots the accumulator, builds the IBacktestTradeResult identity,
    // and moves the position from openPositions to completedTrades. Idempotent if called
    // for an unknown positionId (the accumulator is already gone) — a duplicate close
    // should be a no-op rather than a crash.
    applyCloseFill(fill: IBacktestFill, grossPnlUsdt: MoneyValue, exitReason: IBacktestTradeResult['exitReason']): void {
        const position = this.findPositionForFill(fill);
        if (position === null) {
            return;
        }

        const accumulator = this.ledger.get(position.positionId);
        if (accumulator === null) {
            return;
        }
        accumulator.addFee(new Money(fill.feeUsdt));
        accumulator.addSlippage(Number(fill.slippagePct), this.fillNotional(fill));

        const snapshot = accumulator.snapshot();
        const netPnlUsdt = this.computeNetPnl(grossPnlUsdt, snapshot);

        const trade = this.buildTradeResult(position, fill, grossPnlUsdt, snapshot, netPnlUsdt, exitReason);
        this.book.completedTrades.push(trade);
        this.book.openPositions.delete(position.positionId);
        this.ledger.close(position.positionId);
    }

    // FUNDING: an 8-hour funding tick fired while the position was open. Adds the SIGNED
    // cashflow (positive = received, negative = paid) to the accumulator; settlement
    // into netPnl happens at close.
    applyFundingCashflow(positionId: string, cashflowUsdt: MoneyValue): void {
        const accumulator = this.ledger.get(positionId);
        if (accumulator === null) {
            return;
        }
        accumulator.addFunding(cashflowUsdt);
    }

    // M7 R1a fix-2 (quant): netPnl = gross - fees + signed_funding.
    // grossPnlUsdt is computed from post-slippage fill prices (entry & exit are fills,
    // not reference prices), so slippage is already embedded in the spread; subtracting
    // `slippageCostUsdt` here double-counted it. `slippageCostUsdt` remains in the trade
    // result for attribution/analytics, but it is NOT part of the net identity.
    // `fundingUsdt` is signed: positive = received (adds to PnL), negative = paid
    // (subtracts). FundingReplayLoader.computeCashflow already returns correctly signed
    // values per ADR 0012.
    private computeNetPnl(grossPnlUsdt: MoneyValue, snapshot: { feesUsdt: MoneyValue; fundingUsdt: MoneyValue }): MoneyValue {
        return grossPnlUsdt.minus(snapshot.feesUsdt).plus(snapshot.fundingUsdt);
    }

    private buildTradeResult(
        position: IBacktestPosition,
        closeFill: IBacktestFill,
        grossPnlUsdt: MoneyValue,
        snapshot: { feesUsdt: MoneyValue; fundingUsdt: MoneyValue; slippageCostUsdt: MoneyValue },
        netPnlUsdt: MoneyValue,
        exitReason: IBacktestTradeResult['exitReason'],
    ): IBacktestTradeResult {
        const entryNotional = new Money(position.entryNotionalUsdt);
        const returnPct = entryNotional.isZero() ? '0.00' : netPnlUsdt.dividedBy(entryNotional).times(100).toFixed(2);

        // M8 W5b (ADR 0018 §2.1): the post-clamp risk budget the position carried —
        // |entryPrice - stopLossPrice| × qty, read off the position at close. This is
        // equal to the ATR target (`atr14 × atrStopMultiplier × qty`) when no
        // liquidation-buffer clamp fires (the common path); when the clamp engages it
        // strictly reduces stop-distance, so this value is always ≤ the gate's pre-clamp
        // ATR risk budget. The clamp is monotonically tightening — never widening — so
        // "post-clamp" is the worst-case exposure the protective stop is approved for.
        // Computed at close from the already-populated position fields so no plumbing
        // change through the risk path is required; per the brief, this lives in-memory
        // only and never hits Postgres.
        const entryPrice = new Money(position.entryPriceUsdt);
        const stopLoss = new Money(position.stopLossUsdt);
        const qty = new Money(position.qty);
        const riskBudgetSpent = entryPrice.minus(stopLoss).abs().times(qty);

        return {
            eventId: closeFill.eventId,
            symbol: position.symbol,
            // Strategy version id is owned by the orchestrator; the sink doesn't know it.
            // The orchestrator stamps the correct id when assembling the report — keeping
            // this neutral here avoids leaking unrelated state into the sink. A negative
            // sentinel makes it obvious in tests if it ever escapes.
            strategyVersionId: -1,
            side: position.side,
            slot: position.slot,
            // FlowType / regime / tier are stamped on the originating decision; the sink
            // does not own that metadata. The orchestrator overwrites these fields when
            // it finalises the trade row before appending to the report's trades array.
            flowType: '',
            regimeAtEntry: '',
            coinTier: 'tier1',
            entryPriceUsdt: position.entryPriceUsdt,
            exitPriceUsdt: closeFill.priceUsdt,
            qty: position.qty,
            grossPnlUsdt: grossPnlUsdt.toFixed(8),
            feesUsdt: snapshot.feesUsdt.toFixed(8),
            fundingUsdt: snapshot.fundingUsdt.toFixed(8),
            slippageCostUsdt: snapshot.slippageCostUsdt.toFixed(8),
            netPnlUsdt: netPnlUsdt.toFixed(8),
            riskBudgetSpent: riskBudgetSpent.toFixed(8),
            returnPct,
            openedAtMs: position.openedAtMs,
            closedAtMs: closeFill.tsMs,
            holdMs: closeFill.tsMs - position.openedAtMs,
            exitReason,
            // M37 W2 (ADR 0015 M37 amendment): low-fidelity when EITHER leg used the
            // tier-floor-model book fallback (no captured book_snapshots row). The open-leg
            // provenance was recorded at applyOpenFill; the close leg is this fill.
            lowFidelity: !this.book.wasOpenFillDepthAware(position.positionId) || !closeFill.depthAware,
        };
    }

    private fillNotional(fill: IBacktestFill): MoneyValue {
        return new Money(fill.priceUsdt).times(new Money(fill.qty));
    }

    // Backtest positions are keyed by synthetic positionId; the fill carries an eventId,
    // not a positionId. The orchestrator typically resolves the position before calling
    // applyCloseFill, but for completeness we find the open position by symbol+side as a
    // best-effort fallback (single open position per symbol+side in the 3-slot model).
    private findPositionForFill(fill: IBacktestFill): IBacktestPosition | null {
        for (const position of this.book.openPositions.values()) {
            if (position.symbol === fill.symbol && position.side === fill.side) {
                return position;
            }
        }
        return null;
    }
}
