# Independent Review - M33 Live Exit Enforcement

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/M33-live-exit-enforcement.md`  
**Date:** 2026-06-12

## Verdict

**Do not dispatch as written. Approve the diagnosis and the milestone direction, but amend the plan first.**

M33 targets the right survival-class gap. The plan correctly identifies that live/paper positions can open with `time_stop_at`, can disarm the local SL/TP monitor under paper `exchange_side`, and can fail open-fill audit persistence because `cashflow` is omitted. The chosen high-level fixes are also directionally right:

- route live time-stop closes through `RiskGateService`;
- keep local SL/TP enforcement alive in paper;
- explicitly write entry `cashflow = 0`;
- persist SL/TP prices for restart re-arm;
- introduce one close-in-flight coordinator instead of per-producer flags.

The plan is not yet safe to dispatch because four details undercut the stated guarantees: time-stop priority is not actually deterministic, coordinator release semantics can either double-close or permanently suppress retries, SL/TP persistence still leaves a pre-attach crash window, and the "all close producers" registry contract is not mapped to the actual current emit sites/module graph.

---

## Must-Fix Before Dispatch

### H1 - `prependListener` does not guarantee time-stop wins once the enforcer awaits the database

The plan's collision rule is correct: time-stop must win over SL/TP on the same tick because `BacktestRunnerService.checkPositionExit` checks time-stop first and returns before intrabar SL/TP simulation.

The proposed implementation does not reliably enforce that ordering.

Task 4 says the enforcer will run with `@OnEvent(PRICE_UPDATE_EVENT, { prependListener: true })`, then:

1. `await positions.findLiveRisk()`;
2. filter for the event symbol;
3. for each due row, call `enforceTimeStop`;
4. acquire the `SharedCloseCoordinator` slot inside `enforceTimeStop`.

That means the enforcer yields before acquiring the slot. The existing monitor listener is also invoked from the same `price.update` emission, and its breach path can run while the enforcer is waiting on `findLiveRisk()`. If the monitor acquires the shared slot before the enforcer resumes, SL/TP wins the collision despite the `prependListener`.

`prependListener` can order listener invocation; it cannot serialize async listener completion or protect work after the first `await`.

**Required amendment:** choose an arbitration shape where time-stop priority is decided before any competing SL/TP producer can acquire the slot. Viable options:

- Preferred: one close-arbitration service owns the `price.update` path for both time-stop and SL/TP, evaluates due time-stop first, then SL/TP, then emits one close.
- Or: maintain an in-memory deadline index so the enforcer can synchronously acquire the coordinator slot before the first `await`.
- Or: make `LocalProtectiveMonitor.handleBreach` synchronously ask a shared arbiter whether the position is time-stop due for this event timestamp before it tries to acquire the slot.

D-TS-5-adv should explicitly delay `findLiveRisk()` and prove SL/TP still cannot win while the enforcer is awaiting. Without that adversarial delay, the test can pass while the live race remains.

### H2 - Coordinator release semantics are unsafe and incomplete

The plan says `LocalProtectiveMonitor.onPositionStateTransitioned` / `disarm` / `onOrderIntentExpired` release the shared registry slot, and the enforcer releases on gate reject, halted expiry, or `CLOSED`.

That is not a safe lifecycle for a process-wide "close intent in flight" registry.

First, releasing on generic `LocalProtectiveMonitor.disarm(positionId)` is too early. In current `ExecutionService.applyReduceFillToPosition`, a closing fill calls `localProtectiveMonitor.disarm(position.id)` immediately after setting in-memory qty to zero and before awaited durable writes/finalization. If `disarm()` releases the shared coordinator there, a subsequent tick can acquire the slot and emit another close before the row reaches durable `CLOSED`.

Second, the plan only handles `ORDER_INTENT_EXPIRED_EVENT` with `reason='halted'`. Current execution has other non-closed terminal paths for reduce-family intents:

- clean fill closes and eventually emits `POSITION_STATE_TRANSITIONED_EVENT -> CLOSED`;
- non-clean reduce terminal emits `ORDER_INTENT_UNKNOWN_EVENT`;
- dry-run emits `ORDER_INTENT_EXPIRED_EVENT` with `reason='dry_run'`;
- aborted/rejected paths can emit failure events in no-fill handling.

If a time-stop/SL/TP close reaches a non-clean terminal and no `CLOSED` event follows, a held coordinator slot can suppress all future close attempts forever. If the plan releases too broadly, it can double-submit while reconciliation still owns the row. The contract needs to distinguish "no order exists, retry may happen" from "an order may still be resolving, do not re-emit."

**Required amendment:**

- Do not release the shared close slot from generic `disarm()`. Disarm should remove SL/TP arm state only.
- Define a coordinator state/release table for `CLOSED`, gate reject, halted expiry, dry-run expiry, unknown/reconciling, failed/rejected, missing-position, and promote-failed.
- Add listeners/tests for the non-clean reduce-family paths using the producer's eventId prefix.
- Add an adversarial test where a close fill disarms the monitor but durable finalization is paused; a second tick must not emit a second close before `CLOSED`.

### H3 - Persisting SL/TP only at attach time leaves the pre-attach crash window unprotected after restart

Task 5 persists `stop_loss_price` and `take_profit_price` "at protective-attach time" in or around `applyProtectiveAttachResult`.

That fixes paper `exchange_side` restart re-arm after attach success, but it does not cover the earlier crash window:

1. `createPositionFromFill` inserts a `PENDING_OPEN` row with `timeStopAt`, but does not persist `stopLossPrice` / `takeProfitPrice`.
2. The local monitor is armed in memory before attach.
3. If the process crashes after the position row is inserted/armed but before `applyProtectiveAttachResult` persists SL/TP, boot loses the in-memory arm and has no persisted SL/TP prices to re-arm from.

The plan's Goal says every position that opens in live or paper must be guaranteed to close through declared exits without manual intervention. That guarantee is not true if the declared SL/TP prices are only persisted after protective attach returns.

**Required amendment:** persist the clamped SL/TP prices on the initial position row, preferably in `createPositionFromFill` / `PositionRepository.createOpen`, alongside `timeStopAt`. Then phase 4c can re-arm eligible `PENDING_OPEN`, paper `exchange_side`, and `LOCAL_FALLBACK` rows from the same durable exit fields.

If the milestone intentionally accepts the pre-attach crash window, state it as a go-live blocker or explicit deferred risk. Do not let the plan claim a complete close guarantee while that window remains.

### H4 - "All close producers" is still too vague for a binding safety invariant

The plan correctly says every close producer must consult the shared coordinator. But the implementation task leaves the FLATTEN/kill-switch emit site to be "identified during implementation."

Current code already has at least one concrete gate-routed flatten-like close producer outside `execution/service`: `ReconciliationService.flattenAdoptedForeignPosition` emits `ORDER_INTENT_APPROVED_EVENT` for a close. The control-plane kill switch currently wires `FLATTEN_COORDINATOR` to `LoggingFlattenCoordinator` in `ControlModule`, not a real gate-routed flatten producer.

This matters because `SharedCloseCoordinator` is proposed in `ExecutionModule`, while the known flatten emitter is in `PositionModule` and the kill-switch port is in `ControlModule`. The plan needs the exact module/export/injection shape before dispatch, or the engineer may either duplicate state or introduce a new module cycle.

**Required amendment:**

- Enumerate every current `ORDER_INTENT_APPROVED_EVENT` close/reduce/flatten producer that must acquire the coordinator.
- Name which ones are in scope for M33: `LocalProtectiveMonitor`, `PositionTimeStopEnforcer`, `ReconciliationService.flattenAdoptedForeignPosition`, and any real kill-switch flatten implementation if present.
- Specify how `SharedCloseCoordinator` is exported/imported without duplicating the provider or worsening the `ExecutionModule` / `PositionModule` cycle.
- Add one test per producer pair that can target the same position, not only generic FLATTEN wording.

---

## High-Priority Corrections

### M1 - The due-row state filter should be repository-level, not only service-level

The plan says the enforcer will call `findLiveRisk()` and then filter to `OPEN` / `PENDING_OPEN` in the enforcer.

That is acceptable at the 3-slot cap, but this is a safety predicate, not just a convenience filter. A future call site can accidentally reuse `findLiveRisk()` and include `CLOSING` rows because that repository method is defined as `state != CLOSED AND qty > 0`.

Add a specific repository method such as `findTimeStopCandidatesBySymbol(symbol)` or `findClosableLiveRiskBySymbol(symbol)` that encodes:

- `symbol = :symbol`;
- `qty > 0`;
- `state IN (OPEN, PENDING_OPEN)`;
- `time_stop_at IS NOT NULL`.

This also avoids a full live-risk table read on every price tick without implementing the deferred in-memory deadline index.

### M2 - D-TS-14 should cover restart while an exchange close is already in flight

D-TS-14 covers "registry empty after restart, past-deadline row receives first tick -> exactly one close."

Also test the harder case: the process restarts after submitting a close but before the row is durable `CLOSING` / `CLOSED`. The registry will be empty. The only remaining protection is deterministic eventId/clientOrderId and exchange/order reconciliation. The plan asserts that durable state plus executor idempotency backs the registry after restart, so the test should simulate that exact path.

### M3 - The plan should explicitly preserve decimal-only money handling in the new helper

The proposed `buildDeRiskCloseIntent` helper will compute close `qty`, `notional`, and mark/exit values. Add a short constraint that all monetary math in the helper uses `Money` / `MoneyValue` only, never JS `number`. This is a standing convention, but this milestone is accounting-sensitive enough to state it in the task.

---

## What Looks Good

- The one-line entry `cashflow: new Money(0)` fix is correct and should stay tightly scoped.
- Keeping the local monitor armed in paper after `exchange_side` attach is the least invasive way to close the paper SL/TP vacuum.
- Pulling SL/TP persistence and boot re-arm into scope is the right call; deferring it would leave paper restart behavior unsafe.
- The plan correctly rejects direct exchange calls from the time-stop enforcer and keeps de-risking routed through `RiskGateService`.
- The test list is strong in breadth; it just needs the race/failure cases above to prove the actual invariants.

## Bottom Line

M33 should proceed after amendments. The core fix is necessary, but the current plan's close-dedup substrate is not yet specified tightly enough for state-machine code. Resolve the arbitration-before-await issue, define coordinator release semantics across all executor outcomes, persist exits at position insert time, and map every close producer to one shared provider before dispatching the engine wave.
