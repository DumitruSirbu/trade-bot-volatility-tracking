# Strategy Bake-Off — EXP-013…016: funding, OI-divergence, breakout, pairs vs momentum

**Date:** 2026-06-30
**Author:** Alpha-Forge brainstorm follow-up (bake-off, see
`docs/brainstorm/20260630-1038-alternative-strategies-alpha-forge.md`)
**Scope:** Phase-A offline edge studies on the four remaining backtestable
brainstorm proposals, compared head-to-head against cross-sectional momentum
(EXP-011/012) on the **same** data (5m `candles` + `open_interest` +
`funding_rates`, 301 symbols, 2026-05-30 → 2026-06-30, $20k median-5m-dvol
liquidity floor, 3 sub-windows). No positions opened, no engine code changed.
**Scripts (reusable):** `scripts/research/bakeoff/` (`funding_study.sql`,
`oi_divergence_study.sql`, `breakout_study.sql`, `pairs_study.sql`)
**Raw output:** `docs/analysis/.runs/20260630-1408-bakeoff/`
**Excluded:** Proposal #2 (liquidation cascade) — not backtestable (backtest
weakest in cascade regimes; liquidation feed not ingested). Needs shadow soak.

---

## Scoreboard

| Strategy | Headline result | Verdict |
|----------|-----------------|---------|
| **#1 Cross-sectional momentum** (EXP-011/012) | LS **+4.46%/period net** of real fills, t=1.83, positive in all 3 sub-windows; beta-neutral | **WINNER — promising, proceed** |
| **#4 OI-divergence** (EXP-014) | "Follow fresh money" weak/dead, **BUT** a strong robust **short-cover fade** (price↑ on OI↓ → reverts down, t=−6 to −10, n=46k); magnitude ~0.2–0.26% < round-trip cost | **FILTER, not standalone** |
| **#3 Funding fade** (EXP-013) | Fade spread **negative** (−0.6%/period, t=−0.30); high funding *continues up* | **REJECTED** |
| **#5 Donchian breakout** (EXP-015) | Up-breakouts **+0.90% < +2.15% baseline** — capture *less* than unconditional long; pure beta | **REJECTED** |
| **#6 Stat-arb pairs reversion** (EXP-016) | Reversion **significantly negative** (t=−3.7 to −4.2): spreads *trend*, don't revert | **REJECTED (at these horizons)** |

**Bottom line: momentum is the only survivor.** OI-divergence contains a real
microstructure signal worth keeping as an overlay/filter. The other three are
dead on existing data.

---

## EXP-013 — Funding-Rate Carry / Squeeze fade

**Hypothesis:** extreme funding = crowded longs = fragile → short high-funding,
long low-funding (fade). **Method:** rank tradable symbols by funding rate at t,
deciles, forward return over hd hours; fade spread = fwd(D1 low) − fwd(D10 high).

**Result (24h):** fade spread **−0.60%/period, t=−0.30, 44% positive**; sub-windows
−4.79 / +3.87 / −1.62 (sign-unstable). Per-decile: the **highest-funding decile
had the highest forward return** (+1.84%/24h), not the lowest — crowded-long coins
*continued up* in this window.

**Verdict: REJECTED.** Funding fade has no edge; the only thing "working" is that
high-funding coins keep rising — which is just momentum re-discovered (funding
correlates with recent winners), not an independent funding edge.
**Rules out:** do not build a funding-fade strategy; do not treat extreme funding
as a standalone reversal trigger. Funding may still have value as a *cost input*
(carry on holds) or a momentum-confirming feature, not a fade signal.

## EXP-014 — OI-Divergence Quadrant

**Hypothesis:** price × OI sign classifies move quality; follow "fresh money"
(price & OI same direction), fade "closing" quadrants. **Method:** classify each
hourly event by sign(price chg) × sign(OI chg) over 1h; forward return per
quadrant; "follow fresh money" rule = long price↑OI↑ / short price↓OI↑.

**Result:**
- **Follow-fresh-money is weak/dead:** +0.018%/event, t=1.22 (1h), and ~0 at 4h.
- **The real signal is the short-cover quadrant:** `price↑ & OI↓` (rally on
  falling OI = no new money) forward return **−0.21%/1h (t=−10.3)** and
  **−0.26%/4h (t=−6.5)** across ~12k events — a strong, highly significant,
  economically sensible **fade-the-hollow-rally** signal. The `price↓ & OI↓`
  (long-liquidation) quadrant is mildly negative too.

**Verdict: FILTER, not standalone.** The short-cover fade is the most
statistically robust signal in the entire bake-off (|t| 6–10 on tens of
thousands of obs), but the per-event magnitude (~0.2–0.26%) is **below the
~0.4–0.75% round-trip taker cost** measured in EXP-012, so it is **not directly
tradable as a high-frequency standalone fade.** Its value is as an **overlay /
gate**: e.g., never go long (or prefer skip) when a coin is rising on falling OI;
or use it as a confirmation filter on a lower-frequency strategy. It proves the
OI read carries genuine predictive content.
**Rules out:** do not trade the OI quadrant standalone at hourly frequency
(magnitude < cost); do not use the "follow fresh money" continuation leg (weak).
Keep the short-cover fade as a filter/feature.

## EXP-015 — Donchian Breakout Trend-Following

**Hypothesis:** close breaking the prior 24h high/low continues; convex payoff.
**Method:** rolling channel via window MAX/MIN over prior lb hours of 5m bars,
top-of-hour evaluation; forward return after breakout vs unconditional baseline.

**Result (24h/24h):** **unconditional baseline forward = +2.15%/24h** (the whole
universe drifted up this month). Up-breakouts captured only **+0.90%** —
*worse than baseline* — at a 43.6% hit rate; the short leg lost (−0.30%) into the
up-drift. Sub-windows sign-flip. 12h/12h: up-breakout +0.06% vs +1.60% baseline.

**Verdict: REJECTED.** Breakouts *underperform* simply being long, so the timing
signal subtracts value (classic false-breakout chop). The apparent positive
number is pure beta, not edge — and directional strategies here are contaminated
by the bull-ish 31-day window, unlike momentum's beta-neutral long-short.
**Rules out:** do not build a breakout/trend-following strategy on this data; any
directional long looks "good" only because the window drifted up. **Methodological
note:** always benchmark a directional strategy against the unconditional
forward-return baseline — the universe was net +2.15%/24h.

## EXP-016 — Stat-Arb Pairs (z-score reversion)

**Hypothesis:** linked pairs mean-revert their log-price ratio; enter at |z|≥2,
capture reversion. **Method:** 6 liquid major pairs (BTC/ETH/SOL/BNB), rolling
72h z-score, strategy = −sign(z) × forward ratio change over hd hours.

**Result:** reversion edge **significantly negative** — −0.19%/event t=−3.72 (8h),
−0.37%/event t=−4.16 (24h). i.e. stretched spreads **keep stretching** (spread
*momentum*, not reversion) at hours-to-day horizons. Per-pair mostly negative;
only BTC/ETH marginally positive at 24h (+0.19%, n=114, not robust). Sub-windows
consistently negative.

**Verdict: REJECTED (at these horizons).** Crypto major-pair spreads trend rather
than revert over hours-to-days. Caveat: tested with fixed β=1 (ratio, no
cointegration hedge-ratio estimation) on a 31-day window — proper cointegration
or much shorter/longer horizons could differ, but the *significant negative*
reversion signal makes pairs-reversion a poor next bet.
**Rules out:** do not build hours-to-day pairs mean-reversion; spreads have
momentum at this horizon. If revisited, estimate hedge ratios and test
sub-hourly or multi-day horizons, and expect the multi-position infrastructure
cost.

---

## Cross-cutting findings

1. **Beta contamination is the trap.** The universe drifted **+2.15%/24h**. Any
   directional long (breakout, funding-continuation) looks good for the wrong
   reason. Momentum's strength is that its **long-short is beta-neutral** — the
   +4.46% is *not* market drift. Prefer market-neutral constructions.
2. **High t-stat ≠ tradable.** OI-divergence's short-cover fade has |t|=6–10 (huge
   n) yet isn't standalone-tradable because per-event magnitude < cost. Always
   compare edge magnitude to the ~0.4–0.75% round-trip cost floor (EXP-012).
3. **Several "edges" are momentum in disguise.** Funding-continuation and the OI
   fresh-money leg both reduce to recent-winner continuation. Momentum is the
   underlying factor; the others are noisier proxies for it.
4. **Multiple-testing discipline.** Five strategies × several param combos on one
   31-day window: the survivor (momentum) is ranked #1 for *further soak*, not
   crowned a live winner. One favorable month is not validation.

## Recommendation (what to proceed with)

- **Proceed with #1 cross-sectional momentum** as the single candidate worth
  continued validation — it is the only positive, cost-surviving, beta-neutral,
  sub-window-robust edge found. Path unchanged from EXP-012: soak + monthly
  re-run across a *down* regime; long-only single-slot proxy as the lowest-
  architecture live step; Phase B-full milestone only after post-cost
  significance holds out-of-sample.
- **Keep #4 OI short-cover fade as an overlay/feature**, not a strategy — a
  candidate gate ("don't long a rally on falling OI") to layer onto momentum or a
  future router. Cheap to carry; do not build standalone.
- **Drop #3, #5, #6** on current data (rejections above). Re-open only with a
  specific new mechanism (e.g., cascade-feed ingestion for #2, cointegration
  hedge ratios for #6), not by re-tuning these.
- **#2 liquidation cascade** remains un-tested here — if you want a second iron in
  the fire, it needs the Binance `!forceOrder` feed + a shadow soak, not an
  offline study.

## What I would NOT change yet

Nothing in the live engine. The bake-off narrows five candidates to one
(momentum) plus one overlay (OI short-cover fade). Correct next action is to keep
accumulating soak data and re-run, **not** to build any of these.
