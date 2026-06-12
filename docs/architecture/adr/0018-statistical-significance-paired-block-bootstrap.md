# ADR 0018 — Statistical significance: paired block bootstrap on expectancy-per-unit-risk (M8)

**Status:** Accepted (M8 design wave)
**Date:** 2026-05-24
**Milestone:** M8
**Depends on:** ADR 0017 (same-event comparison provides the paired per-event series).
**Related:** `docs/plans/archive/M8-versioning-comparison.md` (Statistical significance task — *non-negotiable*).

## 1. Context

The M8 brief sets a deliberately hard statistical bar to prevent promoting a
version on noise:

- **Paired block bootstrap** on per-trade **expectancy-per-unit-risk** difference series.
- **Fixed n = 10,000 resamples**, **95% two-sided CI**.
- **Minimum samples:** ≥200 trades total per candidate; ≥100 trades in the
  target regime for a regime-specific claim; ≥30 calendar days of paper/live
  shadow before any scaling.
- **Tail-risk stats reported alongside:** skew, kurtosis, max single loss,
  expected shortfall, longest losing streak.

These thresholds are **not softened** under any circumstance. Below them, the
output is **"inconclusive"** — neither a promote nor a reject. Inconclusive ≠
fail; it means the run did not produce enough evidence.

## 2. Decision

### 2.1 Unit of analysis: expectancy per unit risk (r)

For each closed trade `t`, define

```text
r_t  =  netPnl_t  /  riskBudgetSpent_t
```

where `netPnl_t` is decimal (after fees + funding + slippage) and
`riskBudgetSpent_t` is the decimal **post-clamp** stop-distance × qty — i.e.
`|entryPrice - stopLossPrice| × qty` read off the position at close, where the
stop is the one the position actually carried after the risk gate's
liquidation-buffer clamp (`RiskGateService.clampStopInsideLiquidation`). This
is the money actually exposed under the gate's protective stop, not the
pre-clamp ATR target. The clamp is monotonically tightening — it only
*reduces* stop-distance when leverage would otherwise push the stop beyond the
safe liquidation buffer — so `riskBudgetSpent ≤ atr14 × atrStopMultiplier ×
qty` always holds; when no clamp fires (the common path), the two are equal.
`r_t` is a dimensionless ratio; the final value is the only `number` crossing
the boundary, computed from decimal arithmetic.

**Unit name (load-bearing):** "expectancy per dollar of gate-exposed risk."
The denominator is what the live PnL stream is actually exposed to under the
protective stop, which is what risk-adjusted survival cares about. A future
M9 robustness wave that wants the pre-clamp ATR framing instead can add
`riskBudgetUsdtApproved` as a separate field on the position entity and
re-derive `r` from it without invalidating any M8 numbers — the decision is
reversible at the column level, not the algorithm level.

For `skip` and `missed` events, `r = 0`. **Skips count** — that is the point of
same-event comparison. A version that skips losing events earns 0 versus a peer
that loses on the same event.

### 2.2 The paired difference series

For each ordered pair of versions `(A, B)` and each `event_id` `e` in the tape:

```text
diff_e(A, B)  =  r_e(A)  -  r_e(B)
```

The full series for the pair is `D_AB = [diff_e for e in eventTape]`, length
`= |eventTape|` (not per-trade — per-event). This is the key correction the M8
brief makes versus "paired-by-timestamp" — pairing is by `event_id`, so versions
that enter or exit differently are still comparable.

### 2.3 Block size — circular block bootstrap

Per-trade outcomes are autocorrelated (regime persistence, multi-bar holds,
clustered triggers). Independent resampling underestimates variance. The choice
is the **circular block bootstrap** (Politis & Romano, 1992) with **automatic
block-length selection per Politis & White (2004)** on the difference series:

```text
blockLen = max(4, ceil( politisWhite(D_AB) ))
```

Floor of 4 prevents pathological tiny blocks on short series; the upper bound is
`floor(|D_AB| / 5)` so at least 5 blocks fit. If `|D_AB| < 200`, the run does
not bootstrap — it returns `inconclusive: insufficient_samples`.

The selection method is **deterministic** given the series — important for
reproducibility (same comparison run → same block size → same CI).

### 2.4 The resampling procedure (deterministic)

```text
bootstrap(D_AB, n=10000, blockLen, seed):
  meanDiffs = []
  rng = mulberry32(seed)                    // seeded PRNG; seed derived from run_label
  numBlocks = ceil(|D_AB| / blockLen)
  for i in 0..n-1:
    sample = []
    for b in 0..numBlocks-1:
      start = floor(rng() * |D_AB|)         // circular: wrap-around
      for k in 0..blockLen-1:
        sample.push(D_AB[(start + k) mod |D_AB|])
    sample = sample.slice(0, |D_AB|)        // trim to original length
    meanDiffs.push(mean(sample))
  meanDiffs.sort()
  ci95Low  = meanDiffs[floor(0.025 * n)]
  ci95High = meanDiffs[ceil(0.975 * n) - 1]
  return { meanDiff: mean(D_AB), ci95Low, ci95High, blockLen, n }
```

**Determinism notes:**
- `n = 10000` is **fixed** and not exposed as a config. Lowering it weakens the
  CI; raising it has diminishing returns.
- The PRNG is a seeded `mulberry32` (or equivalent); the seed is a deterministic
  hash of `run_label || pair_id`. Two runs with the same label produce the same
  CI. **No `Math.random()`** anywhere — same determinism rule as live.
- Bootstrap math uses decimal-derived `r` values. Means and quantiles are
  numerically computed via decimal sums then converted at the boundary; quantile
  selection is index-based on a sorted array, so the value reported is one of
  the actual computed means (not interpolated).

### 2.5 Sample-size gates and the `inconclusive` outcome

Before bootstrapping, the harness checks:

| Gate | Threshold | Source |
|---|---|---|
| Trades total per candidate (`A` and `B` each) | ≥ 200 | M8 brief |
| Trades in target regime (when a regime-specific claim is requested) | ≥ 100 | M8 brief |
| Days of paper/live shadow before any scaling | ≥ 30 | M8 brief |
| Paired non-zero events | ≥ 30 | bootstrap stability floor |

If any gate fails, the harness emits:

```text
IPairwiseBootstrapResult {
  versionA, versionB,
  outcome:           'inconclusive',
  reason:            'insufficient_samples' | 'insufficient_regime_samples' | 'insufficient_shadow_days',
  countersByGate:    { tradesA, tradesB, regimeTradesA, regimeTradesB, shadowDays },
  // ci, meanDiff, etc. omitted
}
```

**`inconclusive` is not a failure.** It is the explicit "not enough data to
say." A promotion gate (ADR 0019) treats `inconclusive` as **not-promotable**
without prejudice — re-run after more data accrues.

If gates pass, the bootstrap runs and the outcome is one of:

- `winner = A` if `ci95Low > 0`
- `winner = B` if `ci95High < 0`
- `tie` if the CI straddles zero

### 2.6 Tail-risk stats — always reported alongside

For each candidate version's per-trade `r_t` distribution, the report includes:

```text
ITailRiskStats {
  skew                  number           // moment-based on r series
  kurtosis              number           // excess kurtosis
  maxSingleLossR        number           // min(r_t)
  expectedShortfall5R   number           // mean of worst 5% of r_t
  longestLosingStreak   number           // consecutive r_t < 0 (skips broken by sign)
}
```

A version that wins on mean expectancy but has fat-tail kurtosis + a brutal max
single loss is **not auto-promoted** — the promotion gate (ADR 0019) inspects
these directly. M8's bar is risk-adjusted survival, not raw expectancy.

### 2.7 Multiple-comparison note

With v0/v1/v2/v3 a comparison run produces 6 pairwise tests. The brief does
not require a Bonferroni correction, but the report **logs the 6 raw CIs** and
the harness emits a `multipleComparisonNote` flagging that any single
"significant" pair at α=0.05 has roughly a 1-in-4 chance of being a family-wise
false positive. The promotion gate combines this with the per-regime
breakdown — a candidate promoted on a single marginal pair is treated as
inconclusive.

## 3. Consequences

**Positive**
- The bar is numerically pinned: n=10000, 95% CI, gates at 200/100/30.
- Pairing by `event_id` keeps the test valid when versions trade differently.
- Determinism: same seed → same CI; reproducible reports.
- Tail-risk stats prevent "high mean, brutal tail" promotions.

**Negative**
- `politisWhite` block-length selection adds implementation surface; M8 W3 owns
  the unit tests against published reference series.
- A 30-day shadow gate means M8 cannot promote anything on the day it ships.
  Acceptable — the M8 brief is explicit that scaling is gated on accrued
  shadow time.

## 4. Alternatives considered

1. **Plain (non-block) bootstrap.** Rejected — ignores autocorrelation;
   CIs will be too narrow.
2. **Stationary bootstrap (Politis & Romano 1994, geometric block lengths)
   instead of circular.** Equivalent statistical properties; circular chosen
   for implementation simplicity and exact-length resamples (easier to verify
   in tests).
3. **Test mean PnL or win-rate difference instead of expectancy-per-unit-risk.**
   Rejected — raw PnL confounds bet size with edge; win-rate ignores magnitude.
   `r` is the unit that matches the risk-budget logic the gate already enforces.
4. **Move-block bootstrap with fixed `blockLen = sqrt(N)`.** Rejected — the
   √N heuristic is convenient but ignores actual autocorrelation; Politis–White
   is the standard data-driven choice.
5. **Lower n to 1000 for speed.** Rejected — n=10000 is fixed by the brief
   and is the difference between a CI you can trust at α=0.05 and one that
   wobbles on re-seed.
6. **Bonferroni correction across the 6 pairs.** Considered. Decision: report
   the raw CIs + a multiple-comparison note, and let the promotion gate
   (ADR 0019) decide. Bonferroni at 6 pairs is conservative enough to
   suppress most real edges; the gate's "must outperform on the regime/flow
   it targets" requirement is a stronger filter in practice.

## 5. Open questions

- **Politis–White implementation source.** Decision needed at W3: write from
  reference, or vendor a small library? Vendor list must be screened (no
  GPL). Action item — `bot-shared-maintainer` proposes a candidate before W3.
- **Seed encoding.** The hash of `(run_label, pair_id)` must be stable across
  Node versions. W3 to pick a hash (likely `xxhash` or a documented
  fnv-variant) and pin it.
