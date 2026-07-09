# EXP-025 — xmom expected-fill anchor + thin-book skip (M54 D3 replay)

**Date:** 2026-07-09
**Status:** OPEN — STUB. Instrument built (D3); decision-grade read pending the paper soak (D5/QA wave runs it on real recorded data).
**Type:** Offline, read-only replay extension (fill-anchor-invariant — M53b Route 2). No positions opened, no engine code exercised, no sims committed.
**Instrument:** `packages/analysis/research/xmom_tp_ratio_replay.mjs` (`--expected-fill --max-depth-fraction=<x>`).
**Scope note:** This is CORRECTNESS / fee-bleed measurement, NOT an edge claim. EXP-021 (fragile peak, 1/10 folds) and EXP-022 (all 22 exit-geometry cells net-negative; the binding constraint is the SIGNAL) already proved xmom has no cost-surviving edge. M54 does not change that. See `docs/plans/M54-xmom-entry-geometry-expected-fill.md`.

> **Registry note:** the M54 plan (§7 D3) named this "EXP-023", but EXP-023 and EXP-024 were
> already assigned on 2026-07-08 (reversing-xmom; momentum best-case reproduction). This work was
> allocated the next free ID **EXP-025** to avoid a registry collision. Flagged to the orchestrator.

---

## 1. Question

Does re-anchoring xmom's SL/TP from the **signal price P0** to the **expected fill price**
`F_exp = P0 × (1 + halfSpread/100)` (halfSpread = `spread_at_entry_pct` / 2), plus a pre-send
order-size-aware thin-book **skip** (`entry_notional / book_depth_10bps_at_entry > xmom_max_depth_fraction`),

- **(decision-grade)** reduce the scheduled-open **force_close rate** (~67% baseline, EXP-022 §2)
  and the **fee/slot churn** (0-duration open→force_close→retry cycles), and
- **(characterization, NOT decision-grade)** move the filled-book **SL-hit-rate** and **gross PnL**,

measured off the **real recorded fills** (fill-anchor-invariant), vs the P0-anchored baseline?

## 2. Mechanism (why the anchor is honest, not an edge)

For a long filling at `F = P0 + s·D` (slippage `s` as a fraction of the stop distance `D`), with the
anchor at `F_exp = P0 + s_exp·D` and residual `r = s − s_exp`:

- `slDist = F − SL = D(1 + r)`, `tpDist = TP − F = D(a − r)` ⇒ realized `R:R = (a − r)/(1 + r)`.

Under the old P0 anchor `s_exp = 0`, so `R:R = (a − s)/(1 + s)` is systematically dragged **below**
the arm ratio `a` by the adverse thin-book slippage (`s > 0`). Under the F_exp anchor the R:R is
centered on the **residual** `r`, so it is centered at `a` instead of biased below it. The
half-spread is a **lower-bound** estimator (EXP-022 implies ~0.23·D typical adverse move vs ~0.05·D
modeled), so `E[r] > 0` is expected — the replay captures the `r` distribution (`meanResidual`) to
calibrate `xmom_max_depth_fraction`. **Most of the force_close-rate improvement is expected from the
SKIP, not the anchor** (M54 §2).

## 3. How the replay computes it

- Re-anchors recorded geometry: `SL_new = F_exp − D`, `TP_new = F_exp + a·D`; barriers still price
  off the **real recorded 1m OHLCV** and the **real recorded fill** — the anchor moves only the
  barriers, not the fill (M53b Route 2, immune to the backtest flat-fill model).
- Skip: `depthFraction = entry_notional / book_depth_10bps_at_entry`; **fail-closed** (skip) on a
  null/≤0 depth reading, matching the in-gate `isBookTooThin` convention. Skipped positions leave the
  admitted population (they are never opened).
- Outputs split into **DECISION-GRADE** (force_close, skip, fee-churn = force_close + skip) and
  **CHARACTERIZATION** (filled-book SL-hit-rate, gross PnL delta, meanResidual).

## 4. Results

**PENDING.** Run on the paper-soak `positions` set (`strategy_version_id = 20`) during the D5/QA wave:

```
node packages/analysis/research/xmom_tp_ratio_replay.mjs --ratios=1.5 --expected-fill --max-depth-fraction=0.10
```

Compare against the P0 baseline (same command without `--expected-fill`). Pre-register the
`xmom_max_depth_fraction` value before reading (multiple-comparisons discipline, M54 §12 Q1).

## 5. Non-comparability guard (must be stated in the write-up)

The depth skip **changes the admitted-signal population**, so any filtered-universe filled-book PnL
delta is **NOT comparable** to the EXP-021/022 full-universe baseline and is **NOT** an edge claim
(M54 §10). The anchor also moves absolute SL/TP by the half-spread on **every filled trade**, so a
filled-book PnL swing is a **finding to explain**, not a success or a dismissable artifact. The
decision-grade metric remains **force_close-rate + fee-churn only**. n≈21 scheduled opens is below
decision-grade statistical power (EXP-009/EXP-010) — this is EVIDENCE for the soak read, not proof.
