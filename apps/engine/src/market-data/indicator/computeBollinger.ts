import { IBollingerResult, ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';

// Bollinger Bands over `period` closes: middle = SMA, bands = ± multiplier × σ.
// Band prices are decimal; %B is a dimensionless position ratio. The standard
// deviation of prices is computed in decimal then bands are derived in decimal.
export function computeBollinger(bars: ICandle[], period: number, stdDevMultiplier: number): IBollingerResult {
    const closes = bars.slice(-period).map((bar) => bar.close);
    const middle = average(closes);
    const standardDeviation = computeStandardDeviation(closes, middle);
    const offset = standardDeviation.times(stdDevMultiplier);

    const upper = middle.plus(offset);
    const lower = middle.minus(offset);
    const close = closes[closes.length - 1];
    const bandWidth = upper.minus(lower);

    const percentB = bandWidth.isZero() ? 0.5 : close.minus(lower).dividedBy(bandWidth).toNumber();

    return { upper, lower, middle, percentB };
}

function average(values: MoneyValue[]): MoneyValue {
    if (values.length === 0) {
        return new Money(0);
    }

    const total = values.reduce((sum, value) => sum.plus(value), new Money(0));

    return total.dividedBy(values.length);
}

function computeStandardDeviation(values: MoneyValue[], mean: MoneyValue): MoneyValue {
    if (values.length === 0) {
        return new Money(0);
    }

    const variance = values.reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), new Money(0)).dividedBy(values.length);

    return variance.sqrt();
}
