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
    applyCloseFill(
        fill: IBacktestFill,
        grossPnlUsdt: MoneyValue,
        exitReason: IBacktestTradeResult['exitReason'],
    ): void {
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

    // Pinned identity (ADR 0012 / 0015 §9): netPnl = gross - fees - |funding paid| - slippage cost.
    // |funding paid| means: if the signed cashflow is negative (we paid), subtract its
    // absolute value; if positive (we received), it does NOT enter this identity (funding
    // received is preserved separately in the report).
    private computeNetPnl(
        grossPnlUsdt: MoneyValue,
        snapshot: { feesUsdt: MoneyValue; fundingUsdt: MoneyValue; slippageCostUsdt: MoneyValue },
    ): MoneyValue {
        const fundingPaidAbs = snapshot.fundingUsdt.lessThan(0) ? snapshot.fundingUsdt.abs() : new Money(0);
        return grossPnlUsdt.minus(snapshot.feesUsdt).minus(fundingPaidAbs).minus(snapshot.slippageCostUsdt);
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
        const returnPct = entryNotional.isZero()
            ? '0.00'
            : netPnlUsdt.dividedBy(entryNotional).times(100).toFixed(2);

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
            returnPct,
            openedAtMs: position.openedAtMs,
            closedAtMs: closeFill.tsMs,
            holdMs: closeFill.tsMs - position.openedAtMs,
            exitReason,
            lowFidelity: !closeFill.depthAware,
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
