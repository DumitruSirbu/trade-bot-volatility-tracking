import { computeVwap } from '../../../src/market-data/indicator/computeVwap';
import { ICandle } from '../../../src/market-data/interface/ICandle';
import { Money } from '../../../src/common/utils/money';

function m(value: string | number) {
    return new Money(String(value));
}

// Factory: a simple candle where high = low = close = open for easy hand-verification.
function buildFlatCandle(price: string, volume: string, openTimeMs = 0): ICandle {
    const p = m(price);
    const v = m(volume);

    return {
        openTimeMs,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: v,
        quoteVolume: p.times(v),
        isClosed: true,
    };
}

// Factory: full OHLCV candle.
function buildCandle(open: string, high: string, low: string, close: string, volume: string, openTimeMs = 0): ICandle {
    return {
        openTimeMs,
        open: m(open),
        high: m(high),
        low: m(low),
        close: m(close),
        volume: m(volume),
        quoteVolume: m(close).times(m(volume)),
        isClosed: true,
    };
}

describe('computeVwap', () => {
    describe('zero-volume degenerate case', () => {
        it('returns the close of the last bar when total volume is zero', () => {
            // BUILD — two bars with zero volume
            const bars: ICandle[] = [buildFlatCandle('100', '0'), buildFlatCandle('200', '0')];

            // OPERATE
            const result = computeVwap(bars);

            // CHECK — returns last bar close (the implementation's zero-division guard)
            expect(result.toNumber()).toBe(200);
        });
    });

    describe('single bar', () => {
        it('returns the typical price of that bar when there is exactly one bar', () => {
            // BUILD — high=110, low=90, close=100 → typical=(110+90+100)/3 = 100
            const bars: ICandle[] = [buildCandle('100', '110', '90', '100', '10')];

            // OPERATE
            const result = computeVwap(bars);

            // CHECK
            expect(result.toNumber()).toBe(100);
        });
    });

    describe('uniform prices', () => {
        it('equals the common price when all bars have the same typical price', () => {
            // BUILD — all flat at 50; VWAP = Σ(50×vol) / Σ(vol) = 50
            const bars: ICandle[] = [buildFlatCandle('50', '10'), buildFlatCandle('50', '20'), buildFlatCandle('50', '5')];

            // OPERATE
            const result = computeVwap(bars);

            // CHECK
            expect(result.toNumber()).toBe(50);
        });
    });

    describe('weighted average correctness', () => {
        it('weights higher-volume bars more heavily (hand-computed fixture)', () => {
            // BUILD
            // Bar A: high=100, low=100, close=100 → typical=100, vol=1 → weighted=100
            // Bar B: high=200, low=200, close=200 → typical=200, vol=3 → weighted=600
            // VWAP = (100 + 600) / (1 + 3) = 700 / 4 = 175
            const bars: ICandle[] = [buildFlatCandle('100', '1'), buildFlatCandle('200', '3')];

            // OPERATE
            const result = computeVwap(bars);

            // CHECK
            expect(result.toNumber()).toBe(175);
        });

        it('computes typical price correctly from non-uniform OHLC bars', () => {
            // BUILD
            // Bar: high=120, low=80, close=100 → typical=(120+80+100)/3 ≈ 100, vol=10
            // Flat bar at 100, vol=10 → typical=100
            // VWAP = (100×10 + 100×10) / 20 = 100
            const bars: ICandle[] = [buildCandle('100', '120', '80', '100', '10'), buildFlatCandle('100', '10')];

            // OPERATE
            const result = computeVwap(bars);

            // CHECK
            expect(result.toNumber()).toBe(100);
        });

        it('does not use float arithmetic — result is exact for decimal inputs', () => {
            // BUILD — values that would produce float drift in native JS
            const bars: ICandle[] = [buildFlatCandle('0.1', '3'), buildFlatCandle('0.2', '3')];
            // VWAP = (0.1×3 + 0.2×3) / 6 = 0.9 / 6 = 0.15

            // OPERATE
            const result = computeVwap(bars);

            // CHECK
            expect(result.toString()).toBe('0.15');
        });
    });

    describe('window size boundary', () => {
        it('processes exactly two bars correctly', () => {
            const bars: ICandle[] = [buildFlatCandle('90', '2'), buildFlatCandle('110', '2')];
            // VWAP = (90×2 + 110×2) / 4 = 400/4 = 100

            const result = computeVwap(bars);

            expect(result.toNumber()).toBe(100);
        });
    });
});
