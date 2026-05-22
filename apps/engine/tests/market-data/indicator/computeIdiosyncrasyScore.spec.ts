import { computeIdiosyncrasyScore } from '../../../src/market-data/indicator/computeIdiosyncrasyScore';
import { IDIOSYNCRASY_SCORE_MIN, IDIOSYNCRASY_SCORE_MAX } from '../../../src/market-data/const';

describe('computeIdiosyncrasyScore', () => {
    describe('zero coin move (degenerate denominator)', () => {
        it('returns the minimum score (0) when the coin has no move of its own', () => {
            // coin magnitude = 0 → cannot be idiosyncratic
            expect(computeIdiosyncrasyScore(1.0, 0)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });

        it('returns 0 even when btc also has zero move', () => {
            expect(computeIdiosyncrasyScore(0, 0)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });
    });

    describe('perfect BTC correlation', () => {
        it('returns a score near 0 when coin move equals BTC move in magnitude', () => {
            // raw = 1 - |2|/|2| = 0 → clamped to 0
            const result = computeIdiosyncrasyScore(2.0, 2.0);

            expect(result).toBe(0);
        });

        it('returns 0 when BTC move is larger than coin move', () => {
            // raw = 1 - |5|/|2| = -1.5 → clamped to 0
            const result = computeIdiosyncrasyScore(5.0, 2.0);

            expect(result).toBe(IDIOSYNCRASY_SCORE_MIN);
        });
    });

    describe('perfect idiosyncrasy', () => {
        it('returns 1 when BTC move is zero but coin moves', () => {
            // raw = 1 - 0/|3| = 1 → clamped to 1
            expect(computeIdiosyncrasyScore(0, 3.0)).toBe(IDIOSYNCRASY_SCORE_MAX);
        });
    });

    describe('typical intermediate values', () => {
        it('returns 0.5 when BTC move is half the coin move', () => {
            // raw = 1 - |1|/|2| = 0.5
            expect(computeIdiosyncrasyScore(1.0, 2.0)).toBe(0.5);
        });

        it('uses absolute values for both btc and coin moves', () => {
            // Negative BTC move and negative coin move: magnitudes are the same
            // raw = 1 - |-2|/|-4| = 1 - 0.5 = 0.5
            expect(computeIdiosyncrasyScore(-2.0, -4.0)).toBe(0.5);
        });

        it('handles mixed-sign inputs correctly', () => {
            // btc = +3, coin = -6 → 1 - 3/6 = 0.5
            expect(computeIdiosyncrasyScore(3.0, -6.0)).toBe(0.5);
        });
    });

    describe('clamp boundaries', () => {
        it('never returns a value below the minimum clamp (0)', () => {
            // raw would be very negative when btc >> coin
            const result = computeIdiosyncrasyScore(100.0, 0.001);

            expect(result).toBeGreaterThanOrEqual(IDIOSYNCRASY_SCORE_MIN);
        });

        it('never returns a value above the maximum clamp (1)', () => {
            // raw can only reach 1 when btc=0; clamping to max is always safe
            const result = computeIdiosyncrasyScore(0, 0.001);

            expect(result).toBeLessThanOrEqual(IDIOSYNCRASY_SCORE_MAX);
        });

        it('returns exactly 0 when raw is negative (below clamp floor)', () => {
            // raw = 1 - |10|/|2| = -4 → clamp → 0
            expect(computeIdiosyncrasyScore(10, 2)).toBe(0);
        });
    });

    describe('tiny denominator', () => {
        it('does not return NaN or Infinity for a very small coin move', () => {
            const result = computeIdiosyncrasyScore(0.00001, 0.000001);

            expect(Number.isFinite(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(IDIOSYNCRASY_SCORE_MIN);
            expect(result).toBeLessThanOrEqual(IDIOSYNCRASY_SCORE_MAX);
        });
    });
});
