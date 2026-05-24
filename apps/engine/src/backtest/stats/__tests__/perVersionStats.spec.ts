import { RegimeLabelEnum } from '@bot/shared';

import { computeRegimeBreakdown, computeTailRiskStats, StatisticalPrimitiveException } from '../perVersionStats';

describe('computeTailRiskStats', () => {
    it('computes a hand-checked fixture correctly', () => {
        // Series: 2 wins, 1 skip, 3 losses (one severe).
        const r = [0.5, -0.2, 0, -1.5, 0.8, -0.3];

        const stats = computeTailRiskStats(r);

        expect(stats.maxSingleLossR).toBe(-1.5);
        expect(stats.longestLosingStreak).toBe(1); // [-0.2] then [0] breaks; [-1.5] alone; [-0.3] alone
        // worst 5% with N=6 → tailCount = max(1, floor(0.3)) = 1 → just the min
        expect(stats.expectedShortfall5R).toBeCloseTo(-1.5, 12);
    });

    it('counts the longest losing streak correctly when zeros (skips) break the streak', () => {
        const r = [-0.1, -0.2, 0, -0.3, -0.4, -0.5, 0.1, -0.6, -0.7];

        // Streaks: [-0.1, -0.2] (2), broken by 0, [-0.3, -0.4, -0.5] (3),
        // broken by win, [-0.6, -0.7] (2). Longest = 3.
        expect(computeTailRiskStats(r).longestLosingStreak).toBe(3);
    });

    it('reports zero skew/kurtosis on a constant series (zero-variance defence)', () => {
        const stats = computeTailRiskStats([0.2, 0.2, 0.2, 0.2, 0.2]);

        expect(stats.skew).toBe(0);
        expect(stats.kurtosis).toBe(0);
    });

    it('reports a non-negative max loss when no event lost', () => {
        const stats = computeTailRiskStats([0.1, 0.2, 0, 0.3]);

        expect(stats.maxSingleLossR).toBe(0);
        expect(stats.longestLosingStreak).toBe(0);
    });

    it('handles a single-element series without crashing', () => {
        const stats = computeTailRiskStats([-0.4]);

        expect(stats.maxSingleLossR).toBe(-0.4);
        expect(stats.expectedShortfall5R).toBe(-0.4);
        expect(stats.longestLosingStreak).toBe(1);
        expect(stats.skew).toBe(0);
        expect(stats.kurtosis).toBe(0);
    });

    it('throws StatisticalPrimitiveException on empty input', () => {
        expect(() => computeTailRiskStats([])).toThrow(StatisticalPrimitiveException);
    });

    it('produces excess kurtosis (≈ 0 on a normal-ish sample)', () => {
        // Symmetric uniform sample has excess kurtosis around -1.2; what matters
        // is the SIGN of the subtraction — verify the function subtracts 3.
        const r: number[] = [];

        for (let i = -50; i <= 50; i += 1) {
            r.push(i / 100);
        }

        expect(computeTailRiskStats(r).kurtosis).toBeLessThan(0);
    });
});

describe('computeRegimeBreakdown', () => {
    it('buckets events by regime and computes count/mean/winRate/total per bucket', () => {
        const rows = [
            { regime: RegimeLabelEnum.RANGING, r: 0.5 },
            { regime: RegimeLabelEnum.RANGING, r: -0.2 },
            { regime: RegimeLabelEnum.RANGING, r: 0 },
            { regime: RegimeLabelEnum.TRENDING_UP, r: 1.0 },
            { regime: RegimeLabelEnum.TRENDING_UP, r: 0.5 },
            { regime: RegimeLabelEnum.TRENDING_DOWN, r: -0.8 },
        ];

        const breakdown = computeRegimeBreakdown(rows);

        const ranging = breakdown.buckets.get(RegimeLabelEnum.RANGING);
        expect(ranging).toBeDefined();
        expect(ranging?.tradeCount).toBe(3);
        expect(ranging?.totalR).toBeCloseTo(0.3, 12);
        expect(ranging?.meanR).toBeCloseTo(0.1, 12);
        expect(ranging?.winRate).toBeCloseTo(1 / 3, 12);

        const up = breakdown.buckets.get(RegimeLabelEnum.TRENDING_UP);
        expect(up?.tradeCount).toBe(2);
        expect(up?.winRate).toBe(1);
        expect(up?.totalR).toBeCloseTo(1.5, 12);

        const down = breakdown.buckets.get(RegimeLabelEnum.TRENDING_DOWN);
        expect(down?.tradeCount).toBe(1);
        expect(down?.winRate).toBe(0);
        expect(down?.totalR).toBeCloseTo(-0.8, 12);
    });

    it('returns an empty map for empty input (degenerate candidate)', () => {
        const breakdown = computeRegimeBreakdown([]);

        expect(breakdown.buckets.size).toBe(0);
    });

    it('omits labels that have no events (caller distinguishes "no events" from "zero mean")', () => {
        const breakdown = computeRegimeBreakdown([{ regime: RegimeLabelEnum.RANGING, r: 0.1 }]);

        expect(breakdown.buckets.has(RegimeLabelEnum.TRENDING_UP)).toBe(false);
        expect(breakdown.buckets.has(RegimeLabelEnum.TRENDING_DOWN)).toBe(false);
        expect(breakdown.buckets.has(RegimeLabelEnum.TRANSITIONING)).toBe(false);
    });

    it('does not count skips (r === 0) as wins', () => {
        const breakdown = computeRegimeBreakdown([
            { regime: RegimeLabelEnum.RANGING, r: 0 },
            { regime: RegimeLabelEnum.RANGING, r: 0 },
            { regime: RegimeLabelEnum.RANGING, r: 0 },
        ]);

        const bucket = breakdown.buckets.get(RegimeLabelEnum.RANGING);
        expect(bucket?.winRate).toBe(0);
        expect(bucket?.tradeCount).toBe(3);
    });
});
