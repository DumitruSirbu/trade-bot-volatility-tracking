> **EXP-005 — INCONCLUSIVE (lever found, treatment untested)** | 2026-06-29 | [back to index](README.md)

# Time-stop dominance in `trend_initiation` momentum — root-cause decomposition

## 1. Summary

We investigated why 79% of v16 `trend_initiation` momentum trades close on `time_stop`, to find levers that reduce that dominance. Two findings reframe the problem. First, the time-stop rate itself is structural and barely moves with any filter (74–82% in every regime/tier/side cohort) — confirming EXP-001/EXP-004 that "fix the clock" approaches are dead. Second, and new: **the time-stop loss is almost entirely slippage, not adverse price**. The 278 time-stops are near-flat on price (gross-ex-slippage = −$8.27 total, −$0.03/trade) and lose because modelled slippage costs $1.25/trade on a high trade count. Slippage accounts for $433 of the $536 net loss (81%). The actionable lever that emerges is **entry selectivity to cut trade count (and therefore slippage drag)**, with the single highest-confidence cut being **tier2** (31% of trades, −$300 net, 11.8% WR, consistently worst across all three sub-windows). No cohort reaches net-positive, so this is a loss-reduction / problem-reframe result, not a profitability fix — hence INCONCLUSIVE pending a treatment backtest.

## 2. Setup

- **Data source:** `backtest-v16.json` — V3HybridRouterStrategy, `strategy_versions_id=16`, `max_tp_dist_factor=5.0`, $1000 capital.
- **Window:** 2026-05-30 → 2026-06-29 (27.9 days of trade timestamps).
- **n:** 350 trades, all `flowType=trend_initiation`. Exit mix: time_stop 278 (79.4%), stop_loss 44 (12.6%), take_profit 28 (8.0%).
- **Live cross-check:** `positions` table, `strategy_version_id=16`, n=14 closed (idiosyncrasy/score/tier/side).
- **Method:** Python over the trade array; SQL over `positions`. PnL identity verified: `net = gross − fees − funding` per trade (max residual $4.54, attributable to per-trade rounding). **Slippage is embedded in the fill prices inside `grossPnlUsdt`** and reported separately as `slippageCostUsdt`; "gross-ex-slippage" below means `grossPnlUsdt + slippageCostUsdt` (the price-only outcome with modelled slippage removed).

### 2a. Backtest validity caveat (read before trusting absolute numbers)

This 30-day backtest replays the **current M47/M48 code** (`strategy_versions_id=16`) against historical candles, but M47 only went live on 2026-06-25. So ~26 of 30 days retroactively apply geometry checks (`isDegenerateMomentumGeometry`, fill-acceptance guards) and signal-quality criteria that were not in production during that period. Consequences:

- The 350 trades are **internally consistent** (one code path throughout), so **relative** comparisons within this dataset (regime vs regime, tier vs tier, TP-hit vs time-stop, sub-window vs sub-window) are valid.
- **Absolute** metrics (WR=23.4%, net=−$535.69) are "what current code would have done retroactively," not what the live system produced. Treat absolute WR and dollar magnitudes as indicative only.
- Modelled slippage (`tick_aggregates` fills) is itself a calibration surface; the $433 slippage figure is model output, not realized live cost. Its *dominance* of the loss is the robust signal; its exact magnitude is not.

## 3. Analysis results

### 3.1 TP-hit vs time-stop profile (28 TP vs 278 TS)

| Metric | Take-profit (n=28) | Time-stop (n=278) |
|---|---|---|
| regime: trending_up | 17.9% | 21.6% |
| regime: trending_down | 46.4% | 25.9% |
| regime: transitioning | 35.7% | 52.5% |
| tier1 / tier2 | 75.0% / 25.0% | 67.6% / 32.4% |
| side long / short | 28.6% / 71.4% | 52.9% / 47.1% |
| hold min (median / p25 / p75) | 8.2 / 7.6 / 13.0 | 15.0 / 15.0 / 15.0 |
| gross avg / median | +2.529 / +1.622 | −1.284 / −1.283 |
| net avg / total | +2.348 / +65.75 | −1.473 / −409.42 |

Read-outs: TP hits skew **short** (71%) and **trending_down** (46%) and resolve fast (median 8.2 min). Time-stops skew **transitioning** (52.5%) and split evenly long/short. Time-stop gross is a tight near-flat cluster (median −$1.28), not deeply negative — these are flat drifters, not blow-ups. Of 278 time-stops, 63 had positive gross before fees.

### 3.2 PnL decomposition — slippage is the dominant cost

| Component | Total |
|---|---|
| gross (incl. embedded slippage) | −$469.80 |
| fees | −$66.55 |
| funding | −$0.66 |
| **net** | **−$535.69** |
| slippage (embedded in gross) | $433.25 |
| **gross-ex-slippage** | **−$36.55** |

| Exit group | n | slippage | per-trade | gross | gross-ex-slip |
|---|---|---|---|---|---|
| take_profit | 28 | $29.55 | $1.055 | +$70.82 | +$100.37 |
| **time_stop** | **278** | **$348.55** | **$1.254** | **−$356.82** | **−$8.27** |
| stop_loss | 44 | $55.15 | $1.253 | −$183.80 | −$128.65 |

**The 278 time-stops lose −$0.03/trade on price and −$1.25/trade on slippage.** Strip modelled slippage and the entire book is near-breakeven (−$36.55). Slippage is 81% of the net loss.

### 3.3 Regime-filter simulation (vs baseline WR=23.4%, net=−$535.69, PF=0.240)

| Regime | n | WR% | net | PF | TS% | exit mix (TP/TS/SL) |
|---|---|---|---|---|---|---|
| trending_up | 78 | 21.8 | −104.66 | 0.375 | 77 | 5 / 60 / 13 |
| trending_down | 91 | 25.3 | −121.43 | 0.235 | 79 | 13 / 72 / 6 |
| transitioning | 181 | 23.2 | −309.61 | 0.183 | 81 | 10 / 146 / 25 |

`transitioning` is 52% of trades, the worst PF (0.183), and 58% of the net loss. A trending_up-only filter would skip 272 of 350 trades (78%) yet still loses (−$104.66) — regime alone does not rescue. The actionable cut is **drop `transitioning`**, not "keep only trending_up."

### 3.4 Tier-filter simulation

| Tier | n | WR% | net | PF | TS% | exit mix (TP/TS/SL) |
|---|---|---|---|---|---|---|
| tier1 | 240 | 28.8 | −235.20 | 0.361 | 78 | 21 / 188 / 31 |
| tier2 | 110 | 11.8 | −300.50 | 0.108 | 82 | 7 / 90 / 13 |

**tier2 is worth dropping:** 31% of the trades, 56% of the net loss, an 11.8% win rate, PF 0.108, and it carries $262 of the $433 total slippage. tier1-only nearly halves the loss (−$235) and lifts WR to 28.8%; on price (gross-ex-slip) tier1 is −$20.94 vs the full book −$36.55.

### 3.5 Long vs short

| Side | n | WR% | net | PF | TS% |
|---|---|---|---|---|---|
| long | 182 | 23.1 | −290.89 | 0.275 | 81 |
| short | 168 | 23.8 | −244.81 | 0.195 | 78 |

Win rates are indistinguishable (23.1 vs 23.8). Shorts are **not** structurally worse; they actually produce more TP hits (20 vs 8) but a fatter loss tail (PF 0.195). Side alone is not a lever; side interacts with regime (shorts win in trending_down — see 3.7).

### 3.6 Time-stop hold-time distribution

| Bucket | count |
|---|---|
| 0–5 min | 0 |
| 5–10 min | 0 |
| 10–15 min | 0 |
| ≥15 min (cap) | 278 |

**Every time-stop runs the full 15-minute window** — the backtest applies no early time-exit, so all 278 exit exactly at the cap. Median hold: time-stops 15.0 min vs TP hits 8.2 min. Time-stops are not "almost ran out of time" near-misses nor immediate reversals; they are positions that drift sideways/flat for the whole window and exit near zero on price (median gross −$1.28). This is why widening the clock (EXP-001) cannot help: there is no pending move to capture.

### 3.7 Regime × Tier cross-table [n, WR%, net]

| | tier1 | tier2 |
|---|---|---|
| trending_up | 55 / 25.5% / −45.79 | 23 / 13.0% / −58.87 |
| trending_down | 57 / 36.8% / −28.64 | 34 / 5.9% / −92.79 |
| transitioning | 128 / 26.6% / −160.77 | 53 / 15.1% / −148.84 |

The only near-breakeven cell is **trending_down × tier1** (36.8% WR, −$28.64, PF 0.555, gross-ex-slip **+$22.21**). Every tier2 cell is a deep loser. Adding side: trending_down × tier1 × short is n=56, 35.7% WR, gross-ex-slip +$14.75. Cumulative selectivity:

| Filter | n | WR% | net | PF | TS% | gross-ex-slip |
|---|---|---|---|---|---|---|
| tier1 only | 240 | 28.8 | −235.20 | 0.361 | 78 | −20.94 |
| tier1 short | 109 | 31.2 | −86.44 | 0.360 | 73 | +10.02 |
| tier1 ex-transitioning | 112 | 31.2 | −74.42 | 0.525 | 77 | **+26.72** |
| tier1 trending_down | 57 | 36.8 | −28.64 | 0.555 | 74 | +22.21 |

Note the TS% stays 73–78% even in the best cohorts — **selectivity does not reduce the time-stop rate; it reduces how many time-stops you take and thus the slippage drag.**

### 3.8 Symbol concentration

74 symbols traded; losses are **spread, not concentrated**. Worst 10 symbols sum to −$256 = 45% of the −$573 losing-symbol total. Top by count: WLD (n=20, 20% WR, −$27.77), LAB (n=17, 17.6%, −$32.81), VVV (n=16, 18.8%, −$45.18), ENA (n=14, 28.6%, −$14.57), SOXL (n=13, 38.5%, −$11.87), HYPE (n=12, 8.3%, −$14.06), JTO (n=12, 25.0%, −$7.02), RE (n=11, 36.4%, −$13.03), ALLO (n=10, 10.0%, −$24.62), FIL (n=10, 30.0%, −$7.17). No single symbol drives the book; a symbol blacklist is not a viable lever.

### 3.9 Live positions cross-check (n=14, indicative only)

| exit_reason | n | avg_idio | avg_score | avg_vwap_dev | net |
|---|---|---|---|---|---|
| time_stop | 6 | 0.7511 | 50.44 | −0.178 | −15.10 |
| force_close | 4 | 0.9094 | 48.07 | −1.652 | −0.80 |
| stop_loss | 3 | 0.8633 | 52.46 | −1.463 | −8.49 |
| take_profit | 1 | 0.8760 | 70.18 | +1.557 | +13.13 |

The single live TP hit scored **70.2** vs 48–52 for every losing group, and was the only entry with a positive vwap-deviation. `idiosyncrasy` does not separate winners (force_close had the highest at 0.909). This weakly corroborates EXP-003's **signal_score-floor** hypothesis (not idiosyncrasy) — but n=1 win is anecdote, not evidence. Live tier/side split: tier2 went **0/7 wins, −$20.89**; tier1 went **2/7, +$9.63** — directionally consistent with backtest §3.4.

### 3.10 Sub-window robustness (3 disjoint thirds; methodology gate)

| Cohort | third1 | third2 | third3 |
|---|---|---|---|
| ALL net | −211.13 | −168.94 | −155.63 |
| **tier2 WR%** | **17.8** | **9.1** | **6.2** |
| tier2 net | −117.50 | −90.26 | −92.74 |
| tier1 ex-transitioning WR% | 28.9 | 19.4 | 41.9 |
| tier1 ex-transitioning gross-ex-slip | +6.33 | −7.57 | +27.96 |

**tier2 is robustly worst in all three sub-windows** (WR 17.8/9.1/6.2, net all ≈ −$90 to −$118) — the strongest, most stable signal in the dataset. The positive cohorts (tier1 ex-transitioning) are unstable in WR (28.9/19.4/41.9), matching EXP-003's warning that the "good core" edge does not hold per-window. So: the *negative* lever (drop tier2) is decision-grade; the *positive* cohorts are hypothesis-grade only.

## 4. Candidate levers (ranked by evidence strength)

1. **Drop tier2 from `trend_initiation` momentum** — *Confidence: HIGH.* Mechanism: removes the worst-WR (11.8%), lowest-PF (0.108) cohort that is 31% of trades and 56% of net loss, cutting $262 of slippage drag. Data support: robust across all 3 sub-windows (§3.10) and corroborated live (0/7 wins, §3.9). Does **not** lower the time-stop *rate* (still 82%); it removes losing time-stops wholesale.

2. **Reduce slippage on entry/exit (maker-limit or passive entry)** — *Confidence: MEDIUM (high upside, untested).* Mechanism: slippage is 81% of the net loss; the price-only book is near-breakeven (−$36.55, §3.2). Halving modelled slippage moves the full book from −$536 toward ≈ −$100 and tier1-ex-transitioning to clearly positive on price. Caveat: §2a — modelled slippage magnitude is a calibration surface; a maker-entry variant also forgoes some fast TP fills (TP hits resolve in 8 min). Must be tested, not assumed.

3. **Deprioritize / drop `transitioning` regime** — *Confidence: MEDIUM.* Mechanism: 52% of trades, worst PF (0.183), 58% of net loss (§3.3). Data support: consistent across cohorts, but trending_up-only still loses, so this is a "cut the worst regime," not "keep one regime" lever; less clean than the tier2 cut.

4. **signal_score floor (~≥65)** — *Confidence: LOW (seeds EXP-003).* Mechanism: live TP hit scored 70 vs 48–52 for losers (§3.9). Data support: n=1 win — anecdotal. Needs the score distribution per exit reason over a larger live/shadow sample before acting.

5. **Favor trending_down × tier1 (× short)** — *Confidence: LOW.* Best cell on price (gross-ex-slip +$22.21) but WR unstable per window; hypothesis-grade only.

## 5. Verdict

**INCONCLUSIVE (lever found, treatment untested).** A clear, robust lever emerged (drop tier2) and the root cause was reframed (the time-stop loss is 81% slippage on a flat-drifting, high-count book — not an adverse-price or exit-clock problem). But no cohort is net-positive in this dataset, and the two highest-upside moves (slippage reduction, tier2 cut) have not been run as treatment backtests. Per §2a, the absolute WR (23.4%) and net (−$536) are retroactive-code figures and must not be quoted as live expectations; the relative rankings (tier2 ≪ tier1, transitioning ≪ trending, slippage-dominates) are the trustworthy outputs.

## 6. What this rules out

- **Time-stop rate is not reducible by selection.** It stays 73–82% in every regime/tier/side/combined cohort. Do not propose entry filters as a way to lower the time-stop *percentage*; they lower the *count of losing time-stops*, a different thing.
- **The exit clock is not the lever (re-confirms EXP-001/EXP-004).** All 278 time-stops run the full 15 min and exit flat on price (median gross −$1.28); there is no pending move that more time would capture.
- **Side is not a standalone lever.** Long and short win rates are 23.1% vs 23.8%; shorts are not structurally worse. Any side preference only matters interacted with regime.
- **Symbol blacklisting is not viable.** Losses are spread across 74 symbols; the worst 10 are only 45% of losing-symbol net.
- **idiosyncrasy is not the live separator** in this sample (highest on a non-winning group); if a signal-quality gate is built, floor on `signal_score`, not idiosyncrasy.
- **Stop-loss is not the main bleed.** SL is 44 trades and −$129 on price; the loss lives in the 278 time-stops via slippage.

## 7. Recommended next experiment

**EXP-006 (proposed): tier2 exclusion backtest for `trend_initiation` momentum.** Single, highest-confidence lever. Method: re-run the v16 strategy with tier2 entries gated off (route tier2 `trend_initiation` to `skip`), same window plus a fresh forward window, and report WR / net / PF / slippage / time-stop% vs the v16 baseline, broken out per sub-window. Hypothesis: removing tier2 cuts net loss ≈ 56% and total slippage ≈ $262 without sacrificing any net-positive cohort. Secondary arm (cheap to add): attribute the time-stop loss with slippage zeroed to size the upside of a maker-entry variant (EXP-007 candidate). Do not bundle the unstable positive cohorts (trending_down/tier1) into the gate yet — validate the tier2 cut in isolation first.
