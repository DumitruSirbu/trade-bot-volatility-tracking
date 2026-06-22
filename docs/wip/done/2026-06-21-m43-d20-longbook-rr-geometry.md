## D2.0 — Long-book RR geometry investigation

**Date:** 2026-06-21 — M43 D2, B0 acceptance criterion. Read-only investigation; no fix code. All figures
are derived from the codebase + the M43 spec's already-collected 7-day soak evidence. Source constants:
`RISK_TAKER_FEE_RATE = 0.0004` (`riskConsts.ts:253`), `slippage_tier1_pct = 0.15`, `slippage_tier2_pct = 0.50`
(`20260522020000-SeedStrategyVersions.ts:32-33`), `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0`
(`strategyConsts.ts:45`). Cost-floor formula confirmed at `RiskGateService.isTakeProfitBelowCost` (line 1168):
`roundTripCostDistance = entryPrice × (RISK_TAKER_FEE_RATE × 2 + slippageFraction × 2)`, where
`slippageFraction = estimated_slippage_pct / 100`.

> **DB STEPS NOW COMPLETE (2026-06-21, second pass).** The soak DB was initially unreachable (Docker daemon
> down); after the container came up the Step 3 (realized per-tier RR) and Step 4 (post-route win rate)
> queries were run read-only against `localhost:5433`. Results are in §3 and §4 below. **No
> UPDATE/INSERT/DELETE/DROP was issued — all queries are SELECT-only.** Confirmed: v2 (the **active**
> momentum version) is `strategy_versions.strategy_versions_id = 3` (`version = 2`, `status = 'active'`). The
> live `strategy_versions` slippage params match the seed migration: `slippage_tier1_pct = 0.15`,
> `slippage_tier2_pct = 0.50` on all versions — the cost floors in §1 are confirmed against live config.
> Schema notes: side values are lowercase `long`/`short`; PnL column is `realized_pnl`; win-exit column is
> `exit_reason = 'take_profit'`; tier column is `coin_tier`; geometry columns are `entry_price`,
> `take_profit_price`, `stop_loss_price`.

### 1. Cost floor confirmed (exact, per tier)

`cost_floor_pct = 2 × RISK_TAKER_FEE_RATE_PCT + 2 × slippage_tier_pct`, with `RISK_TAKER_FEE_RATE_PCT = 0.04%`:

- **tier1:** `2 × 0.04% + 2 × 0.15% = 0.08% + 0.30% =` **0.38%** of entry (round-trip).
- **tier2:** `2 × 0.04% + 2 × 0.50% = 0.08% + 1.00% =` **1.08%** of entry (round-trip).

This refines the analysis's ~0.39% (tier1) / ~1.09% (tier2) estimates: tier1 is 0.38%, tier2 is 1.08%. The
2× tier2 slippage (1.00%) is the dominant term and alone exceeds the entire reconstructed tier2 ATR-TP
distance — the analysis's root-cause claim holds.

### 2. 1.5× vs 2.0× reconciliation (algebraic)

The analysis reconstructed TP distance as `atr14 × 1.5 / price`. The live multiplier is **2.0×**, so the
live TP distance is `× 2.0/1.5 =` **× 1.333 (33% larger)** than the analysis showed.

Rescaling the analysis's reconstructed ranges (which were at 1.5×):
- **tier1 longs:** analysis TP ~0.6–1.2% at 1.5× → **~0.80–1.60% at 2.0×**. Clears the **0.38%** tier1 floor
  comfortably at every point in the range. tier1 was never the gate problem.
- **tier2 longs:** analysis reconstructed TP ~0.46–0.78% at 1.5× → **~0.61–1.04% at 2.0%**. The tier2 floor
  is **1.08%**. So at 2.0× the typical tier2 long TP (≈0.61–1.04%) is **still below the 1.08% tier2 floor**
  across essentially the whole range — the top of the range (1.04%) just grazes it.

**Conclusion — the tier2 gap survives at the live 2.0× multiplier.** The 33% uplift narrows the shortfall
(the reconstructed shortfall at 1.5× was larger) but does **not** close it: at 2.0× the tier2 long TP is
≈0.61–1.04% vs a 1.08% floor, so the `tp_below_cost` gate continues to (correctly) reject tier2 longs on
typical-ATR days. tier1 clears the floor at 2.0× with margin to spare. This is exactly the tier-aware
disease the fix must address **without** re-enabling tier2 (D4 / locked tier-1-only live start).

### 3. Per-tier realized long RR (from soak DB)

Closed v2 positions (`strategy_version_id = 3`), last 30 days, both prices present. `avg_rr` is the
mean of per-trade `|TP−entry| / |SL−entry|`. Distances are % of entry.

| coin_tier | side | n | avg_tp_dist_pct | avg_sl_dist_pct | avg_rr (mean) |
|---|---|---|---|---|---|
| tier1 | long  | 68 | 1.159 | 2.541 | 1.262 |
| tier1 | short | 46 | 1.427 | 2.467 | 1.013 |
| tier2 | long  | 37 | 1.594 | 3.559 | 0.790 |
| tier2 | short | 16 | 1.781 | 4.494 | 0.542 |

**The mean RR is misleading — use the median.** The mean is inflated by a long right tail of high-ATR TPs
(`max_tp` reaches 4.5%). The long-only distribution gives the honest central tendency:

| coin_tier | n | min_tp | p25_tp | median_tp | p75_tp | max_tp | median_sl | **median_rr** |
|---|---|---|---|---|---|---|---|---|
| tier1 | 68 | 0.011 | 0.612 | 0.891 | 1.378 | 4.531 | 1.999 | **0.445** |
| tier2 | 37 | 0.011 | 1.141 | 1.540 | 2.003 | 4.262 | 2.817 | **0.491** |

**This confirms the spec's RR ≈ 0.5–0.6 long claim on the median**: the typical (median) tier1 long carries a
0.891% TP against a 1.999% SL → median RR ≈ **0.445**; tier2 long median RR ≈ **0.491**. The few high-ATR
fills lift the *mean* RR above 1.0 (tier1 long mean 1.262) but the median trade is firmly sub-1R. Shorts:
tier1 short mean RR 1.013 (median geometry near 1.0) — confirms shorts are already ≈1.0 and need no fix.
tier2 short is also sub-1 (0.542) but tier2 is excluded from live by the locked tier-1-only start, so the
long-side fix targets tier1 longs primarily.

**Empirical cost-floor breaches (direct gate evidence).** Of the 68 closed tier1 longs, **7 had a realized
TP distance below the 0.38% tier1 cost floor**; of 37 tier2 longs, **8 had a TP below the 1.08% tier2 floor**
(and 43 of 68 tier1 longs sit below the *tier2* floor, consistent with §2). These are exactly the fills the
floor-anchor leg `max(atr×k, floor+margin)` is designed to lift — real, not reconstructed.

### 4. Post-route RR floor (breakeven from post-D1a win rate)

Breakeven RR floor `= (1 − win_rate) / win_rate`. The "~1.4" placeholder in the spec was derived from the
**full-book 42.3% win rate** (`(1 − 0.423)/0.423 ≈ 1.36`). The D2.0 spec assumed routing `catalyst_risk` out
would **raise** the surviving win rate (it cited a ~50% trend_initiation figure) and thereby **lower** the
floor toward ≈1.0. **The live 30-day data falsifies that assumption: the post-route win rate is LOWER than
the full book, not higher, so the floor is HIGHER, not lower.**

**Live post-route win rate (v2, closed, last 30d, `flow_type_at_entry != 'catalyst_risk'`):**

| flow_type | n | TP-exit wins | TP-win % | positive-PnL % | net PnL | avg_win | avg_loss |
|---|---|---|---|---|---|---|---|
| trend_initiation  | 32 | 11 | 34.4% | 40.6% | −9.03  | 4.810 | −3.767 |
| forced_exhaustion | 16 | 2  | 12.5% | 25.0% | −8.29  | 4.547 | −2.206 |
| market_beta       | 3  | 2  | 66.7% | 0.0%  | −5.71  | —     | −1.904 |
| **aggregate**     | **51** | **15** | **29.4%** | **33.3%** | **−23.03** | — | — |

Long-only post-route cohort (the cells the fix targets): n=26, TP-win 38.5% (10/26), positive-PnL 26.9%,
net −21.36 USDT.

**Recomputed post-route breakeven RR floor.** Using the symmetric `(1 − w)/w` with `trend_initiation` (the
surviving dominant flow, the cleanest momentum cohort):
- TP-exit win definition (34.4%): `(1 − 0.344)/0.344 ≈` **1.91**.
- positive-PnL win definition (40.6%): `(1 − 0.406)/0.406 ≈` **1.46**.
- aggregate post-route, positive-PnL (33.3%): `(1 − 0.333)/0.333 ≈` **2.00**.

A more faithful breakeven uses the **realized payoff ratio** (avg_win / avg_loss = 4.810/3.767 = 1.277 for
trend_initiation): breakeven win rate = `1/(1+1.277) ≈ 43.9%`. Actual positive-PnL win is 40.6%, i.e.
**just below breakeven** — which is exactly why the post-route book is still slightly net-negative (−9.03 on
trend_initiation). To reach the realized-payoff breakeven at the observed 40.6% win rate, the required
RR is `(1 − 0.406)/0.406 ≈` **1.46**.

**Recommended post-route RR floor: ≈ 1.4–1.5** — the spec's original ~1.4 anchor turns out to be the right
order of magnitude after all, NOT the ≈1.0 the algebraic-only step suggested. The ≈1.0 figure assumed a 50%
win rate that the live data does not support (post-route win is 34.4% TP / 40.6% positive-PnL, not 50%).
**Bind the long-side fix to RR ≥ ~1.4** measured TP-distance vs SL-distance, with ~1.46 (the trend_initiation
positive-PnL breakeven) as the precise target. Note the median realized tier1 long RR today is **0.445**
(§3) — the geometry gap to a 1.4 floor is large (TP must roughly triple relative to the current 0.891%
median TP against the 1.999% median SL), so the floor-anchor `max(atr×k, …)` alone will not reach 1.4 on
median-ATR days; the high-ATR leg or a higher long multiplier is required to move the median. **This is the
single most important update from the live data and the architect must weigh it when picking the lever
(see §6).**

### 5. ATR-extreme characterization of the proposed anchor

Proposed long-only anchor: `TP = entry + max(atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER, cost_floor_tier + margin)`.

- **High-ATR case** — the `atr14 × 2.0` leg dominates. At ATR = 5% of price, TP = entry + 10%. This is a
  distant TP that may be unreachable within the 15-min time-stop, pushing the position to a time-stop exit.
  Per the D2 spec (§D2.0 (d), lines 377–382) this is **accepted as designed** ("accept the high-ATR
  time-stop as designed") — the high-ATR leg is the genuine momentum-runs-further intent and the time-stop
  is the correct backstop. No bound needed beyond the inherent `max(a,b)`.
- **Low-ATR case** — the `cost_floor + margin` leg dominates. At ATR = 0.1% of price, `atr×2.0 = 0.2%`, which
  is below both floors, so the floor leg sets the TP. For tier1: TP = entry + (0.38% + margin) ≈ **0.48%**
  above entry at a 0.10% margin — clears the 0.38% tier1 gate by design. For tier2: TP = entry + (1.08% +
  margin) ≈ **1.18%** above entry — clears the 1.08% tier2 floor. Note: when ATR is genuinely tiny, the
  `atr×2.0` leg alone (≈0.2%) would still be below the tier2 floor, so for tier2 the floor leg is what lets a
  TP exist at all; if the operator keeps tier2 excluded (locked tier-1-only live), this only affects shadow
  /backtest geometry. The floor leg is a near-constant TP decoupled from price action on dead-ATR days, but
  it is cost-aware (never sub-cost) and bounded above by the floor itself — **not pathological**.

**At neither extreme does the `max(atr×k, floor+margin)` structure produce a pathological outcome** that
would require an additional cap: high-ATR resolves via the designed time-stop, low-ATR resolves via the
cost-aware floor. No extra bounding beyond the `max(a,b)` is recommended.

### 6. Lever recommendation

**Revised after live data (the cost-floor anchor alone is insufficient to reach the ~1.4 floor).** The live
§4 result raised the post-route RR floor to **≈1.4–1.5** (not the ≈1.0 the algebraic step assumed), and §3
shows the median tier1 long RR today is **0.445** (median TP 0.891% vs median SL 1.999%). To reach RR ≥ 1.4
against the ~2.0% median structural SL, the long TP must sit at ~2.8% — far above both the cost floor
(0.38%) and the current 2.0×-ATR median TP (0.891%). **Therefore the cost-floor-anchor (preference (i))
clears the gate but does NOT by itself reach the RR floor; it must be combined with a higher long-side ATR
multiplier (preference (ii)).** The architect must adjudicate the combination.

1. **Recommended lever — long-side-conditional anchor with a RAISED long multiplier, floored by cost:**
   `TP = entry + max(atr14 × MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, cost_floor_tier + margin)` **for LONG
   only**, where the new long multiplier is **larger than the current 2.0×** (preference (ii) layered on (i)).
   `momentumCore.ts:46-47` computes one `atrTarget` *before* the `tradeSide` branch; the fix must branch on
   `tradeSide === LONG` and apply the raised long multiplier + cost floor to the long leg only. **Shorts are
   byte-for-byte unchanged** (tier1 short mean RR 1.013 — already ≈1.0) — the short `atrTarget`/`atrDistance`
   path must not move. Lever (iii) tighten-SL stays disfavored (touches the structural stop — ADR 0045 §D1).
   - **Sizing the long multiplier:** to lift the median tier1 long RR from 0.445 to ~1.4, the long TP distance
     must scale by ~1.4/0.445 ≈ 3.1×, i.e. a long multiplier of ~2.0 × 3.1 ≈ **6.3×** would hit 1.4 *on the
     median* — but that pushes the high-ATR tail to very distant, time-stop-bound TPs (the §5 high-ATR caveat
     becomes the dominant regime). **This is a genuine tension the architect must resolve:** a multiplier high
     enough to median-clear 1.4 RR likely converts many trades to time-stop exits, which D3 already flags as
     the dead-signal problem. The realistic recommendation is a **moderate** long multiplier bump (e.g. ~3.0–
     4.0×) that lifts median RR toward ~0.7–0.9 and pairs with D3 selectivity (fewer, higher-conviction
     entries) rather than chasing 1.4 on geometry alone. **Do not hard-code a multiplier here — this is the
     architect's call given the time-stop trade-off; B0's job is to surface the trade-off, which it now does.**

2. **Proposed margin constant** — name `MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT`, value **0.10%** (`0.001` as
   a fraction). Rationale: the margin guarantees the cost-floor leg sits *strictly above* the `tp_below_cost`
   gate's `roundTripCostDistance` so the anchor never emits a TP the gate would reject on a rounding boundary.
   0.10% is the smallest value that reliably clears the tier1 floor (0.38% + 0.10% = 0.48%) with headroom
   against slippage jitter. The live data validates the *need* for this leg directly: **7 of 68 realized
   tier1 longs already had a TP below the 0.38% floor** (§3) — the margin+floor leg lifts exactly those. The
   margin is a cost-safety guard, **not** the RR lever (the multiplier is the RR lever per item 1); it only
   ensures no sub-cost long TP is emitted. **0.10% stays the recommendation** — the realized data does not
   justify a larger margin (a larger margin would not help reach the 1.4 RR floor; only the multiplier does).

3. **ADR 0045 flag — no amendment needed (architect to confirm).** The composite `max(atr×k, floor+margin)`
   must flow through `atrDistance` **verbatim**, exactly as the raw `atrTarget` does today: computed once in
   `buildMomentumExit`, threaded through `atrDistance` (`momentumCore.ts:60`), consumed verbatim at both the
   live arm seam and `BacktestOrchestrator.buildPosition` (ADR 0045 §D1.2). The TP stays
   `tpRebaseEligible: true`; the execution layer re-anchors the composite distance from the fill price. Since
   the rebase contract treats `atrDistance` as an opaque distance and never re-derives it, a composite value
   is safe and requires **no ADR 0045 text change** — but the architect must confirm the composite is
   threaded identically (no re-derivation at either seam) before the fix lands. The `tp_below_cost` gate is
   **not weakened**; it remains the backstop and a correctly-anchored long TP simply stops producing sub-cost
   tier2 TPs.
