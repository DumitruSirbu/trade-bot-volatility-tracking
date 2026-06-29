# Shadow Test: max_tp_dist_factor 5.0 → 7.0

## Summary

After the M47 deploy (2026-06-25, live `volatility-vwap` v3-hybrid, `strategy_versions_id=16`),
the `trend_initiation` open rate fell ~50% — from 4.5/day (pre-M47 v3) to 2.3/day (v16). The drop
is fully accounted for by the new `isDegenerateMomentumGeometry` check
(`momentumCore.ts:156-172`): at `max_tp_dist_factor = 5.0` it rejects every momentum signal whose
`slDist > atr14 × 3.333`, removing ~4.0 `trend_initiation` triggers/day. Those rejected signals
are orderly trends with VWAP deviation of only 0.8–1.8%, not the 40%+ spikes the cap was designed
to guard against — the real negative/zero-price hazard is independently covered by the SHORT
`TP ≤ 0` guard at `momentumCore.ts:167`. The cap (`5.0`) is flagged **provisional** at
`M47-rr-geometry-fix.md:353`; its empirical calibration was explicitly deferred and has not yet
happened. This document specifies a shadow test of `max_tp_dist_factor = 7.0`, at which the cap
stops binding for every observed rejection (max `slDist/atr = 4.17 < 4.67`) and all sampled
signals re-admit at exactly R:R 1.5. **Promotion to live requires a clean shadow cohort
(positive expectancy, win rate above the R:R-1.5 breakeven, sufficient n and soak days) — never
v3 history, whose broken-geometry R:R ≈ 0.37 is not comparable to the M47 1.5 coupling.**

## Background

### The volume collapse

M47 coupled the take-profit distance to the stop distance in both strategy cores and added a
degenerate-geometry skip. Post-deploy, the live v3-hybrid `trend_initiation` open rate dropped
from 4.5/day to 2.3/day — roughly half the trend-following entries disappeared. No regime change
or universe change explains it; the timing coincides exactly with the M47 restart, and the
missing cohort maps one-to-one onto signals the new geometry check now rejects (~4.0/day).

### Root cause: the cap binding

The momentum stop sits at session VWAP, so `slDist = |reference − vwapSession|`
(`momentumCore.ts:147-149`). The take-profit distance is

```
tpDist     = max(baseLeg, rrFloor)                       # momentumCore.ts:114
rrFloor    = min(rrFloorRaw, cap)                         # momentumCore.ts:144
rrFloorRaw = slDist × min_rr                              # = slDist × 1.5
cap        = atr14 × max_tp_dist_factor                   # = atr14 × 5.0
```

The geometry check then rejects the signal when `tpDist / slDist < min_rr`
(`momentumCore.ts:171`). When the cap binds — i.e. `rrFloorRaw > cap`, which is
`slDist × 1.5 > atr14 × 5.0`, i.e. **`slDist / atr14 > 3.333`** — and `baseLeg` does not
independently exceed the cap, then `tpDist = cap` and

```
tpDist / slDist = (atr14 × 5.0) / slDist < 1.5   ⇔   slDist / atr14 > 3.333
```

so the signal is rejected as degenerate. The boundary is exact: at `slDist/atr14 = 3.333` the
ratio equals 1.5 (admit); anything wider is capped below target (reject). Orderly trends where
VWAP has drifted a normal session distance from price routinely land at `slDist/atr14` between
3.3 and 4.2 — which is precisely the rejected cohort.

### Why the cap is over-tight

The cap's sole stated design purpose (`M47-rr-geometry-fix.md:183`, BLOCKER 5) is to stop an
extreme-spike TP from being placed at a negative or unreachable price: "on an extreme spike where
VWAP sits 40%+ from reference, an uncapped SHORT TP (`reference − rrFloor`) can become negative."
The rejected signals are nothing like that — their VWAP deviation is 0.8–1.8% (see the sample
table below), nowhere near the 40%+ regime the cap targets. The genuine non-positive-price hazard
is already covered by an **independent** guard: the SHORT `reference − tpDist ≤ 0` check at
`momentumCore.ts:167`, which fires before the ratio test and does not depend on the cap. The cap
is therefore not load-bearing for safety on this cohort; it is over-broadly rejecting
well-shaped trades as collateral damage.

### Why v3 history cannot be used

The obvious shortcut — "look at how these signals performed under v3" — is invalid. The rejected
cohort (27 v3 `trend_initiation` positions with `slDist/atr > 3.333`) ran under the pre-M47
**uncoupled** geometry: the momentum TP was a bare `atr14 × 2.0` with no `rrFloor` lift, so those
trades sat at R:R ≈ 0.37. Under the M47 coupling the same signals would carry a TP roughly 4×
wider (R:R 1.5), a completely different exit distribution. The v3 cohort's −$21.42 result
therefore cannot be extrapolated to M47 geometry. Notably, even at the broken 0.37 R:R, the 7 TP
hits inside that cohort netted **+$20.38**, which hints at real edge once the TP is given room to
reach. The only honest way to measure the M47-geometry version of these trades is to run them
forward at R:R 1.5 — which is exactly what the shadow test does.

## The Proposed Change

### What changes

`max_tp_dist_factor: 5.0 → 7.0`, in the **params JSONB of a new shadow `strategy_versions` row
only**. Nothing else is touched. At factor=7 the cap becomes `atr14 × 7.0`, so it only binds when
`slDist/atr14 > 7.0/1.5 = 4.667`. Every observed rejection has `slDist/atr14 ≤ 4.171 < 4.667`, so
the cap stops binding for all of them and each re-admits at exactly R:R 1.5.

### What does NOT change

- `min_rr` stays 1.5 — the core R:R target is unchanged.
- The VWAP structural stop is untouched (M47 invariant: the fix only ever *widens the TP*, never
  tightens the SL — `M47-rr-geometry-fix.md:181`).
- The SHORT `TP ≤ 0` safety guard (`momentumCore.ts:167`) is independent of `max_tp_dist_factor`
  and continues to reject genuine negative-price extreme spikes unchanged.
- `atr_floor_multiplier`, `entry_pct_floor`, all other params copied verbatim from live v16.
- **Live v16 is not modified.** The shadow row runs alongside it on the read-only counterfactual
  path; live capital and the live geometry are unaffected.

### Expected effect

Re-admitting the ~4.0/day rejected `trend_initiation` cohort, less the fraction with
`slDist/atr14` still above 4.667 at factor=7 (none observed in the 4-day sample), yields roughly
**+3.2 `trend_initiation` opens/day** on the shadow version, all entering at R:R exactly 1.5
(the `rrFloor` binds, `tpDist = slDist × 1.5`). The shadow's `trend_initiation` rate should rise
back toward the pre-M47 ~4.5/day; the test measures whether that restored volume is profitable.

## Shadow Test Plan

### Setup

1. **Insert a new `strategy_versions` row** for `name = 'volatility-vwap'`, `status = 'shadow'`,
   with params copied from live v16 except `max_tp_dist_factor: 7.0`. First inspect existing rows
   to pick the version integer and confirm the params blob:

   ```sql
   SELECT strategy_versions_id, name, version, status, params
   FROM strategy_versions ORDER BY version;
   ```

   Use a **JSON-merge / explicit single-row INSERT**, never a seeder full-blob re-run (forbidden
   post-M47, `M47-rr-geometry-fix.md` BLOCKER 3).

2. **Register the version key in `StrategyRegistry` (CODE change — see architect gap).** The
   orchestrator resolves an implementation by the natural key `${name}:${version}`
   (`StrategyRegistry.ts:35-55`). The live geometry-coupled hybrid is `version = 31 → V3HybridRouterStrategy`
   (`StrategyRegistry.ts:32`). A new shadow row must use a **distinct** version integer (name+version
   is UNIQUE), and that integer must be aliased to `v3` with one line in the registry constructor,
   e.g. `this.strategiesByKey.set(this.buildKey(v3.name, <newVersion>), v3);`. Without it,
   `resolve()` throws `No IStrategy implementation registered` and the shadow is skipped. This is
   **not a pure data change** — it needs a code edit + engine restart.

3. **Restart the engine.** The shadow set is resolved **once at boot** from
   `strategy_versions.status = 'shadow'` via `findActiveShadows`
   (`ShadowStrategyOrchestratorService.ts:203-223`). There is no hot reload (TODO M-future), so a
   newly-inserted shadow row is not picked up until the next start.

### Measurement partition

The target cohort is the re-admitted set: signals with **`slDist / atr14 > 3.333`**. All
comparison metrics are computed on this partition, on the new shadow version's `shadow_decisions`
rows (NOT the live `decisions` table — shadow counterfactuals and their `simulated_fill` live only
in `shadow_decisions`).

Compute the partition from each `shadow_decisions` row's `market_snapshot` JSONB:

```
referencePrice = reconstructReferencePrice(event)          # signal-time reference
slDist         = | referencePrice − vwapSession |          # market_snapshot → vwap_session
atr14          = market_snapshot.atr14
cohort         = slDist / atr14 > 3.333
```

PnL is recomputed at the analysis layer directly from the `simulated_fill` JSONB (the canonical
shadow PnL source per ADR 0029 / M39 — `getPerformance.ts`, `compareVersions.ts`):

```
realized_pnl = (exitPrice − entryPrice) × qty × side − feeUsdtEntry − feeUsdtExit
```

counting a row as traded on `missed = false AND exitPrice IS NOT NULL AND entryPrice != '0'`.
Restrict to `signal_type = 'trend_initiation'` and `shadow_version = '<new version>'`.

> **Sizing caveat (do not over-read absolute $):** the shadow path sizes against a simplified
> per-shadow virtual equity, not the live `PositionSizer`
> (`ShadowStrategyOrchestratorService.ts:163-169`). Use the cohort's **PnL sign, expectancy sign,
> and win rate** as the verdict; treat absolute dollar magnitude as indicative, not a live P&L
> projection.

### Promotion gate

A two-stage gate. The shadow cohort screen is a **pre-screen**; live promotion still requires the
full ADR 0019 gate.

**Stage 1 — cohort pre-screen (on `slDist/atr14 > 3.333`, shadow `trend_initiation`):**

| Check | Threshold | Rationale |
|-------|-----------|-----------|
| Cohort sample size | `n ≥ 50` traded shadow positions | At ~3.2/day the cohort reaches 50 in ~16 days; enough to reject obvious negative-EV before committing soak weeks. |
| Expectancy | cohort `avg_realized_pnl > 0` | The whole thesis: the re-admitted trades must be net positive at R:R 1.5. |
| Win rate | `≥ 0.42` | R:R 1.5 breakeven (ex-cost) is `1/(1+1.5) = 0.40`; the 0.42 floor adds a margin for fees + slippage. |
| TP-hit share | `take_profit` exits materially > 0 | Confirms the widened TP is actually reachable (the v3 +$20.38 TP-hit signal, validated at 1.5 R:R). |
| Soak duration | `≥ 21 days` | At least three weekly regime cycles before any live decision; guards the weekly-improvement loop against a one-window fluke. |

**Stage 2 — formal live promotion (ADR 0019, all-of):** if Stage 1 passes, the version must still
clear the ADR 0019 promotion gate against the current `active` of the same `name`: positive OOS
expectancy and profit factor ≥ 1.25 every fold (criteria 1–2), drawdown/worst-day within tolerance
(3–4), paired-block bootstrap winner = candidate with CI excluding zero and not `inconclusive`
(criterion 5, ADR 0018), sample sufficiency ≥200 trades / ≥100 in target regime / ≥30 days
(criterion 6), and the robustness/regime/concentration checks (7–12). **Do not promote on the
Stage-1 cohort screen alone** — it is a thin, partition-specific filter, not the statistical gate.

> **Architect input needed:** the ADR 0019 criterion-6 thresholds (≥200 total, ≥30 days) were
> written for whole-strategy walk-forward reports, not a single re-admit partition that produces
> ~3.2 trades/day. Reaching n=200 *in the cohort* takes ~60+ days. Confirm whether this change is
> gated as (a) a full new strategy version through ADR 0019 unchanged, or (b) a param re-tune of
> the existing live version validated by the Stage-1 cohort screen plus a scoped bootstrap on the
> partition. The two paths imply very different soak durations.

### Risk isolation

The shadow test cannot touch live capital, by construction:

- The shadow orchestrator runs **after** the active-strategy path completes and only writes
  `shadow_decisions` rows — it never calls the exchange order API (ADR 0029 §2.3 hard rule;
  `ShadowStrategyOrchestratorService.ts:146-169, 233-258`).
- Each shadow version keeps its **own virtual ledger** seeded from `PAPER_STARTING_EQUITY_USDT`;
  fills are produced by the deterministic shadow fill simulator, not real orders.
- Every shadow evaluation is wrapped in a per-version `try/catch` so a shadow failure cannot
  cascade into the live path (`:252-257`).
- The live order path is reachable only through the risk gate (CLAUDE.md trading-safety
  invariant: "No order path bypasses the risk gate"); the shadow path is not wired to it.

## Rejected Signal Sample (observed, v16 last 4 days)

R:R columns are `tpDist/slDist` with `tpDist = min(slDist × 1.5, atr14 × factor)` and
`slDist/atr14` as shown. "Pass at 7?" is `slDist/atr14 ≤ 4.667` (cap no longer binds → re-admit at
R:R 1.5).

| Symbol | vwap_dev% | slDist/atr | R:R at factor=5 | R:R at factor=7 | Pass at 7? |
|--------|-----------|------------|-----------------|-----------------|------------|
| TAO    | -1.18     | 3.877      | 1.289           | 1.806           | yes |
| SNX    |  1.79     | 3.589      | 1.393           | 1.950           | yes |
| LTC    |  0.81     | 4.006      | 1.248           | 1.747           | yes |
| ENA    |  1.29     | 3.772      | 1.325           | 1.855           | yes |
| INJ    |  1.31     | 3.458      | 1.446           | 2.025           | yes |
| ADA    | -0.98     | 3.336      | 1.498           | 2.097           | yes |
| XRP    | -0.92     | 4.171      | 1.199           | 1.679           | yes |
| SOL    | -1.07     | 3.970      | 1.260           | 1.764           | yes |

All eight have VWAP deviation under 2% and `slDist/atr14` between 3.34 and 4.17 — well inside the
factor=7 admit boundary of 4.667 and nowhere near the 40%+ extreme-spike regime the cap targets.

Supporting DB context (v3 pre-M47, NOT comparable to M47 geometry — broken R:R ≈ 0.37):

```
v3 trend_initiation by exit_reason:
  take_profit: 13 pos, 9 wins, +$54.06 (+$4.16 avg)   ← edge present even pre-fix
  stop_loss:    6 pos, 0 wins, -$16.40
  time_stop:   28 pos, 9 wins, -$57.49
  force_close:  1 pos, 0 wins,  -$0.19
  TOTAL:       48 pos, 18 wins (37.5%), -$20.02

v3 rejected cohort (slDist/atr > 3.333), 27 pos, R:R ≈ 0.37 (broken, uncoupled atr×2.0 TP):
  take_profit:  7 wins,  +$20.38
  time_stop:   19 losses, -$41.61
  TOTAL: -$21.42  ← NOT extrapolable to M47 1.5 R:R; shadow data required

v16 trend_initiation so far (9 closed, 4 days — too thin to conclude):
  take_profit: 1 win,  +$13.13
  stop_loss:   3,      -$8.49
  time_stop:   4,      -$7.72
  force_close: 1,      -$0.20
```

## Key Code References

- `apps/engine/src/strategy/strategies/momentumCore.ts:139-145` — `resolveRrFloor`:
  `rrFloorRaw = slDist × min_rr`, `cap = atr14 × max_tp_dist_factor`, returns `min(rrFloorRaw, cap)`.
- `momentumCore.ts:147-149` — `resolveMomentumStopDistance`: `slDist = |reference − vwapSession|`.
- `momentumCore.ts:105-115` — `resolveTakeProfitDistance`: `max(baseLeg, rrFloor)`.
- `momentumCore.ts:156-172` — `isDegenerateMomentumGeometry`: the `slDist == 0`, SHORT `TP ≤ 0`
  (line 167, independent safety guard), and `tpDist/slDist < min_rr` (line 171) rejections.
- `apps/engine/src/strategy/registry/StrategyRegistry.ts:22-55` — version→impl resolution by
  `${name}:${version}`; M47 aliases 11/21/31 to v1/v2/v3 (line 30-32). A new shadow version
  integer must be aliased here.
- `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts:203-258` — shadow set
  resolved once at boot from `status = 'shadow'`; per-version virtual ledger; exchange never
  touched; failures contained.
- `apps/engine/src/strategy/repository/ShadowDecisionRepository.ts` — `shadow_decisions`
  persistence, keyed `UNIQUE(shadow_version, event_id)`; `simulated_fill` JSONB.
- `docs/plans/archive/M47-rr-geometry-fix.md:183` — BLOCKER 5, the cap's stated design intent
  (negative/unreachable TP on 40%+ spikes).
- `docs/plans/archive/M47-rr-geometry-fix.md:353` — `max_tp_dist_factor = 5.0` flagged
  **Provisional**, calibration deferred post-deploy.
- ADR 0029 — shadow counterfactual + fill-simulator pipeline (risk isolation).
- ADR 0019 — promotion gate (Stage-2 criteria); ADR 0018 — paired-block bootstrap significance.

## Status

**BACKTEST VERDICT COMPLETE (REJECTED)** — See `docs/analysis/20260629-max-tp-dist-factor-shadow.md` (EXP-004) for the 30-day backtest result. **Summary:** v19 (factor=7.0) adds 72 trades at identical 23.4% win rate; net PnL worsens −$535→−$671 (−$136). Extra trades are dominated by tier2 (34 trades at 11% WR); time-stop dominance persists 82% (vs 79% in v16). Do not promote to live. The real lever is signal quality, not cap width (see EXP-003 directional work on flow_type/idiosyncrasy/entry-timing).

**SHADOW CONTINUES** — forward data accumulation for monitoring; Stage-1 pre-screen unlikely to pass given backtest results.

**ACTIVE SHADOW VERSION** — live as of 2026-06-29.

| Field | Value |
|-------|-------|
| Shadow `strategy_versions_id` | 19 |
| Shadow version key | `volatility-vwap:32` |
| Start date | 2026-06-29 |
| Stage-1 pre-screen eligible | ~2026-07-20 (≥21 days, ≥50 cohort positions) |
| Cohort partition | `slDist/atr14 > 3.333` on `shadow_decisions` where `shadow_version = 'volatility-vwap:32'` and `market_snapshot->>'flow_type' = 'trend_initiation'` |

> **Schema note:** `shadow_decisions` has no `realizedPnl`, `exit_reason`, `opened_at`, or `closed_at`
> fields. PnL is recomputed from `simulated_fill` (`entryPrice`/`exitPrice`/`feeUsdtEntry`/`feeUsdtExit`)
> signed by the `trade_side` column and `qty`, exactly as the canonical analysis query does
> (`packages/analysis/src/query/getPerformance.ts:114-125`). The exit reason is
> `simulated_fill->>'closeReason'` with values `tp` / `sl` / `time_stop` (a TP hit is `'tp'`, not
> `'take_profit'`). Entry time is `created_at`; exit time is `simulated_fill->>'closedAt'`. A row
> counts as traded only on `missed = false AND exitPrice IS NOT NULL AND entryPrice != '0'`.

### How to query progress

```sql
-- cohort positions for the shadow probe (slDist/atr14 > 3.333, trend_initiation)
SELECT
  sd.shadow_decisions_id,
  sd.symbol,
  (sd.market_snapshot->>'flow_type') AS flow_type,
  ABS(
    (sd.market_snapshot->>'vwap_session')::numeric
    * (sd.market_snapshot->>'vwap_deviation_pct')::numeric / 100.0
  ) / NULLIF((sd.market_snapshot->>'atr_14')::numeric, 0) AS sl_dist_over_atr,
  (
    CASE sd.trade_side
      WHEN 'long'  THEN ((sd.simulated_fill->>'exitPrice')::numeric  - (sd.simulated_fill->>'entryPrice')::numeric)
      WHEN 'short' THEN ((sd.simulated_fill->>'entryPrice')::numeric - (sd.simulated_fill->>'exitPrice')::numeric)
    END
  ) * sd.qty::numeric
    - COALESCE((sd.simulated_fill->>'feeUsdtEntry')::numeric, 0)
    - COALESCE((sd.simulated_fill->>'feeUsdtExit')::numeric, 0) AS realized_pnl,
  (sd.simulated_fill->>'closeReason') AS close_reason,
  sd.created_at AS opened_at,
  (sd.simulated_fill->>'closedAt') AS closed_at
FROM shadow_decisions sd
WHERE sd.shadow_version = 'volatility-vwap:32'
  AND (sd.market_snapshot->>'flow_type') = 'trend_initiation'
  AND ABS(
    (sd.market_snapshot->>'vwap_session')::numeric
    * (sd.market_snapshot->>'vwap_deviation_pct')::numeric / 100.0
  ) / NULLIF((sd.market_snapshot->>'atr_14')::numeric, 0) > 3.333
  AND (sd.simulated_fill->>'missed')::boolean = false
  AND sd.simulated_fill->>'exitPrice' IS NOT NULL
  AND sd.simulated_fill->>'entryPrice' != '0'
ORDER BY sd.created_at DESC;
```

**Stage-1 pre-screen** (run at ≥21 days / ≥50 cohort positions):
```sql
WITH cohort AS (
  SELECT
    (
      CASE sd.trade_side
        WHEN 'long'  THEN ((sd.simulated_fill->>'exitPrice')::numeric  - (sd.simulated_fill->>'entryPrice')::numeric)
        WHEN 'short' THEN ((sd.simulated_fill->>'entryPrice')::numeric - (sd.simulated_fill->>'exitPrice')::numeric)
      END
    ) * sd.qty::numeric
      - COALESCE((sd.simulated_fill->>'feeUsdtEntry')::numeric, 0)
      - COALESCE((sd.simulated_fill->>'feeUsdtExit')::numeric, 0) AS realized_pnl,
    (sd.simulated_fill->>'closeReason') AS close_reason
  FROM shadow_decisions sd
  WHERE sd.shadow_version = 'volatility-vwap:32'
    AND (sd.market_snapshot->>'flow_type') = 'trend_initiation'
    AND ABS(
      (sd.market_snapshot->>'vwap_session')::numeric
      * (sd.market_snapshot->>'vwap_deviation_pct')::numeric / 100.0
    ) / NULLIF((sd.market_snapshot->>'atr_14')::numeric, 0) > 3.333
    AND (sd.simulated_fill->>'missed')::boolean = false
    AND sd.simulated_fill->>'exitPrice' IS NOT NULL
    AND sd.simulated_fill->>'entryPrice' != '0'
)
SELECT
  COUNT(*) AS n,
  SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS win_pct,
  ROUND(AVG(realized_pnl), 4) AS avg_pnl,
  SUM(CASE WHEN close_reason = 'tp' THEN 1 ELSE 0 END) AS tp_hits
FROM cohort;
```

Gate: **n ≥ 50, avg_pnl > 0, win_pct ≥ 42, tp_hits > 0, soak ≥ 21 days**. All five must pass before considering Stage-2 (ADR 0019 full gate).
