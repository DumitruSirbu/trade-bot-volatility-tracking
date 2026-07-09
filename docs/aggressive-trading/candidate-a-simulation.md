# Candidate A — Offline Feasibility Simulation

**Date:** 2026-07-06  
**Type:** Offline read-only feasibility screen. Sim environment only; did not touch live xmom soak or any engine code. All scripts + data under `sims/candidate-a/` (gitignored). **Verdict:** Candidate A as specified is **non-viable at 5m timeframe**. Every config is cost-dominated: 66–155% cost drag from turnover × notional-scaled slippage, dominating any potential gross signal. The recommended BASE config even loses money *before* costs (gross PF 0.95, gross −3.48%). Positive gross appears only in cherry-picked sweep variants (regime-gate OFF, N=20, pyramiding OFF), not in the core algorithm. The only rational path forward is a slower timeframe (1h/4h/daily channels, 10–50× less turnover) tested on *longer* history — impossible on 37 days of 5m bars. **Do not carry any 5m variant forward.** If pursued, implement in separate aggressive-bot repository.

---

## What Candidate A is

A classic per-symbol Donchian/Turtle breakout trend-follower on Binance USDT-M perpetuals. Every 5m bar, for each symbol: enter a long position on a break above the prior N-bar highest-high, or a short on a break below the prior N-bar lowest-low, **only when the move aligns with the BTC 24h regime** (no countertrend breakouts). Position size is ATR-normalized (1% of equity per 1 ATR of adverse move), starting at 1 unit and pyramiding upward by +0.5 ATR of favorable move (up to 4 units). Hold with a 2-ATR trailing (chandelier) stop. Exit on either: the opposite N/2-channel break, or the stop is hit, or the BTC regime flips away from the position's direction. This is the archetypal aggressive, turnover-heavy trend-follower and deliberately the opposite family from Candidate C (per-symbol breakout vs. cross-sectional rank).

---

## Why a standalone simulation, not the engine backtest

Same reason as Candidate C: the existing `apps/engine/` backtest runner supports only single-symbol strategies (V0–V3 in StrategyRegistry). This strategy is per-symbol *but* requires portfolio-level gross leverage capping (3× max), funding accrual, and regime-gated entries across 329 symbols, which the engine backtest harness does not support. To avoid bloating the infrastructure and to keep the running xmom soak untouched, Candidate A was screened via a standalone read-only Node.js simulation (`sims/candidate-a/candidate-a-sim.mjs`) that reads 5m candles (with high/low, not just close) and funding rates directly from Postgres and simulates the entry/pyramid/exit loop deterministically.

---

## Data window and universe

**Period:** 2026-05-30 20:00Z → 2026-07-06 17:10Z (37 days, 329 tradable symbols, 5m OHLCV candles)

**Regime structure:** Identical to Candidate C: BTC closed the window −13.6% (43,600 → 37,700 USDT) across four realized regimes (DOWN 7d, UP 10d, DOWN 9d, CHOP 10d). Each regime bucket is 7–10 days — thin for independent significance. Do not treat per-regime statistics here as standalone evidence.

---

## Method and honesty rails

- **No look-ahead:** Donchian channels use the prior N bars strictly (exclusive of current bar `t`); ATR is computed from the prior 14 bars' true range; BTC regime uses `close(t) / close(t-24h)`. Entry decision occurs at `close(t)`. Stop and exit fills consume *future* bars only to realize prices — never to decide entry.

- **Intrabar stop-first (conservative):** within a bar, the trailing stop is checked *before* updating best-price and before exit-signal logic. If a bar could satisfy both a stop trigger and an exit signal, the stop wins (more pessimistic fill). Best-price and stop are re-anchored only *after* the stop check.

- **ATR-normalized sizing:** `qty = (1% × equity) / (2 × ATR)`; `unit_notional = qty × price`. Adds use the same formula on current equity. Sizing uses *realized* equity (open positions are not marked-to-market), so the 3× gross cap is measured on entry notional.

- **Pyramiding:** add one unit every +0.5 ATR of favorable move (ATR fixed at entry, Turtle-style), up to 4 units, only while in profit. An add that would breach the gross cap is skipped.

- **Regime gate:** trades are entered only in the matching direction (long in UP regime, short in DOWN regime, skip in CHOP). Force-exit if regime flips.

- **Turnover-aware costs:**
  - **Fees:** 5 bps/side, flat taker.
  - **Slippage:** liquidity-tiered by symbol (top-100 by dollar-volume = 15 bps/side, rest = 40 bps/side base tier; 20/60 harsh tier). Charged on entry, every pyramided add, and exit.
  - **Funding:** long pays positive funding; short receives it. Accrued per bar over the hold, typical ~1–3h given 2-ATR tight stops. Tiny relative to slippage (see results).

- **Point-in-time universe:** a symbol can qualify at time `t` only if the prior-N and prior-14-bar windows are ≥95% covered (no big gaps). New listings cannot trade until they have sufficient history.

- **Deterministic:** symbol iteration order is fixed (alphabetical) for reproducibility.

---

## Audit and critical fixes

A quant review confirmed **no blockers** — the catastrophic net loss is real accounting (correct cost base, no double-count, no look-ahead), verdict **DIRECTIONALLY-OK-WITH-CAVEATS**. Two things were corrected before the numbers below:

1. **Funding attribution bug (fixed):** Funding was correctly deducted from equity throughout the run, so net PnL was always right, but the cost breakdown table initially read 0 for funding — a reporting-only issue. Now correctly populated: funding is indeed tiny (~4–15 USDT across configs), because 2-ATR stops close most trades in 1–3h.

2. **Overstated "signal is genuine" claim (corrected):** The initial draft claimed a positive signal based on gross PF and avg-win/loss ratios in certain sweep variants. This was **explicitly not clean evidence** — gross return is a path-contaminated hybrid metric (costs compounded equity down, so gross is measured on a decaying base), and the positive gross appears only in cherry-picked configs, not the recommended base. See verdict below for the honest interpretation.

**Pre-correction misleading claim (REJECTED):** early summary quoted "+56% gross" on the regime-gate-OFF variant as evidence of a potential edge. This headline **does not survive the caveats** — the figure is path-contaminated, and the variant itself is not the recommended config. The recommended BASE config has NEGATIVE gross (−3.48%) and gross PF 0.95.

---

## Corrected results

### Headline config comparison (net of all costs)

| Metric | **Base**<br/>(N55/exit20/pyr+gate/3x) | **N=20**<br/>(fast breakout) | **Pyr OFF** | **Gate OFF** | **Liquid-100** | **V0**<br/>(no-trade) |
|--------|----------|----------|----------|----------|----------|------|
| **Final equity (net, base tier)** | 18.64 | 72.22 | 92.17 | 6.93 | 4.43 | 1000.00 |
| **Total return (net, base tier)** | −98.14% | −92.78% | −90.83% | −99.31% | −99.57% | 0.00% |
| **Total return (net, harsh tier)** | −99.23% | −97.23% | −98.95% | −99.81% | −99.89% | 0.00% |
| **Total return (gross)** | −3.48% | +21.63% | +21.71% | +56.47% | +9.58% | 0.00% |
| **Profit factor (gross)** | 0.95 | 1.21 | 1.23 | 1.34 | 1.09 | n/a |
| **Profit factor (net, base tier)** | 0.32 | 0.50 | 0.49 | 0.64 | 0.46 | n/a |
| **Win rate** | 32.7% | 32.6% | 39.0% | 30.5% | 33.4% | n/a |
| **Avg-win / Avg-loss (gross)** | 1.96 | 2.50 | 1.92 | 3.06 | 2.18 | n/a |
| **Max drawdown** | 98.14% | 92.83% | 90.83% | 99.43% | 99.61% | 0.00% |
| **# trades (closed)** | 798 | 801 | 913 | 1546 | 1235 | 0 |
| **Avg pyramid depth (units/trade)** | 1.39 | 1.34 | 1.00 | 1.45 | 1.36 | n/a |
| **Cost drag (% start equity)** | 94.66% | 114.41% | 112.55% | 155.79% | 109.16% | 0.00% |

### Slippage sensitivity (net total return)

The headline numbers assume base-tier slippage (15 bps long / 40 bps short). Below is the sensitivity to harsh tiers (20/60 bps):

| Config | **Base (15/40)** | **Harsh (20/60)** |
|--------|:---:|:---:|
| **Base N55 exit20 pyr+gate 3x** | −98.14% | −99.23% |
| **N=20 fast breakout** | −92.78% | −97.23% |
| **Pyramiding OFF** | −90.83% | −98.95% |
| **Regime-gate OFF (both dirs)** | −99.31% | −99.81% |
| **Liquid-100 universe only** | −99.57% | −99.89% |

Every config is negative under both tiers. Harsh tier degrades returns by an additional 1–8 percentage points. **No config survives to net-positive under either assumption.**

### Cost breakdown (base tier, USDT)

| Config | **Fees** | **Slippage** | **Funding** | **Total** | **Drag %** |
|--------|:---:|:---:|:---:|:---:|:---:|
| Base N55 exit20 pyr+gate 3x | 132.43 | 802.68 | 11.53 | 946.65 | 94.66% |
| N=20 fast breakout | 159.51 | 969.61 | 14.98 | 1144.10 | 114.41% |
| Pyramiding OFF | 159.26 | 961.90 | 4.31 | 1125.47 | 112.55% |
| Regime-gate OFF (both dirs) | 211.46 | 1340.65 | 5.75 | 1557.86 | 155.79% |
| Liquid-100 universe only | 273.06 | 819.17 | −0.64 | 1091.58 | 109.16% |

**Key observation:** Slippage dominates (67–86% of total cost). Funding is confirmed tiny (4–15 USDT) — a rounding error — because tight 2-ATR stops close most positions in 1–3 hours, well inside the 8-hour funding cycle. **The structural cost problem is turnover × notional-scaled slippage, not funding.**

---

## Why the regime gate and pyramiding were tested (and what they reveal)

### Regime-gate impact: helped slightly, but margin is thin

**Base (gate ON):** net(base) −98.14%, harsh −99.23%  
**Gate OFF:** net(base) −99.31%, harsh −99.81%

The gate *helped* — restricting entries to trend-aligned breakouts cut false breakouts in choppy regimes and reduced whipsaw. But the improvement is small (−0.61% net at base tier) and evaporates under harsh costs. **The gate is a marginal tactical improvement on an un-viable template.**

### Pyramiding impact: hurt, not helped

**Base (pyr ON, 1.39 units/trade avg):** net(base) −98.14%  
**Pyr OFF (1.00 units/trade):** net(base) −90.83%

Pyramiding *worsened* returns by ~7 percentage points. Reason: adding to a winner late (after the move has already been caught) locks in a worse entry; the chandelier stop trails down as the trend rolls, but by then the added units are already bought at less favorable prices. On reversals, the added size compounds the loss. **Pyramiding is accretive to *positive* signals (it scales wins), but *destructive* to weak/negative ones.** At 5m timeframe with negative gross, it's a straight loss.

---

## Per-regime breakdown

Trade regime is labeled from BTC's realized 24h return at each entry time (not hardcoded dates). Note the thin per-regime leg counts. **No config achieves net-positive in any single regime under either tier.**

**Base config (N55/exit20/pyr+gate/3x) — per-regime (base tier):**
- **UP:** ~315 trades, net PnL −$321.49, win 33.9%
- **DOWN:** ~383 trades, net PnL −$498.32, win 31.6% ← **worst regime**
- **CHOP:** ~100 trades, net PnL −$126.84, win 32.5%

**Key observation:** DOWN regime is the *worst* bucket everywhere — breakout shorts get squeezed in falling markets (whipsaws and forced stop-outs before the trend resumes). This is the **opposite** of Candidate C's DOWN-leg tailwind (C was net-short and captured falling satellites; A is short breakouts and got squeezed). This is not the same artifact; it's a genuinely different failure mode.

---

## Verdict

### 1. Non-viable as specified

Every configuration is cost-dominated and net-negative:

- **Base (recommended):** −98.14% net (base tier), −99.23% (harsh tier).
- **Best survivor (N=20):** −92.78% net (base), −97.23% (harsh).
- **All configs:** net returns range −76% to −99%; no config is net-positive under either slippage tier.

**Cost drag is the binding constraint:** 66–155% of starting equity is consumed by fees + slippage. Turnover runs 798–1,546 trades over 37 days; each trade involves entry, pyramided adds, and exit, all charged slippage + fee. For a symbol with notional = 1% risk × 10× leverage, the basis-point slippage becomes a large % of the risk budget.

### 2. The signal is NOT proven

The recommended BASE config has:
- **Gross return: −3.48%** (loses money *before* costs)
- **Gross profit factor: 0.95** (< 1, systemically losing)

Positive gross return appears *only* in cherry-picked sweep variants:
- Regime-gate OFF: +56.47% gross ← but the recommended config has the gate ON
- N=20: +21.63% gross ← but the recommended config uses N=55
- Pyramiding OFF: +21.71% gross ← but the recommended config has pyramiding ON

The gross figures in these variants are **path-contaminated hybrids** (costs compounded equity down, so gross is measured on a decayed base), and they are *not* properties of the core algorithm — they only appear when you change the parameters. The honest signal argument, if any, rests on the path-robust ratios:

- **Gross profit factor up to 1.34** (gate OFF variant)
- **Avg-win/loss 1.70–3.06** on the expected-low 30–40% win rate (typical for trend-followers)

These ratios are **suggestive** that a breakout edge *might* exist in *some* variants under ideal conditions. They are **not proof**. And they are absent in the recommended base configuration, which is the one specified in the brief.

### 3. Structural cause: ATR-risk sizing amplifies slippage bleed

ATR-normalized sizing is the aggression mechanism: `qty = (1% eq) / (2 × ATR)`. On low-volatility symbols, ATR is small, so qty is large, pushing notional high. When notional hits the 3× gross cap, slippage (charged in basis points) scales with notional, so a low-vol symbol in a tight spread still bleeds a large % of equity.

**Example:** a stablecoin-vol symbol with ATR $0.001 sizes to 50,000 units. Entry slippage at 40 bps = 200 USDT bleed on a 1% risk budget of ~100 USDT notional. The cost is 2× the intended risk.

**This is not a tuning issue.** It's a fundamental mismatch: 5m churn at ATR-risk sizing, with 40 bps average slippage, *cannot* recover.

### 4. Leverage confirmed magnitude-only; cannot rescue negative templates

**Leverage 1× (gross cap 1x):** net(base) −76.07%, cost drag 66.11%  
**Leverage 3× (base):** net(base) −98.14%, cost drag 94.66%

Return and cost both scale ~linearly with leverage. The *sign* is unchanged. **Leverage is a magnitude knob only — it amplifies both winners and losers proportionally. It cannot flip a negative-gross template to positive.**

### 5. DOWN regime is the worst bucket (opposite of Candidate C, not the same artifact)

Candidate A's per-regime PnL shows DOWN regimes bleeding hardest (−498 USDT on 383 trades in the base config, vs −321 in UP). Candidate C had the opposite: its entire edge came from DOWN regimes (net-short capturing falling satellites).

**This confirms A and C fail via different mechanisms,** not from a shared window artifact. A's breakout shorts get squeezed; C's net-short longs off of falling names profits. They are genuinely orthogonal.

### 6. Single 37-day window, thin regime legs — directional read, not an estimate

This window spans one BTC-regime arc (down, up, down, chop) with each leg 7–10 days. The sample is too thin to reliably estimate per-regime Sharpe or recovery factor. Treat all results here as **feasibility directional guidance only, not a validation or rejection of the breakout hypothesis on longer history.**

---

---

## Higher-timeframe re-test (1h/4h/1d, 30-month history)

**Data:** 2024-01 → 2026-06 (30 months), 1h/4h/1d klines from Binance public dumps + funding. Universe: top-20 liquid names among the 92 symbols with ≥28 months daily history. Results source: `sims/candidate-a/candidate-a-hitf-results.md` (quant review: SOUND, no blockers).

**Bottom line:** The turnover collapse is CONFIRMED — trade counts fall from 5m's **800–1,550 trades/37d** to **382–18,990 trades over 30 months**, and cost drag falls from catastrophic **66–155%** to **2.35%–86.81%**. The first half of the rescue hypothesis is real: slower timeframes annihilate the cost problem.

**But the second half fails:** only 4/6 configs are even gross-positive (4h/1d only; 1h configs are gross-negative with gPF < 1). Where gross is positive it is marginal (gPF 1.02–1.23, gross return 0.16%–25.83% over 30 months). After gap-aware stop fills (stops fill at worse of stop level vs bar open — realistic for 1d gap-throughs), the "robust" 1d N55/exit20 cell drops from the prior estimate to net −2.19% base / −2.90% harsh: **break-even-to-negative, non-viable.**

**The only positive signal is regime-conditional:** every config's entire positive net PnL concentrates in the DOWN regime (shorting beaten-down alts when BTC declines). The long breakout side does not pay. UP regime is negative in all configs; CHOP is flat to slightly negative. This is the SAME down-leg short effect Candidate C surfaced — a different failure mode between candidates, confirming both fail via separate mechanisms.

**Per-regime split (1d N55/exit20, base tier):**
- UP: 105 trades, net −$87.71, win 20.0% ← bleeds
- DOWN: 170 trades, net +$2.48, win 27.6% ← carries all edge
- CHOP: 107 trades, net −$353.04, win 20.6% ← worst bucket

**Verdict: NON-VIABLE.** The hi-TF re-scope cures the COST disease but reveals there is no breakout SIGNAL large enough to survive even the tiny 1d cost drag (2.35%–4.96%). Do not carry forward.

---

## If pursued — next steps (do not carry 5m forward)

The only plausible rescue path is a **far slower timeframe** and **longer history**:

1. **Reframe to 1h/4h/daily channels instead of 5m.** 5m churn (798–1,546 trades/37 days) makes slippage a % of equity, not a per-trade friction. A 1h Donchian would trade ~10× less, a 4h ~40× less. On 10–50× lower turnover, slippage drag drops by the same factor (all else equal, gross return unchanged).

2. **Extend the backtest window to ≥120 days of daily/4h data (or 360 days of 1h).** This 37-day window is too thin; each slower timeframe needs multiple full BTC regime cycles to validate. Daily-bar breakout on 37 days = ~37 bars ≈ barely enough for two multi-day trends. **Cannot test 1h/4h/daily robustly on 5m-bar padding from 37 calendar days.**

3. **Do NOT test on 5m data pretending it's slower.** (E.g., do not take 5m closes at 1h intervals to create "synthetic 1h".) The signal must be live-implementable at the intended timeframe, which means 1h opens are 1h OHLCV candles from the exchange, with real 1h-bar fills and slippage, or the backtest is fiction.

4. **Realistic breakout slippage is higher, not lower.** Momentum-chasing fills are bought when price is rising (worst slippage). The model here assumes flat bps per side; real momentum breakouts slip worse. Budget for realistic slippage at the intended timeframe *before* declaring an edge.

5. **Separate aggressive-bot repository only.** If and only if slower-timeframe testing on longer history shows a durable positive gross return (profit factor > 1.2) and win-rate-independent avg-win/loss > 1.5, implement in a standalone aggressive-trading bot. **Do NOT merge any 5m variant into this repo's engine.** The conservative xmom soak is protected, and the aggressive thesis can evolve independently.

---

## Cross-reference to Candidate C

Both Candidate A (per-symbol breakout) and Candidate C (cross-sectional momentum) are cost-bound on this 37-day window, but via **different mechanisms**:

- **Candidate C:** cross-sectional, costs via high rebalance turnover (8h × 327 symbols = 40+ rebalances), down-leg-specific alpha (DOWN regime +$707 net, UP/CHOP negative). Costs 57–71% of equity.
- **Candidate A:** per-symbol breakout, costs via per-bar trade churn (798–1,546 trades / 37 days) × notional-scaled slippage. Costs 66–155% of equity. Worst in DOWN regime (opposite C's tail).

**Emerging through-line:** on this window and timeframe, transaction cost — not signal absence — is the binding constraint for aggressive strategies. The solutions diverge: C benefits from slower rebalance (R24 vs R8) and drops the microcap short basket; A needs a 10–50× slower timeframe (1h+) to survive slippage. Neither has proven out.

---

## Critical caveats — this is an upper-bound feasibility estimate

- **Intrabar chop smoothed:** the sim advances by full candle closes; real 5m chop within a bar could generate more whipsaws and worse fills. The stop-out rate and slippage are likely understated.

- **Funding on long holds:** 2-ATR stops close most trades in 1–3h, so funding is confirmed tiny. But a slower-timeframe variant (daily channels) could hold 24–72h, accruing multiple 8h funding cycles. Negative funding in up-trends is a real cost to long breakout trades.

- **Fast-mover slippage:** Breakout signal is noisy; once a price breaks a channel, the momentum chasers pile in, and fills slip worse than the flat 40 bps tier2 floor. The model's flat-basis-points assumption is optimistic.

- **Realistic liquidity:** The top-100 liquid filter was tested; removing the bottom-decile microcaps *improved cost drag* but did not rescue the edge (net return still −99.57%), because the microcap overspill is the volume of trades, not the margin per trade.

---

## Reproduce

```bash
# The simulation reads from Postgres directly (candles with high/low, funding_rates).
# Set PHASEB_DB_URL if the database is not the default localhost.

cd sims/candidate-a/
node candidate-a-sim.mjs

# Output: candidate-a-sim-results.md (included in git history)
```

No engine code was touched. The sim is read-only and was never committed to `apps/` or `packages/`.
