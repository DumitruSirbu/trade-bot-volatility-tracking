import { ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';

// Volume-weighted average price over the given closed bars: Σ(typicalPrice × vol)
// / Σ(vol). Typical price = (high + low + close) / 3. All math in decimal — VWAP is
// a price and must never touch a float. Returns the close price if total volume is
// zero (degenerate; avoids divide-by-zero).
export function computeVwap(bars: ICandle[]): MoneyValue {
    let weightedSum = new Money(0);
    let totalVolume = new Money(0);

    for (const bar of bars) {
        const typicalPrice = bar.high.plus(bar.low).plus(bar.close).dividedBy(3);

        weightedSum = weightedSum.plus(typicalPrice.times(bar.volume));
        totalVolume = totalVolume.plus(bar.volume);
    }

    if (totalVolume.isZero()) {
        return bars[bars.length - 1].close;
    }

    return weightedSum.dividedBy(totalVolume);
}
