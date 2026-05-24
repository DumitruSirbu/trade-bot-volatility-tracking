import { OrderPolicyEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils';

// Missed-fill model (ADR 0015 §6 — missed-fill model). Live executes a "no chasing" rule:
// a limit order that is not filled within its cancel timeout is dropped, not re-priced.
// The simulator mirrors that rule using 1s-bar tick_aggregates to decide whether the limit
// would have been touched within the order-timeout window. Without this, the backtest would
// systematically overstate fill rate on POST_ONLY_MAKER and IOC orders that the live book
// would have walked away from.
//
// Semantics by policy:
//   - MARKETABLE_LIMIT_IOC: the order crosses the spread; it fills iff the touched price
//     reaches at least limitPrice within the timeout. For a LONG (we buy), the ask must
//     come down to/below limitPrice → look for tick.low <= limitPrice. For a SHORT (we
//     sell), the bid must come up to/above limitPrice → look for tick.high >= limitPrice.
//   - POST_ONLY_MAKER: we rest at limitPrice on the passive side; it fills iff the price
//     trades THROUGH the resting level. For a LONG passive bid, the ask must cross down to
//     touch our bid → tick.low <= limitPrice. For a SHORT passive ask, the bid must cross
//     up → tick.high >= limitPrice. (Same condition as IOC at the 1s-bar resolution.)
//   - REDUCE_MARKET: not a limit order; always fills (returns missed=false).
//
// Empty ticks for a limit policy → MISSED (true). This is the C6 fidelity-conservatism
// rule: if intrabar evidence is absent, do not invent a favorable fill.
//
// Pure function: no I/O, no clock, no random.
export function isMissedFill(
    policy: string,
    limitPrice: MoneyValue,
    side: 'long' | 'short',
    ticks: { high: MoneyValue; low: MoneyValue; ts: Date }[],
    barOpenMs: number,
    orderTimeoutMs: number,
): boolean {
    if (policy === OrderPolicyEnum.REDUCE_MARKET) {
        return false;
    }

    if (!isLimitPolicy(policy)) {
        return false;
    }

    if (ticks.length === 0) {
        return true;
    }

    const timeoutEndMs = barOpenMs + orderTimeoutMs;
    const ticksWithinWindow = ticks.filter((tick) => {
        const tickMs = tick.ts.getTime();

        return tickMs >= barOpenMs && tickMs <= timeoutEndMs;
    });

    if (ticksWithinWindow.length === 0) {
        return true;
    }

    return !anyTickTouchesLimit(ticksWithinWindow, limitPrice, side);
}

function isLimitPolicy(policy: string): boolean {
    return policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC || policy === OrderPolicyEnum.POST_ONLY_MAKER;
}

// For a LONG buy-side order, we need the ask to come down to limitPrice → tick.low touches.
// For a SHORT sell-side order, we need the bid to come up to limitPrice → tick.high touches.
function anyTickTouchesLimit(ticks: { high: MoneyValue; low: MoneyValue }[], limitPrice: MoneyValue, side: 'long' | 'short'): boolean {
    if (side === 'long') {
        return ticks.some((tick) => tick.low.lessThanOrEqualTo(limitPrice));
    }

    return ticks.some((tick) => tick.high.greaterThanOrEqualTo(limitPrice));
}
