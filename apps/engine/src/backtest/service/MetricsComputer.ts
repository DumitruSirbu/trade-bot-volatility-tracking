import { IBacktestBreakdownRow, IBacktestEquityPoint, IBacktestReport, IBacktestTradeResult } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { Money, MoneyValue } from '../../common/utils/money';

// Annualisation factor for crypto markets: ~365 trading days (24/7). Pinned by ADR 0015 §9.
const ANNUALISATION_FACTOR = Math.sqrt(365);

// Pinned input bundle for the metrics computer. The runner gathers these from W3 state
// (trade list, equity curve, drawdown), the orchestrator counters (skipped triggers,
// rejected gates, missed fills, low-fidelity trades), and the config (run identifiers).
export interface IMetricsInput {
    readonly strategyVersionId: number;
    readonly strategyName: string;
    readonly strategyVersion: number;
    readonly fromUtcDate: string;
    readonly toUtcDate: string;
    readonly runLabel: string;
    readonly trades: readonly IBacktestTradeResult[];
    readonly equityCurve: readonly IBacktestEquityPoint[];
    readonly maxDrawdownPct: string;
    readonly maxDrawdownDurationDays: number;
    readonly skippedTriggerCount: number;
    readonly rejectedByGateCount: number;
    readonly missedLimitFillCount: number;
    readonly lowFidelityTradeCount: number;
}

// Pure computational service that builds the final IBacktestReport from the realised
// trade stream plus the daily-resampled equity curve (ADR 0015 §9). All metrics use NET
// PnL (after fees + funding + slippage). All string parsing goes through Money so no
// float ever touches the math.
//
// @Injectable so BacktestModule can provide it; method itself is pure (no I/O, no clock).
@Injectable()
export class MetricsComputer {
    compute(input: IMetricsInput): IBacktestReport {
        const tradeCount = input.trades.length;
        const { winCount, lossCount, grossWin, grossLoss } = this.partitionTrades(input.trades);
        const winRatePct = this.computeWinRatePct(winCount, tradeCount);

        const totals = this.sumComponents(input.trades);
        const returnPct = this.computeReturnPctFromCurve(input.equityCurve);
        const profitFactor = this.computeProfitFactor(grossWin, grossLoss);
        const avgHoldMs = this.computeAvgHoldMs(input.trades);

        const dailyReturns = this.parseDailyReturns(input.equityCurve);
        const sharpeAnnualized = this.computeSharpe(dailyReturns);
        const sortinoAnnualized = this.computeSortino(dailyReturns);

        return {
            runLabel: input.runLabel,
            strategyVersionId: input.strategyVersionId,
            strategyName: input.strategyName,
            strategyVersion: input.strategyVersion,
            fromUtcDate: input.fromUtcDate,
            toUtcDate: input.toUtcDate,
            tradeCount,
            winCount,
            lossCount,
            winRatePct,
            grossPnlUsdt: totals.grossPnlUsdt.toFixed(8),
            feesUsdt: totals.feesUsdt.toFixed(8),
            fundingUsdt: totals.fundingUsdt.toFixed(8),
            slippageCostUsdt: totals.slippageCostUsdt.toFixed(8),
            netPnlUsdt: totals.netPnlUsdt.toFixed(8),
            returnPct,
            profitFactor,
            avgHoldMs,
            maxDrawdownPct: input.maxDrawdownPct,
            maxDrawdownDurationDays: input.maxDrawdownDurationDays,
            sharpeAnnualized,
            sortinoAnnualized,
            skippedTriggerCount: input.skippedTriggerCount,
            rejectedByGateCount: input.rejectedByGateCount,
            missedLimitFillCount: input.missedLimitFillCount,
            lowFidelityTradeCount: input.lowFidelityTradeCount,
            equityCurve: input.equityCurve,
            perRegime: this.buildBreakdown(input.trades, (trade) => `regime:${trade.regimeAtEntry}`),
            perFlowType: this.buildBreakdown(input.trades, (trade) => `flow:${trade.flowType}`),
            perSymbol: this.buildBreakdown(input.trades, (trade) => `symbol:${trade.symbol}`),
            trades: input.trades,
        };
    }

    private partitionTrades(trades: readonly IBacktestTradeResult[]): {
        winCount: number;
        lossCount: number;
        grossWin: MoneyValue;
        grossLoss: MoneyValue;
    } {
        let winCount = 0;
        let lossCount = 0;
        let grossWin = new Money(0);
        let grossLoss = new Money(0);

        for (const trade of trades) {
            const netPnl = new Money(trade.netPnlUsdt);
            if (netPnl.greaterThan(0)) {
                winCount += 1;
                grossWin = grossWin.plus(netPnl);
            } else {
                lossCount += 1;
                grossLoss = grossLoss.plus(netPnl);
            }
        }

        return { winCount, lossCount, grossWin, grossLoss };
    }

    private computeWinRatePct(winCount: number, tradeCount: number): string {
        if (tradeCount === 0) {
            return '0.00';
        }
        return new Money(winCount).dividedBy(tradeCount).times(100).toFixed(2);
    }

    private sumComponents(trades: readonly IBacktestTradeResult[]): {
        grossPnlUsdt: MoneyValue;
        feesUsdt: MoneyValue;
        fundingUsdt: MoneyValue;
        slippageCostUsdt: MoneyValue;
        netPnlUsdt: MoneyValue;
    } {
        let grossPnlUsdt = new Money(0);
        let feesUsdt = new Money(0);
        let fundingUsdt = new Money(0);
        let slippageCostUsdt = new Money(0);
        let netPnlUsdt = new Money(0);

        for (const trade of trades) {
            grossPnlUsdt = grossPnlUsdt.plus(new Money(trade.grossPnlUsdt));
            feesUsdt = feesUsdt.plus(new Money(trade.feesUsdt));
            fundingUsdt = fundingUsdt.plus(new Money(trade.fundingUsdt));
            slippageCostUsdt = slippageCostUsdt.plus(new Money(trade.slippageCostUsdt));
            netPnlUsdt = netPnlUsdt.plus(new Money(trade.netPnlUsdt));
        }

        return { grossPnlUsdt, feesUsdt, fundingUsdt, slippageCostUsdt, netPnlUsdt };
    }

    // Return % is derived from the equity curve (first → last). Falls back to "0.00" for
    // empty or single-point curves so a no-trade run still produces a valid report.
    private computeReturnPctFromCurve(curve: readonly IBacktestEquityPoint[]): string {
        if (curve.length < 1) {
            return '0.00';
        }
        const firstEquity = new Money(curve[0].equityUsdt);
        const lastEquity = new Money(curve[curve.length - 1].equityUsdt);
        if (firstEquity.isZero()) {
            return '0.00';
        }
        return lastEquity.minus(firstEquity).dividedBy(firstEquity).times(100).toFixed(2);
    }

    private computeProfitFactor(grossWin: MoneyValue, grossLoss: MoneyValue): string {
        if (grossWin.isZero()) {
            return '0.00';
        }
        if (grossLoss.isZero()) {
            return 'Infinity';
        }
        return grossWin.dividedBy(grossLoss.abs()).toFixed(2);
    }

    private computeAvgHoldMs(trades: readonly IBacktestTradeResult[]): number {
        if (trades.length === 0) {
            return 0;
        }
        let total = 0;
        for (const trade of trades) {
            total += trade.holdMs;
        }
        return Math.round(total / trades.length);
    }

    private parseDailyReturns(curve: readonly IBacktestEquityPoint[]): MoneyValue[] {
        // The first equity point has dailyReturnPct = "0.00" by definition; skip it so the
        // statistic measures genuine day-over-day variation.
        const returns: MoneyValue[] = [];
        for (let i = 1; i < curve.length; i += 1) {
            // Stored as percent in the equity point; convert back to fractional return.
            returns.push(new Money(curve[i].dailyReturnPct).dividedBy(100));
        }
        return returns;
    }

    // Sharpe = mean / stddev * sqrt(365); "0.00" when fewer than 2 data points or
    // zero-variance returns (degenerate denominator).
    private computeSharpe(dailyReturns: readonly MoneyValue[]): string {
        if (dailyReturns.length < 2) {
            return '0.00';
        }
        const mean = this.mean(dailyReturns);
        const stddev = this.stddev(dailyReturns, mean);
        if (stddev.isZero()) {
            return '0.00';
        }
        return mean.dividedBy(stddev).times(ANNUALISATION_FACTOR).toFixed(2);
    }

    // Sortino = mean / downside-stddev * sqrt(365), where downside-stddev uses only the
    // returns below MAR=0. "0.00" when fewer than 2 data points or no downside returns.
    private computeSortino(dailyReturns: readonly MoneyValue[]): string {
        if (dailyReturns.length < 2) {
            return '0.00';
        }
        const mean = this.mean(dailyReturns);
        const downsideStddev = this.downsideStddev(dailyReturns);
        if (downsideStddev.isZero()) {
            return '0.00';
        }
        return mean.dividedBy(downsideStddev).times(ANNUALISATION_FACTOR).toFixed(2);
    }

    private mean(values: readonly MoneyValue[]): MoneyValue {
        let sum = new Money(0);
        for (const value of values) {
            sum = sum.plus(value);
        }
        return sum.dividedBy(values.length);
    }

    private stddev(values: readonly MoneyValue[], mean: MoneyValue): MoneyValue {
        let sumSq = new Money(0);
        for (const value of values) {
            const delta = value.minus(mean);
            sumSq = sumSq.plus(delta.times(delta));
        }
        return sumSq.dividedBy(values.length).sqrt();
    }

    // Downside stddev: zero out positive returns (above MAR=0), then RMS over ALL returns.
    // This matches the standard Sortino formulation and keeps the denominator stable.
    private downsideStddev(values: readonly MoneyValue[]): MoneyValue {
        let sumSq = new Money(0);
        for (const value of values) {
            if (value.lessThan(0)) {
                sumSq = sumSq.plus(value.times(value));
            }
        }
        return sumSq.dividedBy(values.length).sqrt();
    }

    private buildBreakdown(trades: readonly IBacktestTradeResult[], keyOf: (trade: IBacktestTradeResult) => string): IBacktestBreakdownRow[] {
        const buckets: Map<string, IBacktestTradeResult[]> = new Map();
        for (const trade of trades) {
            const key = keyOf(trade);
            const bucket = buckets.get(key);
            if (bucket === undefined) {
                buckets.set(key, [trade]);
            } else {
                bucket.push(trade);
            }
        }

        const rows: IBacktestBreakdownRow[] = [];
        for (const [key, bucketTrades] of buckets) {
            const { winCount, grossWin, grossLoss } = this.partitionTrades(bucketTrades);
            const totals = this.sumComponents(bucketTrades);
            rows.push({
                key,
                tradeCount: bucketTrades.length,
                winRatePct: this.computeWinRatePct(winCount, bucketTrades.length),
                netPnlUsdt: totals.netPnlUsdt.toFixed(8),
                profitFactor: this.computeProfitFactor(grossWin, grossLoss),
            });
        }

        // Stable ordering by key so the report is byte-deterministic across runs with the
        // same trade stream (downstream M8 comparator relies on this).
        rows.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
        return rows;
    }
}
