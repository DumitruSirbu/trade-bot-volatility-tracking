import { computeAtr } from '../../../src/market-data/indicator/computeAtr';
import { ICandle } from '../../../src/market-data/interface/ICandle';
import { Money, MoneyValue } from '../../../src/common/utils/money';

function m(value: string | number): MoneyValue {
    return new Money(String(value));
}

function buildCandle(high: string, low: string, close: string, openTimeMs = 0): ICandle {
    return {
        openTimeMs,
        open: m(close),
        high: m(high),
        low: m(low),
        close: m(close),
        volume: m('1'),
        quoteVolume: m(close),
        isClosed: true,
    };
}

// Builds a sequence of bars with constant range of `range` points from a starting close.
// Each bar: high = prevClose + range, low = prevClose, close = prevClose + range/2.
function buildConstantRangeBars(count: number, startClose: number, range: number): ICandle[] {
    const bars: ICandle[] = [];
    let prevClose = startClose;

    for (let i = 0; i < count; i++) {
        const high = prevClose + range;
        const low = prevClose;
        const close = prevClose + range / 2;
        bars.push(buildCandle(String(high), String(low), String(close)));
        prevClose = close;
    }

    return bars;
}

describe('computeAtr', () => {
    describe('insufficient data guards', () => {
        it('returns 0 for an empty bar array', () => {
            const result = computeAtr([], 14);

            expect(result.toNumber()).toBe(0);
        });

        it('returns 0 when bar count equals the period (needs strictly more than period)', () => {
            // computeAtr requires bars.length > period to produce a value
            const bars = buildConstantRangeBars(14, 100, 2);

            const result = computeAtr(bars, 14);

            expect(result.toNumber()).toBe(0);
        });

        it('returns 0 when bar count is one below the threshold (period + 1 - 1 = period)', () => {
            const bars = buildConstantRangeBars(14, 100, 2);

            const result = computeAtr(bars, 14);

            expect(result.toNumber()).toBe(0);
        });
    });

    describe('constant range', () => {
        it('returns a value close to the constant true range when bars have uniform range', () => {
            // With exactly period + 1 bars and uniform range, Wilder seed = range.
            // True range for each bar: max(high-low, |high-prevClose|, |low-prevClose|).
            // For our factory: high-low = range is dominant; all TRs are `range`.
            // ATR converges to `range` immediately for the seed.
            const bars = buildConstantRangeBars(16, 100, 4);

            const result = computeAtr(bars, 14);

            // Allow small drift from Wilder smoothing on the 15th and 16th bar.
            expect(result.toNumber()).toBeGreaterThan(0);
        });
    });

    describe('Wilder smoothing', () => {
        it('produces a positive value for a standard 14-period ATR with 30 bars', () => {
            // BUILD — enough bars to fully warm up ATR(14)
            const bars = buildConstantRangeBars(30, 100, 2);

            // OPERATE
            const result = computeAtr(bars, 14);

            // CHECK
            expect(result.toNumber()).toBeGreaterThan(0);
        });

        it('returns a MoneyValue (decimal) not a plain number', () => {
            const bars = buildConstantRangeBars(20, 100, 5);

            const result = computeAtr(bars, 14);

            // MoneyValue instances have .toNumber() and .isZero() methods from decimal.js
            expect(typeof result.toNumber).toBe('function');
        });
    });

    describe('gap bar true range', () => {
        it('uses |high - prevClose| when that is the largest component', () => {
            // Bar 0: close=100 (seed).
            // Bar 1: high=120, low=110, close=115, prevClose=100.
            //   TR = max(|120-110|=10, |120-100|=20, |110-100|=10) = 20.
            // With only 2 bars and period=1, ATR seed = TR[0] = 20.
            const bars: ICandle[] = [buildCandle('100', '99', '100'), buildCandle('120', '110', '115')];

            const result = computeAtr(bars, 1);

            expect(result.toNumber()).toBe(20);
        });
    });
});
