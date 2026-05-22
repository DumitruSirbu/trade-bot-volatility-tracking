# M8 — Strategy versioning & comparison

**Goal:** Compare strategy versions head-to-head on identical data and promote the
winner — the mechanism that answers "short the spike vs. follow it."

**Depends on:** M7 (backtesting).

## Tasks

- **Version lineage.** Use `parent_version_id` so a new version records its origin (copy-from-previous + tweak).
  - *Output:* lineage queryable; new versions link to parents.
- **Walk-forward / out-of-sample evaluation.** Compare versions on a train/validation/out-of-sample split (not a single in-sample range). A winner must hold up on held-out data.
  - *Output:* `compare_versions(a, b, range)` reports in-sample AND out-of-sample metrics.
- **Statistical significance + minimum sample (pinned method, raised bar).** Require **≥200 trades total per candidate** before any statistical claim; **≥100 trades in the target regime** for a regime-specific winner; and **≥30 calendar days of paper/live shadow** before any scaling. Use a **paired block bootstrap** (block size covering trade autocorrelation) on the per-trade **expectancy-per-unit-risk** difference series (not just raw return) — fixed n=10,000 resamples, **95% two-sided CI**. A winner must have a CI excluding zero; otherwise "inconclusive." Also report **skew, kurtosis, max single loss, expected shortfall, and longest losing streak**.
  - *Output:* the report states sample sizes against these thresholds, a bootstrap CI on expectancy per unit risk, and the tail-risk statistics; thin/insignificant results are flagged "inconclusive."

- **Compare by `event_id` (replaces paired timestamps).** Compare v0 / v1 / v2 / v3 + no-trade on the same `event_id` under the same market path. This replaces the fragile "identical trade timestamps" requirement, which breaks when versions enter and exit differently.
  - *Output:* per-`event_id` outcome distributions across all versions; comparison is robust to differing entry/exit timing.
- **Regime robustness with an objective classifier.** Label periods using the **same ADX(14) regime rule as the live strategy**: ADX < 20 = `ranging`, ADX > 25 = `trending_up`/`trending_down`, 20–25 = `transitioning`. Compute per-regime metrics for v0 (baseline), v1 (mean-reversion suppresses trending entries), v2 (momentum suppresses ranging entries), and v3 (router) separately. A winner must outperform on the regime(s) / flow types it targets.
  - *Output:* reproducible per-regime breakdown using the documented ADX classifier; regime breakdown matches the suppression logic in M3.
- **Promotion criteria.** A version is promotable only if it passes ALL of: net positive **expectancy** after fees + slippage + funding + missed fills; **profit factor ≥ 1.25 out-of-sample**; max drawdown within tolerance; worst 1-day loss survivable; and the edge survives the M7 robustness gates (doubled slippage, drop best 5%, stress windows, not concentrated in one symbol/week). **No daily-profit-target language applies** — success is risk-adjusted survival, not a profit quota. Mark the chosen version `active` and archive others; the live engine reads it.
  - *Output:* promoting changes live behavior via config/state; an inconclusive or robustness-failing candidate cannot be promoted.
- **Direction decision (v1 vs v2 vs v3 vs v0).** Run the no-trade baseline (v0), exhaustion-confirmed mean-reversion (v1), momentum (v2), and the hybrid router (v3) over the accumulated point-in-time dataset on the same `event_id`s. The comparison answers, per flow type / regime: fade, follow, or skip? Direction is never assumed — it is chosen from out-of-sample evidence + live shadow.
  - *Output:* a statistically-qualified recommendation for the initial live version (restricted v1) and the v3 end-state path, with per-regime / per-`flow_type` breakdown.

## Definition of done

A reproducible head-to-head report with out-of-sample + per-regime metrics and a
significance measure; only a statistically-qualified winner can be promoted to
`active`; the v1-vs-v2 comparison gives a data-backed, validated direction choice.
