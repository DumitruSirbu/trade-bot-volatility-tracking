> **EXP-003 — INCONCLUSIVE / SEEDING** | 2026-06-23 | [back to index](README.md)

# Win-rate improvement analysis — 20260623-1914

Synthesis of the time-stop sweep, the reward:risk sweep, and a win-rate decomposition of the
active strategy (**v2 momentum**, `strategy_versions_id=3`). Purpose: seed a milestone of
*potential* improvements, with each idea tagged by how strong the evidence is.

**Data:** real closed positions for v2 momentum (active), `opened_at` 2026-06-11 → 2026-06-23,
n=188 (175 with idiosyncrasy captured). Shadow simulated fills for v0/v1/v3 used where noted.
Single ~2-week soak window — everything here is **hypothesis-grade**, not decision-grade.

> **Version naming (avoid confusion):** the *active/live* version is **v2 momentum** (id=3).
> v1 mean-reversion (id=2) and v3 hybrid router (id=4) run in shadow only. "v3" in earlier
> chat loosely meant the active version — it is actually v2.

---

## 1. The binding constraint is win rate — confirmed, not geometry

Two prior sweeps (`docs/analysis/timestop-sweep-*.md`, `rr-sweep-*.md`) established:

- **Time stop** (15/30/45/60 min): widening does not help; 15-vs-30 (same trade set) degrades
  expectancy. Not the lever.
- **TP:SL ratio** (0.5→2.0, risk-sized): realized RR rises 0.76→1.23 and drawdown falls, but
  **expectancy stays negative at every ratio** because win rate falls in lockstep. Not the lever.

At the realized reward:risk (~1.2), **breakeven needs ≈45% win rate**. The active strategy runs
~25–29% (real) / ~19–22% (backtest). **The entire gap is win rate.** Everything below is about
raising it.

---

## 2. Win-rate decomposition — where the winnable trades live (v2, 30d)

**By flow type:**

| flow_type | n | win% | avg PnL |
|---|---:|---:|---:|
| **trend_initiation** | 36 | **38.9%** | −0.38 |
| catalyst_risk | 122 | 27.0% | −1.60 |
| forced_exhaustion | 27 | 25.9% | −0.78 |
| market_beta | 3 | 0% | −1.90 |

**By idiosyncrasy** (gate currently 0.5): 0.75–1.0 → **30.4%** (n=148); 0.50–0.75 → **14.8%** (n=27).

**By signal_score** (0–100): 27–40 → 11.8% (n=17); 40–59 → 29.7% (n=91); 60–77 → 28.6% (n=49);
80–100 → 33.3% (n=18). Weak but monotonic.

**By side:** long 28.9% vs short 28.4% — **no edge in direction.** **By tier:** tier1 29.8% > tier2 26.6%.

**Combined "core":**

| subset | n | win% | avg PnL | total |
|---|---:|---:|---:|---:|
| **trend_initiation + idiosyncrasy ≥ 0.75** | 27 | **44.4%** | −0.07 | −1.91 |
| everything else ("rest") | 148 | 25.0% | −1.46 | **−216.13** |

Pooled, the core is at breakeven (~44% win) and the *rest* carries essentially all the loss (−216).

---

## 3. Sub-window validation — the core is NOT yet robust (key caveat)

Splitting the window into disjoint sub-windows tells a more sober story than the pooled number:

| window | CORE n | CORE win% | CORE avg | REST n | REST win% | REST avg |
|---|---:|---:|---:|---:|---:|---:|
| 06-11→14 | 0 | — | — | 4 | 75.0% | +1.12 |
| 06-15→18 | 14 | **28.6%** | **−2.71** | 83 | 20.5% | −1.57 |
| 06-19→23 | 13 | **61.5%** | **+2.77** | 61 | 27.9% | −1.48 |

- The core's pooled 44%/breakeven is **carried almost entirely by window 3**. In window 2 the core
  *underperformed* (28.6% win, −2.71 avg — worse than the rest). The edge is **unstable across
  sub-windows** and the per-window n (13–14) is too small to be conclusive. This is exactly the
  overfitting risk that multi-feature slicing on a few hundred trades creates.
- **What IS robust:** the *rest* loses in every window (20–28% win, −1.46 pooled, −216 total).
  Cutting the rest is the high-confidence improvement, independent of whether the core is profitable.

**Read:** trend_initiation + high idiosyncrasy is the *most promising* and *directionally correct*
subset (it's the only thing near breakeven, and the direction matches design intent — genuine
new-money momentum on idiosyncratic moves). But it is **not a validated edge yet** — do not build a
milestone that assumes it prints money. Build to cut the proven losers and gather more soak on the core.

---

## 4. Fade vs follow (shadow version comparison) — reversion is NOT the fix

Shadow simulated fills, non-missed closed only (data is sparse — most shadow fills are "missed"
wrong-side/low-fidelity, and the active v2 does not surface in the clean shadow-closed set):

| flow_type | v1 reversion | v3 hybrid |
|---|---|---|
| trend_initiation | 0% (n=3) | 44.4% (n=9) |
| forced_exhaustion | 0% (n=7) | 0% (n=1) |
| overall | **0% (n=14)** | 40% (n=10) |

- **v1 mean-reversion won 0 of 14** on this trigger set → *fading* these signals is not the answer;
  the momentum direction is fine. The problem is signal *selection*, not direction. (Thin — n=14 —
  but it actively discourages a "switch to fade" milestone.)
- v3 hybrid router shows ~40% on n=10 — interesting but far too thin to act on.
- **Caveat:** shadow ledger volume is too low here for a decisive version comparison; a proper
  `compareVersions` run once shadow close-fidelity improves would firm this up.

---

## 5. Proposed milestone — improvements ranked by evidence strength

**Tier A — robust, low-regret (cut the proven bleed):**
1. **Tighten flow-type selectivity further.** M43-D1a already skips `catalyst_risk`. Extend to skip
   / heavily demote `market_beta` (0% win) and `forced_exhaustion` (26%). Keep `trend_initiation`.
2. **Raise the idiosyncrasy gate 0.5 → ~0.75.** The 0.50–0.75 band wins only 15%; all the signal is
   above 0.75. (Validate the exact cut on the miss-distribution before hard-coding — don't pin 0.75
   off this sample.)
3. **Add a signal_score floor (~45–50).** Cuts the 12%-win bottom bucket.

**Tier B — promising, validate first (do not assume profitable):**
4. **Concentrate capital on `trend_initiation + idiosyncrasy ≥ 0.75`**, but only after the core's win
   rate is confirmed across ≥3 disjoint sub-windows with ≥30 trades each. Right now it's breakeven
   pooled and unstable per-window.

**Tier C — structural hypothesis, untested here but well-motivated:**
5. **Entry timing / pullback entry.** Trades show MAE (−1.08%) ≫ MFE (+0.37%): price moves *against*
   the position immediately after entry — consistent with filling at next-bar open *into* the
   exhaustion of the 5m VWAP spike. A retrace/pullback entry (don't buy the spike top) would attack
   the immediate-adverse-excursion problem and could lift win rate across all buckets. Needs a
   dedicated backtest (a new entry rule, not a parameter).

**Tier D — separable correctness fix (not a win-rate lever, but real):**
6. **Sizer/stop mismatch** (logged in `docs/tech-debt.md`): the sizer risks off 1.5×ATR while the
   actual VWAP stop is ~4×ATR, so the live strategy over-risks ~2.7× its intended per-trade budget on
   a full stop-out. Fix independently of the above.

**Explicitly NOT recommended:** adjusting the time stop, or re-tuning the TP:SL ratio for
profitability — both ruled out by the sweeps.

---

## 6. What to validate before committing the milestone

- Re-confirm the Tier-A selectivity gains and the Tier-B core across **2–3 disjoint sub-windows**
  and ideally a fresh soak fortnight (current evidence is one window; the core is window-3-heavy).
- Quantify how much volume Tier-A/B selectivity removes (funnel impact) — over-tightening can starve
  the book; check the trade rate stays viable for the 1-position live cap.
- For Tier C, build the pullback-entry variant and backtest it head-to-head (same harness pattern as
  the sweeps) before any live change.
- All backtest figures inherit the known calibration gaps (BTC index-shock understated, ETH leg dead,
  modelled fills); trust *relative* rankings over absolute PnL.
