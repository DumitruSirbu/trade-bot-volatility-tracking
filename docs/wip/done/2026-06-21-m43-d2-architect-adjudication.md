## D2 Architect Adjudication

**Date:** 2026-06-21 — M43 D2 lever adjudication. Doc-only decision record; no application code. Inputs:
D2.0 findings (§D2.0 §1–6 above), M43 spec §D2 (the ADR 0045 §D1 hard invariant, the lever preference order,
and the non-goal "do not tune ATR/sigma/time-stop on n=27"), and the milestone-governing sample-size
discipline rule. The implementer reads this section before writing any D2 fix code.

### Decision A — Long-side ATR multiplier: **MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER = 3.5** (moderate bump)

**Verdict: moderate bump, value 3.5×.** Rejected the higher-bump option (5.0–6.3×). Rationale:

- **The sample-size discipline rule is dispositive.** M43 ships only changes justified by **breakeven algebra,
  not fitted parameters**. The ~6.3× figure in D2.0 §6 is reverse-engineered to median-clear the 1.4 floor on
  n=68 — that is a *fitted target*, exactly what the milestone non-goal "do not tune ATR on n=27" forbids. A
  multiplier chosen to hit a fitted RR number on a small window is the disease the discipline rule exists to
  prevent. A moderate move toward breakeven, with a stated residual, is the honest decision.
- **6.3× actively worsens D3.** D2.0 §5 / §6 show a high multiplier pushes the median-ATR trade into a distant
  TP that exits on the 15-min time-stop — the precise dead-signal pathology D3 is investigating. D1a already
  removes the dominant source (11/17 time-stops are `catalyst_risk`); deliberately converting median trades to
  time-stops via geometry would re-inflate the bucket D1a just drained. Geometry must not fight D3.
- **3.5× is the chosen value** (midpoint of the D2.0-recommended 3.0–4.0× band). It scales the long TP distance
  by 3.5/2.0 = 1.75×, lifting the median tier1 long RR from **0.445 to ≈0.78** (0.445 × 1.75) — median TP moves
  from ~0.891% to ~1.56% against the ~2.0% median structural SL. This materially closes the RR gap and lifts
  every realized tier1 long TP well clear of the 0.38% cost floor, without driving median trades into the
  time-stop tail.
- **The residual RR gap is explicitly accepted.** Post-fix median tier1 long RR ≈0.78 remains **below** the
  recomputed ≈1.4–1.5 post-route breakeven floor (D2.0 §4). This shortfall is **accepted as designed**: the
  remaining lift must come from **D3 entry selectivity** (fewer, higher-conviction entries raise the win rate,
  which lowers the required RR), **not** from pushing geometry to a fitted multiplier on n=68. The gap is
  revisited after D3 selectivity lands in a future milestone. M43 does not chase 1.4 on geometry alone.

**Constants the fix introduces (LONG side only):**
- `MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER = 3.5` — long-side ATR TP multiplier. **Distinct from** the
  existing `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0` (`strategyConsts.ts:45`), which is **unchanged** and
  continues to govern the short side byte-for-byte.
- `MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT = 0.001` (0.10%) — cost-floor-leg safety margin (D2.0 §6 item 2),
  guaranteeing the floor leg sits strictly above the `tp_below_cost` gate's `roundTripCostDistance`.

Composite long TP: `TP = entry + max(atr14 × MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, cost_floor_tier +
MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT × entry)`, applied **only** under `tradeSide === LONG`. The short leg's
`atrTarget`/`atrDistance` path must not move (B7).

### Decision B — ADR 0045: **no amendment needed (confirmed)**

The composite `max(atr14 × 3.5, cost_floor + margin)` is an **opaque distance** as far as the M38 rebase
contract is concerned. It must be computed **once** in `buildMomentumExit` and threaded through `atrDistance`
(`momentumCore.ts:60`) **verbatim** — exactly as the raw `atrTarget` is today — then consumed without
re-derivation at both the live arm seam and `BacktestOrchestrator.buildPosition` (ADR 0045 §D1.2). The TP
stays `tpRebaseEligible: true`. Because the rebase contract never inspects or re-derives the distance, a
composite value is byte-compatible with the existing contract and **requires no ADR 0045 text change.**
Implementer obligation: the composite must be the *single* value placed on `atrDistance` (no second
computation at either seam) — the B4 parity test asserts live-rebased TP == backtest-rebased TP for the same
fill. If the implementer finds any seam re-deriving the distance, halt and escalate to the architect before
landing.

### Decision C — Scope: **tier1 long only (confirmed); tier2 not touched**

The D2 fix targets **tier1 long RR only.** Confirmed out of scope and **not** to be altered:
- **tier2 (both sides)** — excluded from live by the locked tier-1-only start. D2.0 §3 shows tier2 short mean
  RR 0.542 and tier2 long median RR 0.491; neither is a D2 target. No change re-enables tier2 TPs.
- **The `tp_below_cost` gate** stays the backstop, logic unchanged (B5g). A correctly-anchored long TP simply
  stops *producing* sub-cost tier2 TPs; the gate still rejects any that slip through. No attempt to re-admit a
  geometrically-impossible tier2 TP (D2.0 §2: the tier2 gap correctly survives at the live multiplier).
- **Shorts (tier1 and tier2)** — byte-for-byte unchanged (tier1 short mean RR 1.013, already ≈1.0).

The "forced_exhaustion" / tier2-short sub-1 RR anomaly (D2.0 §3) is **noted, not fixed** — it lives behind the
tier exclusion and is not a geometry problem M43 addresses.

### GREEN LIGHT — D2 fix wave may proceed

The engine implementer must define, in `apps/engine/src/strategy/const/strategyConsts.ts` (UPPER_SNAKE_CASE,
highest level, no magic numbers in `buildMomentumExit`):

1. `MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER = 3.5`
2. `MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT = 0.001`

Apply the composite `max(atr14 × MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, cost_floor_tier +
MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT × entry)` to the **LONG leg only** (`tradeSide === LONG`); leave the
short leg and `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0` untouched; thread the composite verbatim through
`atrDistance`; do not weaken the `tp_below_cost` gate. Honor B1–B8. **Residual median long RR ≈0.78 (below the
≈1.4 floor) is accepted by design; the remainder defers to post-D3 selectivity.**

---

**B0 status: COMPLETE.** All six steps done — cost floor confirmed against live config (§1), 1.5×↔2.0×
reconciled with the tier2 gap confirmed to survive (§2), realized per-tier RR queried from the live soak DB
(§3), post-route win rate queried and the RR floor recomputed to **≈1.4–1.5** (§4 — note this REVISES the
algebraic-step ≈1.0 upward; the live post-route win rate is 34.4% TP / 40.6% positive-PnL, not the assumed
50%), ATR extremes characterized (§5), lever recommendation revised (§6 — cost-floor anchor alone is
insufficient; it must pair with a raised long multiplier, and the multiplier sizing is a genuine
RR-vs-time-stop trade-off for the architect). **Key correction from the live data: the post-route RR floor
is HIGHER, not lower, than the full-book ~1.4 — do not relax the long-side TP target to ≈1.0.** Open
architect decisions for the D2 fix wave: (a) the exact long ATR multiplier given the high-multiplier →
time-stop trade-off; (b) whether to lean on D3 selectivity rather than push geometry to a full 1.4 median;
(c) confirm the composite `atrDistance` threads identically at both rebase seams (no ADR 0045 text change
expected). D2 fix code may proceed once the architect picks the multiplier.
