import { computeIdiosyncrasyScore } from '../../../src/market-data/indicator/computeIdiosyncrasyScore';
import { IDIOSYNCRASY_MIN_COIN_MOVE_PCT, IDIOSYNCRASY_SCORE_MAX, IDIOSYNCRASY_SCORE_MIN } from '../../../src/market-data/const';

// Pre-D4 reference formula (no noise floor) — the byte-identical baseline the
// hardened function must reproduce for every real trigger-magnitude input. Used
// only by the D4 inertness regression below.
function computeIdiosyncrasyScorePreFloor(btc5mMovePct: number, coin5mMovePct: number): number {
    const coinMagnitude = Math.abs(coin5mMovePct);

    if (coinMagnitude === 0) {
        return IDIOSYNCRASY_SCORE_MIN;
    }

    const raw = 1 - Math.abs(btc5mMovePct) / coinMagnitude;

    return Math.min(IDIOSYNCRASY_SCORE_MAX, Math.max(IDIOSYNCRASY_SCORE_MIN, raw));
}

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

    describe('D4 noise floor (minimum-coin-move guard, M30)', () => {
        it('floors a sub-noise coin move that would otherwise score above the gate', () => {
            // coin 0.02% / btc 0.005% → pre-floor raw = 1 − 0.005/0.02 = 0.75
            // (passes the 0.5 idiosyncratic gate on pure microstructure noise).
            // The noise floor turns this false eligibility into a reject (0).
            expect(computeIdiosyncrasyScorePreFloor(0.005, 0.02)).toBeCloseTo(0.75, 10);
            expect(computeIdiosyncrasyScore(0.005, 0.02)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });

        it('floors regardless of coin-move sign (uses the magnitude)', () => {
            expect(computeIdiosyncrasyScore(0.005, -0.02)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });

        it('does NOT floor a coin move exactly at the threshold (strict < guard)', () => {
            // At exactly the floor the guard does not bite: raw is returned.
            // coin = 0.05% / btc = 0.01% → raw = 1 − 0.01/0.05 = 0.8
            const result = computeIdiosyncrasyScore(0.01, IDIOSYNCRASY_MIN_COIN_MOVE_PCT);

            expect(result).toBeCloseTo(0.8, 10);
            expect(result).toBeGreaterThan(IDIOSYNCRASY_SCORE_MIN);
        });

        it('floors a coin move a hair below the threshold', () => {
            const justBelow = IDIOSYNCRASY_MIN_COIN_MOVE_PCT - 1e-9;

            expect(computeIdiosyncrasyScore(0.01, justBelow)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });

        it('still returns 0 for the exact-zero coin-move guard (regression)', () => {
            expect(computeIdiosyncrasyScore(1.0, 0)).toBe(IDIOSYNCRASY_SCORE_MIN);
        });

        it('still returns 1.0 for an exact-zero BTC move with a real coin move (boundary unchanged)', () => {
            expect(computeIdiosyncrasyScore(0, 3.0)).toBe(IDIOSYNCRASY_SCORE_MAX);
        });

        it('is deterministic — identical inputs yield identical scores with no float drift', () => {
            const first = computeIdiosyncrasyScore(0.7, 1.9);
            const second = computeIdiosyncrasyScore(0.7, 1.9);

            expect(first).toBe(second);
        });
    });

    describe('D4 inertness regression — byte-identical for every real trigger magnitude (M30)', () => {
        // The strategy requires tier{1,2,3}_min_abs_move_pct = 0.8 / 1.2 / 1.5%
        // for a coin to even register a trigger. The 0.05% floor is 16× below the
        // tightest (0.8%), so it MUST be inert for every real input. These fixtures
        // sweep trigger-and-above coin magnitudes (both signs) against a range of
        // BTC moves and assert the hardened score equals the pre-floor reference.
        const triggerCoinMoves = [0.8, 1.2, 1.5, 2.0, 5.0, 10.0, -0.8, -1.2, -1.5, -3.0, -8.0];
        const btcMoves = [0, 0.1, 0.4, 0.8, 1.5, 3.0, -0.4, -1.5, -6.0];

        for (const coin of triggerCoinMoves) {
            for (const btc of btcMoves) {
                it(`is byte-identical to the pre-floor formula at coin=${coin}%, btc=${btc}%`, () => {
                    expect(computeIdiosyncrasyScore(btc, coin)).toBe(computeIdiosyncrasyScorePreFloor(btc, coin));
                });
            }
        }
    });
});
