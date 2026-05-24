import { RegimeLabelEnum } from '@bot/shared';

import { DomainException } from '../../common/exception';
import { BACKTEST_EXPECTED_SHORTFALL_PCT } from '../const/backtestConsts';
import { IRegimeBucket, IRegimeMetrics } from '../interface/IRegimeMetrics';
import { ITailRiskStats } from '../interface/ITailRiskStats';

// Raised at the pure-math boundary when the caller provides an empty series
// where a non-empty one is required. The math layer refuses to invent sentinel
// stats (NaN, zero, infinity) — those would propagate into the report and read
// as "we had data but it was zero". An explicit exception forces the caller
// (ComparisonStatsService in W5b) to short-circuit with `inconclusive`.
export class StatisticalPrimitiveException extends DomainException {
    constructor(message: string) {
        super('STATISTICAL_PRIMITIVE_INVALID', message);
    }
}

// Per-candidate tail-risk descriptors (ADR 0018 §2.6). Operates on the
// already-computed per-trade `r_t` series; arithmetic is `number` here since
// `r_t` is a dimensionless ratio that crossed the decimal boundary upstream.
//
// Empty input throws — see `StatisticalPrimitiveException`. A constant or
// degenerate series produces well-defined values (skew/kurtosis = 0 when the
// sample variance is zero, by definition of the moment-based estimators).
//
// Skew/kurtosis estimator note (R3-M5): we use **population (biased) moments**
// — denominator N for all central moments (including the variance in the
// denominator of skew = m3/m2^1.5 and excess kurtosis = m4/m2^2 - 3). The
// difference vs. the bias-corrected Fisher–Pearson estimator (denominators
// involving N-1, N(N-1)/((N-2)(N-3)) for skew, etc.) is sub-1% at N >= 200,
// the smallest sample the promotion gate accepts (`MIN_TOTAL_TRADES`). We
// chose the biased form for determinism on small samples and exact
// reproducibility of bootstrap inputs — the bias-corrected variants diverge
// for very small N in ways that complicate the unit tests' golden values
// without changing the gate's verdict.
export const computeTailRiskStats = (r: readonly number[]): ITailRiskStats => {
    if (r.length === 0) {
        throw new StatisticalPrimitiveException('computeTailRiskStats: r must be non-empty');
    }

    const mean = computeMean(r);
    const variance = computeCentralMoment(r, mean, 2);

    return {
        skew: variance > 0 ? computeCentralMoment(r, mean, 3) / Math.pow(variance, 1.5) : 0,
        kurtosis: variance > 0 ? computeCentralMoment(r, mean, 4) / (variance * variance) - 3 : 0,
        maxSingleLossR: computeMin(r),
        expectedShortfall5R: computeExpectedShortfall(r, BACKTEST_EXPECTED_SHORTFALL_PCT),
        longestLosingStreak: computeLongestLosingStreak(r),
    };
};

// Per-event input row. `regime` keys the bucket; `r` is the dimensionless
// expectancy-per-unit-risk value for that event under one candidate version.
// Skips/missed events arrive with `r === 0` — they count toward `tradeCount`
// but DO NOT count as wins.
export interface IRegimePerEventR {
    readonly regime: RegimeLabelEnum;
    readonly r: number;
}

// Per-regime breakdown for ONE candidate version (ADR 0017 §2.4). Buckets a
// version's per-event `r_t` by regime label and reports count + mean + win-rate
// + total per bucket. Returns an empty map for an empty input — the comparison
// driver treats "no events in any regime" as a legitimate (degenerate)
// candidate without throwing.
export const computeRegimeBreakdown = (perEventR: readonly IRegimePerEventR[]): IRegimeMetrics => {
    const accumulators = new Map<RegimeLabelEnum, { count: number; total: number; wins: number }>();

    for (const row of perEventR) {
        const acc = accumulators.get(row.regime) ?? { count: 0, total: 0, wins: 0 };
        acc.count += 1;
        acc.total += row.r;

        if (row.r > 0) {
            acc.wins += 1;
        }

        accumulators.set(row.regime, acc);
    }

    const buckets = new Map<RegimeLabelEnum, IRegimeBucket>();

    for (const [regime, acc] of accumulators) {
        buckets.set(regime, {
            tradeCount: acc.count,
            meanR: acc.count > 0 ? acc.total / acc.count : 0,
            winRate: acc.count > 0 ? acc.wins / acc.count : 0,
            totalR: acc.total,
        });
    }

    return { buckets };
};

const computeMean = (xs: readonly number[]): number => {
    let sum = 0;

    for (let i = 0; i < xs.length; i += 1) {
        sum += xs[i];
    }

    return sum / xs.length;
};

// k-th central moment: (1/N) * Σ (x_i - μ)^k. k=2 is variance, k=3/k=4 feed
// the moment-based skew/kurtosis estimators.
const computeCentralMoment = (xs: readonly number[], mean: number, k: number): number => {
    let sum = 0;

    for (let i = 0; i < xs.length; i += 1) {
        sum += Math.pow(xs[i] - mean, k);
    }

    return sum / xs.length;
};

const computeMin = (xs: readonly number[]): number => {
    let min = xs[0];

    for (let i = 1; i < xs.length; i += 1) {
        if (xs[i] < min) {
            min = xs[i];
        }
    }

    return min;
};

// Mean of the worst `pct` fraction of `xs`. Sorts a copy ascending and averages
// the first `max(1, floor(N * pct))` entries — the `max(1, _)` floor matters on
// small samples where `floor(N * 0.05) === 0` would otherwise collapse the
// stat to NaN.
const computeExpectedShortfall = (xs: readonly number[], pct: number): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const tailCount = Math.max(1, Math.floor(sorted.length * pct));
    let sum = 0;

    for (let i = 0; i < tailCount; i += 1) {
        sum += sorted[i];
    }

    return sum / tailCount;
};

// Longest run of consecutive `r < 0`. Skips (`r === 0`) and wins (`r > 0`)
// both reset the running streak — see ADR 0018 §2.6 "zeros break the streak".
const computeLongestLosingStreak = (xs: readonly number[]): number => {
    let longest = 0;
    let current = 0;

    for (let i = 0; i < xs.length; i += 1) {
        if (xs[i] < 0) {
            current += 1;

            if (current > longest) {
                longest = current;
            }
        } else {
            current = 0;
        }
    }

    return longest;
};
