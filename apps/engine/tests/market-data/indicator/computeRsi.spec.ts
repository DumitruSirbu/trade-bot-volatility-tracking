import { computeRsi } from '../../../src/market-data/indicator/computeRsi';
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

// Builds a bar sequence from an array of close prices.
function barsFromCloses(closes: number[]): ICandle[] {
    return closes.map((c) => buildFlatCandle(String(c)));
}

describe('computeRsi', () => {
    describe('insufficient data guards', () => {
        it('returns 50 (neutral) for an empty bar array', () => {
            expect(computeRsi([], 14)).toBe(50);
        });

        it('returns 50 (neutral) when bars.length equals the period (needs strictly more)', () => {
            const bars = barsFromCloses(Array.from({ length: 14 }, (_, i) => 100 + i));

            expect(computeRsi(bars, 14)).toBe(50);
        });
    });

    describe('all gains (no losses)', () => {
        it('returns 100 when every bar is an up-move (no average loss)', () => {
            // 15 strictly rising bars
            const bars = barsFromCloses(Array.from({ length: 15 }, (_, i) => 100 + i));

            const result = computeRsi(bars, 14);

            expect(result).toBe(100);
        });
    });

    describe('all losses (no gains)', () => {
        it('returns a value below 50 when every bar moves down', () => {
            // 15 strictly falling bars
            const bars = barsFromCloses(Array.from({ length: 15 }, (_, i) => 200 - i));

            const result = computeRsi(bars, 14);

            // avg gain = 0 → RS = 0 → RSI = 100 - 100/(1+0) = 0
            expect(result).toBe(0);
        });
    });

    describe('boundary', () => {
        it('returns exactly period + 1 bars minimum to produce a non-neutral value', () => {
            // 14 + 1 = 15 bars; all gaining
            const bars = barsFromCloses(Array.from({ length: 15 }, (_, i) => 100 + i));

            const result = computeRsi(bars, 14);

            expect(result).not.toBe(50);
        });
    });

    describe('RSI bounds', () => {
        it('always returns a value in the 0–100 range', () => {
            const bars = barsFromCloses([100, 102, 101, 103, 100, 99, 104, 105, 103, 102, 101, 99, 100, 101, 102]);

            const result = computeRsi(bars, 14);

            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(100);
        });
    });

    describe('alternating moves', () => {
        it('returns a value between 40 and 60 for alternating up/down moves of equal size', () => {
            // Wilder smoothing means the seed period's gain/loss averages have a fixed
            // ratio from the first 14 changes, and subsequent alternations converge slowly.
            // The result is near 50 but not precisely equal due to the smoothing lag.
            const closes: number[] = [100];

            for (let i = 0; i < 20; i++) {
                closes.push(i % 2 === 0 ? closes[i] + 2 : closes[i] - 2);
            }

            const bars = barsFromCloses(closes);
            const result = computeRsi(bars, 14);

            expect(result).toBeGreaterThan(40);
            expect(result).toBeLessThan(60);
        });
    });
});
