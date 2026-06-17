/**
 * Minimum paired-traded events for the mean PnL delta to be statistically
 * meaningful. Matches the CLT mean-normality rule-of-thumb (n ≥ 30 is the
 * conventional threshold at which the sampling distribution of the sample
 * mean is approximately normal for moderately non-skewed populations); below
 * this floor we suppress `meanPnlDeltaUsd` (returning null) and set
 * `belowSampleFloor=true` so the LLM cannot mistake a small-sample mean for
 * evidence of edge. (Note: this is NOT the same quantity as ADR 0017's
 * block-bootstrap block size, which is a separate dependence-structure
 * parameter; they happen to share a numeric value but have different
 * statistical justifications.)
 */
export const MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN = 30;

/**
 * D3 abstain threshold (ADR 0019 criterion 12, shadow variant). When the
 * force_close fraction of the shadow realized series exceeds this threshold
 * the paired diff is dominated by ~0-PnL same-bar exits and the comparison
 * result is meaningless. `compareVersions` sets `forceCloseAbstain: true`
 * and the mean is suppressed. W2 reduces this fraction to below the floor.
 */
export const MAX_FORCE_CLOSE_FRACTION = 0.5;
