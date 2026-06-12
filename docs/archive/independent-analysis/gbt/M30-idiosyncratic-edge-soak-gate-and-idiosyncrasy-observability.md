# Independent Review — M30 Idiosyncratic-Edge Soak Gate + Idiosyncrasy Observability

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M30-idiosyncratic-edge-soak-gate-and-idiosyncrasy-observability.md`  
**Date:** 2026-06-11

## Verdict

**Do not dispatch as written. Approve the direction, but amend the plan first.**

M30 is pointed at the right next milestone: read the M29 soak before building slot C. The plan is
correct to keep the correlated strategy deferred, to make the slot-C prerequisite executable, and to
add observability around `no_eligible_slot` instead of changing the idiosyncrasy threshold.

Two implementation assumptions are not true in the current code:

1. `effectiveRiskUsdt` is not persisted in either `decisions` or `positions`, so the proposed
   `getIdiosyncraticEdgeReport` cannot compute the stated R-multiple from existing rows without a
   scope change.
2. Backtest does not call the same `computeIdiosyncrasyScore` function as live; it has a separate
   private formula in `BacktestEventBuilder`. D4 would change live scoring but leave backtest scoring
   untouched unless the plan explicitly fixes that parity gap.

Those are dispatch blockers because they contradict the plan's "read-only/no migration/no shared
change" and "same function in live/backtest" claims.

---

## Must-Fix Before Dispatch

### H1 — `effectiveRiskUsdt` is not queryable from persisted rows

D2 says the new report will join closed idiosyncratic `positions` to their open `decisions` row and
compute:

> R-multiple per trade = realized PnL / `effectiveRiskUsdt`

The current persistence surface does not contain that denominator.

Code facts:

- `IIntentSizing` has `riskPerTradeUsdt` and `effectiveRiskUsdt`, but it is engine-internal.
- `StrategyService.buildGateGeometry` persists only `qty`, `notional`, and `leverage` from
  `approvedSizing`.
- `DecisionEntity` has nullable `qty`, `notional`, `leverage`, but no risk fields.
- `PositionEntity` has `entry_price`, `qty`, `realized_pnl`, `stop_loss_price`, etc., but no
  `risk_per_trade_usdt` or `effective_risk_usdt`.
- `market_snapshot` is strict and does not include risk fields.

So this plan line is not implementable as stated:

> A closed position whose open decision lacks `effectiveRiskUsdt` (pre-M29 row) yields null R...

It is not only pre-M29 rows. Post-M29 rows also lack the field.

**Required amendment:** choose one explicit contract:

- Persist the two sizing audit fields on approval rows or positions. This likely means a schema
  migration, and possibly a shared schema change if placed inside `market_snapshot`. That breaks the
  current "no migration/no shared-package change" scope and must be reflected in M30.
- Or redefine the report denominator as a reconstructable actual risk, e.g.
  `abs(entry_price - approved_stop_loss) * qty`, using the open decision's clamped stop and the
  position quantity. That avoids persistence changes but is not `effectiveRiskUsdt`; ADR 0004 §8b and
  the tests must name it honestly and define null/exclusion semantics for missing stop/qty rows.

Do not dispatch D2 until the denominator source is real and tested.

### H2 — D4's live/backtest parity claim is false

The plan says:

> Backtest and live read identical scores because both call the same function on the same inputs.

Current code disagrees.

Live market data calls `apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts`, whose
formula is:

```ts
1 - abs(btc5mMovePct) / abs(coin5mMovePct)
```

with `coinMagnitude === 0 -> 0`.

Backtest event construction has a separate private helper in
`apps/engine/src/backtest/service/BacktestEventBuilder.ts`, whose formula is:

```ts
abs(symbol5mMovePct - btc5mMovePct) /
  (abs(symbol5mMovePct) + abs(btc5mMovePct) + 0.0001)
```

and it returns `0` when `btc5mMovePct === 0`.

That means D4's proposed noise floor would harden only the live market-data scorer unless the plan
also changes the backtest helper. It also means the D4 test "exact-zero BTC move with real coin move
still returns 1.0" is true for the live scorer but false for the current backtest helper.

**Required amendment:** either:

- unify backtest and live on the same exported scorer before adding the noise floor, then update both
  test suites; or
- explicitly declare that M30 changes only live scoring and open a separate blocker/ADR for the
  existing replay divergence.

The first option is strongly preferred because the project invariant is same strategy behavior in
live and backtest.

### H3 — D4 "inert for every real input" needs a real call-graph proof, not only tier fixtures

The 0.05% floor is probably conservative relative to tier trigger floors, but the plan's proof is too
strong:

> It only bites pathological inputs that could never have produced a trigger anyway.

`MarketDataService` computes the score while building indicator snapshots, and backtest has its own
event-builder path. The plan already asks the engine agent to grep for non-trigger call sites; that
should be promoted from a note inside the test list to an explicit implementation step with a written
result in the milestone outcome.

If any code path persists or analyzes sub-0.05% scores outside the final trigger eligibility path,
M30 is not purely inert. That may still be acceptable because it tightens, but it must be described as
a deliberate behavior change.

---

## High-Priority Corrections

### M1 — Make active-version threshold resolution an explicit analysis API input

D3 correctly rejects `WHERE status='active'` because v0 is the seed active row while the engine uses
`ACTIVE_STRATEGY_VERSION_ID=3`. But `packages/analysis` is a pure query package; it should not
silently depend on `AppConfigService`.

Recommended shape:

```ts
getIdiosyncrasyMissDistribution(ds, {
  fromDate,
  toDate,
  activeStrategyVersionId,
})
```

Then the query looks up `strategy_versions.params->>'idiosyncrasy_min_score'` for that exact row.
The MCP/CLI/operator layer can decide where `activeStrategyVersionId` comes from. This keeps the
analysis package deterministic and testable.

### M2 — Rename or qualify `slotCGateOpen`

The plan carefully states that `slotCGateOpen` means "enough sample to evaluate," not "positive edge."
The name still reads like permission to build slot C.

A safer name is `slotCEdgeSampleReady`, `meetsSlotCSampleFloor`, or
`slotCEvaluationReady`. If the plan keeps `slotCGateOpen`, repeat in the interface comments and ADR
that it is a sample-readiness flag only and must be read with `meanRMultiple`.

### M3 — Define standard-error behavior for `n < 2`

The test list mentions empty and single-trade ranges, but the report contract should explicitly say
what `rMultipleStdError` returns when variance is undefined. Recommended:

- `null` for `n < 2`
- decimal string/number for `n >= 2`

Returning `0` for a single trade would imply false certainty.

### M4 — D3 bucket boundary text has a small inconsistency

The plan says "using four equal-width buckets" and then lists five buckets. The next sentence corrects
it to five. Clean this up before dispatch so QA does not implement the wrong count.

---

## Strengths

### 1. Correct sequencing: measurement before slot C

The plan properly resists building the correlated leg immediately after M29. Since M29 only made the
first idiosyncratic fill possible and the soak has essentially no post-M29 sample yet, slot-C work
would be over-fit and non-attributable.

### 2. D3 is the right observability addition

`getFunnelSummary` can count `no_eligible_slot`, but not show how close rejected names were to the
real 0.5 threshold. A miss-distance histogram is exactly the right next query for deciding whether a
future threshold calibration is justified.

### 3. The stale 0.3 premise is correctly called out

The plan is right that production `idiosyncrasy_min_score` is 0.5 in the seed params, not 0.3. Any
future calibration must start from the real active-version parameter.

### 4. D4 direction is conservative

A minimum coin-move floor can only lower inflated scores. That preserves the survival-first direction
as long as the backtest parity issue is fixed and the floor's live call graph is documented.

### 5. No slot model or strategy-threshold edits

Keeping `SlotManager`, `resolveCorrelationMode`, VWAP stop behavior, depth floors, exposure caps, and
DB strategy params untouched is the right scope discipline for M30.

---

## Recommended Plan Amendments

1. Rewrite D2 around a real denominator source. Either persist `effectiveRiskUsdt` with a migration,
   or redefine the denominator as reconstructable actual risk from existing columns.
2. Add an implementation step to remove the duplicate backtest idiosyncrasy scorer or apply the D4
   floor to both live and backtest with explicit tests.
3. Change D3's function signature to accept `activeStrategyVersionId` and look up the threshold from
   that row.
4. Specify `rMultipleStdError = null` for `n < 2`.
5. Fix the "four/five bucket" wording and consider renaming `slotCGateOpen`.

---

## Conclusion

M30 is the right milestone conceptually: make the M29 soak readable, expose idiosyncrasy miss
distance, and keep slot C deferred until there is enough idiosyncratic evidence to judge.

The plan needs amendment before dispatch because its central report depends on an unpersisted
denominator, and its only runtime change would currently deepen an existing live/backtest
idiosyncrasy-scoring divergence. Fix those two contract issues first; then proceed with the normal
implementation, QA, reviewer, and scribe waves.
