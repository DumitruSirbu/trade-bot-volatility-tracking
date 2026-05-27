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
