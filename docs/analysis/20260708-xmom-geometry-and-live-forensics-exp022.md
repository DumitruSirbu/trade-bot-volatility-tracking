# EXP-022 — xmom geometry and live forensics: is the loss fixable via exit mechanics or is it the signal?

**Date:** 2026-07-08  
**Status:** REJECTED — **The binding constraint is the SIGNAL, not exit mechanics.** Broad-spectrum counterfactual testing (force_close causality, held-open paths, spot-vs-futures, DCA, and geometry sweep) proves that widening stops, switching venues, or averaging down do NOT recover edge. The 30-month out-of-sample geometry sweep (22 cells, 10 independent folds, same harness as EXP-021) shows all variants net-negative; improvement is a bull-window artifact. This analysis rules out a family of exit-focused hypotheses and confirms that the only untested lever is a genuinely different signal.  
**Type:** Multi-angle read-only investigation (live-soak clean split, R:R-at-fill forensics, counterfactual forward simulation, geometry sweep). No positions opened, no code touched, no sims committed.  
**Auditor:** `bot-review-quant` (verdict SOUND, no blockers; quant reviewer hit session limit on the geometry sweep; orchestrator completed the read-only audit).

---

## 1. Motivation

EXP-021 found xmom's live parameters are a FRAGILE PEAK: only 1/10 independent quarter-folds net-positive under both base and harsh cost tiers; aggregate −$3014 USDT over 30 months. The user's question: **Is the loss really the underlying signal, or is it fixable via exit mechanics — force_close behavior, stop width, or switching futures→spot?**

This note tests each hypothesis independently. Final verdict: it is the SIGNAL. Five independent angles agree.

---

## 2. Live-soak clean split (scheduled vs manual) — 2026-07-02→07-08, 92 closed positions

Headline live PnL was +10.57 USDT over 92 closed positions, but this is contaminated by manual user rebalance triggers. The user manually fired many beyond the scheduled daily cron (~01:07 UTC). Split by `trigger_source`:

**Scheduled (cron, the real strategy):**
- Opens: 21
- Net PnL: −53.57
- Exit breakdown: 1 TP / 6 SL / 14 force_close
- Win rate: 5% (1/21)
- Force_close rate: 67% (14/21)

**Manual (user-fired):**
- Opens: 71
- Net PnL: +64.13
- Exit breakdown: 10 TP / 12 SL / 49 force_close
- Win rate: 14% (10/71)
- Notes: Carried by outlier pumps (TLM alone +72.50; net-of-TLM negative)

**Finding:** The clean strategy (scheduled) LOSES (−53.57). The headline +10.57 is manual-trigger noise. The +14% win rate on manual is not a control group — user-fired triggers are adversarially timed to catch visibly-trending names. Force-close rate on the clean sample is 67% (14/21).

---

## 3. Force_close root cause proven — it's an OPEN-time math defect (extends EXP-018)

For the scheduled longs, realized R:R at ACTUAL fill price by exit reason:

| Exit reason | n | avg R:R at fill | range |
|---|---|---|---|
| force_close | 14 | **1.03** | all ≤ 1.5, max 1.47 |
| stop_loss | 6 | 1.96 | ≥1.5 |
| take_profit | 1 | 1.55 | — |

**Razor-sharp split at the 1.5 guard floor.** Mechanism: geometry is armed at exactly 1.5 R:R against the 5m close at signal, then adverse entry fill slippage drops realized R:R below 1.5, and the fill guard (`degenerate_geometry_at_fill`) rejects → force_close. 

**Proper fix (architect-owned):** compute the armed geometry against an EXPECTED fill price (signal + expected slippage/half-spread, using the already-captured `spread_at_entry_pct` / `book_depth_10bps_at_entry`) BEFORE opening, so an order is armed honestly or never sent — no open-then-reject fee churn. This stops fee bleed and improves correctness/measurement.

**IMPORTANT caveat:** this fix improves correctness and stops fee bleed, but does NOT create edge (see §6).

---

## 4. Counterfactual: what would the force-closed positions have done if held? (READ-ONLY, DB 5m candles)

For the 14 scheduled force-closed longs, simulated forward from `opened_at` over 24h:

| Scenario | Outcome |
|---|---|
| Actual (force-closed) | −2.7 (fee only) |
| Held to armed TP/SL | 6 TP / 8 SL, total −65.97 |
| Held 24h no-stop (spot buy-and-hold style) | 7 up / 7 down, total −440.85 (craters: TAC −91%, MAGMA −25%) |

**Conclusion:** the force-closed positions would have lost MORE, not less. Force_close is not hiding profit; it cut losers early. Reducing force_closes by admitting more of these trades would INCREASE losses.

---

## 5. Spot-vs-futures + DCA counterfactual (21 scheduled longs, 6-day window, fixed levels)

Same 21 scheduled positions, 6-day window, re-priced under alternative mechanics:

| Scenario | Net PnL |
|---|---|
| Futures actual (tight ATR stop) | −53.57 |
| Spot sell-stop −20% / TP +20% | +106.05 |
| Spot DCA average-down −20% (no stop) | −651.38 (martingale into craters) |

**Interpretation, no spin:**

(a) **The +106 is a STOP-WIDTH effect** (wide vs xmom's tight ~2×ATR stop), NOT a spot-vs-futures effect. At 1× leverage, spot and futures trade the identical price; a spot sell-stop −20% == a futures stop-loss at −20%; you'd get the same +106 result on futures 1×.

(b) **Fee premise correction:** Binance spot taker ≈0.10% > futures taker ≈0.04% + ~0.01–0.03% funding for a 1-day hold. Spot is MORE expensive at daily cadence; it only wins on multi-week holds.

(c) **DCA is decisively dangerous** (−651).

(d) **n=21 over 6 mostly-bullish days = a hypothesis, not a conclusion** → the geometry sweep (§6) is the decisive test.

---

## 6. EXP-022 geometry sweep — the decisive 30-month out-of-sample test

Extended the audited EXP-021 walk-forward harness (same 92-name universe, 10 independent quarterly folds, 3 cost tiers, funding, MTM DD, determinism); added a TP intra-period exit with a PESSIMISTIC same-bar tie-break (stop assumed first). Signal held at live baseline (long-only, top-3, 24h/24h); ONLY exit geometry varied.

Swept **Family A** (ATR stop 2/3/4/6× × TP forward/1.5R/3.0R/4.5R) and **Family B** fixed-% (−8/+15, −15/+20, −20/+20, −20/+30, −10/noTP, none/+20).

### Results

**VERDICT: BULL-WINDOW ARTIFACT.** All 22 cells net-negative.

| Variant | Folds positive | Net aggregate | Regime split |
|---|---|---|---|
| **Baseline (2.0×ATR/noTP)** | 1/10 | −3014 | UP −0, DOWN −272, CHOP +1687 |
| Best aggregate: 6.0×ATR/noTP | 1/10 | −1598 | — |
| Best survival: 4.0×ATR/4.5R | 3/10 | −2318 | — |
| Family B best: −20/+30 | 2/10 | −2068 | — |
| Family B best: none/+20 | 2/10 | −2036 | — |

**Per-regime for the best improver (baseline vs best):** The improvement is churn-reduction in chop/bear, ZERO gain in bull quarters. The big BTC-UP quarters (2024-Q1 +67.9%, 2024-Q4 +47.3%, 2025-Q2 +29.7%) stay net-negative under EVERY geometry (momentum-crash mean-reversion no stop width fixes). Widening reduces the bleed but never creates edge and never reaches ≥7/10 across regimes.

**Reproducibility:** Determinism sha256 (byte-identical rerun): `xmom-geometry-canonical.json = 43312b4a58f8cf451c731b67676274a03fb8151c7472959b74d49515e3372bc9`.

**Audit note:** The quant reviewer hit a session limit; the orchestrator (Opus) completed the read-only audit — VERDICT SOUND, no blockers, no look-ahead in the new TP logic, baseline faithful, the pessimistic tie-break does NOT mask a wide-geometry benefit (a 1h bar spanning both a −20% stop and +20% TP needs ~40% range → essentially never), costing has no double-count, determinism byte-identical.

---

## 7. Verdict & rules-out

**The binding constraint is the SIGNAL** — "buy the 24h top gainers" — **not the venue, not leverage, not stop width, not force_close.** Five independent angles agree: EXP-021 offline (−3014), clean scheduled live (−54), R:R-at-fill proof, held-open counterfactual (−66/−441), and the geometry sweep. 

**Rules out (precise/negative):**

- **Do NOT pursue widening stops/TP as a fix** (bull-window artifact; all 22 cells net-negative; chop-regime churn reduction is orthogonal to UP-regime edge, which does not exist).
- **Do NOT switch futures→spot expecting edge** (stop-width not venue; spot fees higher at daily cadence; the 6-day spot flip is small-sample bull-week luck).
- **Do NOT average-down/DCA** (martingale, −651).
- **Do NOT read the 6-day spot flip as tradable** (n=21 over mostly-bull window).

**Still-valid SEPARATE action:** fix the R:R-at-open math (expected-fill geometry) for correctness + clean measurement + stop fee bleed — but it will NOT create edge.

**The only untested lever is a genuinely different signal**, not another exit rule on the same signal.

---

## 8. Assumptions & approximations (audit this)

The geometry sweep is a **reimplementation-not-live-code** walk-forward over 30 months:

- **Survivorship-biased 92-name universe** (optimistic for long-only; delisted coins excluded).
- **Daily/1h-bar approximation of the live 5m lookback/ATR** — harness uses 1h candles; live ranks on 5m. This is conservative (fewer reranks, less slippage churn).
- **Live-soak sample is tiny** (21 scheduled opens / 6 days) and the counterfactual force-closed subset skews to thin high-slippage names (directional, not definitive).
- **The 6-day spot window was mostly bullish** — not representative of longer regimes.
- **New pessimistic same-bar tie-break biases wide-TP cells slightly down** (safe direction).
- **Past ≠ future** — regime shifts and decay documented in EXP-020 mean future distribution is unlikely to match 30-month retrospective.
- **Any change is a shadow-test hypothesis only.** This study does NOT feed into live parameters directly.

**Raw artifacts (gitignored):** sims/xmom-validation/xmom-geometry-sweep-sim.mjs, xmom-geometry-sweep-results.md, xmom-geometry-canonical.json.

---

## Cross-links & consistency notes

- **EXP-021:** Walk-forward robustness gate (current live params are FRAGILE PEAK, only 1/10 folds positive).
- **EXP-018:** Force-close root cause (entry/guard threshold coincidence, zero slack on thin coins).
- **EXP-020:** Short-leg decay (LONG +1.52%/pd, SHORT +0.31%/pd, both negative in latest window).
- **DEC-001:** 24h cadence decision (reject sub-24h, use offline candle sweep for go/no-go).

All findings align: the SIGNAL is the problem, not the venue, timing, or exit rules.
