# EXP-011 — Cross-Sectional Momentum: does the universe return ranking predict forward returns?

**Date:** 2026-06-30
**Author:** Alpha-Forge brainstorm follow-up (Phase A feasibility, see
`docs/brainstorm/20260630-1038-alternative-strategies-alpha-forge.md` Proposal 1)
**Status:** INCONCLUSIVE — **promising** (signal detected, robust across
sub-windows, survives costs; sample too thin to be decision-grade)
**Type:** Offline analysis over existing `candles`. No positions opened, no
engine state touched.
**Script (reusable):** `scripts/research/cross-sectional-momentum/`
(`xmom_decile_study.sql` + `run.sh`)
**Raw output:** `docs/analysis/.runs/20260630-1327-xmom/`

---

## Hypothesis

In a 200–300 symbol perp universe, the cross-section of trailing returns
predicts the cross-section of forward returns: top-ranked (winner) coins
continue to outperform bottom-ranked (loser) coins over the next holding
period. A long-top-decile / short-bottom-decile book captures the spread.

This is the Phase A go/no-go gate for brainstorm Proposal 1 before building the
Phase B position-level simulation (feeding entries into the existing
`HistoricalFillAdapter` / `simulateIntrabarStop` engine).

## Method

- **Data:** 5m `candles`, 301 symbols, 2026-05-30 → 2026-06-30 (31 days, the
  full soak window).
- **Tradable universe:** symbols with median 5m dollar-volume ≥ $20,000
  (≈ $5.7M/day) → 78–136 symbols depending on the data-coverage requirement of
  each lookback/holding combo. Static liquidity gate to keep illiquid microcaps
  from manufacturing fake tail edge.
- **Design:** at each rebalance point, rank tradable symbols by trailing return
  over `lookback` hours, bucket into deciles (`ntile(10)`), measure each
  symbol's forward return over `holding` hours. **Non-overlapping:** rebalance
  step = holding window, so forward windows never overlap (no autocorrelation
  inflation of the t-stat). Honest but sample-limited.
- **Robustness:** the rebalance series is split into 3 disjoint sub-windows; the
  long-short spread is reported per sub-window.
- **Cost stub:** 10 bps per leg; the long-short book is 4 legs/period
  (long in/out + short in/out) → 40 bps/period charged to the net figure.
- **Combos swept:** (lookback h, holding h) ∈ {(6,6), (24,24), (72,24), (72,72)}.

## Results

### Long-short (D10 − D1) per-period summary

| lb/hd | periods | gross %/period | net %/period | t-stat | % periods + | sub-window spreads |
|-------|---------|----------------|--------------|--------|-------------|--------------------|
| 6/6   | 115     | **−0.12**      | −0.52        | −0.24  | 49.6%       | +0.88, +0.66, −1.55 |
| **24/24** | **26** | **+6.00**  | **+5.60**    | **+2.45** | **61.5%** | **+6.28, +6.99, +3.02** |
| 72/24 | 24      | +2.61          | +2.21        | +1.20  | 58.3%       | −0.07, +2.90, +3.04 |
| 72/72 | 6       | +4.36          | +3.96        | +0.90  | 50.0%       | −2.99, +11.90, +1.15 |

### Per-decile forward return — the 24h/24h operating point

| decile | n | avg trailing % | avg forward % | forward t |
|--------|---|----------------|---------------|-----------|
| 1 (losers) | 172 | −14.20 | **−1.80** | −1.62 |
| 5 | 158 | −1.32 | −1.06 | −2.87 |
| 9 | 150 | +4.66 | +0.41 | 0.53 |
| 10 (winners) | 148 | +22.64 | **+4.11** | 1.93 |

(Full decile ladders for all four combos in the raw `.out` files.)

## What the numbers say (plain facts)

1. **There is a cross-sectional momentum signal, and it lives at the ~24h
   horizon.** At 24h lookback / 24h hold the long-short spread is **+6.0%/period
   gross, +5.6% net of a 10bps/leg stub, t = 2.45, positive in 61.5% of periods
   and in all 3 disjoint sub-windows** (+6.28 / +6.99 / +3.02%). That is the
   first cleanly positive, sub-window-robust signal in this registry.
2. **The edge is a tail phenomenon, not a clean decile ladder.** The middle
   deciles are noisy/slightly negative (general downward drift in the window);
   the spread is carried by the extremes — winners (D10) continuing at +4.1% and
   losers (D1) falling a further −1.8% over the next 24h. A top-vs-bottom basket
   works; a fully decile-weighted book would be noisier.
3. **Short-horizon momentum is dead.** At 6h/6h the spread is **negative**
   (−0.12%/period, t = −0.24, 49.6% positive) — if anything a faint reversal.
   The signal is a 1-day-plus phenomenon, not intraday. This is important: it
   rules out fast rebalancing.
4. **The signal survives realistic costs.** At 24/24, even charging 30 bps/leg
   (120 bps/period — close to EXP-008's ~0.30% slippage finding) leaves
   +4.8%/period. Cost is not the binding risk here.
5. **The winner leg is stronger than the loser leg.** At 72h lookback the loser
   leg (D1) starts to bounce (+) rather than continue down, eroding the short
   side. The long-winner leg is the more reliable half across combos.

## What could explain the pattern (structural vs noise)

- **Structural (real edge):** crypto winner-continuation is the most documented
  cross-asset anomaly (Jegadeesh-Titman; Asness et al.). Retail-driven flow
  chasing 1-day narratives with persistence is a plausible mechanism, and the
  24h-only / no-6h profile is consistent with a flow-persistence story rather
  than a microstructure artifact.
- **Noise / overfit risk (must not ignore):** **26 non-overlapping periods over
  31 days is a thin sample**, and the implied annualized Sharpe of ~9 is **not
  believable out-of-sample** — it reflects a single, likely favorable, month.
  The window is one regime; crypto momentum carries fat-left-tail crash risk on
  sharp reversals that 31 days simply cannot show.
- **Mild survivorship bias:** a symbol must exist at t−lookback, t, and
  t+holding to enter the panel; delisted/newly-listed coins drop out, slightly
  favoring persisters.
- **Tail-coin frictions:** D10 coins averaged +22.6% trailing — exactly the
  names with the worst real-world slippage, borrow, and funding. The price-only
  study understates execution drag on the long-winner leg specifically.

## Verdict

**Phase A bar is cleared.** The signal exists, is concentrated at a clear
operating point (24h/24h), is positive in every sub-window, is carried by an
economically sensible mechanism (winner continuation), and survives a
conservative cost charge. This is a genuine GO for Proposal 1 — the first in the
registry.

**But it is not decision-grade for live capital.** Per this registry's own
methodology bar (≥30 obs/cohort, decision-grade across windows), 26 periods on a
single 31-day regime is below threshold, and Sharpe 9 is a small-sample mirage.

## Rules out / what NOT to do

- **Do not rebalance intraday.** 6h momentum is null-to-negative; fast
  rebalancing burns cost for no signal.
- **Do not build a full decile-weighted book.** The middle deciles are noise;
  the edge is top-vs-bottom tails only. Trade a winner basket (± a loser short),
  not a 10-bucket ladder.
- **Do not size this as a Sharpe-9 strategy.** The annualized figure is a
  one-month artifact. Treat expected live Sharpe as a fraction of it.
- **Do not skip the long-winner execution-drag question.** D10 names are the
  highest-slippage coins; the price-only +4.1% will shrink under real fills.

## What I would check next (smallest confirming step)

1. **Phase B position simulation** at the 24h/24h operating point: feed
   top-decile (and bottom-decile short) entries into the existing
   `HistoricalFillAdapter` + `simulateIntrabarStop` engine to get realistic
   fills, fees, and slippage on the actual D10 winner names — this directly
   answers the execution-drag caveat the price-only study cannot.
2. **Forward soak:** the dataset is the binding constraint. Keep accumulating
   candles; re-run this script monthly. The edge needs to hold across a
   *down* regime before it earns live capital.
3. **Single-slot proxy first:** validate "long the #1 ranked winner, 24h hold"
   under the current 1-position live constraint before arguing for the
   multi-position basket relaxation that the full long-short book requires.

## What I would NOT change yet

Nothing in the live engine. This is a research signal on a thin sample. The
correct next action is Phase B simulation + more soak data, **not** a strategy
build. Premature promotion of a one-month Sharpe-9 result is exactly the
overfit the registry exists to prevent.

## Reproduce

```bash
# read-only; sweeps (6,6) (24,24) (72,24) (72,72) by default
scripts/research/cross-sectional-momentum/run.sh
# tune: FLOOR=<min 5m $vol> NW=<sub-windows> COST=<bps/leg> run.sh
# single combo: psql ... -v lb=24 -v hd=24 -v floor=20000 -v nw=3 -v cost=10 \
#   -f scripts/research/cross-sectional-momentum/xmom_decile_study.sql
```
