# VWAP-Edge — 24h Paper-Soak Trade Analysis

**Author:** VWAP-Edge (quant)
**Window:** trailing 24h ending 2026-06-21 (positions opened `now() - 24h`)
**Active version under soak:** `v2` (momentum, `strategy_version_id = 3`), the only version
that fills live. `v0/v1/v3` run as shadows in `shadow_decisions`.
**Status:** WIP — **quant + logic reviewers passed (no blockers).** Both reproduced every
headline number. Two HIGH corrections applied: (a) v2's stop is **VWAP-structural**, TP is the
**ATR leg** (the geometry causal story was inverted); (b) **v3 emits no shadow fills at all**
(all-NULL), while v1's are degenerate — the D2 caveat is stronger than first written. MED fixes
applied: RR<1 is a long-book fact (shorts ≈1.0); Sharpe is descriptive only at n=26; catalyst_risk
remedy is **skip**, not fade; `forced_exhaustion` flagged as a second mis-route.

> Sample-size caveat up front: **26 closed trades** in the window. That is just above my
> 20-trade noise floor, single regime, no held-out sub-period possible. Everything below is
> **directional, not conclusive**. No parameter should be re-calibrated on this sample alone —
> the recommendations are "what to test next", not "what to ship".

---

## 1. What the numbers say (plain facts)

### Headline P&L (v2, realized, 26 closed + 1 still open)


| Metric                       | Value                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| Net realized PnL             | **−14.76 USDT**                                                          |
| Trades                       | 26 closed (1 open)                                                       |
| Win rate (PnL > 0)           | 42.3% (11/26)                                                            |
| Avg win / avg loss           | +4.36 / −4.18 (≈ symmetric payoff)                                       |
| Per-trade Sharpe             | −0.102 (descriptive only; SE ≈ ±0.20 at n=26 → indistinguishable from 0) |
| Max drawdown (cum. realized) | −27.47 USDT                                                              |
| Notional/trade               | ~500 USDT, leverage 0.33                                                 |


Symmetric payoff (win≈loss in magnitude) with a sub-50% win rate ⇒ negative expectancy. The
support for that claim is the **breakeven-RR geometry** (§ SL/TP, robust to sample size), not
the −0.102 Sharpe — at n=26 the Sharpe standard error is ≈±0.20, so the Sharpe figure alone is
statistically indistinguishable from zero and is reported as descriptive only. The book is not
blowing up — it is **bleeding**.

### Exit-reason distribution — the bleed is time-stops


| exit_reason | n      | net PnL    | avg MFE   | avg MAE | avg hold |
| ----------- | ------ | ---------- | --------- | ------- | -------- |
| take_profit | 6      | **+39.18** | +1.2%     | −0.4%   | 5.8 min  |
| stop_loss   | 2      | −18.12     | ~0%       | −1.9%   | 6.2 min  |
| time_stop   | **17** | **−35.62** | **+0.3%** | −0.8%   | 15.0 min |
| force_close | 1      | −0.19      | —         | —       | —        |


**65% of trades (17/26) die at the 15-min time-stop having never developed** — best-case
excursion (MFE) was only **+0.3%** against a take-profit sitting ~1.3% away. These are not
trades that were stopped early or that reverted; they are **non-events**: the signal fired,
price chopped sideways, the clock ran out. The clean wins (6 TP) and clean losses (2 SL) are
both well-behaved and small in count. The strategy's PnL is dominated by the time-stop bucket.

### Flow-type split — this is the real story


| flow_type            | n   | net PnL    | read                                                    |
| -------------------- | --- | ---------- | ------------------------------------------------------- |
| **trend_initiation** | 8   | **+27.77** | 4 TP (+30.37), 4 time_stop (−2.60) — **profitable**     |
| **catalyst_risk**    | 13  | **−37.26** | 1 TP, 1 SL (−13.76), 11 time_stop (−26.80) — **bleeds** |
| forced_exhaustion    | 4   | −0.90      | ~flat                                                   |
| market_beta          | 1   | −4.36      | noise                                                   |


The entire negative result is **one flow class**. `trend_initiation` — new money entering a
move, which is exactly what a momentum (v2) book *should* follow — is **net positive with a
50% win rate**. `catalyst_risk` is half the book (13/26) and accounts for −37.26: v2 follows
catalyst-driven spikes as if they were trend, and they overwhelmingly chop out at the
time-stop. The 5 worst trades in the window are all `catalyst_risk` or `forced_exhaustion`.

### Tier split


| tier               | net PnL    |
| ------------------ | ---------- |
| tier1 (long+short) | **+16.30** |
| tier2 (long+short) | **−31.05** |


tier2 is the dollar drag (tier2 longs alone −27.42). Consistent with the locked decision to
start live tier-1-only.

### Funnel (v2, 149 decisions / 24h)

- **Skips (78):** `regime_suppressed` 52, `move_out_of_band` 25, `out_of_scope` 1.
- **Open-intents (71):** only **27 passed the risk gate** → 27 fills. Gate rejects on the
other 44:
  - `coin_book_too_thin` 25 — liquidity gate working as intended.
  - `**tp_below_cost` 9** — the take-profit target did not even clear fees+slippage; the gate
  correctly killed these. **This is a TP-placement signal, see §3.**
  - `no_eligible_slot` 7, `same_direction_exposure_cap` 3 — slot/correlation gates.

### SL/TP geometry (realized distances from entry)

> **Mechanism (verified post-review):** v2's stop is the **VWAP structural stop**
> (`StopTypeEnum.STRUCTURAL`, clamped inside liquidation by the risk gate); the take-profit is
> the **ATR-derived leg** (reference ± ATR×multiplier) — see `momentumCore.ts:buildMomentumExit`.
> So below, the wide leg is the **VWAP distance** (SL) and the tight leg is the **ATR TP** — *not*
> an ATR stop. `atr_stop_multiplier`/`structural_stop_hard_cap_pct` do not place v2's stop.


| exit / side         | SL dist (VWAP) | TP dist (ATR) | TP/SL (reward:risk) |
| ------------------- | -------------- | ------------- | ------------------- |
| take_profit / long  | 3.04%          | 1.25%         | **0.41–0.52**       |
| take_profit / short | 1.84%          | 0.88%         | ≈0.96               |
| time_stop / long    | 2.62%          | 1.32%         | 0.50–0.62           |
| time_stop / short   | 3.43%          | 1.56%         | ≈0.98               |


**Reward:risk is well below 1 on the long book (~0.5–0.6); the short book sits ≈1.0.** The
long-side asymmetry dominates (tier2 longs are the dollar drag). With RR ≈ 0.5–0.6 on the longs
you need a >60% win rate to break even; the book runs 42%. The remedy is geometric — tighten/
anchor the **VWAP structural SL** or push the **ATR TP** out — and applies mainly to the longs.

### Cross-version (same 149 events, shadow)


| version                | opens               | skips   | skip rate        |
| ---------------------- | ------------------- | ------- | ---------------- |
| v0 (baseline)          | 0                   | 149     | 100% (by design) |
| **v2 (active)**        | 71 intent / 27 fill | 78      | ~52%             |
| v1 (mean-rev shadow)   | 52                  | 97      | 65%              |
| **v3 (hybrid router)** | **32**              | **117** | **78%**          |


v3, the flow-classifying router, would open **less than half** of what v2 intends (32 vs 71),
and routes `catalyst_risk → skip` (`FLOW_ROUTED_SKIP`). Given that the loss is concentrated in
`catalyst_risk`, v3's added selectivity is the natural fix — **but I cannot prove its PnL yet.**
Correction (post-review): **v3 emits no `simulated_fill` at all (NULL on all 32 shadow opens)** —
it is the *missing-fill* failure mode, not a degenerate one. The degenerate
`missed: wrong_side_of_stop` / `entryPrice: 0` / `lowFidelity` shape belongs to **v1** (24/52
opens). Either way no shadow PnL is computable, so the D2 gate blocks the v3 head-to-head; the
caveat is in fact stronger than "low fidelity."

---

## 2. What could explain the pattern (structural vs noise)

1. **Momentum applied indiscriminately across flow types (structural).** v2 has no flow
  router — it follows every triggered move. `catalyst_risk` spikes (liquidation / event-driven
   one-and-done moves) do not continue; they revert or chop. Following them with momentum is a
   negative-expectancy bet. This is not noise — it is a 13-trade, −37 USDT directional signal
   that matches the strategy's design gap exactly. This is the thesis v3 (hybrid) exists to fix
   (`V3HybridRouterStrategy` routes `catalyst_risk → skip`). **Second mis-route:** v2 also
   *follows* the 4 `forced_exhaustion` trades (OI-collapse / liquidation-cascade flow), which the
   design says should be **faded** (v3 routes these to mean-reversion). They net ~flat here but
   are a structural mis-route in the same family, not pure noise — relevant to the v3-selectivity
   thesis.
2. **Sub-1 reward:risk geometry on the long book (structural).** The **VWAP structural stop**
  sits ~2.5–3.4% out while the **ATR TP** lands ~0.9–1.6% out — wide stop, tight target. On longs
   this is RR ≈ 0.5–0.6; on shorts it is ≈1.0. The long book is structurally short its own payoff.
   The 9 `tp_below_cost` gate rejects are the same disease surfacing at the gate: the ATR TP is
   placed too tight to clear costs on a non-trivial fraction of signals.
3. **Time-stop as the dominant exit on dead signals (structural + selectivity).** MFE +0.3% on
  the time-stop bucket says the entries themselves are weak — the move the detector flagged did
   not produce follow-through. This is a **selectivity (skip) problem**, not a stop/TP tuning
   problem. Tightening TP or widening SL will not rescue a trade that never moves.
4. **tier2 drag (structural, known).** Consistent with the tier-1-only live policy.
5. **Calibration gaps that bound my confidence (must-flag):**
  - **Shadow-fill data is not usable for PnL — two distinct failure modes.** **v3 emits no
   `simulated_fill` at all** (NULL on all 32 shadow opens). **v1's fills are degenerate**
   (`missed: wrong_side_of_stop`, `entryPrice: 0`, `lowFidelity: true`, 24/52 opens). This is
   the **open D2 production-verification gate** in `STATUS.md` (non-zero `simulated_fill` +
   non-degenerate `close_reason` required).**Until D2 cl** **oses, the v3 "would do better"
   hypothesis is unproven — I have v3's selectivity, not v3's PnL.**
  - n = 26, single regime. No sub-period hold-out. The flow-split signal is strong enough to
  act on as a *test directive*, not as a calibration.
  - Known backtest divergences (BTC index-shock understated, ETH dead leg) do not affect this
  live-soak read but remain relevant for any backtest validation of the changes below.

---

## 3. Verdict on the user's three questions

**Q1 — Is the strategy making correct decisions?**
Partially. The **gates** are behaving well (book-depth, tp-below-cost, regime suppression all
firing correctly). The **entry selection** is not: v2 cannot tell `trend_initiation` (which it
trades profitably) from `catalyst_risk` (which the design routes to **skip**). It is making the
right decision on a third of the book and a wrong, repeated decision on the catalyst-risk half.

**Q2 — Is it setting SL and TP correctly?**
**On the long book, no — the reward:risk is inverted.** The **ATR TP** sits ~0.5–0.6× the
**VWAP structural stop** distance on longs (RR < 1); shorts sit ≈1.0. 9 signals were gate-killed
for `tp_below_cost`. The stops themselves are behaving (clean −1.9% SL fills, no
liquidation-distance violations seen), but the **ATR TP is too tight relative to both the VWAP
stop and to costs on the long side**. A 42%-win-rate book needs RR ≥ ~1.4 to be positive; the
long book runs RR ≈ 0.5–0.6.

**Q3 — What can be improved for positive PnL?**
In priority order (highest expected impact first):

1. **Gate/route by flow_type.** Route `catalyst_risk` momentum entries to **skip** (the design's
  answer, not fade — `meanReversionCore` explicitly never fades catalyst/idiosyncratic flow);
   also reconsider v2 *following* `forced_exhaustion` (design fades it). This removes the −37 USDT
   bucket and is the entire reason v3 exists. Validate v3 head-to-head **once the D2 shadow-fill
   gate is closed** (v3 currently emits no fills at all).
2. **Fix the long-book reward:risk geometry.** Push the **ATR TP** out or tighten the **VWAP
  structural SL** so long-side RR ≥ ~1.4 (shorts are already ≈1.0). The `tp_below_cost` rejects
   say the TP is placed below a cost-aware floor — anchor TP to `cost + k·ATR`, not a fixed
   fraction. Reason this against a *VWAP* stop, not an ATR stop.
3. **Raise entry selectivity to cut the dead time-stop bucket.** 17/26 trades reach the
  time-stop with +0.3% MFE — these signals carry no follow-through. A stronger
   trigger/exhaustion confirmation (v1 carries `require_exhaustion_confirmation`) would drop the
   non-events.
4. **Keep live tier-1-only.** tier2 is −31 in this window.

---

## 4. What I would check next (smallest confirming queries) — **executed, results in §4.1**

1. **D2 first.** Re-run the soak until `shadow_decisions.simulated_fill` is non-degenerate, then
  `compareVersions(v2, v3)` on the same `event_id` set. This is the single query that converts
   the v3 recommendation from hypothesis to decision.
2. **Flow × MFE histogram.** Confirm `catalyst_risk` MFE is systematically below
  `trend_initiation` MFE (would prove the route-by-flow thesis directly).
3. `**getFunnelSummary` sl sub-cause split** on `tp_below_cost` to see the exact cost floor vs
  intended TP gap — sizes the RR fix.
4. **Extend the soak to ≥ 60 closed trades / ≥ 2 regimes** before any number is locked.

### 4.1 Results of the confirming queries (executed 2026-06-21)

> **Window note:** these were run on an explicitly **pinned** window
> (`opened_at` in `2026-06-19 22:01 → 2026-06-20 22:01 UTC`) so they reproduce. On this exact
> window the formerly-open position has since closed → **n=27 closed** (catalyst_risk now 14 /
> **−39.29**), vs the headline snapshot of 26 closed + 1 open. The 1 extra trade is a
> catalyst_risk loss; no thesis changes.

**① D2 gate — is the v2-vs-v3 comparison computable yet? → NO (still blocked).**

| shadow_version | opens (24h) | has `simulated_fill` | missed | zero-entry | clean fills (last 3h) |
|---|---|---|---|---|---|
| v1 | 43 | 13 | 10 | 10 | 2 / 4 |
| **v3** | **28** | **0** | 0 | 0 | **0 / 3** |

The comparison is **structurally ready** — 161 shared v2↔v3 `event_id` pairs exist in the window,
the join works. It is **PnL-blocked**: **v3 produces zero simulated fills** (the *missing-fill*
mode — its shadow opens are never handed to the fill simulator), and v1's fills are still mostly
degenerate (`missed`/`entryPrice=0`), with only 2 clean fills appearing in the last 3h. **Verdict:
`compareVersions(v2, v3)` cannot return a PnL today.** Concrete D2 sub-task surfaced: **wire v3
shadow opens into the fill simulator** — fixing v1 fidelity alone does not unblock the v3
head-to-head.

**② Flow × MFE — does catalyst_risk genuinely lack follow-through? → YES, decisively.**

| flow_type | n | avg MFE | **median MFE** | max MFE | avg MAE | **reached TP band (≥1.25%)** |
|---|---|---|---|---|---|---|
| **trend_initiation** | 8 | 1.040% | **0.997%** | 2.374% | −0.461% | **3 / 8** |
| **catalyst_risk** | 14 | 0.262% | **0.209%** | **0.613%** | −1.028% | **0 / 14** |
| forced_exhaustion | 4 | 0.351% | 0.000% | 1.052% | −0.946% | 0 / 4 |
| market_beta | 1 | 0.000% | 0.000% | — | −0.944% | 0 / 1 |

This is the strongest evidence in the analysis, and MFE is a **path statistic independent of where
SL/TP sit** — so it proves the entries themselves, not the exits. **Not one of the 14
catalyst_risk trades ever reached the TP band; their best excursion topped out at +0.61%**, and
their downside (MAE −1.03%) is ~4× their upside (MFE +0.26%) — i.e. catalyst_risk events move
*against* a momentum entry. trend_initiation is the mirror image (MFE +1.04% ≫ MAE −0.46%, 3/8
reached TP). The flow classifier is correctly separating dead events from real ones; v2 simply
isn't acting on it. **Route-by-flow thesis confirmed.**

**③ tp_below_cost — exact cost-floor vs intended-TP gap. → tier2-structural.**

All **9 rejects are tier2.** `take_profit` is not stamped on these rejects (instrumentation gap —
the gate fires before TP is committed), so I reconstructed the intended ATR TP (`atr_14 × 1.5 /
price`) and the cost floor (round-trip taker fee ≈0.09% + 2× tier slippage) from the snapshot:

| | intended ATR TP dist | tier2 cost floor | shortfall |
|---|---|---|---|
| range across the 9 | **0.46% – 0.78%** | **≈1.09%** (2×0.50% tier2 slippage dominates) | **~0.3–0.6% short** |

Every tier2 ATR TP is geometrically incapable of clearing tier2's cost floor — the 2× tier2
slippage (0.50%, 3.3× tier1's 0.15%) alone exceeds the entire ATR TP distance. **This is a
tier2-specific structural defect, not a universal TP-tightness problem.** On tier1 the floor is
≈0.39% and the ATR TP (~0.6–1.2%) clears it. Directly reinforces "keep live tier1-only", and tells
the RR fix it must be **tier-aware** (tier2 needs a wider TP multiplier or exclusion, not a global
TP change). *Caveat: 0.09% round-trip fee is an estimate; the gap is large enough that the exact
fee const does not change the conclusion.*

**④ Extend the soak — sample-size directive.** Current fill pace ≈ 26–27 closed / 24h, so **≥60
closed trades ≈ 2.5 more soak-days**, and **≥2 regimes** requires the window to span a regime
transition (track via `regime_label` / `selectHaltState`). No number above should be locked before
both conditions are met. **Status: not yet met — n=27, single regime.**

---

## 5. What I would NOT change yet (and why)

- **Do not touch ATR/stop multipliers, sigma trigger, or time-stop minutes on n=26.** The
time-stop bleed is a *selectivity* symptom; tuning the stop treats the symptom and risks
destroying the `trend_initiation` edge that is currently paying.
- **Do not promote v3 on this data.** Its selectivity is visible; its PnL is **uncomputable** —
v3 emits zero simulated fills (§4.1①). Promoting on selectivity alone is exactly the
premature-calibration trap.
- **Do not widen tier exposure.** tier2 drag is real in-window.
- **Do not declare the strategy "broken."** Against the v0 skip baseline the *profitable* subset
(`trend_initiation`, tier1) is intact; the fix is subtractive (route out catalyst_risk) and
geometric (RR), not a rebuild.

---

### Appendix — query provenance

All figures from live `trade_bot` Postgres (`positions`, `decisions`, `shadow_decisions`,
`strategy_versions`), `state='closed'` for realized metrics. v0/v1/v3 read from `shadow_decisions`
(per the shared-vs-shadow split). `decisions.position_id` null as expected; open-decision
snapshots not required for this aggregate read. **§1–§3 reflect the original trailing-24h
snapshot (26 closed + 1 open); §4.1 confirming queries use an explicitly pinned window
(`2026-06-19 22:01 → 2026-06-20 22:01 UTC`, 27 closed) so they reproduce exactly — see the §4.1
window note for the 1-trade reconciliation.**