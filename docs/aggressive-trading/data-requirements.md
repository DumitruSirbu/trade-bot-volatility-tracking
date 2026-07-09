# Data Requirements for Aggressive-Strategy Simulation — RESOLVED

**Status:** ✅ DONE — **30-month 1h/4h/1d + funding acquired & re-tests completed.**
**Owner persona:** Trend-Surge (aggressive directional book).
**Date raised:** 2026-07-06 · **Updated:** 2026-07-07 (both candidates re-tested)

> **Outcome:** The acquisition (Binance public dumps, 2024-01 → 2026-06, 1h/4h/1d + funding, 326 symbols tracked ≥28mo) was completed and both aggressive candidates (A and C) were re-tested on longer history and higher timeframes. **Both verdicts came back NEGATIVE and are airtight:** Candidate A survives the cost wall at 1d but has zero tradable edge underneath (DOWN-regime-only short effect, too small to matter). Candidate C does not survive out-of-sample walk-forward testing (0/10 folds net-positive at realistic costs). More data and higher timeframes did NOT flip the verdicts; they **confirmed them** with out-of-sample rigor.

---

## What the data acquisition revealed (closed question)

Both aggressive candidates were re-tested on longer history and higher timeframes:

- **Candidate A** rescoped to 1h/4h/1d on 30 months → **non-viable**. Turnover-cost wall is solved (slower TF = 10–50× less churn), but there is no edge underneath. After gap-aware stop fills, net returns are break-even-to-negative under all cost tiers, concentrated entirely in a DOWN-regime short effect (same as Candidate C's down-leg artifact). Long breakout side does not pay.
- **Candidate C** walk-forward tested across 10 independent calendar-quarter folds (2024-Q1 → 2026-Q2) → **does not survive out-of-sample**. 0/10 folds are net-positive under realistic slippage tiers (base 15/40 bps, harsh 20/60 bps). The single-window 37-day positive was a path fit on one specific calendar window, not a reproducible regime effect. MORE data and HIGHER timeframes did NOT flip either verdict — they **confirmed them** with out-of-sample rigor.

**The fundamental finding:** transaction cost *was* the binding constraint, but its solution (slower timeframes, longer history) revealed that there is no durable directional edge to recover. Both A and C fail not from insufficient data, but because the underlying signals are too weak or too regime-specific to survive honest costs.

---

## Why longer history + higher-timeframe testing was necessary (and what it proved)

The original 37-day / 5m dataset was sufficient to *run* a sim but not sufficient to *believe* one:

- **Candidate A at 5m:** 800–1,550 trades/37 days → 66–155% cost drag destroys net return. The hypothesis was "slower timeframe fixes turnover cost." Testing 1h/4h/1d required **≥120 days of actual higher-TF candles** (not synthetic resamples), and 30 months of 1d candles gave us ~500 bars — enough to form valid 20/55-bar channels and measure edge. **Outcome:** cost wall is breached (1d drag → 2.35%), but no edge exists underneath.
- **Candidate C at 8h rebalance:** the single 37-day window was four thin regime buckets (7–10 days each). A 5-year old UP-regime win and a temporary DOWN-leg coincidence can feel like an edge on one calendar arc. **Out-of-sample validation needed** 10 independent quarterly folds spanning different BTC regimes. **Outcome:** config fails out-of-sample in every quarter; the initial 37-day positive was overfitting to one path.

**Conclusion:** More data did not *flip* the verdicts; it *confirmed* them. The rescue hypotheses for both A and C had internal logic ("slower timeframe saves turnover" / "multi-window testing de-confounds regime from edge"), but both were falsified by the data they claimed would help.

---

## What to acquire (draft spec — refine before actioning)

| Dimension | Current | Needed |
|-----------|---------|--------|
| **Timeframes** | 1m, 5m | **+ 1h, 4h, 1d** (for slow-channel / long-hold strategies) |
| **History depth** | ~37 days | **≥ 1–2 years** (multiple BTC/ETH regime cycles: bull, bear, chop) |
| **Universe** | 327 USDT-M perps | Same, **plus delisted/graduated symbols** over the period (survivorship) |
| **Funding** | 37 days | Matching full-history funding rates (cost model) |
| **Open interest** | 37 days | Matching full-history OI (needed for Candidate E) |

### Acquisition options (evaluated — primary path now BUILT)
- **Binance public data dumps** (`data.binance.vision`) — ✅ **implemented.** Bulk
  historical klines (all timeframes) + funding archives; free, no API keys, no rate
  limits. Layout confirmed via context7 + live probe:
  `data/futures/um/monthly/klines/{SYMBOL}/{tf}/{SYMBOL}-{tf}-{YYYY-MM}.zip` and
  `.../fundingRate/...`. Downloader: `sims/history/download_binance_history.mjs`
  (parameterized by symbols/timeframes/date-range, idempotent, writes a manifest).
- **Resampling the existing 1m/5m** — ✅ implemented (`sims/history/resample_1m.mjs`);
  produced 1h/4h for all ~329 symbols over the current 37-day window. Good for smoke-
  testing higher-TF mechanics, but **adds NO history** — cannot rescue A or de-confound
  C on its own. Stopgap only.
- **ccxt `fetchOHLCV` backfill** — remains the fallback for any gaps the bulk dumps miss;
  not needed so far.

> **⚠️ Open Interest is still the gap.** OI history is NOT in the data dumps and Binance
> REST only retains ~30 days, so **Candidate E (breakout + OI/funding) stays OI-limited**
> even after the full kline/funding pull. Long OI history needs a paid vendor or a
> forward-running collector.

> ⚠️ Any acquisition is a READ-only, additive concern for a **separate aggressive-bot
> repo**. It must NOT touch this repo's engine, migrations, or the live xmom soak DB.
> Historical candles for the aggressive research belong in their own store.

---

## What this proved (Candidates A and C are closed)

**Candidate A (1h/4h/1d re-scope):** CLOSED — non-viable. Turnover-cost rescue is confirmed real, but there is no underlying edge. After gap-aware stop fills, the best config (1d N55/exit20) clears the cost wall but lands net −2.19%/−2.90%. The entire positive signal is DOWN-regime-specific (shorting fallen alts when BTC declines) — the same down-leg artifact Candidate C surfaced. Long breakout side never pays, confirming breakout trending does not work on liquid USDT-M perps. **Verdict: do not carry forward.**

**Candidate C (10-fold walk-forward):** CLOSED — does not survive out-of-sample. The winning config from the improvement sweep (LS tilt L72 R24 2×) was carried forward specifically to falsify a hypothesis: *Does the DOWN-regime microcap-short edge persist across independent windows?* Walk-forward answer: **no**. 0/10 folds are net-positive at realistic costs; 2/10 at unrealistic optimistic slippage, both in bearish backdrops. The original 37-day positive was path-fitting, not a repeatable regime effect. Aggregate DOWN-bucket net is the LARGEST loser (−2564 USDT across 10 folds), contradicting the single-window narrative. **Verdict: do not carry forward.**

---

## Remaining candidates — RESOLVED (B and D re-tested, E OI-limited)

The 30-month higher-TF data enabled *fair* testing of **Candidates B and D**:

- **Candidate B (EMA regime flip, two-sided):** RE-TESTED on 30 months at 1h/4h/1d. RESULT: **PROMISING but NOT YET VALIDATED.** 18/36 configs robust net-positive; ALL 12 daily configs net +2%–+29%, gPF 1.28–1.77. The ONLY aggressive candidate with a cost-surviving, all-regime daily trend edge. Walk-forward: best configs pass 5/10 folds net-positive under both tiers, aggregate PnL positive across all regimes. Real edge but quarter-sensitive; requires further validation stage (fresh universe, new macro epoch, testnet paper, parameter-stability testing) before any capital.

- **Candidate D (TSMOM + vol-targeting):** RE-TESTED on 30 months at 1h/4h/1d. RESULT: **NON-VIABLE. REJECTED.** 0/48 configs net-positive under both tiers. Best: net −13.73%/−20.02% harsh, gPF 1.09. Carries more turnover than B (3.1k–8.9k trades on 1d vs B's ~200–800) for the same trend exposure; strictly dominated by B's cleaner EMA signal. Do NOT carry forward.

**Candidate E (Breakout + OI/funding confirmation):** remains **OI-LIMITED**. Binance public dumps do not retain long-history OI (REST retains ~30 days only); deferred indefinitely unless a vendor becomes available.

**Final disposition:** A/C/D all screened and rejected; B survives to partial OOS validation (5/10 folds) and is the sole lead for further development. Implementation belongs in a separate aggressive-bot repository (not this engine), with explicit regime segmentation and ongoing out-of-sample validation gates through the validation stage.

---

## Through-line: aggressive strategies on liquid USDT-M perps are cost-bound

Across A and C at both 37-day and 30-month scales, the pattern holds: (1) transaction cost is a solvable problem (slower timeframe, lower rebalance frequency fixes it), but (2) once cost is solved, there is no durable directional edge — the only positive signals are regime-conditional artifacts (A & C: short beaten-down alts on BTC down-legs) that are too small to bank. **Longer data and higher timeframes did not discover a new edge; they confirmed the absence of one.**

This does not preclude Candidates B and D from succeeding — both are lower-frequency and less regime-dependent in theory — but it raises the bar: any candidate now must show profit factor > 1.3 and regime-independent Sharpe > 0 across multiple independent windows to survive the cost wall that killed A and C.
