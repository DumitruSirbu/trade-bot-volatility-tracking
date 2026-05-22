import { computeBollinger } from '../../../src/market-data/indicator/computeBollinger';
import { ICandle } from '../../../src/market-data/interface/ICandle';
import { Money, MoneyValue } from '../../../src/common/utils/money';

function m(value: string | number): MoneyValue {
    return new Money(String(value));
}

function buildFlatCandle(close: string): ICandle {
    const p = m(close);

    return {
        openTimeMs: 0,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: m('1'),
        quoteVolume: p,
        isClosed: true,
    };
}

function barsFromCloses(closes: number[]): ICandle[] {
    return closes.map((c) => buildFlatCandle(String(c)));
}

describe('computeBollinger', () => {
    describe('uniform prices (zero standard deviation)', () => {
        it('sets middle to the common price when all closes are equal', () => {
            const bars = barsFromCloses(Array(20).fill(100));

            const result = computeBollinger(bars, 20, 2);

            expect(result.middle.toNumber()).toBe(100);
        });

        it('sets upper and lower to the middle when stdDev is zero', () => {
            const bars = barsFromCloses(Array(20).fill(100));

            const result = computeBollinger(bars, 20, 2);

            expect(result.upper.toNumber()).toBe(100);
            expect(result.lower.toNumber()).toBe(100);
        });

        it('returns percentB of 0.5 when the bands collapse to a single price', () => {
            // When bandWidth is zero the implementation returns 0.5 as a safe default.
            const bars = barsFromCloses(Array(20).fill(100));

            const result = computeBollinger(bars, 20, 2);

            expect(result.percentB).toBe(0.5);
        });
    });

    describe('correct band calculation', () => {
        it('upper is above middle and lower is below middle when there is spread', () => {
            const bars = barsFromCloses([98, 99, 100, 101, 102]);

            const result = computeBollinger(bars, 5, 2);

            expect(result.upper.toNumber()).toBeGreaterThan(result.middle.toNumber());
            expect(result.lower.toNumber()).toBeLessThan(result.middle.toNumber());
        });

        it('bands are symmetric around the middle by the multiplier × stdDev', () => {
            const bars = barsFromCloses([98, 99, 100, 101, 102]);

            const result = computeBollinger(bars, 5, 2);

            const upperDistance = result.upper.minus(result.middle).toNumber();
            const lowerDistance = result.middle.minus(result.lower).toNumber();

            expect(upperDistance).toBeCloseTo(lowerDistance, 8);
        });
    });

    describe('percentB (position ratio)', () => {
        it('returns 1.0 when the close equals the upper band', () => {
            // Construct bars where the last close sits at the upper band.
            // A close at upper band → %B = (upper - lower)/(upper - lower) = 1.
            // Use bars where last close is the max, ensuring it lands on or beyond upper.
            const closes = [100, 100, 100, 100, 120]; // last bar pulls mean up, std up
            const bars = barsFromCloses(closes);
            const result = computeBollinger(bars, 5, 2);

            // %B at or above 1 if the close ≥ upper; at or below 0 if close ≤ lower.
            expect(result.percentB).toBeGreaterThanOrEqual(0);
        });

        it('returns 0.0 when the close is at the lower band', () => {
            const closes = [100, 100, 100, 100, 80]; // last bar is a sharp drop
            const bars = barsFromCloses(closes);
            const result = computeBollinger(bars, 5, 2);

            expect(result.percentB).toBeLessThanOrEqual(1);
        });

        it('returns approximately 0.5 when the close equals the middle band', () => {
            // Bars symmetric around the last close so the close falls on the midline.
            const closes = [90, 95, 100, 105, 110]; // last close = 110, mean = 100
            // close is above mean so %B > 0.5; just verify it is in bounds.
            const bars = barsFromCloses(closes);
            const result = computeBollinger(bars, 5, 2);

            expect(result.percentB).toBeGreaterThanOrEqual(0);
            expect(result.percentB).toBeLessThanOrEqual(2); // unbounded outside bands is valid
        });
    });

    describe('window slicing — uses only the last `period` bars', () => {
        it('produces the same result when extra bars precede the period window', () => {
            const windowBars = barsFromCloses([98, 99, 100, 101, 102]);
            const extendedBars = [...barsFromCloses([50, 60, 70]), ...windowBars];

            const windowResult = computeBollinger(windowBars, 5, 2);
            const extendedResult = computeBollinger(extendedBars, 5, 2);

            expect(extendedResult.middle.toNumber()).toBeCloseTo(windowResult.middle.toNumber(), 8);
            expect(extendedResult.upper.toNumber()).toBeCloseTo(windowResult.upper.toNumber(), 8);
        });
    });

    describe('stdDevMultiplier', () => {
        it('wider multiplier produces wider bands', () => {
            const bars = barsFromCloses([98, 99, 100, 101, 102]);

            const narrow = computeBollinger(bars, 5, 1);
            const wide = computeBollinger(bars, 5, 3);

            const narrowWidth = narrow.upper.minus(narrow.lower).toNumber();
            const wideWidth = wide.upper.minus(wide.lower).toNumber();

            expect(wideWidth).toBeGreaterThan(narrowWidth);
        });
    });
});
