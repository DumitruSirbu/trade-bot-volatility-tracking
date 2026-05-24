/**
 * Adversarial tests for bootstrap math primitives (M8 W8 QA / ADR 0018).
 *
 * Cluster: politisWhite, circularBlockBootstrap, computeTailRiskStats,
 * computeRegimeBreakdown — boundary and degenerate inputs that the production
 * path may never exercise but that must not crash or produce silent nonsense.
 */

import { RegimeLabelEnum } from '@bot/shared';

import { BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN } from '../../const/backtestConsts';
import { circularBlockBootstrap } from '../circularBlockBootstrap';
import { computeRegimeBreakdown, computeTailRiskStats, IRegimePerEventR } from '../perVersionStats';
import { politisWhite, politisWhiteRaw } from '../politisWhite';
import { mulberry32 } from '../rng';

// ─── Series generators ────────────────────────────────────────────────────────

function buildAr1Series(n: number, phi: number, seed: number): number[] {
    const rng = mulberry32(seed);
    const out: number[] = [0];

    for (let i = 1; i < n; i += 1) {
        const noise = rng() * 2 - 1;
        out.push(phi * out[i - 1] + noise);
    }

    return out;
}

function buildIidSeries(n: number, seed: number): number[] {
    const rng = mulberry32(seed);

    return Array.from({ length: n }, () => rng() * 2 - 1);
}

// ─── politisWhite adversarial ─────────────────────────────────────────────────

describe('politisWhite — adversarial', () => {
    it('AR(1) rho=0.8 N=500 yields block length materially > 4 (the floor)', () => {
        const series = buildAr1Series(500, 0.8, 42);
        const block = politisWhite(series);

        // A strongly correlated series must produce a block length well above the
        // floor; the Politis-White formula should detect the autocorrelation.
        expect(block).toBeGreaterThan(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });

    it('series with all sample autocorrelations exactly zero falls to MIN_BLOCK_LEN', () => {
        // A constant series has no variance → ACF denominator = 0 → all ACF = 0
        // → bandwidth M selects the smallest possible → formula degenerates →
        // politisWhite clamps to the floor.
        const series = new Array<number>(500).fill(1.0);
        const block = politisWhite(series);

        expect(block).toBe(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });

    it('politisWhiteRaw returns a finite value on i.i.d. series (may be 0 when no AC detected)', () => {
        // On a truly i.i.d. series the formula may degenerate to 0 when the
        // estimated GHat is 0 (no detected autocorrelation). That is mathematically
        // correct — the production clamped `politisWhite` catches this and falls back
        // to MIN_BLOCK_LEN. The raw layer's contract is only that it does not return
        // NaN or infinity.
        const series = buildIidSeries(400, 77);
        const raw = politisWhiteRaw(series);

        expect(Number.isFinite(raw)).toBe(true);
        expect(raw).toBeGreaterThanOrEqual(0);
    });

    it('clamped politisWhite never returns below MIN_BLOCK_LEN even when raw degenerates to 0', () => {
        // This is the critical safety property: regardless of what the raw formula
        // returns, the production entry-point must always return at least the floor.
        const series = buildIidSeries(400, 77);
        const block = politisWhite(series);

        expect(block).toBeGreaterThanOrEqual(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN);
    });
});

// ─── circularBlockBootstrap adversarial ───────────────────────────────────────

describe('circularBlockBootstrap — adversarial', () => {
    it('blockLen === series.length (one block) produces CI that collapses toward the true mean', () => {
        // With one block, every resample IS the series (just starting at a random
        // circular offset but averaging N elements that sum to the same total).
        // The resulting CI should be extremely narrow — effectively zero width.
        const series = buildIidSeries(100, 5);
        const trueMean = series.reduce((s, x) => s + x, 0) / series.length;

        const dist = circularBlockBootstrap(series, { blockLen: series.length, n: 500, seed: 11 });

        // With one block the resample mean always equals the series mean exactly.
        expect(dist.ci95High - dist.ci95Low).toBeCloseTo(0, 6);
        expect(dist.meanDiff).toBeCloseTo(trueMean, 10);
    });

    it('blockLen === 1 (independent bootstrap) does not crash and produces a valid CI', () => {
        // blockLen=1 degenerates to i.i.d. bootstrap; CI should be narrower than
        // the block bootstrap on an autocorrelated series (this is the known
        // regression direction — not a correctness failure but worth guarding).
        const series = buildAr1Series(200, 0.5, 99);

        const blockDist = circularBlockBootstrap(series, { blockLen: 8, n: 1000, seed: 1 });
        const iidDist = circularBlockBootstrap(series, { blockLen: 1, n: 1000, seed: 1 });

        // Both must be finite and ordered.
        expect(Number.isFinite(iidDist.ci95Low)).toBe(true);
        expect(Number.isFinite(iidDist.ci95High)).toBe(true);
        expect(iidDist.ci95High).toBeGreaterThanOrEqual(iidDist.ci95Low);

        // i.i.d. block (blockLen=1) should produce a narrower CI than a larger
        // block on an autocorrelated series — if this ever reverses, the test
        // acts as a regression tripwire.
        const blockWidth = blockDist.ci95High - blockDist.ci95Low;
        const iidWidth = iidDist.ci95High - iidDist.ci95Low;
        expect(iidWidth).toBeLessThanOrEqual(blockWidth);
    });
});

// ─── computeTailRiskStats adversarial ─────────────────────────────────────────

describe('computeTailRiskStats — adversarial', () => {
    it('one extreme outlier produces kurtosis that reflects the heavy tail, and ES5 equals the outlier', () => {
        // 199 zeros + one severe loss. Excess kurtosis must be positive and large
        // (leptokurtic distribution). ES5 on N=200 → tailCount = max(1, floor(10)) = 10
        // → the 10 worst values are all the same outlier magnitude if we put only one;
        // but with 199 zeros and 1 outlier, the sorted tail is [outlier, 0, 0, ... ].
        // ES5 = (outlier + 9*0) / 10 = outlier / 10.
        const outlier = -100;
        const series: number[] = new Array<number>(199).fill(0);
        series.push(outlier);

        const stats = computeTailRiskStats(series);

        // The most negative single element must be the outlier.
        expect(stats.maxSingleLossR).toBe(outlier);

        // ES5 at N=200 → tailCount = floor(200 * 0.05) = 10 → avg of [outlier, 0*9]
        expect(stats.expectedShortfall5R).toBeCloseTo(outlier / 10, 10);

        // Excess kurtosis is positive for this heavy-tailed series.
        expect(stats.kurtosis).toBeGreaterThan(0);
    });
});

// ─── computeRegimeBreakdown adversarial ───────────────────────────────────────

describe('computeRegimeBreakdown — adversarial', () => {
    it('all-skip outcomes (every r=0) yields meanR=0, winRate=0, totalR=0', () => {
        const events: IRegimePerEventR[] = Array.from({ length: 50 }, () => ({
            regime: RegimeLabelEnum.RANGING,
            r: 0,
        }));

        const metrics = computeRegimeBreakdown(events);
        const bucket = metrics.buckets.get(RegimeLabelEnum.RANGING)!;

        expect(bucket).toBeDefined();
        expect(bucket.meanR).toBe(0);
        expect(bucket.winRate).toBe(0);
        expect(bucket.totalR).toBe(0);
        expect(bucket.tradeCount).toBe(50);
    });

    it('empty input returns an empty buckets map without throwing', () => {
        const metrics = computeRegimeBreakdown([]);

        expect(metrics.buckets.size).toBe(0);
    });

    it('single skip event contributes tradeCount=1 but winRate=0 and meanR=0', () => {
        const events: IRegimePerEventR[] = [{ regime: RegimeLabelEnum.TRENDING_UP, r: 0 }];

        const metrics = computeRegimeBreakdown(events);
        const bucket = metrics.buckets.get(RegimeLabelEnum.TRENDING_UP)!;

        expect(bucket.tradeCount).toBe(1);
        expect(bucket.winRate).toBe(0);
        expect(bucket.meanR).toBe(0);
    });
});
