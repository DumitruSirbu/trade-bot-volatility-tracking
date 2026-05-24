import { WalkForwardSplitModeEnum } from '../enum/WalkForwardSplitModeEnum';

// Engine-local description of how a comparison run subdivides its date range
// into chronologically-ordered (train, validation, oos) folds. Persisted as
// `comparison_reports.split_policy jsonb` (ADR 0017 §2.6) so the planner is
// expected to produce the same fold array on re-run.
//
// All `*Bars` values are counts of the project's primary 5-minute candle (see
// FIVE_MINUTE_MS in common/const/timeConsts). Bars rather than ms keep the
// policy human-authorable ("60-day train" = 60 * 288 bars) without dragging a
// resolution field into every persisted policy row.
//
// Lives in `backtest/interface/` rather than `@bot/shared` because the
// comparison driver (W4) is engine-only — the dashboard never plans folds.
export interface IWalkForwardSplitPolicy {
    readonly trainBars: number;
    readonly validationBars: number;
    readonly oosBars: number;
    readonly stepBars: number;
    readonly mode: WalkForwardSplitModeEnum;
}
