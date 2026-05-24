import { RegimeLabelEnum } from '@bot/shared';

// One row of the per-regime breakdown (ADR 0017 §2.4) attached to each candidate
// version in a comparison report. `meanR`, `winRate`, and `totalR` are computed
// from decimal-derived `r_t` values but expressed at the boundary as `number` —
// these are ratios, not money.
//
// `winRate` excludes skips/missed events (`r_t === 0`) from the denominator.
// A bucket with only skips reports `winRate = 0` and `meanR = 0`.
export interface IRegimeBucket {
    readonly tradeCount: number;
    readonly meanR: number;
    readonly winRate: number;
    readonly totalR: number;
}

// Keyed by `RegimeLabelEnum` value; every label the input contains gets a row.
// Labels absent from the input are absent from the map (callers iterate by key,
// not by enumerating all labels) so the consumer can tell "no events in regime X"
// apart from "zero-mean in regime X".
export interface IRegimeMetrics {
    readonly buckets: ReadonlyMap<RegimeLabelEnum, IRegimeBucket>;
}
