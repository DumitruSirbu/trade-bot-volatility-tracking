// The deterministic output of a single circular block bootstrap pass (ADR 0018 §2.4).
//
// `resampleMeans` is returned sorted ascending so downstream code (per-pair stats,
// percentile inspection) can index without re-sorting. `ci95Low`/`ci95High` are
// index-based on the sorted array — no interpolation — so the reported endpoints
// are actual resample means and reproduce byte-for-byte under the same seed.
export interface IBootstrapDistribution {
    readonly meanDiff: number;
    readonly ci95Low: number;
    readonly ci95High: number;
    readonly blockLen: number;
    readonly n: number;
    readonly resampleMeans: readonly number[];
}
