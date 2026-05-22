import { computeAdx } from '../../../src/market-data/indicator/computeAdx';
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

// Generates a steadily trending-up sequence: each bar's high and low are
// incrementally higher than the previous, simulating a clean uptrend.
function buildUpTrend(count: number, startPrice: number, step: number): ICandle[] {
    return Array.from({ length: count }, (_, i) => {
        const base = startPrice + i * step;
        return buildCandle(String(base + step), String(base), String(base + step / 2));
    });
}

function buildDownTrend(count: number, startPrice: number, step: number): ICandle[] {
    return Array.from({ length: count }, (_, i) => {
        const base = startPrice - i * step;
        return buildCandle(String(base), String(base - step), String(base - step / 2));
    });
}

describe('computeAdx', () => {
    const PERIOD = 14;
    const WARM_UP = PERIOD * 2; // minimum bars needed to produce a non-zero ADX

    describe('insufficient data guards', () => {
        it('returns zeros for an empty bar array', () => {
            const result = computeAdx([], PERIOD);

            expect(result).toStrictEqual({ adx: 0, diPlus: 0, diMinus: 0 });
        });

        it('returns zeros when bar count is below period × 2', () => {
            const bars = buildUpTrend(PERIOD * 2 - 1, 100, 1);

            const result = computeAdx(bars, PERIOD);

            expect(result).toStrictEqual({ adx: 0, diPlus: 0, diMinus: 0 });
        });

        it('returns zeros when bar count equals period × 2 - 1 (one short)', () => {
            const bars = buildUpTrend(WARM_UP - 1, 100, 1);

            const result = computeAdx(bars, PERIOD);

            expect(result.adx).toBe(0);
        });
    });

    describe('trending market', () => {
        it('returns positive ADX for a consistent uptrend with enough bars', () => {
            const bars = buildUpTrend(40, 100, 2);

            const result = computeAdx(bars, PERIOD);

            expect(result.adx).toBeGreaterThan(0);
        });

        it('returns diPlus > diMinus in a clean uptrend', () => {
            const bars = buildUpTrend(40, 100, 2);

            const result = computeAdx(bars, PERIOD);

            expect(result.diPlus).toBeGreaterThan(result.diMinus);
        });

        it('returns diMinus > diPlus in a clean downtrend', () => {
            const bars = buildDownTrend(40, 200, 2);

            const result = computeAdx(bars, PERIOD);

            expect(result.diMinus).toBeGreaterThan(result.diPlus);
        });
    });

    describe('ADX bounds', () => {
        it('returns ADX in the 0–100 range for trend data', () => {
            const bars = buildUpTrend(40, 100, 2);

            const result = computeAdx(bars, PERIOD);

            expect(result.adx).toBeGreaterThanOrEqual(0);
            expect(result.adx).toBeLessThanOrEqual(100);
        });

        it('returns diPlus and diMinus in the 0–100 range', () => {
            const bars = buildUpTrend(40, 100, 2);

            const result = computeAdx(bars, PERIOD);

            expect(result.diPlus).toBeGreaterThanOrEqual(0);
            expect(result.diPlus).toBeLessThanOrEqual(100);
            expect(result.diMinus).toBeGreaterThanOrEqual(0);
            expect(result.diMinus).toBeLessThanOrEqual(100);
        });
    });

    describe('zero true range', () => {
        it('returns ADX of 0 when all bars are flat (no directional movement)', () => {
            // All bars at the same price → no true range, no DM → ADX = 0.
            const bars = Array.from({ length: 40 }, () => buildCandle('100', '100', '100'));

            const result = computeAdx(bars, PERIOD);

            expect(result.adx).toBe(0);
            expect(result.diPlus).toBe(0);
            expect(result.diMinus).toBe(0);
        });
    });
});
