import { ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';

// Average True Range over `period` bars (Wilder). True range = max(high−low,
// abs(high−prevClose), abs(low−prevClose)). ATR is a price-unit measure → decimal.
// Returns 0 when there are not enough bars to seed the average.
export function computeAtr(bars: ICandle[], period: number): MoneyValue {
    if (bars.length <= period) {
        return new Money(0);
    }

    const trueRanges = computeTrueRanges(bars);

    // Wilder seed: simple average of the first `period` true ranges, then smoothed.
    let atr = trueRanges
        .slice(0, period)
        .reduce((sum, tr) => sum.plus(tr), new Money(0))
        .dividedBy(period);

    for (let index = period; index < trueRanges.length; index += 1) {
        atr = atr
            .times(period - 1)
            .plus(trueRanges[index])
            .dividedBy(period);
    }

    return atr;
}

function computeTrueRanges(bars: ICandle[]): MoneyValue[] {
    const trueRanges: MoneyValue[] = [];

    for (let index = 1; index < bars.length; index += 1) {
        const current = bars[index];
        const previousClose = bars[index - 1].close;

        const highLow = current.high.minus(current.low).abs();
        const highClose = current.high.minus(previousClose).abs();
        const lowClose = current.low.minus(previousClose).abs();

        trueRanges.push(Money.max(highLow, highClose, lowClose));
    }

    return trueRanges;
}
