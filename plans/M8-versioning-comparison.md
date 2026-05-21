# M8 — Strategy versioning & comparison

**Goal:** Compare strategy versions head-to-head on identical data and promote the
winner — the mechanism that answers "short the spike vs. follow it."

**Depends on:** M7 (backtesting).

## Tasks

- **Version lineage.** Use `parent_version_id` so a new version records its origin (copy-from-previous + tweak).
  - *Output:* lineage queryable; new versions link to parents.
- **Walk-forward / out-of-sample evaluation.** Compare versions on a train/validation/out-of-sample split (not a single in-sample range). A winner must hold up on held-out data.
  - *Output:* `compare_versions(a, b, range)` reports in-sample AND out-of-sample metrics.
- **Statistical significance + minimum sample.** Require a minimum trade count and a significance criterion (e.g. bootstrap CI on the PnL/Sharpe difference) before declaring a winner — so "v(n+1) beat v(n)" is signal, not noise.
  - *Output:* the report states sample size and a confidence measure; thin/insignificant results are flagged "inconclusive."
- **Regime robustness.** Evaluate across at least one trending and one ranging period (guards the mean-reversion thesis from looking good only in chop).
  - *Output:* per-regime breakdown in the report.
- **Promotion.** Mark the chosen version `active` and archive others; the live engine reads the active version. Promotion is **gated on passing the out-of-sample + significance criteria**.
  - *Output:* promoting changes live behavior via config/state; an inconclusive winner cannot be promoted.
- **v1 vs v2 decision.** Run mean-reversion vs momentum over the accumulated point-in-time dataset.
  - *Output:* a statistically-qualified recommendation for the initial live direction.

## Definition of done

A reproducible head-to-head report with out-of-sample + per-regime metrics and a
significance measure; only a statistically-qualified winner can be promoted to
`active`; the v1-vs-v2 comparison gives a data-backed, validated direction choice.
