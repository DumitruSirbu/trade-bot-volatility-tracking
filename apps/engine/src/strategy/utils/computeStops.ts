import { PositionSideEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';

const ONE = new Money(1);
const PCT_DIVISOR = new Money(100);

// Deterministic, side-aware protective-stop computations (ADR 0003 §3, M3 brief). Pure
// decimal.js — never float. These produce PROPOSED stop prices only; enforcement is M4/M6.

// ATR stop: a fixed ATR multiple away from entry, adverse to the trade side.
//   long  → entry - atr14 × multiplier   (stop sits below entry)
//   short → entry + atr14 × multiplier   (stop sits above entry)
export function computeAtrStop(side: PositionSideEnum, entryPrice: MoneyValue, atr14: MoneyValue, atrStopMultiplier: number): MoneyValue {
    const offset = atr14.times(atrStopMultiplier);

    if (side === PositionSideEnum.LONG) {
        return entryPrice.minus(offset);
    }

    return entryPrice.plus(offset);
}

// Structural stop: placed just beyond the deviation wick (the Bollinger band the price
// pierced) by a small buffer %, then capped so the loss can never exceed a hard %.
//   short (price spiked above) → wick = bollinger upper; raw = wick × (1 + buffer%)
//   long  (price dumped below) → wick = bollinger lower; raw = wick × (1 - buffer%)
// The hard cap clamps the stop to entry × (1 ± hardCap%) so a wide wick can't widen risk
// past the configured ceiling.
export function computeStructuralStop(
    side: PositionSideEnum,
    entryPrice: MoneyValue,
    deviationWickPrice: MoneyValue,
    structuralStopWickBufferPct: number,
    structuralStopHardCapPct: number,
): MoneyValue {
    const bufferFactor = new Money(structuralStopWickBufferPct).dividedBy(PCT_DIVISOR);
    const hardCapFactor = new Money(structuralStopHardCapPct).dividedBy(PCT_DIVISOR);

    if (side === PositionSideEnum.LONG) {
        const rawStop = deviationWickPrice.times(ONE.minus(bufferFactor));
        const hardCapStop = entryPrice.times(ONE.minus(hardCapFactor));

        return Money.max(rawStop, hardCapStop);
    }

    const rawStop = deviationWickPrice.times(ONE.plus(bufferFactor));
    const hardCapStop = entryPrice.times(ONE.plus(hardCapFactor));

    return Money.min(rawStop, hardCapStop);
}
