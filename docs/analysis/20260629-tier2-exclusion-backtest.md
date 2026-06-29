> **EXP-006 — SUPPORTED (loss-reduction; not a profitability fix)** | 2026-06-29 | [back to index](README.md)

# Tier2 exclusion for `trend_initiation` momentum — analytical backtest

## 1. Summary

We tested whether excluding `coin_tier == 'tier2'` signals improves the v16 `trend_initiation` momentum book, the strongest lever seeded by EXP-005. Filtering the 350-trade v16 backtest to tier1-only (n=240) improves every headline metric versus the full-set baseline: win rate 23.4% → 28.8%, net PnL −$535.69 → −$235.20 (loss cut by 56%, +$300.49), net profit factor 0.240 → 0.361, max drawdown 51.6% → 23.9%. The per-trade expectancy improvement is robust across all three disjoint sub-windows (avg net/trade −1.064, −1.126, −0.750 vs baseline −1.531 in each). The verdict is **SUPPORTED** for the narrow hypothesis "dropping tier2 helps" — it does, and robustly. It is **not** a path to profitability: tier1-only is still net −$235, its breakeven win rate is 52.8% against a delivered 28.8%, and even removing 100% of modelled slippage leaves it at −$64 (gross-ex-slippage −$20.94, fees −$45.56). Tier2 exclusion is a loss-reduction / risk-control filter, not an edge.

## 2. Setup

**Method — analytical filter, not a new backtest run.** We filter the existing v16 backtest JSON (`backtest-v16.json`, 350 trades, strategyVersionId=16, `volatility-vwap` v21, factor=5.0) to `coinTier == 'tier1'` and recompute all metrics from the per-trade records.

**Why this is equivalent to a re-run.** Each trade in the backtest is independent and single-slot. Removing tier2 signals does not create new tier1 opportunities — all tier1 signals already exist in the candle data and were already executed when the slot was free. There is no tier filter in the strategy params schema (`max_coin_tier` lives in the live mode profile, not strategy params — see §3.7), so a "re-run with tier2 off" would simply omit the same tier2 rows we drop here and produce identical tier1 metrics. The analytical filter is exact, not an approximation.

**Sanity check.** The full-set recompute reproduces the baseline exactly: n=350, WR=23.43%, net=−$535.69, net-PF=0.240, slippage=$433.25, gross=−$469.80. PnL signs and cost folding are therefore intact in the source data.

**Profit-factor convention.** This codebase's canonical `profitFactor` is **net-based** (sum of net wins / |sum of net losses|); the full set's 0.240 confirms it. The task's §1 PF definition is gross-based. We report both: net-PF for all baseline comparisons (apples-to-apples with the 0.240 baseline) and gross-PF where the task asks for it.

**Validity caveat (carried from EXP-005 §2a).** Absolute WR/net are retroactive-code figures — M47 R:R geometry shipped live only on 2026-06-25, so this backtest scores the current code over a window the bot did not live-trade with it. Backtest calibration gaps apply (BTC index-shock candle-vs-window mismatch, ETH leg dead in single-symbol replay, modelled fills via `tick_aggregates`, modelled slippage at 0.15%/0.5%/1.0% per tier). **Relative rankings (tier1 vs tier2, regime ordering, sub-window stability) are trustworthy; absolute dollars inherit the gaps.**

## 3. Analysis results

### 3.1 Tier1-only full metrics (n=240)

- tradeCount 240, winCount 69, lossCount 171, winRatePct **28.75%**
- grossPnlUsdt −191.7955, feesUsdt 45.5602, fundingUsdt 2.1592, slippageCostUsdt 170.8507, netPnlUsdt **−235.1964**
- returnPct on $1000 base **−23.52%** (net/1000; the JSON header `returnPct` field uses a compounded-equity base and is not used here)
- profitFactor (net-based, canonical) **0.361**; profitFactor (gross-based, task def) 0.434 (gross wins 147.1360 / |gross losses| 338.9315)
- avgHoldMs 840,021 → **0.233 h** (~14.0 min, i.e. the trades ride to the 15-min time stop)
- exitReason: TP 21 (8.8%), SL 31 (12.9%), TS **188 (78.3%)** — time-stop dominance unchanged
- avgNetPnlPerTrade **−0.9800** (vs baseline −1.5306)
- gross-ex-slippage (gross + slippageCost, price-only book) **−20.9448**

### 3.2 Per-regime breakdown (tier1 only)

Reported as: n | WR% | net PnL | net-PF | exit TP/SL/TS | gross-ex-slippage.

- **trending_up** — n=55 | 25.45% | −$45.79 | PF 0.505 | TP 3 / SL 8 / TS 44 | gross-ex-slip **+$4.51**
- **trending_down** — n=57 | 36.84% | −$28.64 | PF 0.555 | TP 11 / SL 4 / TS 42 | gross-ex-slip **+$22.21**
- **transitioning** — n=128 | 26.56% | −$160.77 | PF 0.238 | TP 7 / SL 19 / TS 102 | gross-ex-slip **−$47.66**

Reading: `transitioning` is the sink — 53% of tier1 trades and 68% of tier1 net loss, the only regime negative even on the price-only book. `trending_down` and `trending_up` are **price-positive** (gross-ex-slippage +$22.21 and +$4.51); they lose only after slippage and fees. `trending_down` is the best regime on every axis (highest WR 36.8%, most TP, fewest SL, best PF, smallest loss).

### 3.3 Sub-window robustness (tier1, three disjoint chronological thirds, n=80 each)

- **Third 1** — n=80 | WR 30.00% | net −$85.14 | TP 6 / SL 9 / TS 65 | avg net/trade **−1.064**
- **Third 2** — n=80 | WR 21.25% | net −$90.06 | TP 4 / SL 10 / TS 66 | avg net/trade **−1.126**
- **Third 3** — n=80 | WR 35.00% | net −$60.00 | TP 11 / SL 12 / TS 57 | avg net/trade **−0.750**

Baseline (full v16): avg net/trade −1.531, WR 23.43%.

Does the improvement hold? On **per-trade expectancy: yes in all 3/3 windows** (−1.064, −1.126, −0.750 all beat −1.531). On **win rate: 2/3 windows** beat baseline (Third 2 at 21.25% dips below the 23.43% baseline). Trade count differs (80 per third vs 350 baseline), so expectancy is the correct cross-window comparator; net PnL is negative in all thirds for both books. The lever is directionally stable — no window reverses the sign of the improvement.

### 3.4 Delta vs baseline

PF is net-based (canonical, matches the 0.240 baseline). MaxDD and Sharpe for tier1 are reconstructed from a net-PnL equity curve ordered by `closedAtMs`; the annualization factor is calibrated so the full-set reconstruction reproduces the published Sharpe −37.44, so the tier1 figure is a consistent relative estimate (not the engine's exact value).

| Metric | Baseline v16 | EXP-006 tier1-only | Delta vs baseline | v19 (cap=7.0, EXP-004) |
|---|---|---|---|---|
| Trades | 350 | 240 | −110 | 422 |
| Win rate | 23.43% | 28.75% | +5.32 pp | 23.4% |
| Net PnL | −$535.69 | −$235.20 | +$300.49 (−56%) | −$671.57 |
| Net PF | 0.240 | 0.361 | +0.121 | ~0.21 |
| Return on $1000 | −53.57% | −23.52% | +30.05 pp | −67.16% |
| Max drawdown | 51.56% | ~23.88% | −27.7 pp | (worse) |
| Sharpe (annual.) | −37.44 | ~−27.0 | +10.4 | (worse) |
| Avg net/trade | −1.531 | −0.980 | +0.551 | ~−1.59 |
| Exit TS share | 79.4% | 78.3% | −1.1 pp | ~82% |

Tier1-only and v19 are the two directions one could push from baseline: tier1-only (drop the worst tier) improves every metric; v19 (admit more tier2-dominated signals) worsens every metric. They are mirror images, which corroborates EXP-004's root cause — the marginal `trend_initiation` signal, concentrated in tier2, loses money.

### 3.5 Breakeven analysis (tier1)

- Net-payoff geometry: avg win +$1.9242 (n=69), avg loss −$2.1518 (n=171), payoff ratio 0.8942. **Breakeven WR = 1/(1+0.8942) = 52.79%**, against a delivered **28.75%** — a 24-point gap. Geometry alone cannot close it (consistent with EXP-002).
- **Slippage reduction to break even at current WR: 137.66%** — i.e. **impossible**. Removing 100% of modelled slippage (−$170.85) still leaves net = −$64.35, because the price-only-plus-fees book is negative (gross-ex-slippage −$20.94, fees −$45.56, funding +$2.16). Slippage is the largest single cost but not the whole loss for tier1.
- **Is any regime subset of tier1 already net-positive? No.** The best, `trending_down`, is −$28.64 net. But two regimes are **price-positive** before costs: `trending_down` gross-ex-slippage +$22.21 and `trending_up` +$4.51. A tier1 ∩ {trending_down, trending_up} ∩ maker-entry (zero slippage) book would be approximately price +$26.72 − fees ($21.21) ≈ near-breakeven-positive — the only construct in this data that points above zero, and it is hypothetical (untested, seeds EXP-007).

### 3.6 Slippage decomposition (tier1)

- Slippage is **72.64%** of tier1's net loss ($170.85 of $235.20) — high, but below the full-set 81% because tier1 trades carry less slippage per unit and tier1's non-slippage costs are proportionally larger.
- Tier1 gross-ex-slippage = **−$20.94** total (−$0.087/trade) — the price-only book is near-flat but still negative, not net-zero. Tier1 momentum does not even reach price-breakeven before costs.
- Slippage cost-per-trade: **tier1 $0.712/trade vs tier2 $2.386/trade** — tier2 bleeds **3.35×** the slippage of tier1 per trade. This is the modelled-rate ratio (tier2 `slippage_tier2_pct` 0.5% / tier1 `slippage_tier1_pct` 0.15% = 3.33×) playing out on realized fills. Tier2's higher slippage rate on a worse-WR, fewer-but-larger-loss book is the mechanical reason tier2 is the dominant loss center.

### 3.7 Implementation feasibility

`SELECT params FROM strategy_versions WHERE strategy_versions_id = 16` returns the v21 params blob. There is **no `coin_tier_filter`, `max_coin_tier`, or any tier-exclusion key**. Tier appears only as per-tier *sizing/eligibility* params: `slippage_tier{1,2,3}_pct` and `tier{1,2,3}_{min,max}_abs_move_pct`. The strategy can size and bound tiers but cannot exclude one.

**Verdict: needs a shared schema change + engine change** — it cannot be done via the params JSONB alone. To gate tier2 in shadow/live you would add a typed `max_coin_tier` (or `excluded_coin_tiers`) field to the strategy params schema in `packages/shared/`, route it through `bot-shared-maintainer`, and enforce it in the signal-eligibility path **upstream of the risk gate** (never bypassing it). `coinTier` is already computed per signal (it is in the trade records), so the gate is a single predicate; the work is the contract + a guarded filter + paired tests, not new analytics.

## 4. Verdict

**SUPPORTED — as a loss-reduction / risk-control filter, not as a profitability fix.**

The hypothesis "excluding tier2 improves the `trend_initiation` book" is confirmed. Tier1-only beats the baseline on **all three required axes** — win rate (28.75% vs 23.43%), net PF (0.361 vs 0.240), and net PnL (−$235.20 vs −$535.69) — and the per-trade-expectancy improvement is **robust across 3/3 sub-windows** (win-rate improvement holds 2/3). Max drawdown halves (51.6% → 23.9%). The mechanism is clean and corroborated three ways: tier2 is 31% of trades but 56% of net loss, has the worst WR (11.8%) and net-PF (0.124), and bleeds 3.35× the per-trade slippage; EXP-005 flagged it across all sub-windows; EXP-004 showed the mirror image (admitting more tier2 worsens everything); live data shows 0/7 tier2 wins.

The result is bounded and we state it plainly: tier1-only is **still net −$235** and not deployable as a standalone edge. Breakeven needs a 52.8% WR (delivered 28.8%), and even perfect (zero) slippage leaves it at −$64 because the price-only-plus-fees book is negative. Tier2 exclusion removes the worst cohort; it does not manufacture an edge in what remains. Promote it as a **defensive gate** (fewer, less-toxic trades, lower drawdown), not as the profitability lever.

## 5. Post-fix re-run (2026-06-29, OI bug fixed)

After the `BacktestRunnerService` OI-index bug was fixed (see `tech-debt.md M25`), EXP-006 was re-run from scratch with the corrected harness (`backtest-v16-oi-fixed.json`, same window 2026-05-30 → 2026-06-29). Key differences vs the original analytical-filter run:

| Metric | Original (broken harness) | Fixed harness | Change |
|---|---|---|---|
| Total trades | 350 | 208 | −40% (previously misclassified signals now correctly skipped) |
| tier1 trades | 240 | 139 | −42% |
| tier2 trades | 110 | 69 | −37% |
| All WR | 23.4% | 24.5% | +1.1 pp |
| tier1 WR | **28.8%** | **28.1%** | −0.7 pp (essentially unchanged) |
| tier2 WR | 11.8% | 17.4% | +5.6 pp (fewer bad signals classified there) |
| All net PnL | −$535.69 | −$293.62 | +$242 |
| tier1 net PnL | **−$235.20** | **−$152.42** | +$82 |
| tier2 net PnL | −$300.49 (56% of loss) | −$141.20 (48% of loss) | +$159 |
| tier1 sub-window WR | 30.0% / 21.3% / 35.0% | **30.4% / 26.1% / 27.7%** | More stable (narrower spread) |

**Verdict is unchanged: SUPPORTED.** Tier1 WR is statistically stable (28.8% → 28.1%; within estimation noise at n=139–240). Sub-window WR is *more* stable on the fixed harness (26–30% range vs 21–35% range before). Tier2 is still materially worse than tier1 on WR (+10.7 pp gap) and net/trade (−$1.09 vs −$2.05). Tier2 is 33% of trades and 48% of loss.

**New finding — `forced_exhaustion` now appears in backtest:** 47 trades (23% of book); tier1 sub-cohort WR 30.8%. This is higher than the live `forced_exhaustion` WR of 10.3–11.4% (EXP-010). The discrepancy is likely a market-regime difference (the backtest window 2026-05-30 → 2026-06-29 saw different OI-collapse dynamics than the historical live window) and/or the limited n=26 for tier1 `forced_exhaustion`. Do not read the 30.8% figure as a validated edge — it requires independent soak-window confirmation before acting on it.

**Trade count drop explained:** 350 → 208 (−40%) because the OI fix now correctly routes ~142 signals per 30-day window to `catalyst_risk` / `market_beta` / `low_quality_noise`, which V3HybridRouter skips. The fixed 6.9 trades/day aligns with the observed live open rate (~8/day). The broken harness was inflating trade count by ~70% by routing skippable signals as `trend_initiation`.

## 6. What this rules out

- **Do not treat tier2 as salvageable for `trend_initiation` momentum.** It is the dominant loss center on every axis and worst in all three sub-windows; no widening, sizing, or geometry change in prior experiments rescued it. Drop it, do not tune it.
- **Do not expect tier2 exclusion to make the strategy profitable.** Tier1-only is still deeply negative with a 24-point breakeven-WR gap. Any plan that says "cut tier2 and we're green" is wrong by $152 (fixed harness) / $235 (original).
- **Do not pursue slippage reduction as a tier1 silver bullet in isolation.** Even 100% slippage removal leaves tier1 at ~−$54 (gross-ex-slippage −$29/139 trades); the price+fee book is negative. Slippage reduction must be paired with regime selection (cut `transitioning`) and/or selectivity to clear zero.

## 6. Implementation note

Gating tier2 in live/shadow is a **code change, not a config toggle** (§3.7): there is no params field for it today. Required: (1) add `max_coin_tier` / `excluded_coin_tiers` to the shared strategy-params schema via `bot-shared-maintainer`; (2) enforce in signal eligibility upstream of — never bypassing — the risk gate, using the already-available `coinTier`; (3) paired tests (tier1 admitted, tier2 rejected, boundary at the tier edge). Until then, tier2 exposure is governed only by the live mode profile's `max_coin_tier`, which scopes the universe, not the per-signal strategy decision.

## 7. Recommended next experiment

**EXP-007 — maker-entry (slippage-reduction) variant on tier1 ∩ {trending_down, trending_up}.** This is the only construct in EXP-005/EXP-006 that points above zero: tier1's two trending regimes are price-positive (gross-ex-slippage +$22.21 and +$4.51), and slippage is 73% of tier1's loss. Model maker (limit) entry — lower/zero entry slippage at the cost of some missed fills — on the tier1, trending-only cohort, and test whether the price-positive book survives the fill-rate haircut to reach net-positive. Pair the tier2 gate (this experiment) with the regime gate and maker entry; validate across the same three sub-windows and require ≥30 trades/window before acting.
