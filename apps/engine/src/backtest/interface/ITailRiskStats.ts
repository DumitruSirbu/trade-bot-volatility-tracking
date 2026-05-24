// Per-candidate tail-risk descriptors reported alongside every bootstrap result
// (ADR 0018 §2.6). A version that beats a peer on mean expectancy but carries
// fat-tail kurtosis + a brutal max single loss is NOT auto-promoted; the
// promotion gate inspects these directly. M8's bar is risk-adjusted survival,
// not raw expectancy.
//
// - `skew` and `kurtosis` are moment-based on the `r_t` series; `kurtosis` is
//   the EXCESS form (i.e. with 3 already subtracted, so a normal distribution
//   scores 0).
// - `maxSingleLossR` is `min(r_t)` — the most negative outcome, expressed in
//   R units. A non-negative value means no losses in the window.
// - `expectedShortfall5R` is the arithmetic mean of the worst 5% of `r_t`. With
//   fewer than 20 events the floor is the single worst event.
// - `longestLosingStreak` counts consecutive `r_t < 0` outcomes. Skips
//   (`r_t === 0`) BREAK the streak — see ADR 0018 §2.6.
export interface ITailRiskStats {
    readonly skew: number;
    readonly kurtosis: number;
    readonly maxSingleLossR: number;
    readonly expectedShortfall5R: number;
    readonly longestLosingStreak: number;
}
