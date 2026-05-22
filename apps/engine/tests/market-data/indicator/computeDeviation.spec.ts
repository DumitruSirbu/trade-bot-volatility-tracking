import {
    computeDeviationPct,
    computeDeviationSigma,
    computeDeviationDistanceInSigma,
    computeAverageVolume,
    computeVolumeRatio,
} from '../../../src/market-data/indicator/computeDeviation';
import { ICandle } from '../../../src/market-data/interface/ICandle';
import { Money, MoneyValue } from '../../../src/common/utils/money';

function m(value: string | number): MoneyValue {
    return new Money(String(value));
}

function buildFlatCandle(price: string, volume: string): ICandle {
    const p = m(price);
    const v = m(volume);

    return {
        openTimeMs: 0,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: v,
        quoteVolume: p.times(v),
        isClosed: true,
    };
}

describe('computeDeviationPct', () => {
    describe('zero anchor guard', () => {
        it('returns 0 when anchor is zero to avoid division by zero', () => {
            const result = computeDeviationPct(m('100'), m('0'));

            expect(result).toBe(0);
        });
    });

    describe('correct percentage computation', () => {
        it('returns 0 when price equals anchor', () => {
            expect(computeDeviationPct(m('100'), m('100'))).toBe(0);
        });

        it('returns a positive percentage when price is above anchor', () => {
            // (110 - 100) / 100 × 100 = 10 %
            expect(computeDeviationPct(m('110'), m('100'))).toBe(10);
        });

        it('returns a negative percentage when price is below anchor', () => {
            // (90 - 100) / 100 × 100 = -10 %
            expect(computeDeviationPct(m('90'), m('100'))).toBe(-10);
        });

        it('computes a fractional percentage without float drift', () => {
            // (100.5 - 100) / 100 × 100 = 0.5 %
            const result = computeDeviationPct(m('100.5'), m('100'));

            expect(result).toBeCloseTo(0.5, 10);
        });
    });
});

describe('computeDeviationSigma', () => {
    describe('insufficient data guards', () => {
        it('returns 0 for an empty bar array', () => {
            expect(computeDeviationSigma([], m('100'))).toBe(0);
        });

        it('returns 0 for a single bar (population σ needs at least two values)', () => {
            const bars = [buildFlatCandle('100', '1')];

            expect(computeDeviationSigma(bars, m('100'))).toBe(0);
        });

        it('returns 0 when VWAP anchor is zero', () => {
            const bars = [buildFlatCandle('100', '1'), buildFlatCandle('110', '1')];

            expect(computeDeviationSigma(bars, m('0'))).toBe(0);
        });
    });

    describe('zero variance', () => {
        it('returns 0 when all closes are at the VWAP (no spread)', () => {
            const bars = [buildFlatCandle('100', '1'), buildFlatCandle('100', '1'), buildFlatCandle('100', '1')];

            expect(computeDeviationSigma(bars, m('100'))).toBe(0);
        });
    });

    describe('correct standard deviation', () => {
        it('returns the population σ of close-vs-VWAP deviations (hand-computed)', () => {
            // close deviations from VWAP=100: +10 %, -10 %, 0 %
            // mean = 0 %, variance = ((10² + (-10)² + 0²)/3) = 66.67, σ = √66.67 ≈ 8.165
            const bars = [buildFlatCandle('110', '1'), buildFlatCandle('90', '1'), buildFlatCandle('100', '1')];
            const vwap = m('100');

            const result = computeDeviationSigma(bars, vwap);

            expect(result).toBeCloseTo(8.165, 2);
        });
    });

    describe('exactly two bars boundary', () => {
        it('computes with exactly two bars without throwing', () => {
            const bars = [buildFlatCandle('100', '1'), buildFlatCandle('104', '1')];
            const vwap = m('100');

            const result = computeDeviationSigma(bars, vwap);

            // deviations: 0%, +4% → mean=2%, var=((0-2)²+(4-2)²)/2=4, σ=2
            expect(result).toBeCloseTo(2, 10);
        });
    });
});

describe('computeDeviationDistanceInSigma', () => {
    it('returns 0 when sigma is zero to avoid division by zero', () => {
        expect(computeDeviationDistanceInSigma(5, 0)).toBe(0);
    });

    it('returns the ratio of deviation to sigma', () => {
        // 4% deviation / 2% sigma = 2σ
        expect(computeDeviationDistanceInSigma(4, 2)).toBe(2);
    });

    it('returns a negative value when deviation is negative', () => {
        expect(computeDeviationDistanceInSigma(-3, 1)).toBe(-3);
    });

    it('returns a fractional sigma distance correctly', () => {
        expect(computeDeviationDistanceInSigma(1, 4)).toBe(0.25);
    });
});

describe('computeAverageVolume', () => {
    it('returns zero for an empty bar array', () => {
        expect(computeAverageVolume([]).toNumber()).toBe(0);
    });

    it('returns the volume of a single bar', () => {
        const bars = [buildFlatCandle('100', '42')];

        expect(computeAverageVolume(bars).toNumber()).toBe(42);
    });

    it('returns the simple average across multiple bars', () => {
        const bars = [buildFlatCandle('100', '10'), buildFlatCandle('100', '20'), buildFlatCandle('100', '30')];
        // avg = 60 / 3 = 20

        expect(computeAverageVolume(bars).toNumber()).toBe(20);
    });

    it('handles zero-volume bars in the window', () => {
        const bars = [buildFlatCandle('100', '0'), buildFlatCandle('100', '0')];

        expect(computeAverageVolume(bars).isZero()).toBe(true);
    });
});

describe('computeVolumeRatio', () => {
    it('returns 0 when the average volume is zero', () => {
        expect(computeVolumeRatio(m('100'), m('0'))).toBe(0);
    });

    it('returns 1 when current volume equals average volume', () => {
        expect(computeVolumeRatio(m('50'), m('50'))).toBe(1);
    });

    it('returns a value greater than 1 when current exceeds the average', () => {
        // 100 / 50 = 2
        expect(computeVolumeRatio(m('100'), m('50'))).toBe(2);
    });

    it('returns a value less than 1 when current is below the average', () => {
        // 25 / 50 = 0.5
        expect(computeVolumeRatio(m('25'), m('50'))).toBe(0.5);
    });

    it('returns 0 when current volume is zero', () => {
        expect(computeVolumeRatio(m('0'), m('50'))).toBe(0);
    });
});
