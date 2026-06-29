import { IStrategyParams } from '@bot/shared';

import { Money, MoneyValue } from './money';

// The slFloor formula reads only the two floor-defining params. Typed as the Pick (not full
// IStrategyParams) so both the strategy-time caller (meanReversionCore, passing full params) and
// the fill-time caller (exitGeometryHelper, passing the geometryParams Pick stamped on the
// approved event — ADR 0045 §D2.11) satisfy it without a structural-subtype mismatch.
type SlFloorParams = Pick<IStrategyParams, 'atr_floor_multiplier' | 'entry_pct_floor'>;

// Noise floor for the mean-reversion stop: the LARGER of an ATR-relative bound (the binding
// constraint for most signals) and a percent-of-entry sanity bound (for zero/near-zero ATR).
// entry_pct_floor is a percent-NUMBER (0.3 = 0.3%), so divide by 100 before applying to entry.
export function resolveSlFloorDistance(referencePrice: MoneyValue, inputs: { atr14: string; params: SlFloorParams }): MoneyValue {
    const atrFloor = new Money(inputs.atr14).times(inputs.params.atr_floor_multiplier);
    const pctFloor = referencePrice.times(new Money(inputs.params.entry_pct_floor).dividedBy(new Money(100)));

    return Money.max(atrFloor, pctFloor);
}
