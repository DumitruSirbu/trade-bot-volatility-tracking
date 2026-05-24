import { MoneyValue } from '../../common/utils';
import { TickAggregateEntity } from '../../market-data/entity';

// Intrabar stop/TP simulator (ADR 0015 §8). For an OPEN position carried across a 5m bar,
// the question is: did the price path within the bar touch the stop_loss or take_profit
// level, and if so which one first? The naive answer "use bar high/low" loses ordering —
// a bar that touches BOTH ends doesn't tell you which side fired. tick_aggregates (1s
// OHLCV) gives us the per-second path so we can walk it chronologically and find the
// first level breached.
//
// Semantics:
//   - LONG: SL hit when tick.low <= stopLoss; TP hit when tick.high >= takeProfit.
//   - SHORT: SL hit when tick.high >= stopLoss; TP hit when tick.low <= takeProfit.
//   - If both are touched within the same 1s tick, the LOWER-fidelity tie-break picks
//     SL first. This is the conservative choice — bias outcomes toward the loss side
//     when intrabar order is ambiguous (C6 fidelity-conservatism).
//   - Empty ticks → fall back to bar high/low (lowFidelity = true). When BOTH are
//     touched at the bar level with no tick path to disambiguate, SL fires first.
//
// Pure: no clock, no I/O. Tick ordering is taken as given (caller passes sorted ticks).
export interface IStopSimulatorResult {
    readonly hit: 'stop_loss' | 'take_profit' | null;
    readonly hitTsMs: number | null;
    readonly hitPrice: MoneyValue | null;
    readonly lowFidelity: boolean;
}

export function simulateIntrabarStop(
    side: 'long' | 'short',
    stopLoss: MoneyValue,
    takeProfit: MoneyValue,
    ticks: TickAggregateEntity[],
    barHigh: MoneyValue,
    barLow: MoneyValue,
    barOpenMs: number,
): IStopSimulatorResult {
    if (ticks.length === 0) {
        return resolveFromBarExtremes(side, stopLoss, takeProfit, barHigh, barLow, barOpenMs);
    }

    const sortedTicks = [...ticks].sort((left, right) => left.ts.getTime() - right.ts.getTime());

    for (const tick of sortedTicks) {
        const slHit = isStopLossTouched(side, tick.high, tick.low, stopLoss);
        const tpHit = isTakeProfitTouched(side, tick.high, tick.low, takeProfit);

        if (slHit && tpHit) {
            return {
                hit: 'stop_loss',
                hitTsMs: tick.ts.getTime(),
                hitPrice: tick.close,
                lowFidelity: false,
            };
        }

        if (slHit) {
            return {
                hit: 'stop_loss',
                hitTsMs: tick.ts.getTime(),
                hitPrice: tick.close,
                lowFidelity: false,
            };
        }

        if (tpHit) {
            return {
                hit: 'take_profit',
                hitTsMs: tick.ts.getTime(),
                hitPrice: tick.close,
                lowFidelity: false,
            };
        }
    }

    return { hit: null, hitTsMs: null, hitPrice: null, lowFidelity: false };
}

// Fallback when tick_aggregates is empty for the bar. We can only see bar-level extremes
// so chronological ordering is unknowable — SL wins ties (C6 conservatism). Reported as
// lowFidelity so IBacktestReport.lowFidelityTradeCount can flag it.
function resolveFromBarExtremes(
    side: 'long' | 'short',
    stopLoss: MoneyValue,
    takeProfit: MoneyValue,
    barHigh: MoneyValue,
    barLow: MoneyValue,
    barOpenMs: number,
): IStopSimulatorResult {
    const slHit = isStopLossTouched(side, barHigh, barLow, stopLoss);
    const tpHit = isTakeProfitTouched(side, barHigh, barLow, takeProfit);

    if (slHit) {
        return { hit: 'stop_loss', hitTsMs: barOpenMs, hitPrice: stopLoss, lowFidelity: true };
    }

    if (tpHit) {
        return { hit: 'take_profit', hitTsMs: barOpenMs, hitPrice: takeProfit, lowFidelity: true };
    }

    return { hit: null, hitTsMs: null, hitPrice: null, lowFidelity: true };
}

function isStopLossTouched(side: 'long' | 'short', high: MoneyValue, low: MoneyValue, stopLoss: MoneyValue): boolean {
    if (side === 'long') {
        return low.lessThanOrEqualTo(stopLoss);
    }

    return high.greaterThanOrEqualTo(stopLoss);
}

function isTakeProfitTouched(side: 'long' | 'short', high: MoneyValue, low: MoneyValue, takeProfit: MoneyValue): boolean {
    if (side === 'long') {
        return high.greaterThanOrEqualTo(takeProfit);
    }

    return low.lessThanOrEqualTo(takeProfit);
}
