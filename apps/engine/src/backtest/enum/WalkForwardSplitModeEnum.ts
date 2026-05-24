// Walk-forward split modes (ADR 0017 §2.1). Engine-internal because the
// comparison driver and its persisted `comparison_reports.split_policy jsonb`
// row live only in the engine; promoting to `@bot/shared` would force a
// serialisation boundary for purely in-process planning. JSONB stores the raw
// string value, so re-runs round-trip safely.
export enum WalkForwardSplitModeEnum {
    ROLLING = 'rolling',
    EXPANDING = 'expanding',
}
