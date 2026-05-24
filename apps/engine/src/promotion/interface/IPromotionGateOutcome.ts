// Per-criterion failure record (ADR 0019 §2.3). `index` is the 1-based criterion
// number from the spec table; `name` is a human-readable label. `threshold` and
// `observed` are stringified at this boundary so the outcome JSON survives
// round-trip via comparison_reports.artefact_uri without leaking MoneyValue
// instances into the persisted shape.
//
// `severity`:
//   - 'block'        — criterion in {1, 2, 3, 4, 7, 8, 9, 10, 11, 12}; failure
//                      forces decision='reject'.
//   - 'inconclusive' — criterion in {5, 6}; failure forces decision='inconclusive'
//                      unless paired with a block failure.
//   - 'deferred'     — W6 placeholder for criteria 7 & 9 (robustness re-runs).
//                      Counted as inconclusive at the W6 boundary to prevent a
//                      promotion solely because robustness is unimplemented.
export type PromotionCriterionSeverity = 'block' | 'inconclusive' | 'deferred';

export interface IPromotionCriterionFailure {
    readonly index: number;
    readonly name: string;
    readonly threshold: string;
    readonly observed: string;
    readonly severity: PromotionCriterionSeverity;
}

// `reason` discriminates the inconclusive sub-cases for the CLI renderer (W7)
// and the W6.1 backfill that will turn 'robustness_pending' into a real result.
export type PromotionInconclusiveReason = 'statistical' | 'sample_sufficiency' | 'robustness_pending';

export interface IPromotionGateOutcome {
    readonly versionId: number;
    readonly reportId: number;
    readonly decision: 'promote' | 'reject' | 'inconclusive';
    readonly passedCriteria: readonly number[];
    readonly failedCriteria: readonly IPromotionCriterionFailure[];
    readonly inconclusiveReason?: PromotionInconclusiveReason;
    readonly evaluatedAt: Date;
}
