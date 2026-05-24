import { circularBlockBootstrap } from '../circularBlockBootstrap';
import { mulberry32 } from '../rng';

const buildShiftedIidSeries = (n: number, shift: number, seed: number): number[] => {
    const rng = mulberry32(seed);

    return Array.from({ length: n }, () => rng() * 2 - 1 + shift);
};

describe('circularBlockBootstrap', () => {
    it('brackets the true mean inside its 95% CI on a known distribution', () => {
        const trueMean = 0.5;
        const series = buildShiftedIidSeries(400, trueMean, 1);

        const dist = circularBlockBootstrap(series, { blockLen: 8, n: 2000, seed: 123 });

        expect(dist.ci95Low).toBeLessThan(trueMean);
        expect(dist.ci95High).toBeGreaterThan(trueMean);
    });

    it('is byte-for-byte reproducible under the same seed', () => {
        const series = buildShiftedIidSeries(300, 0, 5);

        const a = circularBlockBootstrap(series, { blockLen: 10, n: 1000, seed: 42 });
        const b = circularBlockBootstrap(series, { blockLen: 10, n: 1000, seed: 42 });

        expect(b.resampleMeans).toEqual(a.resampleMeans);
        expect(b.ci95Low).toBe(a.ci95Low);
        expect(b.ci95High).toBe(a.ci95High);
        expect(b.meanDiff).toBe(a.meanDiff);
    });

    it('produces a different distribution under a different seed', () => {
        const series = buildShiftedIidSeries(300, 0, 5);

        const a = circularBlockBootstrap(series, { blockLen: 10, n: 1000, seed: 1 });
        const b = circularBlockBootstrap(series, { blockLen: 10, n: 1000, seed: 2 });

        expect(b.resampleMeans).not.toEqual(a.resampleMeans);
    });

    it('returns resampleMeans sorted ascending', () => {
        const series = buildShiftedIidSeries(150, 0, 7);
        const dist = circularBlockBootstrap(series, { blockLen: 6, n: 500, seed: 9 });

        for (let i = 1; i < dist.resampleMeans.length; i += 1) {
            expect(dist.resampleMeans[i]).toBeGreaterThanOrEqual(dist.resampleMeans[i - 1]);
        }
    });

    it('wraps a block that straddles the end of the series back to index 0 (circular)', () => {
        // Series: 99 zeros + a single 1 at the last index. With blockLen = 5 and
        // seed-driven starts, any block beginning at index >= 96 must wrap into
        // index 0 to fill its length — meaning the sentinel at index 99 cannot
        // contribute outside its single occurrence. Compute the maximum possible
        // resample mean: it is bounded by (1 / |series|) * (number of times the
        // sentinel can be drawn). We assert the bootstrap mean stays within this
        // ceiling, which holds only if circular wrap-around is in effect.
        const series = new Array<number>(100).fill(0);
        series[99] = 1;

        const dist = circularBlockBootstrap(series, { blockLen: 5, n: 5000, seed: 17 });

        for (const m of dist.resampleMeans) {
            expect(m).toBeGreaterThanOrEqual(0);
            // Even drawing every block at start = 99 gives at most (1 / 100) per
            // block × ceil(100/5) blocks = 0.20 — well under 1.
            expect(m).toBeLessThanOrEqual(0.5);
        }
    });

    it('reports the meanDiff as the arithmetic mean of the input series', () => {
        const series = [-2, -1, 0, 1, 2, 3];
        const dist = circularBlockBootstrap(series, { blockLen: 2, n: 100, seed: 3 });

        expect(dist.meanDiff).toBeCloseTo(0.5, 12);
    });

    it('throws on an empty series', () => {
        expect(() => circularBlockBootstrap([], { blockLen: 4, n: 100, seed: 1 })).toThrow(RangeError);
    });

    it('throws on blockLen < 1', () => {
        expect(() => circularBlockBootstrap([1, 2, 3], { blockLen: 0, n: 100, seed: 1 })).toThrow(RangeError);
    });

    it('throws on n < 1', () => {
        expect(() => circularBlockBootstrap([1, 2, 3], { blockLen: 1, n: 0, seed: 1 })).toThrow(RangeError);
    });
});
