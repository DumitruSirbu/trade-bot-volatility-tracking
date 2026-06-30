# EXP-012 — Cross-Sectional Momentum Phase B-lite: does the edge survive real fills?

**Date:** 2026-06-30
**Author:** Alpha-Forge brainstorm follow-up (Phase B-lite, see EXP-011 and
`docs/brainstorm/20260630-1038-alternative-strategies-alpha-forge.md` Proposal 1)
**Status:** INCONCLUSIVE — **edge survives modeled fills but thins below
significance** (long-short t drops 2.45 → 1.83 after costs; still positive in all
3 sub-windows; below decision-grade on 26 periods)
**Type:** Offline analysis. Re-prices EXP-011 entries through the REAL shared
fill core (`@bot/shared applyFill`). No positions opened, no engine code changed.
**Script (reusable):** `packages/analysis/research/phaseB_fill_sim.mjs`
**Raw output:** `docs/analysis/.runs/20260630-1346-xmom-phaseB/`

---

## Hypothesis

EXP-011 found a cross-sectional momentum edge at the 24h/24h operating point on
**frictionless** close-to-close returns (long-short +6.0%/period, t=2.45) and
flagged one open caveat: the winner (D10) leg trades the highest-slippage coins,
so the price-only figure overstates the realizable edge. **Does the edge survive
the engine's actual execution cost?**

## Method

- **Re-uses EXP-011's exact panel** (24h lookback / 24h hold, $20k median-5m-dvol
  liquidity floor, non-overlapping rebalances, 3 sub-windows), restricted to the
  two traded deciles: D10 (long basket) and D1 (short basket). 320 positions
  across 26 periods.
- **Prices every entry and exit through the real engine fill model** —
  `applyFill` from `@bot/shared` (the same pure core the backtest
  `HistoricalFillAdapter` and PAPER mode use): tier-floor **adverse slippage** +
  **taker fees** (4 bps), applied in the correct adverse direction per side and
  per open/close action.
- **Real per-symbol coin tier** pulled from the `instruments` table (not assumed)
  — tier1 → 0.15% slippage, tier2 → 0.50% slippage per fill.
- **Taker-market fills** (`REDUCE_MARKET` policy, always fills) on both legs — the
  realistic assumption for momentum entries that cross the spread.
- Per-position net return = `(exit_fill − entry_fill) × qty − fees` (sign-flipped
  for shorts), as a fraction of $1,000 notional. Aggregated to a per-period
  long-short series; mean, std, t-stat, annualized Sharpe, per-sub-window.

**Cross-check:** the frictionless long-short recomputed here is +6.0011%, t=2.45
— **identical to EXP-011**, confirming the same panel feeds both studies.

## Results

### Long-short (D10 long + D1 short), per 24h period

| | mean %/period | std % | t-stat | ann Sharpe | % periods + |
|---|---------------|-------|--------|------------|-------------|
| frictionless (EXP-011) | **+6.00** | 12.48 | **2.45** | 9.19 | 61.5% |
| **real fills (this study)** | **+4.46** | 12.44 | **1.83** | 6.86 | 61.5% |

### Long-only (D10 winners — the single-slot live proxy), per 24h period

| | mean %/period | t-stat |
|---|---------------|--------|
| frictionless | +4.18 | 1.81 |
| **real fills** | **+3.42** | **1.49** |

### Cost & robustness detail

- **Average round-trip friction** (entry+exit slippage + fees): **long leg
  ~75 bps, short leg ~79 bps**. The long-short book pays both → ~154 bps/period,
  matching the 6.00 → 4.46 gap.
- **Tier composition** (why the drag is large): D10 long = 70 tier1 / 78 tier2;
  D1 short = 72 tier1 / 100 tier2. **Roughly half of each leg is tier2** (0.50%
  slippage/fill) — exactly the high-slippage-winner concern EXP-011 raised,
  now quantified.
- **Per sub-window long-short (real fills):** +6.38% / +5.49% / +1.63% —
  **still positive in all 3 disjoint windows**, same decay shape as frictionless.

## What the numbers say (plain facts)

1. **The edge survives modeled execution, but materially thinner.** The
   long-short spread falls from +6.00% to **+4.46%/period** after real
   tier-floor slippage + taker fees. The single-slot long-only proxy falls from
   +4.18% to **+3.42%/period**.
2. **It crosses below conventional significance after costs.** Long-short t drops
   **2.45 → 1.83**; long-only t is **1.49**. On 26 periods, neither clears t≈2.
   The signal is directionally intact but no longer statistically convincing once
   you pay to trade it.
3. **Phase A's 10 bps/leg cost stub was ~4× too optimistic.** Real round-trip
   friction is ~75–79 bps per leg (vs the stub's ~20 bps round trip), because
   ~half of both baskets are tier2 names at 0.50% slippage/fill.
4. **Robustness holds in sign.** Positive in all 3 sub-windows on real fills,
   carried (as in EXP-011) by the winner-continuation long leg.

## What could explain the pattern (structural vs noise)

- **Structural:** the edge is large enough (gross +6%/period) to survive a ~1.5pp
  cost haircut and stay positive across sub-windows — consistent with a real
  winner-continuation effect, not a cost mirage.
- **Still small-sample:** 26 non-overlapping periods on a single 31-day regime.
  The t<2 after costs and the implausible ~7 annualized Sharpe both say "thin
  sample, one favorable month," not "validated strategy."

## Critical caveats — this is an UPPER bound on net edge

The tier-floor fill model captures the **dominant** cost but not all of it. Real
net edge is **lower** than +4.46% because this study does **not** model:

- **Fast-mover slippage beyond the tier floor.** D10 winners averaged +22.6%
  trailing — entering them likely slips worse than the flat tier2 0.50% floor.
  (EXP-008 established the backtest slippage is a fixed %-of-notional, not
  velocity-aware — same limitation here.)
- **IOC missed fills.** The 2 s IOC timeout vs ~10 s tick granularity makes
  per-order miss modeling a granularity artifact, so taker-market always-fill was
  assumed. Real momentum chases will miss some fast D10 entries — a real,
  un-modeled drag on the long leg specifically.
- **Funding** on a 24h hold (not charged here), and **borrow/availability** on the
  D1 short leg (many tier2 shorts are hard to borrow at size).

## Verdict

**Edge survives realistic modeled fills but is no longer decision-grade.** Costs
eat ~1.5pp of the 6pp gross long-short and push the t-stat below 2; the
single-slot long-only proxy is +3.4%/period at t=1.49. The winner-leg
execution-drag caveat EXP-011 raised is now **quantified and real** (~75 bps
round trip, half the basket is tier2), and additional un-modeled costs
(fast-mover slip, missed fills, funding/borrow) make +4.46% an **upper bound**.

This **confirms EXP-011's promise without promoting it**: the signal is real and
robust in sign through costs, but the post-cost significance and the
single-regime, 26-period sample keep it below the bar for live capital.

## Rules out / what NOT to do

- **Do not promote to a strategy build on this evidence.** Post-cost t<2 on one
  regime is not a green light; it is a "keep gathering data" signal.
- **Do not model momentum costs at 10 bps/leg.** Real tier-floor friction is
  ~75–79 bps round trip per leg; use that (or worse) in any future sizing.
- **Do not treat +4.46% as the realizable edge.** It is an upper bound; fast-mover
  slip, missed fills, funding, and short-borrow all subtract further.
- **Do not assume the short leg is free.** D1 is 58% tier2 and carries the
  highest friction (~79 bps) plus un-modeled borrow cost.

## What I would check next (smallest confirming step)

1. **More soak, then re-run both EXP-011 and EXP-012 monthly.** The binding
   constraint is sample size and regime diversity — the edge must hold post-cost
   across a *down* regime before it earns capital. Both scripts are
   parameterized and reusable for this.
2. **If/when post-cost significance holds across regimes**, the long-only
   single-slot proxy (+3.4%/period, taker-market, 24h hold) is the
   lowest-architecture way to take it live under the current 1-position
   constraint — and only then is the Phase B-full milestone (cross-sectional
   ranking layer + multi-position basket) justified.

## What I would NOT change yet

Nothing in the live engine. EXP-012 sharpens EXP-011's verdict but does not
cross the promotion bar. Correct next action is **soak + monthly re-run**, not a
strategy build.

## Reproduce

```bash
node packages/analysis/research/phaseB_fill_sim.mjs        # 24h/24h, $20k floor
PHASEB_DB_URL=postgres://... node packages/analysis/research/phaseB_fill_sim.mjs
```
