import { ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';

// Signed % deviation of a price from an anchor (e.g. close vs VWAP). The sign
// yields the event side downstream. Computed in decimal, returned as a plain
// number because a percentage is a dimensionless ratio, not money.
export function computeDeviationPct(price: MoneyValue, anchor: MoneyValue): number {
    if (anchor.isZero()) {
        return 0;
    }

    return price.minus(anchor).dividedBy(anchor).times(100).toNumber();
}

// Rolling σ of per-bar VWAP deviations over the window — the normalizer that turns
// a raw % move into a σ "distance". σ is a NORMALIZED DISTANCE, not a probability
// (returns are fat-tailed). Population standard deviation of each bar's close-vs-
// VWAP deviation. Returns 0 when fewer than two bars or zero spread.
export function computeDeviationSigma(bars: ICandle[], vwap: MoneyValue): number {
    if (bars.length < 2 || vwap.isZero()) {
        return 0;
    }

    const deviations = bars.map((bar) => computeDeviationPct(bar.close, vwap));
    const mean = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
    const variance = deviations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deviations.length;

    return Math.sqrt(variance);
}

// Normalized distance of the latest close from the anchor, in units of σ.
export function computeDeviationDistanceInSigma(deviationPct: number, sigma: number): number {
    if (sigma === 0) {
        return 0;
    }

    return deviationPct / sigma;
}

// Average base-asset volume over the window (decimal). Zero-safe.
export function computeAverageVolume(bars: ICandle[]): MoneyValue {
    if (bars.length === 0) {
        return new Money(0);
    }

    const total = bars.reduce((sum, bar) => sum.plus(bar.volume), new Money(0));

    return total.dividedBy(bars.length);
}

// Current-bar volume / window-average volume (dimensionless ratio).
export function computeVolumeRatio(currentVolume: MoneyValue, averageVolume: MoneyValue): number {
    if (averageVolume.isZero()) {
        return 0;
    }

    return currentVolume.dividedBy(averageVolume).toNumber();
}
