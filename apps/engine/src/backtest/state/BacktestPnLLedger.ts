import { Money, MoneyValue } from '../../common/utils/money';

// Accumulates the four cost/cashflow components for ONE open position over its lifetime
// (ADR 0015 §9). Created when the position opens, read once at close to build the
// IBacktestTradeResult.netPnlUsdt identity:
//
//     netPnlUsdt = grossPnlUsdt - feesUsdt - |fundingUsdt| - slippageCostUsdt
//
// The accumulator is intentionally write-once-per-event: callers add deltas as fills
// and funding ticks land, then snapshot at close. No mutation after snapshot.
export class PositionPnLAccumulator {
    private feesUsdtAcc: MoneyValue = new Money(0);
    private fundingUsdtAcc: MoneyValue = new Money(0);
    private slippageCostUsdtAcc: MoneyValue = new Money(0);

    constructor(
        readonly positionId: string,
        readonly symbol: string,
        readonly entryNotionalUsdt: MoneyValue,
    ) {}

    addFee(feeUsdt: MoneyValue): void {
        this.feesUsdtAcc = this.feesUsdtAcc.plus(feeUsdt);
    }

    // Signed: positive = funding received, negative = funding paid. Stored signed so the
    // close-time identity can still compute |funding paid| for the netPnl formula while
    // the report can show the signed total to operators.
    addFunding(fundingUsdt: MoneyValue): void {
        this.fundingUsdtAcc = this.fundingUsdtAcc.plus(fundingUsdt);
    }

    // slippagePct can be signed (adverse vs favorable); slippage *cost* is absolute.
    // Cost in USDT = |slippagePct| / 100 * filledNotional.
    addSlippage(slippagePct: number, filledNotional: MoneyValue): void {
        const absPct = new Money(slippagePct).abs();
        const cost = absPct.dividedBy(100).times(filledNotional);
        this.slippageCostUsdtAcc = this.slippageCostUsdtAcc.plus(cost);
    }

    snapshot(): { feesUsdt: MoneyValue; fundingUsdt: MoneyValue; slippageCostUsdt: MoneyValue } {
        return {
            feesUsdt: this.feesUsdtAcc,
            fundingUsdt: this.fundingUsdtAcc,
            slippageCostUsdt: this.slippageCostUsdtAcc,
        };
    }
}

// Holds the live accumulators for every currently-open backtest position. A Map keyed by
// the synthetic positionId mirrors how BacktestBook stores open positions, so callers can
// pair the two without a secondary index. Closing removes the entry: a closed position's
// costs are flushed into IBacktestTradeResult and the ledger should not retain it.
export class BacktestPnLLedger {
    private readonly accumulators: Map<string, PositionPnLAccumulator> = new Map();

    open(positionId: string, symbol: string, entryNotionalUsdt: MoneyValue): void {
        this.accumulators.set(positionId, new PositionPnLAccumulator(positionId, symbol, entryNotionalUsdt));
    }

    get(positionId: string): PositionPnLAccumulator | null {
        return this.accumulators.get(positionId) ?? null;
    }

    // Removes the accumulator and returns it so the caller can snapshot the final costs
    // into the IBacktestTradeResult. Returns null when no accumulator exists (idempotent
    // close path: a duplicate close should be a no-op, not a crash).
    close(positionId: string): PositionPnLAccumulator | null {
        const accumulator = this.accumulators.get(positionId);
        if (accumulator === undefined) {
            return null;
        }
        this.accumulators.delete(positionId);
        return accumulator;
    }
}
