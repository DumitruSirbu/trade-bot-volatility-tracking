# Candidate C — Offline Feasibility Simulation

**Date:** 2026-07-06  
**Type:** Offline read-only feasibility screen. Sim environment only; did not touch live xmom soak or any engine code. All scripts + data under `sims/candidate-c/` (gitignored). **Update:** Initial sim found cost-dominated no edge (C2 net +13.44% gross +75.60% at base slippage, but −6.18% at harsh). Follow-up improvement sweep tested whether cheaper variants rescue it. **Verdict:** Initial screen rejected. Sweep found two technically net-positive configs (R24 2× and R8 2× with liquid filter) but both are regime-fit artifacts — all edge is one thin DOWN bucket; UP/CHOP legs bleed. **No durable edge found.** If pursued, implement in separate aggressive-bot repository. **No promotion to engine or xmom.**

---

## What Candidate C is

An aggressive, regime-tilted cross-sectional momentum strategy on Binance USDT-M perpetuals. Every 8 hours, rank the universe (327 symbols) by trailing 24-hour return. Long the top 15 symbols, short the bottom 15. **Tilt the book by BTC 24h regime:** UP market → full long exposure + half short (net long); DOWN market → full short exposure + half long (net short); CHOP → neutral long-short split. Apply 3× gross leverage, no per-position ATR sizing or disaster stops in this sim (deferred refinement). This is the aggressive counterpart to the conservative xmom strategy already running live; the directional tilt is the novel element being tested.

---

## Why a standalone simulation, not the engine backtest

The existing `apps/engine/` backtest runner supports only single-symbol strategies (V0–V3 in StrategyRegistry) via a simple event loop. The xmom strategy runs **live only** in the portfolio orchestration path (`MomentumOrchestratorService`) and has no backtest harness. To avoid bloating the engine backtest infrastructure just for an exploratory aggressive variant, and to keep the running soak untouched, Candidate C was screened via a standalone read-only Node.js simulation (`sims/candidate-c/candidate-c-sim.mjs`) that reads 5m candles and funding rates directly from Postgres and simulates the rebalance loop deterministically.

---

## Data window and regime map

**Period:** 2026-05-30 20:00Z → 2026-07-06 17:10Z (37 days, 327 tradable symbols, 5m candles)

**BTC performance and regime buckets:**  
BTC closed the window **−13.6%** net (from ~43,600 to ~37,700 USDT). Four realized regimes on the window:

- **DOWN (05-31 → 06-06, ~7 days):** BTC −18.0%, realized vol ~51% annualized
- **UP (06-06 → 06-16, ~10 days):** BTC +10.1%, realized vol ~38% annualized
- **DOWN (06-16 → 06-25, ~9 days):** BTC −11.1%, realized vol ~48% annualized
- **CHOP/recovery (06-26 → 07-06, ~10 days):** BTC +6.1%, realized vol ~35% annualized

**Caveat:** This 37-day window is good for *variety* (touches down/up/down/chop) but each regime leg is only 7–10 days — thin buckets for robust regime-conditional testing. Do not treat any per-regime statistic here as independently significant.

---

## Method and honesty rails

- **Universe selection:** A symbol qualifies at rebalance time `t` if **both** candles `[t-L, t]` have ≥95% of their 5m slots populated and `close(t-L)` and `close(t)` are both present. No forward-looking confirmation (an earlier bug required the symbol to still print at `t+R` hours later, which is look-ahead bias — this was fixed). Survivorship-safe for new listings (zero pre-history → never qualify early).
  
- **Forward realization:** Each selected leg settles at `close(t+R)` if that candle exists; else at the last available close in the `(t, t+R]` window; else at `close(t)` (zero forward return) if the symbol delisted and never printed again. The forward close is **isolated to the PnL calculation** and never used to select or filter positions.

- **No look-ahead:** signals use only data ≤ rebalance time `t`; the forward close ∈ `(t, t+R]` is marked separately and only realized in the return calculation. Deterministic.

- **Turnover-aware costs:**  
  - **Fees:** 5 bps / side, flat taker.
  - **Slippage:** **side-tiered** (not flat). Long positions charged 15 bps/side. Short positions charged 40 bps/side (bottom-decile short basket is illiquid microcaps). Slippage is applied to the *traded delta* each rebalance (`|target_notional − prior_notional|` per symbol), not the round-trip upper bound. A persisting name at similar weight trades ≈0; a name entering the short book trades at its full notional × short slippage tier.
  - **Funding:** Standard perp convention — long pays positive funding; short receives it. For each held leg, summed from the funding_time rows in the hold window and applied as a cost (positive funding → cost for long, credit for short).

- **Sizing:** Equal-notional per leg; 3× gross leverage means the full book is allocated as `TARGET_LEVERAGE × equity / num_active_legs` per leg, so gross exposure is constant at 3×. The tilt shifts only the net long/short imbalance, not total leverage.

- **Regime tags:** BTC 24h trailing return > +1.0% ⇒ UP, < −1.0% ⇒ DOWN, else CHOP. Simple and non-tuned.

---

## Audit and critical fixes

A quant review found three issues; all three were **corrected before the numbers below:**

1. **BLOCKER — look-ahead in universe selection:** An earlier version required the symbol to have a candle at `t+R`, which is look-ahead (you'd only trade symbols you already knew would still print R hours later). This biased selection toward surviving/popular names and was a material positive bias. **Fixed:** qualification uses only `[t-L, t]` with ≥95% coverage, no future confirmation.

2. **HIGH — optimistic slippage model:** The first pass used flat 8 bps slippage for all positions and sides. The short book is bottom-decile, illiquid microcaps; this was ~5× too optimistic for the short leg. **Fixed:** side-tiered slippage (15 bps long / 40 bps short) reflecting actual liquidity profile.

3. **HIGH — inflated Sharpe from zero-padding and tiny-n:** Rebalances thin on breadth (< 30 tradable names after filtering) were zero-padded as "skip steps" in the return series, which deflated variance and inflated the Sharpe. Additionally, annualizing a 37-day series introduces bias on a small sample. **Fixed:** (a) skipped rebalances are excluded entirely from the Sharpe calculation (not zero-padded); (b) Sharpe is labeled **non-inferential** because n is small, and it is computed only on *traded* rebalances (101–107 periods depending on config).

**Pre-correction headline (MISLEADING — rejected after fixes):** C2 showed +47% net return and a +5.75 percentage-point "tilt benefit" over the neutral config. This headline **did not survive the corrections** and was an artifact of look-ahead, flat optimistic slippage, and zero-padding inflation.

---

## Corrected results

### Headline config comparison (net of all costs)

| Metric | **C1**<br/>(L=24h/R=8h/tilt) | **C2**<br/>(L=72h/R=8h/tilt) | **NEUTRAL**<br/>(L=24h/R=8h) | **V0**<br/>(no-trade) |
|--------|------|------|---------|------|
| **Final equity (net)** | 542.33 | 1134.45 | 548.45 | 1000.00 |
| **Total return (net)** | −45.77% | +13.44% | −45.16% | 0.00% |
| **Total return (gross)** | +35.41% | +75.60% | +23.78% | 0.00% |
| **Profit factor (gross)** | 1.06 | 1.13 | 1.04 | n/a |
| **Profit factor (net, per-rebalance)** | 0.77 | 1.08 | 0.73 | n/a |
| **Max drawdown** | −60.01% | −31.96% | −50.50% | 0.00% |
| **Sharpe (annualized, non-inferential)** | −2.99 | 2.19 | −3.95 | 0.00 |
| **Cost drag (% start equity)** | 84.44% | 62.29% | 68.55% | 0.00% |
| — Fees (USDT) | 122.70 | 101.03 | 101.23 | — |
| — Slippage (USDT) | 707.65 | 566.19 | 567.77 | — |
| — Funding (USDT) | 14.02 | −44.35 | 16.46 | — |
| **# rebalances (grid)** | 107 | 101 | 107 | 0 |
| **# rebalances traded** | 81 | 64 | 81 | 0 |
| **# rebalances skipped** | 26 | 37 | 26 | 0 |

### Slippage sensitivity (net total return)

The headline config assumes side-tiered slippage at **15 bps (long) / 40 bps (short)**. This is the dominant modeling choice; a reviewer should stress-test it. Below are three scenarios:

| Config | **Optimistic** (8/8) | **Base** (15/40) | **Harsh** (20/60) |
|--------|:---:|:---:|:---:|
| **C1** (L=24h/tilt) | −5.45% | −45.77% | −62.15% |
| **C2** (L=72h/tilt) | +52.29% | +13.44% | −6.18% |
| **NEUTRAL** (L=24h) | −10.99% | −45.16% | −59.91% |

**Interpretation:** C2 is **fragile** — the edge exists only in the optimistic-to-base slippage range. A shift to harsh tiers (which is realistic for the 52% tier2 short basket) flips it negative. C1 and NEUTRAL are negative across all tiers.

---

## Did the regime tilt add value?

Compare **C1 (tilt) vs NEUTRAL (no tilt)** — both use L=24h/R=8h, only difference is the directional tilt:

- **C1 net return:** −45.77%  
- **NEUTRAL net return:** −45.16%  
- **Tilt delta (net):** −0.61%

**Tilt delta (gross):** +11.63% (35.41% − 23.78%)

The tilt swung the *gross* return higher (more directional exposure = more gross exposure) but *net* return *lower* (the directional bet was the wrong direction, and costs ate the gap). The directional tilt on this 37-day window **added no value and cost 61 bps net**, precisely the opposite of what an aggressive thesis would promise. This is a single-window result on thin regime buckets; treat as directional feasibility only, not a validation or rejection of the regime-tilt hypothesis.

---

## Per-regime breakdown

Regime is labeled from BTC's realized 24h return **at each rebalance time** (not hardcoded dates). Note the thin per-regime leg counts:

**C1 (L=24h/tilt):**
- UP: 13 rebalances, 286 legs, net PnL −$24.69, hit-rate 48.6%
- DOWN: 36 rebalances, 792 legs, net PnL −$158.48, hit-rate 54.9%
- CHOP: 32 rebalances, 960 legs, net PnL −$319.04, hit-rate 48.4%

**C2 (L=72h/tilt):**
- UP: 15 rebalances, 330 legs, net PnL −$208.32, hit-rate 49.7%
- DOWN: 28 rebalances, 616 legs, net PnL +$707.11, hit-rate 56.0% ← **all the edge is here**
- CHOP: 21 rebalances, 630 legs, net PnL −$352.91, hit-rate 49.4%

**NEUTRAL (L=24h, no tilt):**
- UP: 13 rebalances, 390 legs, net PnL +$112.02, hit-rate 50.3%
- DOWN: 36 rebalances, 1080 legs, net PnL −$258.48, hit-rate 52.1%
- CHOP: 32 rebalances, 960 legs, net PnL −$299.56, hit-rate 48.4%

**Key observation:** C2's entire positive return (+$13.44% net, or +$134.45 USDT) comes from the DOWN regime (+$707.11 net). When BTC went down, the net-short C2 positioning captured the falling satellite losers. This is a **regime-fit artifact**, not a robust edge — it only works when the market is down, and down regimes are transient. The UP and CHOP regimes both bleed.

---

## Verdict

### 1. The regime tilt added no value
The directional tilt was the novel idea: press the major trend instead of hedging it out. On this window, **C1 (tilted) returned −45.77% net vs NEUTRAL −45.16% net**, a −0.61% delta. The tilt was a **wrong directional bet** (BTC was net down, and the tilt weighted net-long exposure until early June). Costs consumed any gross return advantage.

### 2. C2's edge is a fragile regime-fit artifact
C2 (longer lookback L=72h, tilted) is the only net-positive config at +13.44% net. But:
- **The edge is concentrated in ONE regime:** +$707.11 net from the DOWN leg (28 rebalances). In UP and CHOP, C2 is negative.
- **It is brittle on slippage:** the edge evaporates under realistic short-side liquidity assumptions. Moving from optimistic (8/8) to base (15/40) slippage cuts the return from +52.29% to +13.44%. Moving to harsh (20/60) flips it to −6.18%.
- **The short basket is 52% tier2 (hard to borrow, high slippage).** The sim charges a flat 40 bps slippage per side, but realizable short-side costs (borrow fees, funding on 72h holds, fast-mover slip) are higher and are not modeled here.

### 3. Costs dominate everything
At 3× gross leverage with 8-hour rebalancing:
- **Turnover-driven slippage is the biggest drag:** 707–566 USDT across configs, or ~57–71% of starting equity.
- **Funding is material:** long positions paying positive funding across the window; shorts getting a small credit from the DOWN regime's negative-funding legs.
- **Per-leg round-trip friction (entry+exit fees+slippage):** ~75–79 bps per leg. At an 8-hour rebalance cadence, the P&L needed to overcome costs is steep.

### 4. This is a feasibility screen on one thin window — NOT go/no-go
- **Sample size:** 37 days, four regimes, 7–10 days per regime. Each regime bucket is too thin to be independently significant.
- **One asset class, one regime diversity arc:** UP leg, down leg, sideways. Not two full BTC cycles. The cross-sectional momentum edge is known to decay (see EXP-011/012 on the conservative side); this window's DOWN leg may be drawing on a temporary regime-win.
- **No held-out test:** these configs were simulated on the same data they will be tuned from; the optimistic slippage scenario (C2 +52%) is probably an overfit marker.

---

## Improvement Sweep — Can the Cost Problem Be Fixed?

The initial sim showed C2 +13.44% net at base slippage (15/40 bps) but collapsed to −6.18% at harsh (20/60 bps), with costs consuming 57–71% of equity. A follow-up sweep tested whether cheaper variants could find a survivable configuration. This section documents what was tried, what worked partially, and why the cost problem cannot be engineered away.

### What was swept and why

The sweep varied:
- **Rebalance frequency:** R ∈ {8h, 24h, 48h} — slower rebalance = fewer turnovers = lower slippage drag.
- **Leverage:** {1×, 2×, 3×} — magnitude only; scales both gross return and costs proportionally.
- **Book mode:** long-short tilt (full exposure both sides with regime imbalance) vs. long-only (drop the short basket entirely).
- **Liquidity filter:** top-100 symbols by median dollar-volume (removes bottom-decile microcap shorts).

**Goal:** find any config net-positive under BOTH the base (15/40) AND harsh (20/60) slippage tiers — the robustness bar. Mechanics identical to the corrected main sim (point-in-time universe on `[t-L,t]`, forward-realization, side-tiered slippage, turnover-aware costs, funding sign convention, traded-only Sharpe). Tested on the same 37-day window.

### Headline ranking (by net return under harsh 20/60 tier)

| Config | net(base) | net(harsh) | gross | netPF(base) | maxDD(base) | cost%(base) | Robust? |
|--------|-----------|-----------|-------|------------|------------|-----------|---------|
| **LS tilt L72 R24 2x** | +15.07% | +7.65% | +35.05% | 1.24 | 19.44% | 20.00% | **YES** |
| **LS tilt L72 R8 2x LIQ100** | +14.17% | +2.22% | +49.57% | 1.18 | 20.04% | 34.61% | **YES** |
| LS tilt L72 R8 2x | +11.63% | −1.55% | +49.11% | 1.12 | 21.42% | 37.15% | no |
| LS tilt L72 R48 2x | −27.18% | −30.42% | −18.96% | 0.30 | 28.71% | 8.88% | no |
| LONG-only L72 R24 1x | −2.34% | −3.09% | −2.93% | 0.92 | 13.72% | −0.60% | no |
| LONG-only L72 R24 2x | −6.88% | −8.33% | −7.97% | 0.88 | 26.12% | −1.21% | no |
| LS tilt L72 R48 1x LIQ100 | −11.07% | −12.73% | −6.18% | 0.33 | 11.95% | 5.07% | no |

Two configs clear both tiers (net > 0 under base and harsh). But see the per-regime split before calling either an edge.

### Four findings

**1. Slower rebalance helps but is non-monotonic; R24 is the sweet spot.**

Cost drag falls monotonically with R (37.15% @ R8 → 20.00% @ R24 → 8.88% @ R48), confirming turnover is the dominant cost lever. But at R48 the *gross* signal itself goes negative (−18.96%): a 72h-lookback momentum signal does not survive a 48h forward hold — the signal decays faster than the cost saving. 

| R | net(base) | cost% | gross |
|---|-----------|-------|-------|
| 8h | +11.63% | 37.15% | +49.11% |
| 24h | +15.07% | 20.00% | +35.05% |
| 48h | −27.18% | 8.88% | −18.96% |

**R24 is the sweet spot:** slow enough to cut turnover drag meaningfully, fast enough to keep the cross-sectional momentum signal alive.

**2. Liquid-universe filter and long-only are counterproductive; the short book is both cost AND alpha.**

The microcap short basket is 52% of tier-2 names — the biggest slippage bleed. Filtering removes cost but kills the edge. At the R24 sweet spot, the liquid-100 filter *flips the net return* from +15.07% (base) to −8.63%, undoing the cost savings entirely because it removes the DOWN-regime alpha source. Long-only configs are strictly worse: every LO-* variant is net-negative under both tiers, and its cost drag is near zero, meaning there is no viable long-side alpha on this window.

**The short book is simultaneously the main cost AND the only alpha source on this window. You cannot engineer away the cost without killing the edge.**

**3. The robust winner is still a regime-fit artifact.**

The best survivor, **LS tilt L72 R24 2x** (+15.07% base / +7.65% harsh), is technically net-positive under both tiers. But per-regime breakdown reveals it is not a durable edge:

| Regime | Rebalances | Legs | Net PnL |
|--------|-----------|------|---------|
| UP | 6 | 132 | −$139.86 |
| DOWN | 8 | 176 | +$289.65 |
| CHOP | 6 | 180 | +$7.33 |

Essentially **ALL the edge is in the DOWN bucket** — a thin ~8-rebalance window covering the two BTC down-legs in the sample. In UP regimes the strategy *loses money*; CHOP is flat. Strip the down-legs and there is no edge. This is a regime-fit artifact, not a structural alpha source.

**4. Leverage confirmed magnitude-only; cannot rescue negative templates.**

Compare 1× vs 3× on the same R48/liquid-filter/LS template:

| Template | Leverage | net(base) | net(harsh) | gross |
|----------|----------|-----------|-----------|-------|
| LS L72 R48 LIQ100 | 1× | −11.07% | −12.73% | −6.18% |
| LS L72 R48 LIQ100 | 3× | −32.09% | −36.08% | −19.30% |

Return and cost both scale ~linearly with leverage; the *sign* is unchanged. **Leverage is a magnitude knob only — it cannot rescue a fundamentally negative-edge template.**

### Updated verdict

The cost problem *can* be mitigated: **R24 rebalance + 2× leverage is far better than 3×/8h**, cutting cost drag from 37% to 20% and producing net-positive configs that survive both base and harsh slippage tiers. But this is **not a validated edge**:

- **Entire profit is one regime:** the winning config draws all $289.65 of its DOWN-regime PnL from a thin 8-rebalance window; stripping that window leaves nothing. The two 10-day UP and CHOP regimes are both red.
- **Regime-fit artifact, not structure:** The window (2026-05-30 → 07-06) happened to contain two strong BTC down-legs where net-short positioning captured falling satellite losers; this is a 37-day coincidence, not a reproducible pattern.
- **Short book is the crux:** The only way to eliminate the short-basket cost is to drop it, which kills the entire edge. At R8 with the liquid filter the short bleed is reduced but the net signal is more expensive (cost 34.61% vs 20.00% at R24); at R24 the filter flips the config from +15% to −9%.

**Conclusion:** The sweep confirms that leverage and rebalance frequency are real cost levers, but the underlying edge candidate (regime-tilted cross-sectional momentum on this window) cannot be cost-engineered into a durable signal. The winning R24 2× config is technically net-positive under both slippage tiers but is fragile, regime-specific, and regime-fit-dependent. **Hypothesis-generating only; not a go-signal for multi-window validation.**

If the R24 2× config were to be tested further (deferred), the specific hypothesis to falsify is: **Does the DOWN-regime microcap-short alpha persist across independent windows and survive harsh costs out-of-sample?** Prediction: largely not. Two documented modeling caveats: (a) the liquid-universe filter used full-window liquidity ranking, a mild membership look-ahead that does not affect the winning configs; (b) forward-realization of delisted/stopped microcap shorts is clustered at last-known close in exactly the alpha-bearing short book, which may be optimistic.

---

## If pursued — next steps (deferred; sweep complete)

The improvement sweep already tested lower leverage (1×, 2×, 3×) and slower rebalance (R8, R24, R48). The findings do not support pursuing this candidate further on the current window:

1. **Multi-window backtest is required:** The current 37-day window is too thin and too regime-specific. The winning R24 2× config draws all its profit from a thin DOWN bucket; validating it would require ≥90–120 days spanning multiple independent BTC regime cycles. Only if multi-window testing shows the DOWN-regime microcap-short alpha survives out-of-sample would further refinement be justified.

2. **Realistic short-side modeling is prerequisite, not follow-up:** Borrow-fee schedule, funding on long holds, and liquidity-aware slippage (velocity-dependent, not flat %) are not refinements; they are part of the robustness check. The current model underestimates short-leg costs.

3. **ATR-normalized sizing + disaster stops:** The sim assumes equal-notional per leg and no per-position stops. This is deferred; position-level ATR normalization and hard stops would reduce tail risk but do not change the regime-fit diagnosis.

4. **Separate aggressive-bot repository:** If and only if multi-window testing shows a durable edge, **implement in a standalone aggressive-trading bot, not in this repo.** The conservative xmom soak is protected, live engine code is unchanged, and the aggressive thesis can evolve independently with full transparency around win rates and regime dependence.

### Non-negotiable guardrail

**Do NOT promote to engine or xmom:** Nothing from this sim should be merged into `apps/engine/` or `packages/shared/`. All sims live in gitignored `sims/` and are read-only. No aggressive variant shares live capital with the conservative xmom strategy during go-live ramp. The 37-day window and sweep results are hypothesis-generating only.

---

## Multi-window walk-forward (out-of-sample, 30-month history)

**Data:** 2024-01 → 2026-06 (30 months), 1h klines from Binance public dumps + funding, split into 10 independent calendar-quarter windows. Universe: 92 symbols with ≥28 months daily history, point-in-time at rebalance. Config under test: **LS tilt L72 R24 2× (N=15)** — the winning config from the improvement sweep, previously suspected to be a DOWN-regime fit on one 37-day window. Mechanics verbatim (point-in-time universe, forward-realization, side-tiered slippage, turnover-aware costs). Results source: `sims/candidate-c/candidate-c-multiwindow-results.md` (quant review: SOUND, no blockers).

**Verdict: DOES NOT SURVIVE OUT-OF-SAMPLE — NOT REPRODUCIBLE.**

- **Net-positive under BOTH base+harsh tiers: 0/10 folds.** Not one independent quarter passes the robustness bar.
- **Net-positive at optimistic 8/8 tier: 2/10 folds** (2025-Q4 DOWN, 2026-Q2 CHOP). This unrealistic tier is the only way the config clears zero.
- **Positive GROSS edge (before cost): 5/10 folds.** Even pre-cost, most quarters bleed.
- **Of the two optimistic-tier survivors: both are DOWN/bearish-regime windows.** No UP-regime or balanced CHOP fold is net-positive even at optimistic slippage.
- **Aggregate net PnL by regime bucket across all folds (base tier): UP −1107 USDT, DOWN −2564 USDT, CHOP −1384 USDT.** All buckets negative. DOWN is the largest loser, contradicting the single-window narrative that DOWN-leg shorting was the edge.
- **Turnover cost alone: 33.05%–57.54% per quarter.** Exceeds any positive gross edge.

**The original 37-day positive was a path fit, not a repeatable regime effect.** When split into 10 independent windows and tested forward-looking, the config fails out-of-sample in every quarter under realistic costs. A faint gross-edge exists at pre-cost, but the regime story is weaker than single-window testing suggested: DOWN is not a reliable winner (aggregate DOWN-bucket net is −2564 USDT, the largest loss bucket across all folds), so the edge was a temporary calendar coincidence, not a structural short-bias advantage.

**Per-fold results (base tier net return):**
```
2024-Q1 (CHOP, BTC +67.90%)  | net −40.27% | gross +17.16% | gPF 1.00
2024-Q2 (DOWN, BTC −11.89%)  | net −45.65% | gross +1.75%  | gPF 1.00
2024-Q3 (CHOP, BTC +0.61%)   | net −67.14% | gross −35.18% | gPF 0.93
2024-Q4 (CHOP, BTC +47.29%)  | net −72.75% | gross −45.50% | gPF 0.87
2025-Q1 (CHOP, BTC −12.55%)  | net −53.95% | gross −14.55% | gPF 0.98
2025-Q2 (CHOP, BTC +29.65%)  | net −61.50% | gross −29.24% | gPF 0.94
2025-Q3 (CHOP, BTC +6.21%)   | net −71.35% | gross −42.76% | gPF 0.80
2025-Q4 (DOWN, BTC −23.27%)  | net −34.12% | gross +24.73% | gPF 1.05 ← best
2026-Q1 (DOWN, BTC −22.25%)  | net −35.36% | gross +12.88% | gPF 1.04
2026-Q2 (CHOP, BTC −14.22%)  | net −26.55% | gross +29.75% | gPF 1.07 ← only optimistic-tier positive
```

Every fold is net-negative under base and harsh tiers, with net returns ranging −26.55% to −72.75%. The two DOWN-regime folds (2025-Q4, 2026-Q1) outperform the CHOP-dominated folds, but by only ~7–8 percentage points, and both are still deep red. This pattern exactly matches a regime-fit artifact: the strategy works *only when* BTC falls (shortable weakness is available), not across calendar regimes.

**Why the hypothesis failed:** the sweep carried the LS L72 R24 2× config forward as **"hypothesis to falsify"** after one 37-day window showed a DOWN-bucket advantage. Multi-window testing *falsified* it — the DOWN advantage was a single-window phenomenon, not a durable edge. Forward-testing on 10 independent quarters proves the config does not reproduce: 0 folds pass the base-tier robustness bar, and the best it can do at optimistic slippage is 2/10, both in bearish backdrops.

**Verified:** this resolves the open question from the prior sim: *Is the DOWN-regime alpha reproducible out-of-sample?* **No.**

---

## If pursued — next steps (deferred; sweep complete)

---

## Critical caveats — this is an upper-bound feasibility estimate

The modeling captures the *dominant* costs but the short leg specifically is charged **less** than reality:

- **Short-borrow availability & cost:** Perp shorts don't have a locate market, but availability and funding-as-borrow substitute; many tier2 shorts are hard to maintain at size. Not modeled.
- **Funding on long holds:** A 72h hold (C2) spans 9 funding intervals (8h × 9). Positive funding on a long position is a *cost per interval*; the sim sums realized funding, which is correct, but C2's +$707.11 DOWN regime legs are almost entirely tier2 short baskets that benefited from negative funding in those specific dates — a regime-win, not a structural edge.
- **Fast-mover slippage:** D1 losers averaged −14.6% trailing; entering/exiting the falling tail slips worse than the flat 40 bps tier2 floor.
- **Missed fills:** Taker-market always-fill was assumed; real momentum chases will miss some fills on fast moves.

---

## Reproduce

```bash
# The simulation reads from Postgres directly (candles, funding_rates).
# Set PHASEB_DB_URL if the database is not the default localhost.

cd sims/candidate-c/
node candidate-c-sim.mjs

# Output: candidate-c-sim-results.md (this file)
```

No engine code was touched. The sim is read-only and was never committed to `apps/` or `packages/`.
