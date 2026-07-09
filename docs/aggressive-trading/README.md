# Aggressive-Bot Research — Candidate Screening

This directory documents the systematic screening of five directional trend-following candidates for a separate aggressive crypto trading bot. All five candidates have been evaluated on the same 30-month higher-timeframe dataset (2024-01 → 2026-06, 1h/4h/1d). **ONE lead survives: Candidate B (EMA regime flip), currently PROMISING but NOT YET VALIDATED.**

---

## Candidate Summary

| Candidate | Detector | Status | Key Finding |
|-----------|----------|--------|-------------|
| **A** | Donchian/Turtle breakout | ❌ NON-VIABLE | No underlying edge (1d cost-free breakout only, short-only DOWN effect). Higher timeframes cure turnover but reveal no signal. |
| **B** | EMA regime flip (two-sided) | 🟡 PROMISING (partial OOS) | **FIRST aggressive candidate with cost-surviving edge.** 18/36 configs robust. All 12 daily configs net +2%–+29%, gPF 1.28–1.77. **Partial walk-forward validation: 5/10 folds** positive under both tiers; aggregate PnL positive across UP/DOWN/CHOP. Real trend edge but quarter-sensitive; not yet validated. Requires further stage: fresh universe, new macro epoch, testnet paper, parameter-stability. |
| **C** | Cross-sectional momentum + regime tilt | ❌ NON-VIABLE (0/10 folds OOS) | Initial 37-day positive was path-fitting. Multi-window walk-forward: 0/10 quarters net-positive under realistic costs. DOWN-regime edge was a temporary calendar coincidence, not reproducible. |
| **D** | TSMOM + vol-targeting | ❌ NON-VIABLE | 0/48 configs net-positive. Best: −13.73%/−20.02% harsh. Carries more turnover than B (3k–8.9k daily trades vs B's ~200–800) for the same trend exposure; strictly dominated by B. |
| **E** | Breakout + OI/funding confirmation | ⏸️ DEFERRED (OI-limited) | Data gap: Binance public dumps do not retain long-history open-interest. Deferred indefinitely unless OI vendor becomes available. |

---

## How We Got Here: The Screening Gauntlet

1. **Initial hypothesis (37-day, 5m timeframe):** Four candidates (A–D) were sketched on theoretical grounds, then screened on 37 days of intraday data. Result: all cost-dominated, no clear winner.

2. **Data acquisition:** Binance public monthly kline dumps (2024-01 → 2026-06, 1h/4h/1d + funding) acquired to enable fair testing at slower timeframes where signal/cost trade-offs clarify.

3. **30-month sweep:** A, B, C, D re-tested at realistic higher timeframes (1h/4h/1d). A and C confirmed non-viable with certainty; B and D emerged as candidates.

4. **10-fold walk-forward validation (Candidates B and C):** C was carried forward as the "prior favourite" (best 37-day config); walk-forward falsified it (0/10 folds). B was carried forward; walk-forward partially validated it (5/10 folds).

5. **Final verdict (cross-candidate comparison):**
   - **B** cleared the out-of-sample gate that killed C (5/10 vs 0/10 folds).
   - **A** has no edge underneath the cost wall, even at 1d.
   - **D** carries more turnover than B for the same directional trend factor; strictly dominated.
   - **E** cannot be tested without OI history.

---

## The B Thesis: Why It's the Only Lead

Candidate B (10-EMA vs 20-EMA regime flip, two-sided, daily timeframe) is special because:

1. **Real gross edge:** 36/36 configs gross-positive, gPF up to 1.77 — unlike A/C/D, B has a genuine pre-cost trend signal.

2. **Cost-surviving:** All 12 daily configs net-positive under BOTH base (15/40 bps) and harsh (20/60 bps) slippage tiers. Cost drag only 2.35%–6.13% on daily (vs D's 21.4%–139%, A's 66–155% at 5m, C's 57–71% at 8h).

3. **All-regime edge:** On 1d, the EMA flip edge is positive in UP, DOWN, AND CHOP (aggregate: UP 8024 / DOWN 4205 / CHOP 2161 USDT) — not a down-leg artifact like A and C.

4. **Partial out-of-sample validation:** Best configs survive 5/10 independent quarterly folds under both tiers (7/10 at optimistic slippage). Aggregate PnL positive across all regime buckets across folds. **DECISIVELY beats C's 0/10 and A/D's non-existent cost edge.** But does NOT reach a robust ≥7/10 majority; quarter/regime-sensitive.

5. **Short leg additive:** On the daily grid, the two-sided short leg ADDS net return (6/6 pairings) and survives MORE out-of-sample folds than long-flat configs — validating the "aggressive two-sided" thesis on slow timeframes.

---

## B's Caveats (Why It's NOT Green Yet)

1. **Single survivorship-tilted universe:** 20 names with ≥28 months history (liquid survivors). Delisted small-caps and names that graduated from tier-2 are missing.

2. **Single macro epoch:** 2024–26 is one mostly-uptrend crypto macro span. No evidence of robustness to a bear-dominated or mean-reverting epoch.

3. **Quarter-sensitive:** Half the quarters still net-negative after harsh costs. A run of bad quarters is entirely possible; not a "validated" edge.

4. **MTM drawdown ~15–25%:** Real intra-trade peak-to-trough under a survival-first mandate requires proper sizing and risk controls.

---

## Recommended Next Step (B Only)

If B warrants further development in a separate bot repo:

1. **Fresh, expanded universe (delisted recovery):** Include names that were in the universe during 2024–26 but are no longer listed, to address survivorship bias.

2. **Different macro epoch (if obtainable):** A 2022–2024 bear-biased period or a longer 2020–2026 span spanning boom/bust cycles would test regime-robustness.

3. **Live-testnet paper trading:** Minimal size on Binance Testnet (or demo trading) to validate live fill modeling, slippage realism, and no regressions from the sim environment.

4. **Formal parameter-stability analysis:** Sweep sensitivity of the EMA pairs (8/21, 10/20, 20/50, +200 filter variants) to confirm the edge is not brittle to small changes.

5. **Independent review:** Before any capital, the sim assumptions (gap-aware stops, vol-targeting target-vol, regime anchoring, cost tiers) should be audited by a second quant engineer.

---

## Through-Line: Crypto Aggressive Strategies Are Cost-Bound

Across all five candidates, the pattern is clear:

- **Transaction cost is the binding constraint.** On liquid USDT-M perps, turnover × basis-point slippage annihilates weak-to-moderate signals.
- **Solution: slower timeframes.** Daily EMA flip costs ~2–6% drag vs intraday 80–230% drag.
- **One edge survives cost + out-of-sample:** a LOW-TURNOVER daily trend-following signal (B). Breakout (A), cross-sectional momentum (C), and per-asset TSMOM (D) all failed the cost + robustness bar.
- **The aggressive-bot hypothesis, revised:** There IS a repeatable directional edge on liquid USDT-M perps — but it is a daily-timeframe trend flip, must be sized conservatively under a survival mandate, and is quarter/regime-sensitive, not a validated safe edge yet.

---

## Files in This Directory

- **[candidate-strategies.md](candidate-strategies.md)** — Detailed specifications and results for all five candidates (A–E). Start here to understand each detector family.
- **[data-requirements.md](data-requirements.md)** — Data acquisition strategy, the 30-month history pull, and what was resolved (A–D screened, E OI-limited).
- **[candidate-a-simulation.md](candidate-a-simulation.md)** — Full Candidate A offline feasibility sim (37-day + 30-month re-test).
- **[candidate-c-simulation.md](candidate-c-simulation.md)** — Full Candidate C offline feasibility sim + 10-fold walk-forward.
- **`sims/candidate-b/candidate-b-results.md`** (gitignored) — 30-month sweep results for B (1h/4h/1d, 36 configs).
- **`sims/candidate-b/candidate-b-walkforward-results.md`** (gitignored) — 10-fold out-of-sample walk-forward for B's daily configs.
- **`sims/candidate-d/candidate-d-results.md`** (gitignored) — 30-month sweep results for D (1h/4h/1d, 48 configs).

---

## Key Decision: Separate Bot Repo

If Candidate B advances to further validation:

- **Do NOT merge into this repo's engine or xmom soak.** Conservative (VWAP reversion) and aggressive (daily trend) strategies carry orthogonal risk; live capital on one should not contaminate calibration/deployments of the other.
- **Implement in a standalone aggressive-bot repository** with its own full stack (data, backtester, live orchestration), independent risk gates, and explicit out-of-sample validation gates for each new deployment.
- **Share infrastructure:** reuse this repo's `packages/shared/` types, Postgres schema extensions (if needed), and exchange-layer constants; diverge only in strategy logic and risk policy.

---

## Historical Note

This investigation was initiated to answer whether the conservative xmom bot's profitability could be improved via a directional aggressive counterpart. The answer: one promising lead (B), but it requires a separate codebase, its own validation pipeline, and careful sizing under a survival-first mandate. It is not a quick "upgrade" to the existing engine.

See `docs/analysis/README.md` (hypothesis registry) and the memory index for cross-references to EXP-011–016 (conservative momentum research) and the original VWAP retirement that prompted this investigation.
