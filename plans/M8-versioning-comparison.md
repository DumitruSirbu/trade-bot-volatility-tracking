# M8 — Strategy versioning & comparison

**Goal:** Compare strategy versions head-to-head on identical data and promote the
winner — the mechanism that answers "short the spike vs. follow it."

**Depends on:** M7 (backtesting).

## Tasks

- **Version lineage.** Use `parent_version_id` so a new version records its origin (copy-from-previous + tweak).
  - *Output:* lineage queryable; new versions link to parents.
- **Walk-forward / out-of-sample evaluation.** Compare versions on a train/validation/out-of-sample split (not a single in-sample range). A winner must hold up on held-out data.
  - *Output:* `compare_versions(a, b, range)` reports in-sample AND out-of-sample metrics.
- **Statistical significance + minimum sample (pinned method).** Require **≥30 trades per regime** and a **paired block bootstrap** (block size covering trade autocorrelation) on the per-trade return-difference series, comparing versions on identical trade timestamps — fixed n=10,000 resamples, **95% two-sided CI**. A winner must have a CI excluding zero; otherwise "inconclusive."
  - *Output:* the report states sample size and a bootstrap CI; thin/insignificant results are flagged "inconclusive."
- **Regime robustness with an objective classifier.** Label periods trending vs ranging by a defined rule (e.g. ADX or realized-volatility threshold over the market index) — not hand-picked — and evaluate across at least one of each.
  - *Output:* reproducible per-regime breakdown using the documented classifier.
- **Promotion.** Mark the chosen version `active` and archive others; the live engine reads the active version. Promotion is **gated on passing the out-of-sample + significance criteria**.
  - *Output:* promoting changes live behavior via config/state; an inconclusive winner cannot be promoted.
- **v1 vs v2 decision.** Run mean-reversion vs momentum over the accumulated point-in-time dataset.
  - *Output:* a statistically-qualified recommendation for the initial live direction.

## Definition of done

A reproducible head-to-head report with out-of-sample + per-regime metrics and a
significance measure; only a statistically-qualified winner can be promoted to
`active`; the v1-vs-v2 comparison gives a data-backed, validated direction choice.
