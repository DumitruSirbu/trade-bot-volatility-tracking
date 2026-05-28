import { IIntraBarStopResult } from '../interface/IIntraBarStopResult.js';
import { isLessThanOrEqual, isGreaterThanOrEqual, parseDecimal } from './decimalMath.js';

/**
 * Intra-bar stop/TP simulator (ADR 0015 §8 — extracted to shared).
 * For an open position carried across a bar, determines if the price path
 * touched the stop-loss or take-profit level, and which one first.
 *
 * Semantics:
 *   - LONG: SL hit when tick.low <= stopLoss; TP hit when tick.high >= takeProfit.
 *   - SHORT: SL hit when tick.high >= stopLoss; TP hit when tick.low <= takeProfit.
 *   - If both are touched in the same tick, SL fires first (C6 conservatism).
 *   - Empty ticks → fall back to bar high/low (lowFidelity = true). When BOTH
 *     are touched at bar level with no tick path, SL fires first.
 *
 * Pure: no clock, no I/O. Tick ordering is taken as given (caller sorts).
 */

export interface ITickAggregateSnapshot {
    readonly high: string; // decimal
    readonly low: string; // decimal
    readonly close: string; // decimal
    readonly ts: Date;
}

/**
 * Evaluate intra-bar stop/TP triggers for an open position during a bar.
 *
 * @param side Position side ('long' or 'short')
 * @param stopLoss Stop-loss price (string, decimal format), or null if no SL
 * @param takeProfit Take-profit price (string, decimal format), or null if no TP
 * @param ticks Intra-bar tick snapshots sorted chronologically
 * @param barHigh Bar's high price (string, decimal format)
 * @param barLow Bar's low price (string, decimal format)
 * @param barOpenMs Bar open timestamp in ms
 * @returns Result indicating which level (if any) was hit first
 */
export function simulateIntrabarStop(
    side: 'long' | 'short',
    stopLoss: string | null,
    takeProfit: string | null,
    ticks: ITickAggregateSnapshot[],
    barHigh: string,
    barLow: string,
    barOpenMs: number,
): IIntraBarStopResult {
    if (ticks.length === 0) {
        return resolveFromBarExtremes(side, stopLoss, takeProfit, barHigh, barLow, barOpenMs);
    }

    const sortedTicks = [...ticks].sort((left, right) => left.ts.getTime() - right.ts.getTime());

    for (const tick of sortedTicks) {
        const slHit = isStopLossTouched(side, tick.high, tick.low, stopLoss);
        const tpHit = isTakeProfitTouched(side, tick.high, tick.low, takeProfit);

        if (slHit && tpHit) {
            // Both hit in same tick: SL wins (conservatism)
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

/**
 * Fallback when tick_aggregates is empty for the bar.
 * Can only see bar-level extremes, so chronological ordering is unknowable.
 * SL wins ties (C6 conservatism).
 */
function resolveFromBarExtremes(
    side: 'long' | 'short',
    stopLoss: string | null,
    takeProfit: string | null,
    barHigh: string,
    barLow: string,
    barOpenMs: number,
): IIntraBarStopResult {
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

/**
 * Check if stop-loss was touched on this tick/bar.
 */
function isStopLossTouched(side: 'long' | 'short', high: string, low: string, stopLoss: string | null): boolean {
    if (stopLoss === null) {
        return false;
    }

    const sl = parseDecimal(stopLoss);

    if (side === 'long') {
        // LONG: SL hit when tick.low <= stopLoss
        return isLessThanOrEqual(parseDecimal(low), sl);
    }

    // SHORT: SL hit when tick.high >= stopLoss
    return isGreaterThanOrEqual(parseDecimal(high), sl);
}

/**
 * Check if take-profit was touched on this tick/bar.
 */
function isTakeProfitTouched(side: 'long' | 'short', high: string, low: string, takeProfit: string | null): boolean {
    if (takeProfit === null) {
        return false;
    }

    const tp = parseDecimal(takeProfit);

    if (side === 'long') {
        // LONG: TP hit when tick.high >= takeProfit
        return isGreaterThanOrEqual(parseDecimal(high), tp);
    }

    // SHORT: TP hit when tick.low <= takeProfit
    return isLessThanOrEqual(parseDecimal(low), tp);
}
