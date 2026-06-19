# M38 implementation brief (D1 + D2) — engine agent

Authoritative design: ADR 0045. Milestone brief: `M38-exit-geometry-repair-and-fill-drift-gate.md`.
D3 (V3 promotion) is GATED and out of this brief. Decimal-only math (`Money`), no float, ≤5
files/dispatch.

## 1. Files to touch, in order

1. `apps/engine/src/strategy/interface/IProposedExit.ts` — add the two fields (contract).
2. `apps/engine/src/strategy/strategies/momentumCore.ts` — set `tpRebaseEligible: true`, compute
   and set `atrDistance` (the same `atrTarget` already at `:42`).
3. `apps/engine/src/strategy/strategies/meanReversionCore.ts` — set `tpRebaseEligible: false`,
   `atrDistance: null` on the returned exit (`buildMeanReversionExit`, ~`:142`). **Do not touch any
   other reversion behaviour.**
4. New pure helpers util (e.g. `apps/engine/src/execution/utils/exitGeometryHelper.ts` + barrel) —
   `rebaseMomentumTakeProfit`, `evaluateFillDrift`.
5. New `PositionCloseCoordinatorService` in the execution module (synthetic-close extraction).
6. `apps/engine/src/execution/service/ExecutionService.ts` — D1 rebase seam + D2 gate/unwind.
7. `apps/engine/src/backtest/service/BacktestOrchestrator.ts` — D1 rebase at `buildPosition`.
8. Engine-local: `FILL_ACCEPTANCE_REJECTED` metric label + `MAX_SIGNAL_DRIFT_PCT` const
   (execution/risk `const/`). Any drift sub-reason enum stays engine-local.

## 2. New `IProposedExit` fields (engine-local, NOT packages/shared)

```ts
readonly tpRebaseEligible: boolean;       // momentum=true, meanReversion=false
readonly atrDistance: MoneyValue | null;  // post-clamp distance; null when not rebase-eligible
```
Flows automatically onto `IOrderIntentApprovedEvent.clampedExit` and `BacktestOrchestrator`'s
`decision.clampedExit` (both typed `IProposedExit`). The `buildCloseIntent` synthetic exits in
`LocalProtectiveMonitor` / `ReconciliationService` must set `tpRebaseEligible: false, atrDistance: null`.

## 3. Helpers (pure — no I/O, no clock, decimal-only)

```ts
rebaseMomentumTakeProfit(clampedExit: IProposedExit, avgFillPrice: MoneyValue, side: PositionSideEnum): MoneyValue
// returns avgFillPrice +/- clampedExit.atrDistance (+ LONG, - SHORT). Caller guarantees eligibility.

evaluateFillDrift(clampedExit: IProposedExit, avgFillPrice: MoneyValue, side: PositionSideEnum,
                  entrySnapshot?: IMarketSnapshot, maxDriftPct?: number)
  : { shouldReject: boolean; reason?: string; driftPct?: number }
// wrong-side-of-SL leg always runs (keyed on clampedExit.stopLossPrice). magnitude leg runs only
// when entrySnapshot && maxDriftPct present. referencePrice op-order EXACTLY entryHelpers.ts:44-46.
```
No boolean flag arguments. Both helpers consumed by live + (rebase only) backtest.

## 4. D1 seam lines

- **ExecutionService.ts:** in `openOrAddPositionAndAttachProtection`, OPEN path only. Compute the
  rebased TP **once** before `createPositionFromFill` (so the persisted `take_profit_price` at
  `:1137`, the `arm` at `:928`, and the `attach` at `:952` all use the SAME value). Guard:
  `if (clampedExit.tpRebaseEligible && clampedExit.atrDistance !== null) { tp = rebaseMomentumTakeProfit(...) } else { tp = clampedExit.takeProfitPrice }`.
  Thread the resolved TP into `createPositionFromFill` (param), `arm`, and `attach`. SL unchanged.
  Mean-reversion / null `atrDistance` → no rebase (fallback to frozen, rely on `tpEligible`).
- **BacktestOrchestrator.ts:367-388 (`buildPosition`):**
  `if (clampedExit.tpRebaseEligible && clampedExit.atrDistance) { takeProfitUsdt = rebaseMomentumTakeProfit(clampedExit, new Money(fill.priceUsdt), side).toFixed(18) }`
  else keep `decision.clampedExit.takeProfitPrice.toFixed(18)`. **No D2 in backtest.**

## 5. D2 placement, reject, FLATTEN unwind (live-only)

- **Placement:** OPEN path, after `createPositionFromFill` returns (~`:905-906`), BEFORE arm `:922`.
  Confirmed full fill only (partial/`RECONCILE_REQUIRED` → existing reconcile path, not D2).
- **Evaluate:** `evaluateFillDrift(clampedExit, avgFillPrice, side, entrySnapshot, MAX_SIGNAL_DRIFT_PCT)`.
  Log `driftPct` on every evaluation (pass or reject).
- **On reject:** skip the arm. Route the PENDING_OPEN row through `PositionCloseCoordinatorService`:
  acquire close slot → build `FLATTEN` `IOrderIntent` → `riskGate.evaluate` (auto-approved de-risk)
  → emit `ORDER_INTENT_APPROVED_EVENT` → reduce-family finalize → CLOSED row `FORCE_CLOSE`. Handle
  gate-reject / throw slot-leak exactly as the two existing copies. Emit the
  `FILL_ACCEPTANCE_REJECTED` counter. **Do NOT mutate the `decisions` row.**
- **Result:** decisions row unchanged + one CLOSED positions row (`FORCE_CLOSE`) + one counted
  metric; DB and exchange agree (no phantom).

## 6. Do NOT touch

- `packages/shared` — except confirm `FLATTEN` / `FORCE_CLOSE` exist (they do). Do **not** add
  `SIGNAL_STALE` to `SkipReasonEnum`. `tpRebaseEligible`/`atrDistance`/`MAX_SIGNAL_DRIFT_PCT`/
  `FILL_ACCEPTANCE_REJECTED` are all engine-local.
- The mean-reversion exit path (D1 is momentum-only; reversion TP is VWAP-anchored — rebasing
  corrupts it). Only add the two contract fields set to `false`/`null`.
- The ADD/reduce path (arm is OPEN-only; ADR 0007 §3 forbids re-anchor on ADD).
- The SL — never rebased (one-R structural budget; wrong-side SL handled by D2 reject).
- The synchronous arm ordering for surviving positions (ADR 0008 §2).
- `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER` / `time_stop_minutes` — no tuning this milestone.
- Ship `MAX_SIGNAL_DRIFT_PCT` magnitude cap OFF by default (or a wide ~8% un-calibrated fat-finger
  guard); the operative reject is the wrong-side-of-own-SL check.
