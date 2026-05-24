import { BACKTEST_BOOTSTRAP_CI_HIGH_QUANTILE, BACKTEST_BOOTSTRAP_CI_LOW_QUANTILE } from '../const/backtestConsts';
import { IBootstrapDistribution } from '../interface/IBootstrapDistribution';

import { mulberry32 } from './rng';

// Inputs to a single circular block bootstrap pass. `n` is the resample count
// (fixed at 10000 in production by ADR 0018 §2.4, but parameterised here so
// tests can run cheaper smoke checks). `seed` is the deterministic input that
// keys the PRNG — callers derive it from `fnv1a32(run_label || pair_id)`.
export interface ICircularBlockBootstrapOptions {
    readonly blockLen: number;
    readonly n: number;
    readonly seed: number;
}

// Circular block bootstrap (Politis & Romano 1992) on the paired difference
// series (ADR 0018 §2.4). For each of `n` resamples, draws ⌈N/blockLen⌉ blocks
// at random circular start positions, concatenates, trims to original length,
// and records the mean. Indices wrap around the array end — that wrap is the
// "circular" part: a block whose start sits near `series.length - 1` keeps
// pulling values from index 0 instead of running off the end.
//
// Determinism: a fixed seed produces an identical `resampleMeans` array
// byte-for-byte, and the CI endpoints are index-based on the sorted array (no
// interpolation), so reports reproduce byte-for-byte under the same `run_label`.
//
// Guards:
//   - empty series → throws (caller must pre-validate; the bootstrap is the
//     wrong layer to invent a sentinel mean).
//   - `blockLen < 1` or `n < 1` → throws; both would silently corrupt downstream
//     CI math.
export const circularBlockBootstrap = (series: readonly number[], opts: ICircularBlockBootstrapOptions): IBootstrapDistribution => {
    assertValidInputs(series, opts);

    const seriesLen = series.length;
    const { blockLen, n, seed } = opts;
    const blocksPerResample = Math.ceil(seriesLen / blockLen);
    const rng = mulberry32(seed);

    const resampleMeans = new Array<number>(n);

    for (let i = 0; i < n; i += 1) {
        resampleMeans[i] = computeOneResampleMean(series, blockLen, blocksPerResample, rng);
    }

    resampleMeans.sort((a, b) => a - b);

    const lowIndex = Math.floor(BACKTEST_BOOTSTRAP_CI_LOW_QUANTILE * n);
    const highIndex = Math.ceil(BACKTEST_BOOTSTRAP_CI_HIGH_QUANTILE * n) - 1;

    return {
        meanDiff: computeMean(series),
        ci95Low: resampleMeans[lowIndex],
        ci95High: resampleMeans[highIndex],
        blockLen,
        n,
        resampleMeans,
    };
};

// Pulls `blocksPerResample` blocks of length `blockLen` from circular indices,
// then averages the first `series.length` of them (trim to original length so
// every resample mean is over the same denominator).
const computeOneResampleMean = (series: readonly number[], blockLen: number, blocksPerResample: number, rng: () => number): number => {
    const seriesLen = series.length;
    let sum = 0;
    let count = 0;

    for (let b = 0; b < blocksPerResample; b += 1) {
        const start = Math.floor(rng() * seriesLen);

        for (let k = 0; k < blockLen; k += 1) {
            if (count >= seriesLen) {
                break;
            }

            sum += series[(start + k) % seriesLen];
            count += 1;
        }

        if (count >= seriesLen) {
            break;
        }
    }

    return sum / seriesLen;
};

const computeMean = (series: readonly number[]): number => {
    let sum = 0;

    for (let i = 0; i < series.length; i += 1) {
        sum += series[i];
    }

    return sum / series.length;
};

const assertValidInputs = (series: readonly number[], opts: ICircularBlockBootstrapOptions): void => {
    if (series.length === 0) {
        throw new RangeError('circularBlockBootstrap: series must be non-empty');
    }

    if (opts.blockLen < 1) {
        throw new RangeError(`circularBlockBootstrap: blockLen must be >= 1 (got ${opts.blockLen})`);
    }

    if (opts.n < 1) {
        throw new RangeError(`circularBlockBootstrap: n must be >= 1 (got ${opts.n})`);
    }
};
