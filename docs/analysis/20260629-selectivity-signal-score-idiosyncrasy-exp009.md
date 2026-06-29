> **EXP-009 — INCONCLUSIVE** | 2026-06-29 | [back to index](README.md)

# EXP-009 — `signal_score` floor & idiosyncrasy gate as win-rate levers

## 1. Summary

**Dataset:** the largest available real-position cohort carrying both
`signal_score_at_entry` and `idiosyncrasy_at_entry` — **n=209 closed live
positions** pooling strategy versions **v3 (n=195, 2026-06-11 → 2026-06-25)** and
**v16 (n=14, 2026-06-26 → 2026-06-29)**. This is the full universe of closed
positions with both fields populated; v3 is the only version with ≥30 such trades,
v16 is admitted to extend the window but is a known confound (see Setup).

**Key finding:** `signal_score` carries a **weak, directionally-consistent but
non-actionable** edge; `idiosyncrasy` carries **no usable signal at all**.

- Baseline pooled WR is **23.4%** (49/209), net **−$231.77**, −$1.11/trade.
- TP exits score higher on `signal_score` (avg **61.4**) than every losing exit
  group (SL 55.1, time-stop 55.1, force-close 51.2). This is the only field that
  separates winners from losers.
- A `signal_score` floor lifts WR **monotonically** 23.4% → 36.4% (floor 70), but
  **never reaches the 40% SUPPORTED bar** and **net PnL stays negative at every
  floor** (best −$52.35 at floor 65). Breakeven (52.8%) is never approached.
- `idiosyncrasy` avg is **flat (~0.86)** across all exit reasons; gating on it does
  nothing — WR stays pinned at 22–24% across the entire 0.60–0.85 sweep, because
  the ≥0.7 condition is *already* baked into flow classification upstream
  (`idiosyncrasy_min_score` default 0.7), so the live set is pre-filtered.
- Best gate `signal_score ≥ 65` (n=48, WR 35.4%) holds **3/3 sub-windows above the
  23.4% baseline** (50.0% / 25.0% / 31.2%) but with wide spread; its Wilson 95% CI
  is **[23.4%, 49.6%]** — lower bound **below 30%**, failing the SUPPORTED CI floor.

**Verdict: INCONCLUSIVE.** A real but weak `signal_score` edge exists; it does not
reach 40% WR, does not turn any cohort net-positive, and its CI lower bound sits
below 30%. The idiosyncrasy lever is **rejected** outright (no signal). This
exhausts the analytical entry-selectivity levers available on the current dataset.

## 2. Setup

- **Data source:** live `positions` table, `exit_reason IS NOT NULL AND
  signal_score_at_entry IS NOT NULL AND idiosyncrasy_at_entry IS NOT NULL`.
- **n = 209** closed positions (v3: 195, v16: 14). Total ≥ 50, so the dataset
  clears the minimum-sample bar, though gated sub-cohorts thin to n=33–48.
- **Fields used:** `signal_score_at_entry` (numeric, range 26.5–99.8),
  `idiosyncrasy_at_entry` (numeric 0–1, range 0.512–1.000), `exit_reason`,
  `realized_pnl`, `flow_type_at_entry`, `opened_at` (chronological ordering).
- **Win definition:** `exit_reason = 'take_profit'`. `realized_pnl` is net
  (fees + slippage folded in, identical accounting live).
- **Validity caveats:**
  - **Version confound (primary):** pooling v3 and v16 mixes two strategy
    generations that may emit different `signal_score` quality. v16 is only 14/209
    (6.7%), so it cannot drive the result, but the floor sweep's absolute WR is a
    v3-dominated figure. Relative rankings (does a higher floor raise WR?) are the
    trustworthy output; absolute WR is indicative.
  - **Upstream pre-filter:** `idiosyncrasy_min_score` (default 0.7) is enforced
    inside `classifyFlowType`, so the live set already excludes most low-idio
    candidates. The idiosyncrasy sweep below therefore measures variation *within
    an already-gated population* — its flatness is partly structural, but the
    p25=0.805 distribution confirms there is no further edge to extract above 0.7.
  - **Live-only dataset:** these are real fills, not backtest replays, so no
    look-ahead or modelled-fill caveat applies; but the window is short
    (2026-06-11 → 2026-06-29, ~18 days) and regime-limited.
  - `reconciled_missing` (n=4) and `force_close` (n=7) are treated as
    non-wins (correct: neither hit TP).

## 3. Results

### Task 1 — Baseline characterization (pooled, n=209)

- **WR 23.44%** (49 TP / 209), **net −$231.77**, **−$1.1089/trade**.
- **Exit mix:** time_stop 123 (58.9%), take_profit 49 (23.4%), stop_loss 26
  (12.4%), force_close 7 (3.3%), reconciled_missing 4 (1.9%). Time-stop dominance
  reconfirms EXP-001/EXP-005.

`signal_score` distribution:

| min | p25 | median | p75 | p95 | max |
|---|---|---|---|---|---|
| 26.52 | 47.11 | 53.63 | 64.42 | 85.87 | 99.77 |

`idiosyncrasy` distribution:

| min | p25 | median | p75 | p95 | max |
|---|---|---|---|---|---|
| 0.512 | 0.805 | 0.937 | 0.974 | 0.993 | 1.000 |

**Score / idio by exit_reason (the discriminator test):**

| exit_reason | n | avg signal_score | avg idiosyncrasy |
|---|---|---|---|
| take_profit | 49 | **61.41** | 0.863 |
| stop_loss | 26 | 55.12 | 0.862 |
| time_stop | 123 | 55.13 | 0.887 |
| force_close | 7 | 51.18 | 0.869 |
| reconciled_missing | 4 | 46.03 | 0.864 |

Winners score **~6 points higher** on `signal_score` than the two main losing
groups — a real separation. `idiosyncrasy` is **flat (0.862–0.887)** across every
group, including a *higher* mean for time-stops (0.887) than TPs (0.863): no signal.

### Task 2 — `signal_score` floor sweep

| Floor | n | WR% | Net PnL | Avg net/trade | Retained% |
|---|---|---|---|---|---|
| (none) | 209 | 23.4 | −231.77 | −1.109 | 100.0 |
| 45 | 172 | 25.6 | −183.98 | −1.070 | 82.3 |
| 50 | 129 | 29.5 | −132.65 | −1.028 | 61.7 |
| 55 | 96 | 31.2 | −125.42 | −1.306 | 45.9 |
| 60 | 74 | 32.4 | −98.29 | −1.328 | 35.4 |
| 65 | 48 | 35.4 | −52.35 | −1.091 | 23.0 |
| 70 | 33 | 36.4 | −65.40 | −1.982 | 15.8 |

WR rises **monotonically** with the floor — genuine predictive structure. But:
**no floor reaches 40% WR**, let alone 52.8% breakeven; **net PnL is negative at
every floor**; and avg net/trade does **not** improve monotonically (worsens at
floor 70 to −$1.98 as the sample shrinks to n=33). The lift is real but tops out
around 36%.

### Task 3 — Idiosyncrasy gate sweep

| Gate | n | WR% | Net PnL | Avg net/trade | Retained% |
|---|---|---|---|---|---|
| (none) | 209 | 23.4 | −231.77 | −1.109 | 100.0 |
| 0.60 | 194 | 22.7 | −230.30 | −1.187 | 92.8 |
| 0.65 | 190 | 22.6 | −226.43 | −1.192 | 90.9 |
| 0.70 | 182 | 23.6 | −214.49 | −1.178 | 87.1 |
| 0.75 | 173 | 23.1 | −215.80 | −1.247 | 82.8 |
| 0.80 | 158 | 22.2 | −199.51 | −1.263 | 75.6 |
| 0.85 | 149 | 22.8 | −201.33 | −1.351 | 71.3 |

WR is **flat (22.2–23.6%)** across the entire sweep and avg net/trade *worsens*
as the gate tightens. The idiosyncrasy field has **no discriminative power** within
this (already ≥0.7-pre-filtered) population. **Rejected as a standalone lever.**

### Task 4 — Combined gate sweep

| S ≥ , I ≥ | n | WR% | Net PnL | Avg net/trade |
|---|---|---|---|---|
| 45 / 0.65 | 163 | 24.5 | −182.93 | −1.122 |
| 50 / 0.60 | 123 | 28.5 | −133.88 | −1.089 |
| 50 / 0.70 | 119 | 28.6 | −130.04 | −1.093 |
| 55 / 0.70 | 91 | 30.8 | −119.55 | −1.314 |
| 55 / 0.75 | 90 | 30.0 | −119.33 | −1.326 |
| 60 / 0.80 | 65 | 30.8 | −90.00 | −1.385 |

Adding the idiosyncrasy condition **does not beat the signal_score floor alone**:
the combined cells track the pure-`signal_score` column (e.g. S55/I0.70 → 30.8% is
no better than floor 55's 31.2% at lower n). The idio leg only throws away trades.
**The best gate is a single `signal_score` floor**, not a combination.

### Task 5 — Sub-window robustness (best gate)

Best gate carried forward: **`signal_score ≥ 65`** (highest-WR floor that keeps
n ≥ 30 with the best net PnL, −$52.35). Gated cohort n=48 split into chronological
thirds (n=16 each):

| Window | dates | n | WR% | wins | net PnL | beats 23.4% baseline? |
|---|---|---|---|---|---|---|
| W1 | 06-14 → 06-17 | 16 | 50.0 | 8 | −36.88 | yes |
| W2 | 06-17 → 06-20 | 16 | 25.0 | 4 | −25.29 | yes (marginal) |
| W3 | 06-20 → 06-26 | 16 | 31.2 | 5 | +9.81 | yes |

3/3 windows beat the ungated baseline WR — clearing the EXP-003 methodology gate
(2/3 required). But the spread is wide (25.0%–50.0%), only **W3 is net-positive**,
and per-window n=16 is thin. For reference, `signal_score ≥ 70` gives 45.5% /
27.3% / 36.4% (n=11 each) — same instability, all net-negative. The pattern is
**directionally robust but not stable enough** to call an edge.

### Task 6 — `flow_type` filter

Distribution: catalyst_risk 112 (53.6%), trend_initiation 56 (26.8%),
forced_exhaustion 38 (18.2%), market_beta 3 (1.4%).

| flow_type | n | WR% | net PnL |
|---|---|---|---|
| catalyst_risk | 112 | 26.8 | −176.19 |
| trend_initiation | 56 | 23.2 | −24.42 |
| forced_exhaustion | 38 | 10.5 | −25.45 |
| market_beta | 3 | 66.7 | −5.71 |
| **excl. catalyst_risk** | 97 | **19.6** | −55.58 |

Contrary to EXP-003's flag, in this dataset **excluding `catalyst_risk` lowers WR
(23.4% → 19.6%)** — catalyst_risk actually has the second-highest WR here (26.8%).
The worst flow is `forced_exhaustion` (10.5% WR). This reverses EXP-003's pooled
read and confirms flow_type exclusion is not a reliable lever on the current data.

### Task 7 — Signal-vs-noise assessment (best gate, `signal_score ≥ 65`)

- Gated cohort: n=48, 17 wins, **WR 35.42%**; baseline WR 23.44%.
- **Wilson 95% CI on gated WR: [23.4%, 49.6%]** — width 26pp.
- **CI lower bound (23.4%) is NOT > 30%** → fails the SUPPORTED CI requirement.
- CI does **not** reach the 52.8% breakeven (upper bound 49.6%).
- **Cohen's h = 0.264** (vs baseline) — a **small** effect (h<0.2 negligible,
  0.2–0.5 small, 0.5–0.8 medium). The WR lift is statistically *small*, not large.
- For `signal_score ≥ 70`: WR 36.36% (n=33), Wilson 95% CI **[22.2%, 53.4%]** —
  even wider, lower bound below 30%, and the CI now straddles breakeven only
  because the interval is too wide to be informative (Cohen's h=0.284).

The gated win rate is **statistically indistinguishable from a 30% strategy** at
95% confidence, and its lower bound never clears 30%. The effect is real in point
estimate but small and imprecise.

## 4. Verdict

**INCONCLUSIVE.**

Applying the decision rule:
- **SUPPORTED** requires best-gate WR ≥ 40% (n ≥ 30), 2/3 sub-windows beating
  baseline, and 95% CI lower bound > 30%. → **Fails on two counts:** max WR is
  36.4% (never 40%), and the CI lower bound is 22–23% (< 30%). The 2/3 sub-window
  condition *is* met (3/3), but it is insufficient alone.
- **REJECTED** requires no threshold reaching WR ≥ 35% with n ≥ 20. → **Not met:**
  `signal_score ≥ 65` reaches 35.4% at n=48. So this is not a clean rejection.
- Therefore **INCONCLUSIVE**: a real improvement exists (monotonic WR lift, winners
  score higher), but the gated cohort fails the SUPPORTED bar (no 40% WR, CI lower
  bound < 30%, small Cohen's h, never net-positive except one thin sub-window).

The idiosyncrasy lever specifically is **REJECTED** (flat WR across the full sweep,
zero discriminative power, worsens avg net/trade as it tightens).

## 5. What this rules out

- **Idiosyncrasy gating as a win-rate lever** — fully exhausted. The field does not
  separate winners from losers in live data; tightening it only discards trades and
  worsens per-trade expectancy. Do not propose raising `idiosyncrasy_min_score`
  above its current 0.7 to improve WR.
- **A `signal_score` floor as a profitability fix** — even at the most selective
  floor (70, keeping 16% of trades) the book stays net-negative (−$65) and WR caps
  at ~36%, ~17pp short of the 52.8% breakeven. Selectivity cannot close the gap.
- **`flow_type` (catalyst_risk) exclusion** — reverses sign vs EXP-003 on this
  dataset; not a dependable lever.
- **Combined gates** — the idiosyncrasy condition adds nothing on top of the
  signal_score floor; a two-field gate is not worth building.
- Together with EXP-006/007/008, this **closes the analytical entry-selectivity and
  execution levers** on the current ~18-day live + 30-day backtest data. Every
  in-data lever has now been tested: exit clock (EXP-001), R:R geometry (EXP-002),
  selectivity synthesis (EXP-003), TP-distance cap (EXP-004), time-stop/tier
  (EXP-005/006), maker slippage (EXP-007/008), and signal/idio flooring (EXP-009).

## 6. Implementation note

Not SUPPORTED → no parameter change is recommended.

For the record, the schema state (`grep` over `packages/shared/src/schema/`):
- `idiosyncrasy_min_score` **already exists** (`strategyParamsSchema.ts:22`,
  `z.number().min(0).max(1)`, default 0.7 in fixtures). It is consumed by
  `classifyFlowType` (`packages/shared/src/util/classifyFlowType.ts:25`) as a
  flow-classification condition, **not** as a hard pre-entry filter — which is why
  the live dataset is already ≥0.7-skewed and the sweep is flat. Raising it is
  not warranted (Task 3).
- There is **no `signal_score` floor / `min_signal_score` param.** `signal_score`
  is computed in `marketSnapshotSchema.ts:31` but is never used as an entry gate.
  Were a future, larger dataset to revive this lever, adding a `signal_score_min`
  to `strategyParamsSchema` and gating in the strategy entry path would be the
  change — but the current evidence does not justify the shared-schema + engine
  work (the gated cohort is still net-negative).

## 7. Recommended next action

The analytical/backtest data is **exhausted** for entry-selectivity and execution
levers — EXP-001 through EXP-009 have each rejected or failed-to-support every
in-data lever, and all converge on the same root cause: **win rate (~23% backtest /
~25–29% live) is far below the ~52.8% breakeven, and no entry filter, exit clock,
geometry, tier cut, maker variant, or signal/idio gate available in the current data
closes that gap.**

Recommended:
1. **Stop running analytical experiments on the current dataset** — it cannot
   produce a SUPPORTED profitability result; the levers are mined out.
2. **Run a longer forward paper/soak on the current best defensive configuration**
   (tier1-only per EXP-006, which is the only loss-reducing change with 3/3
   sub-window support) to accumulate a larger, single-version live dataset with
   `signal_score_at_entry` captured. The v3+v16 confound and the n=33–48 gated
   cohorts are the binding limitation here; only more *same-version* live data can
   resolve whether the weak `signal_score` edge (TP 61.4 vs losers ~55, Cohen's
   h=0.26) is real or sampling noise.
3. **Re-open the `signal_score` floor only when a single strategy version has
   ≥150 closed positions with `signal_score_at_entry`** — at that n the Wilson CI
   on a 36% gated WR would narrow enough to test the SUPPORTED CI-lower-bound>30%
   condition that this experiment could not clear.
4. Treat the strategy as **not yet validated for go-live size increases**; the
   binding constraint is structural win rate, which requires a new *signal*
   (different entry trigger or regime model), not further filtering of the existing
   one.

---

*Method: pure analytical re-compute on 209 closed live positions (Python over a
CSV export of the `positions` table); no source code or strategy params changed.
Wilson score interval and Cohen's h computed from the raw win/loss counts.*
