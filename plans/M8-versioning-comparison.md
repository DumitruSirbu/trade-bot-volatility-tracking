# M8 — Strategy versioning & comparison

**Goal:** Compare strategy versions head-to-head on identical data and promote the
winner — the mechanism that answers "short the spike vs. follow it."

**Depends on:** M7 (backtesting).

## Tasks

- **Version lineage.** Use `parent_version_id` so a new version records its origin (copy-from-previous + tweak).
  - *Output:* lineage queryable; new versions link to parents.
- **Compare command.** Run two (or more) versions over the same date range; produce a side-by-side metrics report.
  - *Output:* `compare_versions(a, b, range)` report (PnL, win rate, drawdown).
- **Promotion.** Mark the chosen version `active` and archive others; the live engine reads the active version.
  - *Output:* promoting a version changes live behavior via config/state, no redeploy of logic.
- **v1 vs v2 decision.** Run mean-reversion vs momentum over accumulated candles.
  - *Output:* an empirical recommendation for the initial live direction.

## Definition of done

A reproducible head-to-head report exists, a winner can be promoted to `active`,
and the v1-vs-v2 comparison gives a data-backed direction choice.
