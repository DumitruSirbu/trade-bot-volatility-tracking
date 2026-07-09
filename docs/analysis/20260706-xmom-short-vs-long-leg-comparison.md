# EXP-020 — Cross-Sectional Momentum: does a SHORT loser leg beat or complement the LONG-only xmom?

**Date:** 2026-07-06
**Author:** Quant offline follow-up to EXP-011 / EXP-012 (Proposal 1 lineage), staged per the
M53b Route-2-first (offline, read-only) methodology.
**Status:** INCONCLUSIVE — **short does NOT beat long standalone; complements only as an ex-post
market hedge; whole signal has DECAYED out-of-sample.** Keep gathering data + monthly re-run.
No promotion, no live-path change.
**Type:** Offline analysis over existing `candles` + `instruments`. Re-prices both legs through the
REAL shared fill core (`@bot/shared applyFill`). No positions opened, no engine/shared/migration code
touched. Read-only.
**Scripts (reusable):** `scripts/research/cross-sectional-momentum/` (decile SQL, gross) +
`packages/analysis/research/shortLeg_fill_sim.mjs` (new — short leg isolated + regime split, real fills).
**Raw output:** `docs/analysis/.runs/20260706-1201-xmom/` (gross sweep) and
`docs/analysis/.runs/20260706-1203-xmom-shortleg/` (real-fill leg comparison).

---

## Hypothesis

The live xmom strategy is LONG-only: it longs the D10 winners (`crossSectionalMomentumCore` ranks
best-first, `MomentumOrchestratorService` hardcodes `tradeSide: LONG`). EXP-011/012 showed the winner
leg is the stronger half and the loser (D1) leg bounces at longer lookbacks. **Does adding a SHORT leg
that shorts the D1 losers — either standalone, or as a long-short book — beat or complement LONG-only,
and specifically does SHORT win in the DOWN regime that LONG lost in?**

This is the decision-grade extension of EXP-011/012 into a dedicated short-vs-long comparison over the
**full** currently-available soak window (grown from 31 to 36.5 days since EXP-011).

## Method

- **Data:** 5m `candles`, 324 symbols, **2026-05-30 20:00 → 2026-07-06 08:55 (36.5 days)** — the full
  soak window (EXP-011/012 ran on the first 31 days).
- **Operating point:** 24h lookback / 24h hold — the only combo EXP-011 found signal at (6h/6h is dead,
  re-confirmed below). $20k median-5m-dvol liquidity floor. Non-overlapping rebalances (step = hold, so
  forward windows never overlap; no autocorrelation t-inflation). 32 rebalance periods, 108-symbol
  tradable universe, 1,912 decile-1/10 positions.
- **Ranking parity with live:** D10 = the winner basket `crossSectionalMomentumCore` would long today;
  D1 = the loser basket a sign-flipped comparator (`rank_side:'short'`, Piece 1 below) would short.
- **Real fills:** every entry AND exit priced through `applyFill` from `@bot/shared` — the same pure
  core the backtest `HistoricalFillAdapter` and PAPER mode use: tier-floor **adverse** slippage
  (tier1 0.15% / tier2 0.50% / tier3 1.0% per fill) + 4bps taker, in the **correct adverse direction
  per side** (short pays up on entry, down on exit — sign-flipped from long). Real per-symbol
  `coin_tier` from `instruments`. Taker-market always-fill (`REDUCE_MARKET`).
- **Short PnL sign:** per-position gross = `(entryPx − exitPx)·qty` for shorts (profits when price
  falls), `(exitPx − entryPx)·qty` for longs; net = `(gross − fees)/notional`. Verified against the
  EXP-012 core.
- **Regime match (the crux):** each period is tagged UP/DOWN by the realized cross-sectional **mean
  forward return of the full tradable universe** (the "market" that period). Legs are then compared
  WITHIN each realized regime and WITHIN each chronological sub-window — never long-in-an-up-month vs
  short-in-a-down-month.
- **Every number is flagged gross vs net-of-fees** (EXP-018 "gross misled once" rule).

## Results

### (A) Gross decile forward return — 24h/24h, full 36.5-day window (from the SQL sweep)

| decile | n | avg trailing % | avg forward % (gross) | forward t |
|--------|---|----------------|-----------------------|-----------|
| 1 (losers)  | 209 | −14.58 | **−1.08** | −0.85 |
| 5           | 190 |  −0.94 | −0.56 | −1.75 |
| 10 (winners)| 178 | +22.92 | **+2.45** | +1.33 |

Loser-leg forward is **−1.08%** (was −1.80% in EXP-011); winner-leg **+2.45%** (was +4.11%). A **short**
of D1 earns the sign-flip: **+1.08% gross pooled** — still smaller in magnitude than the long's +2.45%.

### (B) Per-leg per-period series through REAL fills — 24h/24h, 32 periods

| leg | basis | mean %/period | std % | t-stat | ann Sharpe | % periods + |
|-----|-------|---------------|-------|--------|------------|-------------|
| **LONG** (D10)  | frictionless | +2.25 | 11.95 | 1.07 | 3.60 | 56.3% |
| **LONG** (D10)  | **net fills** | **+1.52** | 11.88 | **0.72** | 2.45 | 46.9% |
| **SHORT** (D1)  | frictionless | +1.05 | 8.97 | 0.66 | 2.23 | 65.6% |
| **SHORT** (D1)  | **net fills** | **+0.31** | 8.97 | **0.20** | 0.67 | 62.5% |
| **L-S book**    | frictionless | +3.30 | 14.02 | 1.33 | 4.50 | 56.3% |
| **L-S book**    | **net fills** | **+1.83** | 13.95 | **0.74** | 2.51 | 56.3% |

Round-trip friction: **long leg 73.1 bps, short leg 74.5 bps**. Tier mix: D10 long 89 tier1 / 89 tier2
(50% tier2); **D1 short 100 tier1 / 109 tier2 (52% tier2)** — the hard-to-borrow half.

### (C) Regime-matched (realized market-forward sign; DESCRIPTIVE, ex-post) — net fills

| regime | n periods | LONG net %/pd | SHORT net %/pd | L-S net %/pd |
|--------|-----------|---------------|----------------|--------------|
| **UP**   | 17 | **+6.14** | **−4.40** | +1.74 |
| **DOWN** | 15 | **−3.72** | **+5.65** | +1.94 |

### (D) Per chronological sub-window, leg-by-leg (net fills) — the tradable-order read

| sub-window | n | span | market fwd % | LONG net % | SHORT net % | L-S net % |
|------------|---|------|--------------|------------|-------------|-----------|
| w1 | 11 | 05-31 .. 06-10 | +0.09 | **+8.72** | +1.97 | +10.69 |
| w2 | 10 | 06-11 .. 06-23 | −0.79 | −2.52 | **+1.29** | −1.23 |
| **w3** | 11 | **06-24 .. 07-04** | +0.21 | **−2.00** | **−2.24** | **−4.24** |

### (E) 6h/6h remains dead (gross)

L-S 6h/6h = −0.21%/period, t=−0.46, 47.5% positive — re-confirms EXP-011: no intraday leg, long or short.

## What the numbers say (plain facts)

1. **Short does NOT beat long standalone.** Net of real fills the long leg is **+1.52%/period
   (t=0.72)**; the short leg is **+0.31%/period (t=0.20)** — statistically indistinguishable from zero.
   On the mean the long leg is ~5× the short leg. The winner-continuation half is still the stronger
   half, exactly as EXP-011 found.
2. **The regime split is a mechanical mirror, not an independent edge.** In realized UP periods long
   makes +6.14% and short loses −4.40%; in realized DOWN periods it flips (long −3.72%, short +5.65%).
   Short "wins where long lost" only in the trivial sense that a short is the market-mirror of a long.
   The L-S book is the one regime-balanced object (+1.74% up / +1.94% down) — that is the *diversification*
   case for a short leg, not a standalone-alpha case.
3. **The regime tag is EX-POST — not a tradable rule.** UP/DOWN is assigned from the *realized* forward
   market return, which you do not know at rebalance. "Short in down regimes" is descriptive attribution,
   **not** a conditioning signal you could deploy. Nothing here says you can time the switch.
4. **The most damning fact: the whole signal has DECAYED out-of-sample, and short does NOT rescue it.**
   The L-S gross spread fell **+6.00% (EXP-011, t=2.45) → +4.46% (EXP-012 real, t=1.83) → +3.30% gross /
   +1.83% net (this study, t=0.74)** as the window grew. The newest chronological window w3 (late-Jun →
   Jul) is **negative on BOTH legs** (long −2.00%, short −2.24%, book −4.24%). The short leg decayed in
   lockstep with the long — it is not a hedge against the decay, it is subject to the same decay.
5. **Every short number is an UPPER bound and the short leg is worse-positioned than the long.** 52% of
   the D1 short basket is tier2 (hard-to-borrow at size); the +0.31% net short leg charges NO short-borrow,
   NO funding on the 24h hold, NO fast-mover slip, NO missed IOC. Any one of those pushes a +0.31% leg
   negative. The long leg's caveats are real too but it starts from +1.52%, not +0.31%.

## What could explain the pattern (structural vs noise)

- **Structural (real but small):** cross-sectional winner-continuation is the most documented cross-asset
  anomaly (Jegadeesh-Titman; Asness et al.), and the loser-continuation short side is its natural
  companion. A modest, cost-surviving winner edge is plausible. But the *asymmetry* (long > short) is also
  documented in crypto — losers mean-revert/bounce harder (short-covering, delisting-rebound), eroding the
  short side, which is exactly what the D1 forward (−1.08%, t=−0.85) and the longer-lookback bounce in
  EXP-011 showed.
- **Noise / overfit (dominant risk here):** 32 non-overlapping periods on a **single ~36-day regime** is
  below this registry's decision-grade bar (≥30 obs *and* stability across disjoint windows). The signal
  is NOT stable across the three sub-windows (+10.69 / −1.23 / −4.24 net) — it is monotonically decaying,
  the opposite of robust. The EXP-011 Sharpe-9 was a one-month mirage; this window's decay is the
  out-of-sample correction arriving.
- **Survivorship:** a symbol must exist at t−24h, t, t+24h to enter — delisted/new coins drop, mildly
  favoring persisters on both legs.
- **Short-specific frictions un-modeled:** borrow availability/fee, funding on 24h holds, and fast-mover
  slippage on the D1 tail all subtract from the short leg specifically and are NOT in the +0.31%.

## Verdict

**Short does not beat long, and does not rescue the decaying edge.** Standalone, the short leg is
+0.31%/period net at t=0.20 — indistinguishable from zero and ~5× weaker than the long leg (+1.52%,
t=0.72). Its only genuine value is as the market-mirror half of a **long-short book**, which is the one
object that is regime-balanced (+1.74% up / +1.94% down net) — but (a) that book is still only +1.83%/pd
at t=0.74 (below significance), (b) it requires the multi-position basket relaxation the current 1-slot
live constraint forbids, (c) the regime-balance is an ex-post attribution, not a tradable timing rule,
and (d) the newest sub-window shows BOTH legs negative, so the diversification did not hold when it was
most needed.

Layered on top: the short leg's +0.31% is an **upper bound** that charges no short-borrow, funding, or
fast-mover slip — costs that fall disproportionately on the 52%-tier2 D1 basket and very plausibly turn
the realizable short leg **negative**.

**This is a NO-GO for building a live short-momentum shadow lane now.** It does not clear the bar to
justify even the scaffolding's follow-on (Piece 3). The correct action is the same as EXP-011/012:
**keep gathering soak data and re-run this comparison monthly.** The edge — long *or* short — must stop
decaying and hold post-cost across a genuine down regime before any short leg earns engineering effort.

## Critical caveats — this short edge is an UPPER bound (mandatory, per EXP-018)

The tier-floor fill model captures the dominant execution cost but the short leg specifically is charged
**less** than reality. The +0.31%/period net short leg does NOT include:

- **Short-borrow availability & fee.** D1 is 52% tier2; many are hard-to-borrow at size. Real perps have
  funding-as-borrow, not a locate market, but availability at the top-of-book still constrains the short
  side and is un-modeled.
- **Funding on the 24h hold.** Perpetual shorts pay/receive funding every 8h (up to 3 intervals per 24h
  hold). On trending-down losers, funding is frequently *against* a fresh short (positive funding → short
  receives, negative → short pays); it is netted to zero here, which is optimistic.
- **Fast-mover slippage beyond the tier floor.** D1 losers averaged −14.6% trailing; entering/exiting the
  falling tail slips worse than the flat tier2 0.50% floor (EXP-008: backtest slippage is fixed
  %-of-notional, not velocity-aware — same limitation here).
- **Missed IOC fills.** Taker-market always-fill was assumed; real chases miss some fast fills.

Combined with the small-sample / single-regime-diversity limit (32 periods, one ~36-day regime, decaying
across sub-windows), **any offline short edge must beat long by a margin, not a hair — and here it loses
outright.**

## Rules out / what NOT to do

- **Do not build a standalone short-momentum strategy on this evidence.** +0.31%/period net at t=0.20 is
  a zero, and an upper-bound zero at that.
- **Do not read the DOWN-regime short win as tradable alpha.** It is the mechanical mirror of the long,
  measured on an ex-post regime tag you cannot condition on live.
- **Do not treat the short leg as a decay hedge.** In the newest window both legs are negative; the short
  decayed with the long.
- **Do not rebalance intraday for a short leg either** — 6h/6h is dead on both sides.
- **Do not model the short leg's cost at the long leg's rate.** Borrow + funding + fast-mover slip on a
  52%-tier2 falling-tail basket exceed the 74.5 bps modeled here.
- **Do not size any of this as the EXP-011 Sharpe-9.** That was a one-month artifact; the out-of-sample
  window is decaying toward zero.

## What I would check next (smallest confirming step)

1. **More soak, then re-run EXP-011 / EXP-012 / EXP-020 monthly.** The binding constraint is sample size
   and regime diversity. The decay across sub-windows is the headline; another month tells us whether it
   stabilizes or continues to zero. All three scripts are parameterized and reusable.
2. **Only if the long leg re-establishes post-cost significance across a genuine down regime** does the
   short leg's *complementary* (book-balancing) value become worth pricing — and even then the first
   question is short-borrow/funding feasibility at size, not more offline replay.
3. **Do NOT chase Route-1 (live shadow lane) for the short leg.** Its evidence bar (below) is not met.

## What I would NOT change yet

Nothing in the live engine, shared package, or migrations. xmom stays LONG-only. This is a research signal
on a thin, decaying sample; the short leg is a zero-to-negative standalone and an ex-post-only complement.
Premature scaffolding of a short lane is exactly the overfit-to-one-window risk the registry exists to
prevent.

---

## Design spec — Pieces 1-2, STAGED & GATED (documented, NOT built)

Framed exactly as M53b frames Route-1: small scaffolding that is **DEAD CODE** until a portfolio-shadow
evaluation lane (the milestone-sized, live-path-risky **Piece 3**) exists. **Neither piece is needed for
THIS offline report** — the analysis above rank-flips the comparator inside the research script
(`shortLeg_fill_sim.mjs`), touching no engine/shared code. The engine implementation earns its keep only
if the evidence later warrants the live shadow lane. It does not today.

### Piece 1 — `rank_side` param on `IMomentumParams` (packages/shared)

- Add `rank_side: z.enum(['long', 'short']).default('long')` to `momentumParamsSchema.ts` (schema is
  intentionally non-`.strict()` for forward-compat, so this is additive and back-compatible; an empty
  `params` object still parses to `'long'`).
- Make `crossSectionalMomentumCore`'s comparator **sign-aware**: multiply the `trailingReturnPct` diff by
  `+1` for `'long'` (best-first, today's behavior) or `−1` for `'short'` (worst-first). `'long'` is a
  **provable no-op** reproducing today's exact ranking (same tie-break on symbol ascending).
- Route the shared change through `bot-shared-maintainer`; paired test asserting `'long'` reproduces the
  current dense-rank 1..M byte-for-byte and `'short'` reverses it.

### Piece 2 — `xmom-short` `IPortfolioStrategy` lineage + shadow-status seed row

- A distinct portfolio-strategy lineage `xmom-short` whose params carry `rank_side:'short'`, seeded as a
  `strategy_versions` row with `status='shadow'` (dump-first per CLAUDE.md rule-9; migration only when
  Piece 3 is committed).
- The orchestrator's hardcoded `tradeSide: LONG` becomes side-derived from `rank_side` for this lineage
  (short ranks losers-first → opens SHORT). This is the seam that, without Piece 3's containment, would
  reach the live order path — hence it stays dead until Piece 3.

### Piece 3 (NOT specced here beyond its gate) — the live portfolio-shadow evaluation lane

The milestone-sized, live-path-risky fan-out that would actually *evaluate* `xmom-short` on the live tape.
This is the analog of M53b's Route-1: it carries the same load-bearing containment invariant (a
`status='shadow'` cohort intent must record ONLY to `shadow_decisions`/`simulated_fill` and NEVER reach
`emitApproval`, the executor, or the risk gate — CLAUDE.md "no order path bypasses the risk gate") and the
same flat-fill feasibility risk. **Not built, not specced in detail, and not justified by current
evidence.**

### Go / no-go decision rule for committing Pieces 1-3 (analogous to M53b's gates)

Commit the scaffolding + live shadow lane **only if ALL** hold on a future monthly re-run:

1. **Long-leg durability (precondition).** The LONG leg re-establishes post-cost significance
   (net t ≥ ~2) and holds positive across ≥3 disjoint sub-windows **including a genuine down regime** —
   i.e. the decay documented here reverses. If the long leg is not durable, a short leg is moot.
2. **Short marginal value.** The SHORT leg is net-positive after a **short-borrow + funding + fast-mover**
   cost charge (not just the tier floor), AND the long-short book's net t exceeds the long-only net t by a
   **margin** across sub-windows — short must *add* diversified return, not merely mirror.
3. **Sample bar.** ≥ ~300 paired per-symbol observations spanning ≥2 regime types, with the
   multiple-comparisons exposure (long / short / book across windows) pre-registered before the read.
4. **Route-1 fidelity + containment gates (M53b gate (a)/(b))** pass — realistic entry slippage in the
   shadow fill path (no flat-fill collapse) and the adversarial containment test (shadow intent never
   reaches the risk gate/executor).

**Fail any one → do not build.** On today's data, gates 1, 2, and 3 all fail (long leg decaying and
insignificant; short leg a zero/upper-bound; sample thin and unstable). **Decision: NO-GO; re-run
monthly.**

---

## Reproduce

```bash
# (A) gross decile sweep over the FULL candles window (regenerates 24/24, 6/6, 72/24, 72/72):
FLOOR=20000 NW=3 COST=10 scripts/research/cross-sectional-momentum/run.sh
#   -> docs/analysis/.runs/<ts>-xmom/lb24_hd24.out   (gross L-S + per-decile)

# (B) short-vs-long leg comparison through the REAL @bot/shared applyFill core,
#     with the regime-matched split (new research script; read-only, no engine touch):
node packages/analysis/research/shortLeg_fill_sim.mjs
#   env override: PHASEB_DB_URL=postgres://... node packages/analysis/research/shortLeg_fill_sim.mjs
#   -> per-leg net/frictionless series, UP/DOWN regime rows, per-sub-window leg-by-leg, friction+tier mix
```

**Script tweak made (research tooling only):** added
`packages/analysis/research/shortLeg_fill_sim.mjs` — a copy of `phaseB_fill_sim.mjs` extended to (1) report
the D1 SHORT leg as its own series and (2) fetch the full decile panel to tag each period's realized
UP/DOWN market regime and emit the regime-matched + per-sub-window leg-by-leg breakdown. No change to
`apps/engine/`, `packages/shared/`, or any migration.
