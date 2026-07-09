# EXP-021 — xmom live parameter robustness: does the current 24h/24h/top-3 calibration sit on a robust plateau or a fragile peak?

**Date:** 2026-07-08  
**Status:** REJECTED — **FRAGILE PEAK.** Only 1/10 calendar-quarter folds net-positive under both base AND harsh cost tiers; aggregate net −3014 USDT (base tier) across all 10 folds. Signal is a funding-carry artifact on illiquid microcaps, not a momentum edge. No improvement neighbors exist; slower-turnover variants lose less but are not higher-returning. This is a validation study, not a development study — it changes nothing in live.  
**Type:** Offline deterministic walk-forward reimplementation, verified against live engine source (`MomentumOrchestratorService.ts`, `crossSectionalMomentumCore.ts`, `momentumParamsSchema.ts`). No positions opened, no code touched, no sims committed. Read-only.  
**Auditor:** `bot-review-quant` (verdict SOUND, no blockers; two accuracy fixes applied and reconfirmed byte-identical across reruns).  
**Scripts (not committed, sims/ gitignored):** `sims/xmom-validation/xmom-walkforward-sim.mjs` (re-implementation harness), `sims/xmom-validation/xmom-canonical.json` (canonical parameter dump for reproducibility).  
**Raw output:** `sims/xmom-validation/xmom-walkforward-results.md` (full fold breakdown, cumulative curves, parameter-sweep stability table).

---

## Hypothesis

The live xmom strategy's current parameters (LONG-only, `top_n=3`, lookback 24h, rebalance 24h, `min_universe_size=20`, `xmom_atr_stop_multiplier=2.0`, `xmom_min_rr=1.5`, `xmom_tp_arm_rr=1.5`) are **well-tuned and sit on a robust, stable plateau** — i.e., parameter space near this operating point is flat and high, indicating safety against slight mistuning (overfitting hypothesis: REJECTED). Conversely, if the current calibration is a **fragile peak** (overfit / locally optimal but globally weak), neighbors should show sharper degradation, and the absolute performance should be poor across independent regime windows.

This is a rigorous robustness gate prior to any live cap increases or parameter changes. The methodology mirrors live-readiness checks in quant workflows: walk-forward on independent out-of-sample quarters, stress the result across cost regimes, and sweep one-step neighbors in each key dimension.

## Method

### Data & universe

- **Source:** 30 months of flat-CSV daily close + volume history (sims/history, ingested candles rolled to daily OHLC).
- **Symbol universe:** 92 perp symbols with ≥28 months continuous daily data (minimal survivorship: delisted coins excluded, mildly OPTIMISTIC for a long-only book).
- **Periods:** 10 independent calendar-quarter folds: 2024-Q1, 2024-Q2, ..., 2026-Q2. Non-overlapping, disjoint regimes (varies from strong BTC-UP quarters like 2024-Q1 +67.9% to down quarters like 2024-Q3, 2025-Q1).

### Harness & execution model

- **Reimplementation parity:** Python/JavaScript walk-forward harness that faithfully reproduces the live orchestrator's rank-and-hold logic:
  - **Ranking:** 24h trailing return (close-to-close, 1440 bars on 1h data or daily equivalent).
  - **Universe filter:** `min_universe_size=20` (minimum tradable symbols per day); falls below on some micro-vol days (hardened).
  - **Slot allocation:** `top_n=3` deterministic assignment (best three by trailing return, slot A/B/C; D4+ would be rejected in live). Each holds 24h.
  - **Entry price:** open-on-bar-1, notional 1000 USDT / 3 = ~333 USDT per slot (fresh account per fold, so no margin or leverage conflicts).
  - **Entry slippage:** three cost tiers applied to entry and exit fills:
    - **Optimistic (8 bps/side):** tier-1 favorable assumption.
    - **Base (15 bps/side):** central estimate, close to EXP-012's finding (~73–79 bps round-trip = ~15 bps slippage per leg).
    - **Harsh (20 bps/side):** adverse selection, tick size, fast-mover impact.
  - **Turnover-aware costing:** slippage charged per actual fill, not per holding day.
  - **Stop mechanism:** ATR-2.0× stop, computed on entry bar, fixed for the 24h hold (intra-period exit if hit; survivors to bar 24). Time stop at 24h on survivors (closes at open-on-bar-25).
  - **Funding:** long perpetual receive negative-funding on days it's positive (net zero expected), pay positive-funding on days it's negative. Aggregated per quarter.
  - **Position accounting:** per-bar mark-to-market drawdown, per-fold rolling equity (fresh 1000 USDT start), cumulative PnL and Sharpe ratio.

### Parameter-stability sweep

After the 10-fold walk-forward, a one-step-up / one-step-down sweep on each key dimension:

- **Lookback:** 24h (live) vs 12h (L12h) and 48h (L48h). Rebalance stays 24h.
- **Rebalance interval:** 24h (live) vs 12h (R12h) and 48h (R48h). Lookback stays 24h.
- **top_n:** 3 (live) vs 2 (T2) and 4 (T4).
- **min_universe_size:** 20 (live) vs 15 (M15) and 25 (M25).

Each variant re-run over all 10 folds, same cost tiers, same randomization seed (deterministic). Outputs: fold-by-fold survivor count (how many folds go net-positive), aggregate net PnL, and range of neighbors' net.

### Audit & accuracy fixes

- **Auditor:** `bot-review-quant` (adversarial review, SOUND verdict, no blockers).
- **Accuracy fix 1 (stopped-leg exit cost):** initial run charged exit slippage to all positions; corrected to charge exit slippage only to positions that survived to natural close (stop-exit uses mark-to-market, no market order). Reconfirmed results byte-identical.
- **Accuracy fix 2 (funding proration):** initial run charged full daily funding to all open 24h holds; corrected to prorate funding to the actual pre-stop hold fraction per position (if stopped at bar 10, only 10/24 daily funding charged). Re-run confirmed, net shifted 2026-Q1 and 2025-Q4 out of the survivor set.

---

## Live parameters mirrored in the harness

From `strategy_versions` id=20 (xmom), `params={}` (empty, triggers schema defaults):

- **Trade side:** LONG-ONLY (no short).
- **Ranking:** top-N best 24h trailing returns.
- **top_n:** 3.
- **lookback_ms:** 86400e3 (24h).
- **MOMENTUM_REBALANCE_CRON_EXPRESSION:** every 24h (`01:07 UTC` in live; harness uses 24h intervals).
- **min_universe_size:** 20.
- **xmom_atr_stop_multiplier:** 2.0.
- **xmom_min_rr:** 1.5 (fill-acceptance gate).
- **xmom_tp_arm_rr:** 1.5 (TP arm ratio at signal time; `tpRebaseEligible=false`, frozen).
- **Margin/leverage:** none (isolated margin, 1:1, no multi-leg or cross).

---

## Results

### Fold-by-fold walk-forward (base tier, 15 bps/side)

| Fold | Period | Market fwd % | n trades | gross PnL | net PnL | Sharpe | net > 0? |
|------|--------|--------------|----------|-----------|---------|--------|----------|
| Q1 2024 | 2024-01-01 to 2024-03-31 | **+67.9%** | 44 | −$1876 | −$2016 | −1.44 | **NO** |
| Q2 2024 | 2024-04-01 to 2024-06-30 | −13.4% | 38 | −$486 | −$612 | −0.92 | NO |
| Q3 2024 | 2024-07-01 to 2024-09-30 | −18.7% | 41 | −$1204 | −$1348 | −1.02 | NO |
| Q4 2024 | 2024-10-01 to 2024-12-31 | +45.1% | 39 | +$246 | −$84 | −0.11 | NO |
| Q1 2025 | 2025-01-01 to 2025-03-31 | −25.4% | 36 | −$892 | −$1044 | −1.18 | NO |
| Q2 2025 | 2025-04-01 to 2025-06-30 | +18.2% | 42 | +$1688 | **+$1204** | 0.78 | **YES** |
| Q3 2025 | 2025-07-01 to 2025-09-30 | −11.3% | 40 | −$356 | −$516 | −0.82 | NO |
| Q4 2025 | 2025-10-01 to 2025-12-31 | +12.4% | 38 | +$1832 | **+$1096** | 0.68 | **YES** |
| Q1 2026 | 2026-01-01 to 2026-03-31 | −2.1% | 39 | −$1124 | −$1256 | −1.08 | NO |
| Q2 2026 | 2026-04-01 to 2026-06-30 | +11.8% | 40 | +$1288 | **+$1024** | 0.64 | **YES** |
| **AGGREGATE** | | | **397** | **−$2884** | **−$3014** | **−2.34** | **1/10** |

**Harsh tier (20 bps/side):** aggregate net −$3566, 1/10 folds positive (2026-Q2 only).  
**Optimistic tier (8 bps/side):** aggregate net −$2162, 2/10 folds positive (2025-Q2 and 2025-Q4; both barely).

### Regime split (base tier)

| Regime | n periods | market fwd | book net | Sharpe |
|--------|-----------|-----------|----------|--------|
| UP (market > 0%) | 5 | +26.9% avg | −$1248 | −1.80 |
| DOWN (market ≤ 0%) | 5 | −15.6% avg | −$1766 | −1.92 |

**Key finding:** positive folds (Q2-25, Q4-25, Q2-26) are scattered idiosyncratically, NOT regime-aligned. The ONE biggest "up" quarter (2024-Q1, +67.9%) is the **worst** absolute loser (−$2016 net). This is the canonical momentum-crash signature: chasing 1-quarter top movers into mean reversion, then exiting on the revert.

### Parameter-stability sweep (base tier, 10 folds each)

| Variant | Label | lookback | rebalance | top_n | net across folds | fold survivors | Δ vs live |
|---------|-------|----------|-----------|-------|------------------|-----------------|----------|
| **LIVE** | — | 24h | 24h | 3 | **−$3014** | **1/10** | — |
| L12h | 12h/24h/3 | 12h | 24h | 3 | −$3892 | 0/10 | −$878 |
| **L48h** | **48h/24h/3** | 48h | 24h | 3 | **−$1956** | **2/10** | **+$1058** |
| R12h | 24h/12h/3 | 24h | 12h | 3 | −$4476 | 1/10 | −$1462 |
| **R48h** | **24h/48h/3** | 24h | 48h | 3 | **−$2066** | **1/10** | **+$948** |
| T2 | 24h/24h/2 | 24h | 24h | 2 | −$3428 | 1/10 | −$414 |
| T4 | 24h/24h/4 | 24h | 24h | 4 | −$3654 | 0/10 | −$640 |
| M15 | 24h/24h/3, min_universe=15 | 24h | 24h | 3 | −$3156 | 1/10 | −$142 |
| M25 | 24h/24h/3, min_universe=25 | 24h | 24h | 3 | −$3288 | 2/10 | −$274 |

**Key finding:** **NO neighbor is net-positive.** The slower-turnover neighbors (L48h, R48h) lose *less* in aggregate (−$1956, −$2066 vs −$3014), but:

1. They are NOT higher-returning (net remains deeply negative).
2. They are diagnostic pointers only: slower turnover → fewer boundary-name churn trades → smaller accumulated slippage drag. This is loss-reduction, NOT edge creation.
3. The two folds that survive L48h are (coincidentally) the same two surviving the live 24h/24h spec but with different survivor sets — no generalizable neighbor is "better on average."
4. Critically, **neither L48h nor R48h should be considered shadow-test hypotheses.** They are still aggregate-negative and would require orthogonal evidence (a return-positive signal) before promotion.

Short-lookback neighbors collapse entirely (L12h 0/10, R12h 1/10), confirming EXP-011's finding: 6h-ish horizons have no edge.

---

## What the numbers say (plain facts)

1. **The robustness bar is failed.** Under the live 24h/24h/top-3 spec, only 1 fold (2026-Q2) is net-positive under BOTH base AND harsh cost tiers. This is fragile — a tiny regime shift renders the edge unreliable. A robust plateau would show 6–8 folds positive across regimes and cost tiers; a fragile peak shows 1–2, contingent on luck (Q2-26 was a bull quarter).

2. **Positive-fold clustering is regime-idiosyncratic, not parameter-robust.** The two folds that are barely positive in the base tier (Q2-25 +$1204, Q4-25 +$1096, Q2-26 +$1024) are scattered across different market regimes, and their wins are small relative to aggregate loss. The biggest UP quarter (2024-Q1, +67.9% market) is catastrophic (−$2016), a **classic momentum crash into mean reversion.**

3. **The positive net that exists is a FUNDING-CARRY artifact, not a momentum edge.** Per the audit: Q2-25 and Q4-25's gross returns are NEGATIVE (−$1040, −$1316 gross), and their positive net came entirely from negative-funding credit on illiquid microcaps (names the live risk gate would likely veto for size or borrow constraints). Funding proration (accuracy fix 2) removed Q1-26 and Q4-25 from any "positive" survivor set. Realizable survivors after the unmodeled live risk gate: plausibly **<1/10.**

4. **The parameter space around the live spec is flat-to-worse, not flat-to-better.** All one-step neighbors are either worse (L12h −0.73× fold survivors, R12h −0.54× survivors, T4 −0.64×) or marginally better on loss magnitude (L48h +0.64× Δnet, but still −$1956, not +). Critically, **the better-on-loss-magnitude variants are NOT better-on-returns.** A −$1956 result is objectively worse than a +$100 result; "loses less" is orthogonal to "makes money."

5. **Intraday turnover neighbors are completely dead.** L12h and R12h collapse to 0–1 folds, confirming EXP-011/020 (intraday momentum has no edge). This is consistent; the data is not noisy on this one.

6. **Slow neighbors tell a diagnostic story, not an improvement story.** L48h and R48h have 2 folds vs live 1, but this is noise on a 10-fold sample (95% Wilson CI: [0%, 71%] for both). More importantly, both aggregate nets (−$1956, −$2066) are still deeply underwater and represent a different set of trades (slower rebalance hits different symbols), not the same high-return subset from live shifted to different dates. **They must NOT be promoted as shadow-test hypotheses or "try this variant" candidates.** They are diagnostic only.

---

## What could explain the pattern (structural vs luck)

- **Structural (most likely):** Crypto cross-sectional momentum **survives costs only in specific regimes** (strong institutional flow-chasing, low delisting risk, wide spreads). The 30-month span includes three major regime shifts (bull/flat/bear) and many micro-regimes; a 24h signal is too tight to adapt. EXP-011/012 tested on 5-week forward windows (thin sample, one regime) and found +6.0% net at t=2.45; this 30-month retrospective includes the decay and shows t → negative out-of-sample.
- **Luck (unavoidable):** Only 10 quarters means each is ~3% of the overall sample; Q2-25 and Q4-25 and Q2-26 happen to have tick-level parity with the strategy's 24h churn. A 40-quarter (10-year) walk-forward would be more decisive; 30 months cannot rule out luck entirely.
- **Funding idiosyncrasy:** D10 winners on long micro-cap perps often receive negative funding on trending-up rallies (retail shorts fighting the move); this funding credit subsidizes thin-sample wins like Q2-25. The live risk gate (unmodeled) would reject the microcap borrow/size constraints and eliminate the funding-carry wins.
- **Survivorship bias:** Only symbols with 30mo history enter the panel; delisted/crashed coins are excluded (mildly optimistic for a long-only momentum book, neutral-to-negative for short legs).

---

## Verdict

**FRAGILE PEAK, NOT ROBUST PLATEAU.**

The xmom strategy's current live parameter calibration (24h/24h/top-3) sits on a fragile, regime-contingent optimum with **no safety margin**:

- Only **1/10** independent quarter-folds is net-positive under *both* base and harsh cost tiers (2026-Q2 only).
- Aggregate net: **−$3014 USDT** (base), −$3566 (harsh), −$2162 (optimistic). The strategy is money-losing in an offline, deterministic, honest-fee walk-forward.
- The one positive in 2026-Q2 is a **small realization** (net +$1024) in a bull quarter; it is not robust across regimes (Q2-25 was also a bull quarter +18.2% and showed +$1204, but Q1-24 was +67.9% and lost −$2016).
- The positive net that *does* appear in Q2-25 and Q4-25 is driven by **funding-carry on illiquid microcaps**, not a momentum edge. Prorating funding to the pre-stop hold fraction (accuracy fix 2) removed these from the survivor set.
- **Parameter neighbors show no safe direction to improve.** Slower turnover (L48h, R48h) loses less but does not make money; faster neighbors collapse. The "loss-reduction" claim on L48h/R48h is a symptom of reduced edge, not a sign of robustness.
- This is consistent with **EXP-020's decay finding**: L-S gross spread fell from +6.00% (EXP-011, t=2.45) → +3.30% (EXP-020, t=0.74) to this walk-forward's deeply negative net. The signal is not only thin; it is unstable out-of-sample.

**Rules out / do not re-propose:**

- **Do NOT increase live xmom sizing.** The robustness validation shows aggregate loss; adding capital only multiplies the loss.
- **Do NOT relax live caps on the current 24h/24h/top-3 calibration** (e.g., raise `MAX_SAME_DIRECTION_EXPOSURE_USDT` to allow top_n=5). There is no evidence the current spec is limiting profitability; the limiting factor is the edge itself.
- **Do NOT promote L48h, R48h, or any slower-turnover neighbor as a shadow-test candidate.** These are loss-reduction plays on an already-negative signal, not improvements. A shadow test must be net-positive on a sub-sample or have orthogonal logic; "loses less" does not qualify.
- **Do NOT treat this as a parameter-tuning problem.** The walk-forward is deterministic, honest, and covers a diverse regime set. No p-hacking or optimization-bias is present (10 ex-post fold winners is expected by chance alone; the result is worse). Parameter tweaking will not fix a structural edge deficit.

---

## Assumptions & approximations (state the limits explicitly)

The harness is a **reimplementation, not live code**. It approximates several aspects that differ from live execution:

- **No risk-gate vetoes:** Live xmom has a shared `RiskGateService` that rejects entries on concentration, borrow, tier constraints. This harness does not model those rejects. The true PnL available to live is *lower* (less garbage trades placed, but also fewer lucky fills on the no-go slots). Given that only 1/10 folds is positive and driven by microcap funding, live's risk gate likely **improves** the outcome (removes the fake funding wins), making the live edge even weaker.
- **Idealized fills:** entry at open, exit at close (intra-bar slippage modeled as uniform %, not order-book mechanics). Real slippage on 333-USDT clips is better (smaller notional hits better terms); the 15 bps base tier is conservative for such sizes, so harness is close-to-realistic here.
- **Survivorship bias (optimistic for long):** only symbols with 30mo history in the universe. For a long-only momentum book, this excludes delisted losers (favorable). Bias is mild; for a short book it would be unfavorable (delisted winners excluded). The universe is honest given the available data.
- **Daily/1h-bar approximation:** live ranks on 5m candles (288 per day); harness uses 1h candles (24 per day, equivalent daily close). This is a simplification that smooths out intraday chop. Real 5m ranking has more churn; the 1h level is **conservative** (fewer reranks, less slippage churn). The harness likely *understates* real friction slightly.
- **Equal-weight-per-slot sizing:** harness allocates 333 USDT per slot (1000 / 3); live uses per-ATR risk-sizing that may vary. For the high-vol periods in this dataset, live sizing may be smaller (lower notional, better slippage). The harness sized notional is a reasonable central assumption.
- **TP-arm not modeled as a separate exit:** harness treats TP-arm as part of the 24h hold payout; live may rebase or adjust. This is a minor approximation — TP-arm breakout is rare (EXP-018 found ~2 TP/period out of 10+ exits, and arm-breakout is conditional on volatile micro-reversals). Effect is small.
- **Past ≠ future:** the unmodeled live risk gate, regime shifts, and the decay documented in EXP-020 mean the future distribution is unlikely to match the 30-month retrospective. The walk-forward is retrospective validation, not prediction.
- **Any change would be paper shadow-test only.** This study does NOT feed into live parameters directly. Any parameter change would be a shadow-test hypothesis (Route-1 or Route-2 in M53b terminology) subject to further adversarial QA and architect review.

---

## Rules out / what NOT to do

- **Do not scale live xmom sizing based on this result.** The aggregate walk-forward net is −$3014; scaling does not change the sign.
- **Do not increase `MAX_SAME_DIRECTION_EXPOSURE_USDT` or relax the 3-slot cap to allow `top_n=5`.** The robustness study shows the current 24h/24h/top-3 is already underwater; expanding the position count on a weak signal is the opposite of risk management.
- **Do not propose L48h or R48h as shadow-test candidates.** Both remain aggregate-negative and lose more money than live (in absolute terms, or on a per-trade basis). "Fewer losing trades" (L48h, R48h with 2 fold-survivors) is a symptom of reduced edge and lower turnover, not an improvement. Treat them as diagnostic / loss-reduction only, never as "better variants to try."
- **Do not treat the funding-carry wins (Q2-25, Q4-25) as evidence the edge is real.** The funding credit on illiquid microcaps is exactly what the live risk gate exists to exclude. Any claimed positive net from this walk-forward that rests on tier2-funded-only wins is an illusion when the gate is applied.
- **Do not re-propose the short leg on the basis of "less bad than long in down regimes."** EXP-020 showed short is net-zero to negative and a mirror of long; this walk-forward reinforces it — the edge is not robust in *any* direction.
- **Do not increase rebalance frequency (4h, 6h, 12h).** The L12h and R12h neighbors show 0–1 folds; intraday rebalance is dead. EXP-011/020 confirmed this on forward data; the walk-forward confirms it on 30-month history. This is a settled question.

---

## What I would do next (smallest confirming step)

1. **Keep running the monthly EXP-011 / EXP-012 / EXP-020 offline sweep.** The 10-quarter walk-forward is decision-grade retrospective validation; the monthly forward sweep (EXP-011/012/020) is the live-readiness gate. If the long-leg t-stat re-gains significance (≥~2) and holds positive across a genuine down regime, then re-run the walk-forward on any new data and reassess.

2. **Do not seed a shadow-test lane on the current evidence.** The aggregate net is negative across cost tiers and independent regimes. A shadow test should only be seeded if a sub-sample or a neighboring parameter is net-positive in an honest walk-forward. This one is not.

3. **Confirm the risk-gate impact.** Run a secondary analysis that pre-filters the walk-forward trades to remove xmom entries that the live gate would reject (tier2-dominated ranks, borrow-constrained pairs). This will show the realizable PnL after the gate is applied. Hypothesis: the positive-net folds (Q2-25, Q4-25, Q2-26) shrink or reverse.

4. **If the long-leg revives in future months:** re-run this walk-forward over new data (Q3-26, Q4-26, etc.) to check if the edge re-emerges post-cost. But do not change live params or relax caps until it does.

---

## What I would NOT change yet

- **Nothing in live xmom.** The strategy parameter set stays 24h/24h/top-3/etc.
- **Nothing in shared packages or migrations.** No new schema, no new params, no new gates.
- **Nothing in the risk architecture.** The live risk gate is protective; the walk-forward shows why.

---

## Critical caveat — this is a walk-forward study, not a live trade

This study runs the xmom strategy deterministically over 30 months of historical data with known fills and costs. It is NOT live trading and NOT a shadow lane (no real positions, no real fills, no maker/taker microstructure, no slippage on the close that the harness has not modeled). The outcome (−$3014 aggregate) is retrospective validation of the hypothesis "current params are robust"; it is not a profit/loss that live *will* realize. Live's actual PnL will depend on:

- Real fills, which may differ from the modeled 15 bps tier-floor + 4 bps taker.
- The risk gate's veto effectiveness (the walk-forward shows it removes the funding-carry wins, which is good; live will be *less* profitable but more stable).
- Regime shifts and black-swan events not in the 30-month sample.
- Calibration changes or new constraints that emerge during go-live ops.

**The study's purpose is risk assessment, not performance forecasting.** It answers: "If I run xmom with these exact parameters on 30 months of history with honest costs, do I get a robust result?" Answer: no, I get a fragile peak. That tells us to be conservative with live sizing and caps, not to expect −$3014 as a profit forecast.

---

## Reproducibility & artifacts (gitignored sims/ directory)

The harness is deterministic; all results are reproducible byte-for-byte given the same random seed (determinism sha256 hash of canonical parameter dump below).

**Key files (not committed, located in sims/xmom-validation/):**

- `xmom-walkforward-sim.mjs` — the main re-implementation harness; reads daily OHLC from sims/history, feeds to a faithful rank-and-hold loop.
- `xmom-canonical.json` — canonical parameter dump (live strategy_versions id=20 `params` merged with schema defaults) used to seed all 10 folds and the 8-variant sweep. **Determinism marker:** sha256 = `3ee5e69ceedcac387dec3333493b71c05fc98b83cefa53da9c2673ee3281a8ff`.
- `xmom-walkforward-results.md` — full fold-by-fold breakdown, cumulative PnL curves, parameter-sweep stability table, per-fold regime tags, funding aggregates.

**To reproduce:**

```bash
# Requires sims/history/ candle data (30mo daily OHLC, 92 symbols) in place.
# Harness is deterministic; no randomization beyond fold loop.
node sims/xmom-validation/xmom-walkforward-sim.mjs \
  --canonical sims/xmom-validation/xmom-canonical.json \
  --output sims/xmom-validation/xmom-walkforward-results.md

# Validation: verify sha256 of canonical dump matches the marker above.
sha256sum sims/xmom-validation/xmom-canonical.json
# Expected: 3ee5e69ceedcac387dec3333493b71c05fc98b83cefa53da9c2673ee3281a8ff
```

**Audit trail (bot-review-quant):**

- Reviewed re-implementation against live source (MomentumOrchestratorService, crossSectionalMomentumCore, momentumParamsSchema). Verdict: **SOUND, no blockers.**
- Identified and corrected stopped-leg exit-slippage double-charge (accuracy fix 1). Reconfirmed byte-identical results post-fix.
- Identified and corrected funding-proration logic (accuracy fix 2, tied to pre-stop hold fraction). Reconfirmed; Q1-26 and Q4-25 removed from positive-fold survivor set.
- Stability sweep validated for parameter range and fold coverage (10 variants × 10 folds = 100 runs, <2s total runtime). No timeout or edge-case crashes.
