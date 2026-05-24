import { IBacktestEquityPoint, IBacktestTradeResult } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Builds the daily mark-to-market equity curve from the completed-trade stream plus an
// end-of-day unrealized snapshot for any still-open positions (ADR 0015 §9). Pinned
// definition:
//
//     equity[d] = startingCapital
//               + sum(netPnl of trades closed on or before day d)
//               + unrealizedAtEndOfDay[d]
//
//     dailyReturn[d] = (equity[d] - equity[d-1]) / equity[d-1]
//
// Max drawdown is the largest peak-to-trough % decline along this curve; duration is the
// number of days between that peak day and that trough day.
export class BacktestEquityCurve {
    constructor(private readonly startingCapitalUsdt: MoneyValue) {}

    build(
        completedTrades: readonly IBacktestTradeResult[],
        unrealizedByDate: Map<string, MoneyValue>,
    ): IBacktestEquityPoint[] {
        const dayKeys = this.collectDayKeys(completedTrades, unrealizedByDate);
        if (dayKeys.length === 0) {
            return [];
        }

        const realizedByDay = this.realizedNetPnlByDay(completedTrades);
        const curve: IBacktestEquityPoint[] = [];

        let cumulativeRealized = new Money(0);
        let previousEquity: MoneyValue | null = null;

        for (const utcDate of dayKeys) {
            cumulativeRealized = cumulativeRealized.plus(realizedByDay.get(utcDate) ?? new Money(0));
            const unrealized = unrealizedByDate.get(utcDate) ?? new Money(0);
            const equity = this.startingCapitalUsdt.plus(cumulativeRealized).plus(unrealized);
            const dailyReturnPct = this.computeDailyReturnPct(previousEquity, equity);

            curve.push({
                utcDate,
                equityUsdt: equity.toFixed(8),
                dailyReturnPct,
            });

            previousEquity = equity;
        }

        return curve;
    }

    // Largest peak-to-trough % decline along the curve, plus the day count between the
    // peak day and the trough day. Returns "0.00" / 0 for an empty or single-point curve.
    computeDrawdown(curve: readonly IBacktestEquityPoint[]): { maxDrawdownPct: string; maxDrawdownDurationDays: number } {
        if (curve.length < 2) {
            return { maxDrawdownPct: '0.00', maxDrawdownDurationDays: 0 };
        }

        let peakEquity = new Money(curve[0].equityUsdt);
        let peakDate = curve[0].utcDate;
        let worstDrawdownPct = new Money(0);
        let worstDurationDays = 0;

        for (const point of curve) {
            const equity = new Money(point.equityUsdt);
            if (equity.greaterThan(peakEquity)) {
                peakEquity = equity;
                peakDate = point.utcDate;
                continue;
            }

            if (peakEquity.lessThanOrEqualTo(0)) {
                continue;
            }

            const drawdownPct = peakEquity.minus(equity).dividedBy(peakEquity).times(100);
            if (drawdownPct.greaterThan(worstDrawdownPct)) {
                worstDrawdownPct = drawdownPct;
                worstDurationDays = this.daysBetween(peakDate, point.utcDate);
            }
        }

        return {
            maxDrawdownPct: worstDrawdownPct.toFixed(2),
            maxDrawdownDurationDays: worstDurationDays,
        };
    }

    private collectDayKeys(
        completedTrades: readonly IBacktestTradeResult[],
        unrealizedByDate: Map<string, MoneyValue>,
    ): string[] {
        const keys = new Set<string>();
        for (const trade of completedTrades) {
            keys.add(this.toUtcDate(trade.closedAtMs));
        }
        for (const key of unrealizedByDate.keys()) {
            keys.add(key);
        }
        return Array.from(keys).sort();
    }

    private realizedNetPnlByDay(completedTrades: readonly IBacktestTradeResult[]): Map<string, MoneyValue> {
        const result: Map<string, MoneyValue> = new Map();
        for (const trade of completedTrades) {
            const day = this.toUtcDate(trade.closedAtMs);
            const current = result.get(day) ?? new Money(0);
            result.set(day, current.plus(new Money(trade.netPnlUsdt)));
        }
        return result;
    }

    private computeDailyReturnPct(previousEquity: MoneyValue | null, equity: MoneyValue): string {
        if (previousEquity === null || previousEquity.isZero()) {
            return '0.00';
        }
        return equity.minus(previousEquity).dividedBy(previousEquity).times(100).toFixed(2);
    }

    private toUtcDate(ms: number): string {
        const date = new Date(ms);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private daysBetween(fromUtcDate: string, toUtcDate: string): number {
        const fromMs = this.utcDateToMs(fromUtcDate);
        const toMs = this.utcDateToMs(toUtcDate);
        return Math.round((toMs - fromMs) / MS_PER_DAY);
    }

    private utcDateToMs(utcDate: string): number {
        const [year, month, day] = utcDate.split('-').map((segment) => Number(segment));
        return Date.UTC(year, month - 1, day);
    }
}
