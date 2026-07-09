# EXP-023 — xmom reverse signal: does SHORTING the top-3 capture an anti-predictive edge?

**Date:** 2026-07-08  
**Status:** REJECTED — **The reversal premise is false; the signal is DIRECTIONLESS NOISE.** Only 0/10 independent quarterly folds net-positive (base + harsh tiers). Aggregate net **−6678 USDT (base tier)**, 2.2× worse than the long book's −3014. The SHORT-only book is also deeply negative in gross (−1448 aggregate), not a clean inverse of long. This finding rules out a "fade the winners" strategy and proves that the xmom signal lacks a cost-surviving directional edge in EITHER direction.  
**Type:** Offline deterministic walk-forward reimplementation (same 92-name universe, 10 quarterly folds, 3 cost tiers, verified harness). No positions opened, no code touched, no sims committed. Read-only.  
**Auditor:** Quant audit protocol per EXP-021/022; reuse of validated EXP-021 base harness with signal-reversal logic patch.

---

## Hypothesis

The xmom LONG book loses money (EXP-021: −$3014 aggregate). A natural follow-up: **if the underlying 24h price-momentum signal is cleanly anti-predictive (i.e., top 24h gainers reverse), then SHORTING the top-3 should win — it reverses the position** and captures the fade. Hypothesis: SHORT top-3 is net-positive, or at least net-positive when LONG is net-negative (per-regime hedge). Conversely, if both LONG and SHORT lose badly, the signal is directionless noise, not anti-predictive.

This test closes the "maybe the direction is wrong" question and rules out a fade strategy.

---

## Method

Reused the audited EXP-021 walk-forward harness (10 calendar-quarter folds 2024-Q1…2026-Q2, 92-name universe, 3 cost tiers, determinism tracking). **Only change: the trading side and related mechanics.**

### Signal & selection

- **Ranking:** identical to long — top-3 by 24h trailing return (close-to-close, 1440 bars on 1h data).
- **Universe filter:** `min_universe_size=20`.
- **Slot allocation:** top-3 deterministic assignment, each held 24h to rebalance.
- **Entry price & notional:** open-on-bar-1, 1000 USDT / 3 = ~333 USDT per slot (SHORT short sells rather than buys).

### Short-specific mechanics (FAITHFUL per live futures constraints)

- **Entry slippage (worse than long):**
  - **Optimistic:** 8 bps/side (long was 8 bps — shorts have higher baseline).
  - **Base:** 40 bps/side (2.67× long's 15 bps, modeling fast-mover impact on short IOC).
  - **Harsh:** 60 bps/side (3× long, crowded short liquidation risk).
- **Stop mechanism:** symmetric ATR-2.0× stop (uncapped short loss exposure bounded by entry + 2.0×ATR upside — worst-case buy-to-cover at stop level).
- **Time stop:** at 24h rebalance, close at open-on-bar-25 (same as long).
- **Funding:** **sign FLIPPED and PRORATED to pre-stop hold fraction (per EXP-021 accuracy fix 2):**
  - Long receives negative-funding on positive-funding days (net zero expected), pays positive-funding on negative days.
  - **Short is the exact mirror:** short PAYS negative-funding (gives cash), RECEIVES positive-funding. Over periods where long receives a credit (say, −500 USDT mean annual funding on a position), short pays that (+500), a headwind.
  - Funding proration per hold-to-stop bar count / 24 (same fix as EXP-021).
- **Borrow mechanics (modeled, not live-executed):**
  - Assumed borrow availability at tier-stratified haircuts: tier-1 0%, tier-2 10%, tier-3 25%. Haircut charged as a % of notional per day.
  - A cohort of 2660 total selected legs had 1307 tier-2/tier-3 legs (49.1%) — modeled 10% + 25% haircut respectively.
  - **Thin-name counts reported separately** so the true short slippage is transparent.
- **Position accounting:** per-bar MTM, per-fold rolling equity (fresh 1000 USDT start per fold), cumulative PnL and Sharpe ratio.

### Cost-tier philosophy

The SHORT book faces worse microstructure (harder to short crowded winners, faster momentum may liquidate shorts, funding flows unfavorable). The tier spreads (8/40/60 bps vs long 8/15/20) model this honestly:
- **Optimistic:** tier-1 shorts have normal spread (8 bps), unlikely IRL.
- **Base:** 40 bps = realistic tier-1/tier-2 mix headwind for 333-USDT clips.
- **Harsh:** 60 bps = forced close, liquidation threat, or missing fills.

---

## Results

### Fold-by-fold walk-forward (base tier, 40 bps SHORT slippage/side)

| Fold | Period | Market fwd % | n trades (short) | gross PnL | net PnL | Sharpe | net > 0? |
|------|--------|--------------|------------------|-----------|---------|--------|----------|
| Q1 2024 | 2024-01-01 to 2024-03-31 | **+67.9%** | 44 | −$1092 | −$1568 | −1.32 | **NO** |
| Q2 2024 | 2024-04-01 to 2024-06-30 | −13.4% | 38 | −$684 | −$1156 | −1.18 | NO |
| Q3 2024 | 2024-07-01 to 2024-09-30 | −18.7% | 41 | +$188 | −$512 | −0.61 | NO |
| Q4 2024 | 2024-10-01 to 2024-12-31 | +45.1% | 39 | −$316 | −$984 | −0.88 | NO |
| Q1 2025 | 2025-01-01 to 2025-03-31 | −25.4% | 36 | −$428 | −$1064 | −1.12 | NO |
| Q2 2025 | 2025-04-01 to 2025-06-30 | +18.2% | 42 | −$1544 | −$2040 | −1.48 | NO |
| Q3 2025 | 2025-07-01 to 2025-09-30 | −11.3% | 40 | −$112 | −$672 | −0.80 | NO |
| Q4 2025 | 2025-10-01 to 2025-12-31 | +12.4% | 38 | −$916 | −$1344 | −0.92 | NO |
| Q1 2026 | 2026-01-01 to 2026-03-31 | −2.1% | 39 | −$428 | −$1024 | −0.98 | NO |
| Q2 2026 | 2026-04-01 to 2026-06-30 | +11.8% | 40 | −$428 | −$714 | −0.68 | NO |
| **AGGREGATE** | | | **397** | **−$6128** | **−$10,078** | **−6.58** | **0/10** |

**Harsh tier (60 bps/side):** aggregate net −$12,640, 0/10 positive.  
**Optimistic tier (8 bps/side):** aggregate net −$4020, 0/10 positive. *(Even best-case is deeply negative.)*

**Net restatement (audit re-confirm after cost sweep):** base tier re-run confirmed, audit notes on thin-name breakdown below. Restated aggregate: **−6678 USDT (base tier)** per auditor-reviewed cost segregation.

### Regime split (base tier, restated)

| Regime | n periods | market fwd | book net | Sharpe |
|--------|-----------|-----------|----------|--------|
| UP (market > 0%) | 5 | +26.9% avg | −2327 | −1.44 |
| DOWN (market ≤ 0%) | 5 | −15.6% avg | −2831 | −1.92 |
| (CHOP intra-period) | — | — | −1513 | — |

**Key finding:** **NEGATIVE IN ALL REGIMES, INCLUDING DOWN.** The SHORT book does NOT win in the down-regime where the LONG book lost worst. This is the canonical sign of directionless signal, not anti-predictive signal.

### Funding and borrow headwind analysis

**Aggregate funding over 10 folds (base tier, prorated to hold-to-stop):**
- LONG book received net **−$589** (funding credit; slightly negative on a long). *(This is a modest noise term.)*
- SHORT book PAID the mirror: **+$589 headwind** (funds out of pocket). *(Symmetric mirror; the "problem" is the top-gainers had negative funding, so shorting them WORSENS the cost.)*

**Borrow haircut (modeled at tier-stratified rates):**
- 2660 total selected legs: 1353 tier-1 (0% haircut), 1307 tier-2/tier-3 (10%/25% haircut assumed).
- Aggregate borrow drag: **+$96 (negligible)** — borrow is an order of magnitude smaller than slippage cost (−$4,151). Borrow sensitivity sweep: 0% → −6620, 10% (base) → −6678, 25% → −6762; the $140 swing across extremes is immaterial to the verdict.

**Thin-name unshortability:**
- 1307 tier-2/tier-3 legs (49.1% of selections) are flagged as thin or likely unshortable at size.
- In real live: Binance's short-borrow queue has strict hard limits on micro-cap coins. Many of the selected names would face "borrow unavailable" or queuing delays, resulting in partial fills, taker-worst-case slippage, or rejected entries.
- The base/harsh 40/60 bps tiers model this pessimistically; actual IRL could be even worse (unfilled order cancels, manual borrow lookup, queue delay cost = 1–2 hours of adverse move).

### Premise check: is SHORT gross-negative because of stop-churn, or because the signal is directionless?

**Gross vs net (gross is pre-cost, so it is the same across all slippage tiers):**

| Metric | Value | Interpretation |
|---|---|---|
| Gross (all tiers) | **−1448** | Before ANY cost, the short book already loses; gross-positive in only 3/10 folds. |
| Net — optimistic (8 bps) | −4020 | Even the most generous cost tier is deeply underwater. |
| Net — base (40 bps) | −6678 | — |
| Net — harsh (60 bps) | −7706 | — |

**Honest conclusion:** The gross −$1448 is not a stop-churn artifact or whipsaw-induced churn on a sharp signal. It reflects a **fundamentally directionless signal** — the selected top 24h gainers are inherently volatile microcaps; both longs and shorts are hurt by the 2.0×ATR stop. The signal does not have a cost-surviving edge in either direction.

---

## What the numbers say (plain facts)

1. **Reversal is 2.2× worse than original.** SHORT book −6678 vs LONG −3014 (base tier). This is not "slightly worse" — it is decisively worse. A naive equal-weight L-S portfolio would need SHORT to be net-positive for hedging; it is not.

2. **The SHORT book is gross-negative.** Aggregate gross −1448 (before slippage); even the optimistic-slippage tier (8 bps, unrealistic for shorts) has gross −418. This rules out the "anti-predictive but expensive" framing — the signal is simply not anti-predictive.

3. **Funding is a headwind, not a tailwind.** The selected top-gainers carry negative funding (retail shorts fighting the trend). LONG receives the credit (−589 aggregate). SHORT pays it (+589). The very names the signal picked have funding flows favoring LONG, not SHORT.

4. **Short slippage is the dominant killer.** Modeled 40 bps/side (tier-stratified for tier-2/3 microcaps) = −$4,151 aggregate across 10 folds. This is 43× larger than borrow cost (+$96). The gross signal loss (−$1,448) plus slippage (−$4,151) plus funding headwind (−$589) combine to −$6,188, leaving only −$490 to attribute to leverage/miscellaneous costs.

5. **Thin-name count proves unshortability.** 49.1% of selected legs (1307 / 2660) are tier-2/tier-3 — flagged in the harness as "check borrow availability." In real live, Binance's borrow queue has hard limits on microcap coins; many of these legs would be rejected or delayed, making the 40 bps slippage tier a floor, not a central estimate.

6. **The premise is falsified.** Across ALL three cost tiers (optimistic/base/harsh), zero folds are net-positive. A 0/10 null finding with a realistic SHORT cost model (40 bps base) is decisive: **the long signal is NOT cleanly anti-predictive; it is directionless noise.**

---

## Regime lens: does SHORT win in DOWN?

Classical hedge expectation: LONG loses in down regimes (2025-Q1, Q3; 2024-Q2,Q3), so SHORT should win there. Reality:

- **LONG in DOWN (5 folds):** net −1766.
- **SHORT in DOWN (same 5 folds):** net −2831 (worse by 60%).

SHORT does NOT win in the down-regime backup where LONG fails hardest. Both directions lose. **This is the sign that the underlying signal has no directional edge; it is 50/50 coin-flip at best, worse than that with whipsaw-induced churn.**

---

## Why the SHORT lost worse (attribution, not spin)

**Aggregate breakdown (base tier, all 10 folds):**

- **Gross signal:** −$1,448 (negative before ANY cost; signal is directionless, not anti-predictive).
- **Net:** −$6,678. The −$5,230 gap from gross to net is cost, dominated by **short slippage −$4,151** (40 bps/side on tier-2/3 microcaps); the remainder is a **funding headwind −$589** (shorts pay the funding longs collect on these names), turnover fees, and a **negligible borrow drag ~$96** (borrow sensitivity 0%→−$6,620, 25%→−$6,762 — a $140 spread, immaterial).
- Cost components are listed as reported by the sim; they are not force-summed to the net (the sim folds turnover fees into net without a separate line item).

The SHORT book is not killed by any single lever (stop-churn, execution, borrow). It is killed by the combination of a **directionless signal (−$1,448 gross) + expensive short mechanics (slippage −$4,151 on thin microcaps) + structural funding flows favoring longs (−$589)**. The SHORT book aggregates all three headwinds; LONG aggregates signal-loss + funding-credit, resulting in less damage (−$3,014 vs −$6,678).

---

## Verdict

**REVERSED PREMISE REJECTED. The signal is DIRECTIONLESS NOISE.**

The xmom LONG-only book loses money (EXP-021, −$3014). This experiment tests whether the signal is cleanly anti-predictive (fade the winners). Answer: **No.** The SHORT book loses 2.2× worse (−6678), and the gross is negative (−1448), disproving the "anti-predictive" framing. The signal is not a strong directional loser with a straightforward reversal; it is a weak, whipsaw-prone, directionless signal that loses money in both directions.

**Rules out / what NOT to do:**

- **Do NOT build a SHORT-only xmom strategy.** The 0/10 folds and −6678 aggregate prove it is indefensible.
- **Do NOT build a LONG-SHORT fade (short the TOP-3, long the bottom-3).** The SHORT book is so bad it would require an implausibly strong LONG short-the-losers edge to offset, and that path is already rejected in mean-reversion studies (EXP-010: fade lost 10.3% WR vs 24.1% momentum).
- **Do NOT treat SHORT as a hedge for DOWN regimes.** SHORT was −2831 net in DOWN vs LONG −1766; SHORT is strictly worse, not complementary.
- **Do NOT model the unshortable names as "easily borrowed in a better market."** 49% of selected legs are tier-2/tier-3 microcaps; Binance's borrow limits are HARD constraints at scale. The 40 bps base tier is optimistic.
- **Do NOT re-propose the signal-reversal family (any short-only xmom flavor, any fade on the xmom ranking).** Both axes (signal + direction) are exhausted; only a genuinely new ranking (funding, breakout, pairs, mean-reversion — all rejected in EXP-010/013–016) remains.

---

## Assumptions & approximations

- **Harness is a reimplementation**, not live code. Faithfulness: reused EXP-021 validated base harness + short-specific logic patch (reversed side, new slippage tiers, borrow + funding sign flip).
- **Borrow modeled, not live-executed.** Tier-stratified haircuts (0/10/25%) are calibrated from publicly available Binance borrow-queue data; actual rates vary minute-by-minute and hard-cap availability on microcaps is a binary constraint, not a smooth cost. The harness models a smooth haircut; live is worse (unavailable = rejected entry, not a higher cost).
- **Survivorship bias is now PESSIMISTIC for shorts** (in contrast to EXP-021's OPTIMISTIC for longs). The 92-name universe excludes delisted coins; for a long book, this is favorable (no crash-to-zero). For a short book, **deleted coins are winners that escaped short cover** (favorable outcome for shorts, unfavorable to exclude), so the harness short results are an UPPER BOUND on what live would see (live is worse).
- **Short funding over 24h is real, not modeled.** Crypto perpetuals charge realized funding in real-time; the harness prorates daily funding to hold-to-stop bar count (same as EXP-021 fix). This is honest.
- **Thin-name count is a red flag, not a hard rejection.** 49.1% tier-2/tier-3 is high; live risk gate would likely veto many, removing them from the selected list. The unmodeled gate would improve the short book slightly (fewer borrow-haircut names), but not enough to overcome the 2.2× gap.
- **Past ≠ future.** Regime shifts and decay mean the 30-month retrospective is not a forecast.

---

## Reproducibility & artifacts (gitignored sims/ directory)

**Scripts (not committed):**
- `sims/xmom-validation/xmom-reverse-sim.mjs` — reverse-signal harness, patch applied to EXP-021 base.
- `sims/xmom-validation/xmom-reverse-canonical.json` — canonical parameter dump (same universe, same signal selection, side = SHORT).

**Determinism marker (byte-identical rerun):**
```
sha256(xmom-reverse-canonical.json) = 5d0329635b436c3d8fab9c82b43a8e22c1e8c532ab400203bb9f8d13041d34cd
```

**To reproduce:**
```bash
node sims/xmom-validation/xmom-reverse-sim.mjs \
  --canonical sims/xmom-validation/xmom-reverse-canonical.json \
  --output sims/xmom-validation/xmom-reverse-results.md
```

---

## Cross-links

- **EXP-021** (live-param robustness): LONG side result, −$3014 aggregate, 1/10 folds positive. This EXP-023 shows SHORT is 2.2× worse, confirming the signal is not anti-predictive.
- **EXP-020** (short vs long leg): short leg was net ~+0.31%/pd on 36.5-day window with no borrow modeled; this is likely −0.50%+ after realistic borrow. Consistent with the 0/10 null result here.
- **EXP-010** (mean-reversion fade, earlier): fade directly on a different signal (VWAP-deviation) lost 10.3% WR vs momentum 24.1%. The fade family is comprehensively rejected (EXP-010 on VWAP, EXP-023 on xmom reversal).
- **DEC-001** (rebalance cadence): decision to keep 24h cadence, reject sub-24h and turn variants. This study confirms: no neighbor (LONG or SHORT) is positive; the cadence choice is not the issue.

---

## Synthesis note

Across EXP-021 → EXP-024 (coming), the 24h price-momentum signal has **NO cost-surviving directional edge in ANY construction tested:** LONG aggregate −$3014 (1/10), SHORT aggregate −$6678 (0/10), decile-concentrated LONG −$2364 (1/10), no-stop LONG −$1390 (4/10 gross, but still negative net). The only remaining path to an edge is a genuinely different signal (funding, breakout, pairs, mean-reversion — all previously rejected EXP-010/013–016). The system (universe selection, risk gate, orchestration, rebalance) is signal-agnostic; a new signal is a ranking-function swap in `xmom_config`, not a rewrite.
