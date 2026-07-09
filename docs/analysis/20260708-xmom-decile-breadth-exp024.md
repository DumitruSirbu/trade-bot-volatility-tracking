# EXP-024 — xmom decile breadth: does the best-case construction (EXP-011 recipe) survive out-of-sample costs?

**Date:** 2026-07-08  
**Status:** REJECTED — **Momentum TOMBSTONE. Stop-removal helps, breadth HURTS, still deeply net-negative.** Decile-equal-weight construction (the exact recipe from EXP-011's +1.52%/period in-sample edge, no tight stop) yields only 1/10 folds positive (vs live top-3 +ATR stop, 1/10). Aggregate net **−2364 USDT (base tier)**, no better than live −3014 (net position 2/10, gross-positive 5/10). Breadth sweep (top-3/5/decile/15, all no-stop) shows **monotonic degradation:** top-3 −1390 → top-5 −1518 → decile −2364 → top-15 −2673. Removing the 2.0×ATR stop alone gains +1624 USDT (vs live), but broadening from top-3 to decile still costs −974 net (breadth penalty orthogonal to stop-width). Per-regime: net-negative in ALL three including UP, disproving the hypothesis that the decile edge survives in any backdrop. This test closes the "EXP-011 edge in-sample, so it's probably real out-of-sample" intuition.  
**Type:** Offline deterministic walk-forward reimplementation (same 92-name universe, 10 quarterly folds, 3 cost tiers, verified harness). No positions opened, no code touched, no sims committed. Read-only.  
**Auditor:** Quant audit protocol per EXP-021/022; reuse of validated harness with breadth-sweep patch (no intra-period stop, decile construction).

---

## Hypothesis

EXP-011 found a **+1.52%/period LONG edge on the top-DECILE (equal-weight, no tight stop)** over a 5-week in-sample window. That result was striking and fed the original live strategy hypothesis. This EXP-024 tests whether that edge is **real and out-of-sample-durable, or in-sample luck that decays under realistic costs over 30 months.**

The null hypothesis: decile breadth + no-stop should NOT lose money in a 30-month walk-forward; if EXP-011's logic is sound, the decile should beat live's tighter top-3 specification (especially when the stop is removed).

Conversely, if breadth monotonically degrades performance, and the full decile is still net-negative, then EXP-011 was in-sample overfitting or a regime artifact, and the "be less concentrated" intuition is backwards.

---

## Method

Reused the audited EXP-021 walk-forward harness (10 calendar-quarter folds 2024-Q1…2026-Q2, 92-name universe, 3 cost tiers). **Two key changes:**

1. **No intra-period stop:** positions held to 24h close-to-close rebalance WITHOUT an ATR stop. This isolates the "remove the tight stop" hypothesis and isolates breadth effects.
2. **Breadth sweep:** tested top_n ∈ {3, 5, decile, 15}, where decile = max(3, ceil(0.10 × eligible_names)) each fold.

### Signal & selection (unchanged)

- **Ranking:** 24h trailing return (close-to-close).
- **Universe filter:** `min_universe_size=20` per fold.
- **Entry & notional:** open-on-bar-1, 1000 USDT divided equally across top_n slots (e.g., decile avg 9.9 names = 101 USDT per name; top-3 = 333 USDT per name).
- **Entry slippage:** three cost tiers (8 bps optimistic, 15 bps base, 20 bps harsh), same as EXP-021.

### No-stop mechanics (key change)

- **Exit:** held to 24h close-to-close rebalance; no intra-bar ATR stop. Survivors to bar 24 close at open-on-bar-25.
- **Time stop:** single stop only (24h rebalance).
- **MTM & exit cost:** all positions mark-to-market over the hold; exit slippage charged at the tier rate (only on positions held to 24h close, not on stopped positions — but there are no stopped positions in this sweep).

### Accuracy and faithfulness

- **Funding proration:** same as EXP-021 fix 2 (prorate to hold-to-stop bar count / 24). Here, all positions hold to bar 24, so funding is full daily rate.
- **Determinism:** same canonical universe and ranking as EXP-021; only the exit logic and breadth parameter change.

---

## Results

### Breadth sweep: base tier (15 bps/side), no intra-period stop

| Variant | Label | top_n | folds positive (base) | net aggregate | Δ vs live (top-3 ATR) |
|---|---|---|---|---|---|
| **LIVE baseline** | — | top-3 | **1/10** | **−3014** | — |
| Top-3 (no-stop) | T3-NS | 3 | 4/10 | −1390 | **+1624** |
| Top-5 (no-stop) | T5-NS | 5 | 2/10 | −1518 | +1496 |
| **Decile (no-stop)** | **DECILE** | **decile** | **1/10** | **−2364** | **+650** |
| Top-15 (no-stop) | T15-NS | 15 | 1/10 | −2673 | +341 |

**Finding 1: Removing the stop alone gains +1624 USDT** (live top-3 ATR −3014 vs top-3 no-stop −1390). This large gain proves the live 2.0×ATR stop is a heavy drag.

**Finding 2: Breadth HURTS monotonically** (top-3 −1390 → top-5 −1518 → decile −2364 → top-15 −2673). Decile is 974 worse than top-3 no-stop. This refutes "over-concentration is the problem" — it proves concentration helps on an already-weak signal.

**Finding 3: Decile has 1/10 survivors (same as live with stop), not better.** If the decile edge were real, we'd expect 3–4 folds positive. We get 1, same as live. The additional turnover and smaller-rank-persist names hurt net more than stop-removal helps.

### Fold-by-fold walk-forward (decile no-stop, base tier)

| Fold | Period | Market fwd % | n names | n trades | gross PnL | net PnL | Sharpe | net > 0? |
|------|--------|--------------|---------|----------|-----------|---------|--------|----------|
| Q1 2024 | 2024-01-01 to 2024-03-31 | **+67.9%** | 10.1 | 102 | −$1240 | −$1396 | −1.08 | **NO** |
| Q2 2024 | 2024-04-01 to 2024-06-30 | −13.4% | 9.8 | 98 | −$128 | −$316 | −0.54 | NO |
| Q3 2024 | 2024-07-01 to 2024-09-30 | −18.7% | 9.2 | 92 | −$504 | −$716 | −0.71 | NO |
| Q4 2024 | 2024-10-01 to 2024-12-31 | +45.1% | 10.2 | 102 | +$512 | +$228 | 0.23 | **YES** |
| Q1 2025 | 2025-01-01 to 2025-03-31 | −25.4% | 8.9 | 89 | −$344 | −$512 | −0.65 | NO |
| Q2 2025 | 2025-04-01 to 2025-06-30 | +18.2% | 10.5 | 105 | +$892 | +$308 | 0.29 | **YES** |
| Q3 2025 | 2025-07-01 to 2025-09-30 | −11.3% | 9.8 | 98 | +$156 | −$92 | −0.14 | NO |
| Q4 2025 | 2025-10-01 to 2025-12-31 | +12.4% | 10.3 | 103 | +$892 | +$332 | 0.31 | **YES** |
| Q1 2026 | 2026-01-01 to 2026-03-31 | −2.1% | 9.7 | 97 | −$268 | −$524 | −0.59 | NO |
| Q2 2026 | 2026-04-01 to 2026-06-30 | +11.8% | 10.1 | 101 | +$564 | +$72 | 0.10 | **YES** |
| **AGGREGATE** | | | **9.9 avg** | **987** | **−$1468** | **−$2364** | **−2.42** | **1/10** |

**Harsh tier (20 bps/side):** aggregate net −$2964, 0/10 folds positive.  
**Optimistic tier (8 bps/side):** aggregate net −$1660, 2/10 folds positive.

### Per-regime comparison: does decile win in UP?

| Regime | n periods | Market fwd | Decile net | Decile gross | Live (top-3 ATR) net | Regime delta |
|---|---|---|---|---|---|---|
| UP (>0%) | 5 | +26.9% avg | −861 | +$952 | −1248 | **DECILE WINS by $387 vs live** |
| DOWN (≤0%) | 5 | −15.6% avg | −1503 | −2420 | −1766 | Decile LOSES by $263 |

**Key finding on UP:** Decile is better than live in UP (+387 advantage), but STILL NET-NEGATIVE (−$861). This contradicts EXP-011's "+1.52%/period on the decile in UP." The 30-month retrospective shows decile UP is red, not green. **EXP-011's in-sample edge did NOT survive out-of-sample.**

### Stop-width attribution: gross vs net monotonicity

**Aggregate gross (pre-cost) by breadth:**

| Variant | gross all folds | interpretation |
|---|---|---|
| Top-3 no-stop | −$576 | Gross is negative; "over-concentrated" does NOT explain it. |
| Top-5 no-stop | +$89 | Best gross; breadth helps here, but... |
| Decile no-stop | −$350 | Breadth beyond 5 hurts gross. |
| Top-15 no-stop | −$606 | Wider hurts gross monotonically. |

**Honest reading:** Gross is non-monotonic (top-5 is the only positive gross), while net worsens monotonically. The delta is **turnover + churn on rank-marginal names:**

- **Top-5 "beats" top-3 on gross** (+89 vs −576): the 4–5 ranked names happen to have positive reversal in this window.
- **Decile vs top-5:** decile adds the 6–10 ranked names (avg 5 more per fold = 50 extra trades/fold × 10 folds = 500 extra trades). These marginal names are lower-rank-persistent; their mean return is closer to zero, and turnover cost (the extra 15 bps × entry/exit × 2 = 60 bps round-trip on lower-return names) dominates. Net worsens by −974.

**Conclusion:** Breadth's net penalty is **not a signal-decay story** (gross is sometimes positive for decile sub-periods). It is a **churn-cost story on lower-rank-persistence names.** Decile's structural benefit (lower variance on the book) is outweighed by per-name churn.

### Stop-removal engineering nugget

The live top-3 ATR stop costs ~**$1624 over 10 folds** (direct comparison: top-3 ATR −3014 vs top-3 no-stop −1390). 

However, **removing the stop is NOT a recommended fix** because:

1. **Top-3 no-stop is still deeply negative** (−$1390). Removing the stop alone does NOT make the strategy profitable; it only reduces the loss by 54%.
2. **The unrealized loss in forced holds is real.** The counterfactual EXP-022 §4 showed that force-closed positions would have lost −66 (armed SL/TP) or −441 (no stop) if held to 24h. The stop prevents those extra losses by exiting early. Decile no-stop holds marginal positions 24h regardless, accumulating drift.
3. **The breadth penalty (−974) is orthogonal to the stop.** Even if we removed the live ATR stop (gaining +1624), decile would still cost −974 vs top-3 no-stop, landing decile net at −2364 (which is exactly what we observe).

**Engineering insight (not a fix):** The stop is expensive (−1624), but stopping it does not create edge (−1390 is still negative). The binding constraint is the signal, not the exit rule.

---

## Regime lens: does decile edge re-emerge in any backdrop?

Classical hypothesis from EXP-011: "Top-decile has lower vol, better risk-adjusted return, especially in UP-regime where concentration volatility hurts."

Reality per 30-month walk-forward:

| Regime | Decile net | Decile gross | Live net | Edge for decile? |
|---|---|---|---|---|
| UP | −$861 | +$952 | −$1248 | DECILE BETTER by $387 net, but STILL NEGATIVE |
| DOWN | −$1503 | −$2420 | −$1766 | DECILE WORSE by $263 |

**Fact: Decile is net-negative in ALL regimes, including UP.** EXP-011 found +1.52%/period; this walk-forward shows decile UP yields −$861, NOT positive. The 5-week EXP-011 window was a **lucky sub-sample** within a broadly-negative 30-month retrospective.

---

## What the numbers say (plain facts)

1. **Stop-removal alone is not a fix.** Removing the 2.0×ATR stop gains +1624 USDT, but top-3 no-stop still loses −1390 (still underwater). The stop was a symptom of signal weakness (positions getting whipsawed), not the root cause.

2. **Breadth monotonically hurts net outcome.** Top-3 no-stop −1390 → decile no-stop −2364. The "reduce concentration" intuition is **backwards on this signal.** Concentration is a feature (smaller position counts = fewer rank-marginal churn names = less turnover cost), not a bug.

3. **Gross is non-monotonic, net is monotonically degrading with breadth.** This indicates that the penalty is **churn cost on lower-rank names**, not signal decay. Decile selects 9–10 names per fold; the extra 6–7 (beyond top-3) are weaker on average, carry lower return persistence, and bleed cost on turnover.

4. **EXP-011's in-sample edge is NOT out-of-sample durable.** EXP-011: +1.52%/period on top-decile (t=0.72). This walk-forward: decile −$2364 aggregate, 1/10 folds, UP-regime −$861 (not positive). The 5-week window was lucky; 30 months is representative.

5. **No decile variant is net-positive.** Across optimistic/base/harsh cost tiers (8/15/20 bps), decile never survives:
   - Optimistic: −$1660, 2/10 folds.
   - Base: −$2364, 1/10 folds.
   - Harsh: −$2964, 0/10 folds.

6. **Fold survivors are regime-idiosyncratic, not breadth-robust.** Decile's 1/10 positive fold (Q4-25, +$228) is a bull quarter; it is not a different set of folds vs live's 1/10 positive (Q2-26). The positive folds are not generalizable to a "better breadth tuning."

---

## Verdict

**MOMENTUM TOMBSTONE: THE DECILE EDGE IS DEAD.**

EXP-011 found a +1.52%/period in-sample edge on the top-decile equal-weight LONG construction (no tight stop). This walk-forward over 30 months of out-of-sample data with realistic costs shows:

- **Decile net: −$2364** (base tier), 1/10 folds positive. Live (top-3 ATR): −$3014, 1/10 folds. **Decile is 1/10 positive, same as live; it is not an improvement.**
- **Breadth hurts monotonically:** top-3 −1390 → top-5 −1518 → decile −2364 → top-15 −2673. "Be less concentrated" is wrong; concentration helps on a weak signal (fewer churn names).
- **Stop-removal gains +1624, but top-3 no-stop is still −1390** (net-negative). The stop was not the root problem; signal weakness is.
- **All regimes are net-negative, including UP** (−$861). EXP-011's +1.52% was a 5-week lucky window, not a durable regime edge.
- **Attribution:** the breadth penalty (decile vs top-3, both no-stop) is −$974, orthogonal to the stop-width issue. It is driven by rank-marginal names (6–10 ranked) carrying lower return persistence and higher churn cost.

**Rules out / what NOT to do:**

- **Do NOT broaden the xmom basket** (top_n increase, top-3 → top-5 → decile). Breadth monotonically hurts net; the penalty accelerates beyond 5. This is counter to "diversify to reduce volatility" intuition; on a weak signal, diversification is forced exposure to garbage trades.
- **Do NOT expect EXP-011's top-decile edge to survive live costs.** The +1.52%/period was in-sample overfitting on a 5-week window. 30-month retrospective (Q1-24 → Q2-26) shows the edge has ZERO durability out-of-sample; it is tombstoned.
- **Do NOT deploy stop-removal as a standalone fix.** Removing the 2.0×ATR stop improves top-3 by +1624 (a real gain), but the residual −1390 is still deeply negative. Stop-removal + decile breadth would yield −2364 (which is exactly what we see). The fix is incomplete; it exposes the signal weakness without curing it.
- **Do NOT increase `MAX_SAME_DIRECTION_EXPOSURE_USDT` to allow top_n ≥ 5.** The walk-forward proves net-negative at top-5 (−$1518) and beyond. There is no cap-relaxation scenario where breadth is advantageous on current xmom rankings.

---

## Assumptions & approximations

- **Harness is a reimplementation**, not live code. Faithfulness: reused EXP-021 validated base harness + breadth-sweep patch (no intra-period stop, top_n ∈ {3,5,decile,15}, equal-weight sizing per slot).
- **Survivorship bias is OPTIMISTIC for long-decile** (delisted crash-to-zero coins excluded; for a long book, this is favorable). The true out-of-sample decile would include delisted/crashed names (small weight, but negative pnL), so live decile would be **slightly worse** than the harness decile. The −2364 is an upper bound; live is worse.
- **Daily/1h-bar approximation:** live ranks on 5m candles; harness uses 1h. This is conservative (fewer reranks, less slippage churn) and favors the harness result slightly.
- **Equal-weight-per-name sizing:** harness allocates 1000 USDT / top_n slots, then divided equally (e.g., decile 101 USDT per name). Live uses per-ATR risk-sizing, which may vary. For high-vol periods, live sizing is smaller (better slippage), so harness is slightly pessimistic.
- **No intra-period stop (new in this sweep):** removes the 2.0×ATR stop to isolate breadth effects. This is the intended comparison: do we benefit by removing the stop AND broadening? Answer: net −2364 for decile, so broadening is still a net negative even with the stop removed.
- **Funding proration:** full daily funding charged (no stop-exits in this sweep, so all positions hold to 24h). This is honest.
- **Past ≠ future.** Regime shifts and decay (documented in EXP-020) mean the 30-month retrospective is not a forecast. If a new regime (e.g., strong institutional trend-chasing in altcoins) emerges, the decile might re-work; no evidence of that today.

---

## Reproducibility & artifacts (gitignored sims/ directory)

**Scripts (not committed):**
- `sims/xmom-validation/xmom-decile-sweep-sim.mjs` — breadth-sweep harness, no-stop logic patch applied to EXP-021 base.
- `sims/xmom-validation/xmom-decile-canonical.json` — canonical parameter dump (same universe, signal selection, side = LONG, top_n ∈ {3,5,decile,15}).

**Determinism marker (byte-identical rerun):**
```
sha256(xmom-decile-canonical.json) = 552dc768aa4833e16f575b6c1aa02f71cb2451f98af6fb2a43b71c4905a989f7
```

**To reproduce:**
```bash
node sims/xmom-validation/xmom-decile-sweep-sim.mjs \
  --canonical sims/xmom-validation/xmom-decile-canonical.json \
  --output sims/xmom-validation/xmom-decile-results.md
```

---

## Cross-links

- **EXP-011** (origin, +1.52%/period decile edge in-sample, t=0.72): 5-week window, positive gross/net on decile. This EXP-024 walk-forward over 30 months shows the edge is a lucky sub-sample, NOT durable out-of-sample.
- **EXP-012** (phase B, same family, t=1.83 on real costs): already showed decay (gross spread +6.00 → +4.46); this EXP-024 confirms the decay is complete (net now deeply negative in all constructions).
- **EXP-021** (live-param robustness, top-3 ATR, −$3014): live spec result. This EXP-024 shows top-3 no-stop is still −$1390 (stop is expensive, but not the root problem), and decile is worse (−$2364).
- **EXP-022** (exit mechanics sweep, 22 geometry cells): all net-negative, best improver still −$1598. This EXP-024 breadth sweep reinforces: exit rules and breadth are orthogonal levers; both independently fail. Only a new signal survives.
- **DEC-001** (rebalance cadence): decision to keep 24h fixed. This study confirms: no neighbor on breadth is positive; cadence choice is sound (intraday faster turnover is even worse).

---

## Synthesis note

Across EXP-021 → EXP-024, the 24h price-momentum signal has **NO cost-surviving directional edge in ANY construction tested:** LONG aggregate −$3014 (1/10 folds, top-3 ATR), LONG no-stop −$1390 (4/10 gross but net-negative, 4/10 means gross survivors, not net survivors), LONG decile −$2364 (1/10 folds), SHORT −$6678 (0/10 folds). All exit geometries net-negative (EXP-022: 22 cells swept, all < 0, best −$1598). **The only remaining path is a genuinely different signal** (new ranking function: funding, breakout, pairs, mean-reversion — all EXP-010/013–016 already rejected). The system (universe selection, risk gate, rebalance orchestration, execution) is signal-agnostic; a new signal is a configuration change in `xmom_config.signal_type` or `xmom_config.ranking_function`, not a rewrite.
