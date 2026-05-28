import { OrderPolicyEnum } from '../enum/OrderPolicyEnum.js';
import { isLessThanOrEqual, isGreaterThanOrEqual, parseDecimal } from './decimalMath.js';

/**
 * Missed-fill model (ADR 0015 §6 — extracted to shared).
 * Live executes a "no chasing" rule: a limit order not filled within its cancel timeout
 * is dropped, not re-priced. The simulator mirrors this using intra-bar ticks.
 *
 * Semantics by policy:
 *   - MARKETABLE_LIMIT_IOC: order crosses the spread; fills if touched price
 *     reaches limitPrice within timeout. For LONG (buy), ask must come down to/below
 *     limitPrice. For SHORT (sell), bid must come up to/above limitPrice.
 *   - POST_ONLY_MAKER: we rest at limitPrice on the passive side; fills if price
 *     trades THROUGH the resting level. For LONG passive bid, ask must cross down.
 *     For SHORT passive ask, bid must cross up.
 *   - REDUCE_MARKET: not a limit order; always fills.
 *
 * Empty ticks for a limit policy → MISSED (C6 fidelity-conservatism: if intrabar
 * evidence is absent, do not invent a favorable fill).
 *
 * Pure function: no I/O, no clock, no random.
 */

export interface ITickSnapshot {
    readonly high: string; // decimal
    readonly low: string; // decimal
    readonly ts: Date;
}

/**
 * Determine if a limit order would be missed given the intra-bar tick path.
 *
 * @param policy Order policy (e.g. OrderPolicyEnum.MARKETABLE_LIMIT_IOC)
 * @param limitPrice Limit price (string, decimal format)
 * @param side Order side ('long' or 'short')
 * @param ticks Intra-bar tick snapshots sorted by time
 * @param barOpenMs Bar open timestamp in ms
 * @param orderTimeoutMs Order timeout in ms (how long the order rests before cancellation)
 * @returns true if the order would be missed, false if it would fill
 */
export function isMissedFill(
    policy: string,
    limitPrice: string,
    side: 'long' | 'short',
    ticks: ITickSnapshot[],
    barOpenMs: number,
    orderTimeoutMs: number,
): boolean {
    if (policy === OrderPolicyEnum.REDUCE_MARKET) {
        return false; // market orders always fill
    }

    if (!isLimitPolicy(policy)) {
        return false; // non-limit policies are not modelled as missable
    }

    if (ticks.length === 0) {
        return true; // no ticks → cannot confirm fill → missed
    }

    const timeoutEndMs = barOpenMs + orderTimeoutMs;
    const ticksWithinWindow = ticks.filter((tick) => {
        const tickMs = tick.ts.getTime();
        return tickMs >= barOpenMs && tickMs <= timeoutEndMs;
    });

    if (ticksWithinWindow.length === 0) {
        return true; // no ticks within order timeout → missed
    }

    return !anyTickTouchesLimit(ticksWithinWindow, limitPrice, side);
}

function isLimitPolicy(policy: string): boolean {
    return policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC || policy === OrderPolicyEnum.POST_ONLY_MAKER;
}

/**
 * Check if any tick in the path touches the limit price on the right side.
 *
 * For a LONG buy-side order, we need the ask to come down to limitPrice → tick.low touches.
 * For a SHORT sell-side order, we need the bid to come up to limitPrice → tick.high touches.
 */
function anyTickTouchesLimit(ticks: ITickSnapshot[], limitPrice: string, side: 'long' | 'short'): boolean {
    const limit = parseDecimal(limitPrice);

    if (side === 'long') {
        // LONG: ask comes down to limitPrice → tick.low <= limitPrice
        return ticks.some((tick) => isLessThanOrEqual(parseDecimal(tick.low), limit));
    }

    // SHORT: bid comes up to limitPrice → tick.high >= limitPrice
    return ticks.some((tick) => isGreaterThanOrEqual(parseDecimal(tick.high), limit));
}
