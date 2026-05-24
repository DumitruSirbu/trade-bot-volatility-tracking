import { BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN } from '../../const/backtestConsts';
import { mulberry32 } from '../rng';
import { politisWhite, politisWhiteRaw } from '../politisWhite';

const buildIidSeries = (n: number, seed: number): number[] => {
    const rng = mulberry32(seed);

    return Array.from({ length: n }, () => rng() * 2 - 1);
};

// AR(1) with coefficient `phi`. Theoretical autocorrelation is phi^k, so
// strongly autocorrelated series should pick a larger block.
const buildAr1Series = (n: number, phi: number, seed: number): number[] => {
    const rng = mulberry32(seed);
    const out: number[] = [0];

    for (let i = 1; i < n; i += 1) {
        const noise = rng() * 2 - 1;
        out.push(phi * out[i - 1] + noise);
    }

    return out;
};

describe('politisWhite', () => {
    it('is deterministic — same input series returns the same block length', () => {
        const series = buildAr1Series(400, 0.6, 1);

        expect(politisWhite(series)).toBe(politisWhite(series));
    });

    it('picks a larger block for a strongly autocorrelated AR(1) than for an i.i.d. series', () => {
        const ar1 = buildAr1Series(800, 0.8, 11);
        const iid = buildIidSeries(800, 11);

        const ar1Block = politisWhite(ar1);
        const iidBlock = politisWhite(iid);

        expect(ar1Block).toBeGreaterThan(iidBlock);
    });

    it('returns a block within the [4, floor(N/5)] envelope for a real-sized series', () => {
        const series = buildAr1Series(500, 0.5, 2);
        const block = politisWhite(series);

        expect(block).toBeGreaterThanOrEqual(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
        expect(block).toBeLessThanOrEqual(Math.floor(series.length / 5));
    });

    it('falls back to the floor on a very short series', () => {
        expect(politisWhite([0.1, -0.2, 0.05])).toBeLessThanOrEqual(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });

    it('falls back to the floor on an all-zero series (zero-variance defence)', () => {
        const series = new Array(300).fill(0);

        expect(politisWhite(series)).toBe(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });

    it('falls back to the floor on a constant series (zero-variance defence)', () => {
        const series = new Array(300).fill(0.7);

        expect(politisWhite(series)).toBe(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });

    // R1-quant M5: long-memory series should pick a materially larger block now
    // that computeAutocorrelations extends to 2·K_N (the window no longer reads
    // zeros past K_N, so G_hat is not biased downward on persistent processes).
    it('R1-M5: picks a materially larger block on a long-memory AR(1) (rho=0.9) than the floor', () => {
        const series = buildAr1Series(800, 0.9, 23);

        const block = politisWhite(series);

        expect(block).toBeGreaterThan(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN + 4);
    });

    it('returns a non-negative finite raw estimate on an i.i.d. series', () => {
        const series = buildIidSeries(400, 9);
        const raw = politisWhiteRaw(series);

        expect(Number.isFinite(raw)).toBe(true);
        expect(raw).toBeGreaterThanOrEqual(0);
    });
});
