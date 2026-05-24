// One chronologically-ordered (train, validation, oos) window triple produced
// by `WalkForwardPlanner.plan`. Persisted verbatim as one element of
// `comparison_reports.folds jsonb` (ADR 0017 §2.6) — every field is a primitive
// `number` so the array survives JSON round-trip without a custom reviver.
//
// All `*Ms` values are inclusive lower / exclusive upper millisecond bounds
// (`[fromMs, toMs)`) consistent with the rest of the backtest replay window
// contract.
export interface IWalkForwardFold {
    readonly foldIndex: number;
    readonly trainFromMs: number;
    readonly trainToMs: number;
    readonly validationFromMs: number;
    readonly validationToMs: number;
    readonly oosFromMs: number;
    readonly oosToMs: number;
}
