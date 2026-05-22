import { Decimal } from 'decimal.js';

import { MONEY_PRECISION, MONEY_ROUNDING } from '../const';
import { MoneyParseException } from '../exception';

// A dedicated Decimal constructor configured for money. Cloning (rather than
// mutating the global Decimal via Decimal.set) keeps these settings local to
// monetary math and prevents other Decimal users from changing them out from
// under us — and, conversely, stops this rounding mode from silently biasing
// any future accounting math that uses the global Decimal.
//
// IMPORTANT: MONEY_ROUNDING (ROUND_DOWN) is intended for sizing / notional-cap
// math only — truncating never overshoots a risk limit. PnL, fees, and other
// accounting math must round EXPLICITLY at the call site (banker's / HALF_EVEN).
// A dedicated accounting rounding context lands in M3 with real PnL; do NOT add
// a second global context here.
export const Money = Decimal.clone({
    precision: MONEY_PRECISION,
    rounding: MONEY_ROUNDING,
});

export type MoneyValue = InstanceType<typeof Money>;

// Domain-neutral decimal alias for NON-monetary NUMERIC columns (durations, scores,
// pcts/ratios/rates). Same underlying decimal.js value and the same
// decimalColumnTransformer apply, but MoneyValue stays reserved for actual
// prices/qty/notional/fees/PnL so a reviewer can tell money from a ratio at a glance.
export type DecimalValue = InstanceType<typeof Money>;

// Parse an exchange/DB string into a money value. A JS number is intentionally
// NOT accepted: a float would already be corrupted before Decimal ever sees it.
export function parseMoney(value: string | MoneyValue): MoneyValue {
    try {
        return new Money(value);
    } catch (cause) {
        // decimal.js@10 throws synchronously on invalid input; wrap it as a typed
        // domain error so callers never see a leaked third-party error.
        throw new MoneyParseException(String(value), cause);
    }
}

// Serialise for the wire / DB. Money crosses the boundary as a string, never a
// float, so precision is preserved end to end.
export function formatMoney(value: MoneyValue): string {
    return value.toFixed();
}

export function addMoney(left: MoneyValue, right: MoneyValue): MoneyValue {
    return left.plus(right);
}

export function subtractMoney(left: MoneyValue, right: MoneyValue): MoneyValue {
    return left.minus(right);
}

export function multiplyMoney(left: MoneyValue, right: MoneyValue): MoneyValue {
    return left.times(right);
}

// -1 if left < right, 0 if equal, 1 if left > right.
export function compareMoney(left: MoneyValue, right: MoneyValue): number {
    return left.comparedTo(right);
}

export function isGreaterThanMoney(left: MoneyValue, right: MoneyValue): boolean {
    return left.greaterThan(right);
}
