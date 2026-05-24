// Politis & White (2004) automatic block-length selection for the circular
// block bootstrap (ADR 0018 §2.3). The selection is data-driven: it estimates
// the autocorrelation structure of the series and picks the block length that
// asymptotically minimises the MSE of the bootstrap variance estimator.
//
// Reference:
//   Politis, D. N., & White, H. (2004). "Automatic Block-Length Selection for
//   the Dependent Bootstrap." Econometric Reviews, 23(1), 53-70.
//
// Formula implemented (circular variant):
//
//     b_opt  =  ( 2 * G_hat^2  /  D_hat )^(1/3)  *  N^(1/3)
//
// where, with the flat-top lag window λ(x) = 1 for |x| ≤ 1/2, 2(1-|x|) for
// 1/2 < |x| ≤ 1, and 0 otherwise, and sample ACF ρ̂(k):
//
//     G_hat  =  Σ_{k=-M..M}  λ(k/M) * |k| * ρ̂(|k|)
//     D_hat  =  (4 / 3) * g_hat(0)^2
//     g_hat(0)  =  Σ_{k=-M..M}  λ(k/M) * ρ̂(|k|)
//
// The bandwidth M = 2*m is chosen by the standard "smallest m such that K
// consecutive ρ̂ lie under 2/√N" rule (Politis–White §3.1, "Algorithm for
// choosing M").
//
// The wave exposes the raw real-valued estimate via `politisWhiteRaw` for
// testing and the production-safe `politisWhite` that floors at 4, ceilings at
// ⌊N/5⌋ (so at least five blocks fit), and rounds to an integer — the bound
// the caller actually feeds into `circularBlockBootstrap`.

import {
    BACKTEST_POLITIS_WHITE_K_CONSECUTIVE,
    BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN,
    BACKTEST_POLITIS_WHITE_MIN_BLOCKS_PER_RESAMPLE,
} from '../const/backtestConsts';

// Public: clamped integer block length suitable for `circularBlockBootstrap`.
// Floor 4 prevents pathological tiny blocks on short series; the upper bound
// ⌊N/5⌋ guarantees at least five blocks per resample. Short and degenerate
// series fall through to the floor — see the edge-case branches below.
export const politisWhite = (series: readonly number[]): number => {
    const n = series.length;
    const cap = Math.max(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN, Math.floor(n / BACKTEST_POLITIS_WHITE_MIN_BLOCKS_PER_RESAMPLE));

    if (n < 2 * BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN) {
        return Math.min(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN, Math.max(1, n));
    }

    const raw = politisWhiteRaw(series);

    if (!Number.isFinite(raw) || raw <= 0) {
        return Math.min(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN, cap);
    }

    const ceiled = Math.ceil(raw);
    const floored = Math.max(BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN, ceiled);

    return Math.min(floored, cap);
};

// Internal-but-exported: the real-valued formula output BEFORE clamping. Kept
// addressable so tests can assert the underlying estimate (e.g. on a synthetic
// AR(1) series whose theoretical b_opt is computable in closed form).
export const politisWhiteRaw = (series: readonly number[]): number => {
    const n = series.length;
    const acf = computeAutocorrelations(series);
    const m = selectBandwidthM(acf, n);
    const lagWindowSpan = 2 * m;

    let gHat = 0;
    let g0Hat = 0;

    for (let k = -lagWindowSpan; k <= lagWindowSpan; k += 1) {
        const absK = Math.abs(k);
        const weight = flatTopWindow(k / Math.max(m, 1));
        const rho = absK === 0 ? 1 : (acf[absK] ?? 0);

        gHat += weight * absK * rho;
        g0Hat += weight * rho;
    }

    const dHat = (4 / 3) * g0Hat * g0Hat;

    if (dHat <= 0) {
        return 0;
    }

    const ratio = (2 * gHat * gHat) / dHat;

    return Math.cbrt(ratio) * Math.cbrt(n);
};

// Sample autocorrelations ρ̂(k) for k = 0..2·K_N, K_N = ⌈√N⌉. We compute up to
// 2·K_N (not just K_N) because the flat-top lag-window in `politisWhiteRaw`
// integrates ρ over [-2m, 2m] and m can reach K_N — without the extension the
// outer half of the window silently reads zero, biasing G_hat downward on
// long-memory series (R1 quant M5 / ADR 0018 §2.3).
// Pearson-style: mean-centred numerator over (denominator = Σ (x-μ)^2). For a
// constant series the denominator is zero — return all zeros so the caller
// (and the formula) degrades gracefully instead of producing NaN.
const computeAutocorrelations = (series: readonly number[]): number[] => {
    const n = series.length;
    const bandwidthLag = Math.ceil(Math.sqrt(n));
    const maxLag = Math.min(n - 1, 2 * bandwidthLag);
    const mean = series.reduce((sum, x) => sum + x, 0) / n;

    let denom = 0;
    let maxAbs = 0;

    for (let i = 0; i < n; i += 1) {
        const dev = series[i] - mean;
        denom += dev * dev;

        if (Math.abs(series[i]) > maxAbs) {
            maxAbs = Math.abs(series[i]);
        }
    }

    const acf: number[] = new Array(maxLag + 1).fill(0);
    // Relative floor: a constant series produces denom on the order of
    // (FP epsilon * scale)^2 * n. We treat anything below this as zero-
    // variance — otherwise FP noise in the normalised ACF spoofs spurious
    // autocorrelation and the formula returns a meaningless block length.
    // Use a relative threshold proportional to (scale * sqrt(N) * EPSILON)^2.
    // Adding N values introduces ~sqrt(N) * EPSILON * scale relative error per
    // entry, squared and summed N times. Constant or near-constant series fall
    // safely under this floor.
    const scale = Math.max(1, maxAbs);
    const varianceFloor = scale * scale * n * n * Number.EPSILON * Number.EPSILON * 16;

    if (denom <= varianceFloor) {
        return acf;
    }

    acf[0] = 1;

    for (let k = 1; k <= maxLag; k += 1) {
        let num = 0;

        for (let i = 0; i < n - k; i += 1) {
            num += (series[i] - mean) * (series[i + k] - mean);
        }

        acf[k] = num / denom;
    }

    return acf;
};

// Algorithm for choosing M (Politis & White §3.1): find the smallest lag m such
// that |ρ̂(m + j)| < 2/√N for j = 0..K-1 consecutive lags (K = 2 by default).
// Bandwidth is then 2*m. If no such m exists in the search range, return the
// largest searched lag so the formula still sees meaningful weights.
const selectBandwidthM = (acf: readonly number[], n: number): number => {
    const threshold = 2 / Math.sqrt(n);
    // Search range is K_N = ⌈√N⌉ even though acf now extends to 2·K_N so the
    // window can integrate ρ over [-2m, 2m] without truncation (see
    // computeAutocorrelations). Capping the search at K_N preserves the
    // original Politis & White §3.1 bandwidth selection semantics.
    const bandwidthLag = Math.min(acf.length - 1, Math.ceil(Math.sqrt(n)));
    const consecutive = BACKTEST_POLITIS_WHITE_K_CONSECUTIVE;

    for (let m = 1; m <= bandwidthLag - (consecutive - 1); m += 1) {
        let allBelow = true;

        for (let j = 0; j < consecutive; j += 1) {
            if (Math.abs(acf[m + j]) >= threshold) {
                allBelow = false;
                break;
            }
        }

        if (allBelow) {
            return m;
        }
    }

    return Math.max(1, bandwidthLag);
};

// Flat-top lag window (Politis & Romano 1995) used by Politis & White (2004):
//   λ(x) = 1                  for |x| ≤ 1/2
//   λ(x) = 2 * (1 - |x|)      for 1/2 < |x| ≤ 1
//   λ(x) = 0                  otherwise
const flatTopWindow = (x: number): number => {
    const absX = Math.abs(x);

    if (absX <= 0.5) {
        return 1;
    }

    if (absX <= 1) {
        return 2 * (1 - absX);
    }

    return 0;
};
