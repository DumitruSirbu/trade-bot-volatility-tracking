# Review of M33 — Live exit enforcement

## 1. Overall Assessment
The M33 plan provides a highly detailed, well-reasoned, and structurally sound approach to fixing the live exit enforcement gaps. The decomposition into three distinct sub-problems (time-stop enforcement, paper mode SL/TP simulation, and entry cashflow) is logical, and the proposed solutions adhere strictly to the system's existing architectural constraints (e.g., routing through `RiskGateService`, avoiding schema migrations, and maintaining event-time determinism). 

The introduction of the `SharedCloseCoordinator` is a particularly strong architectural decision that elegantly solves the cross-producer collision problem (time-stop vs. SL/TP vs. FLATTEN) without introducing complex distributed locking.

However, there are a few critical risks—primarily around database performance and lock lifecycle management—that should be carefully monitored or addressed during implementation.

## 2. Strengths
* **Symmetric Deduplication:** Moving from an asymmetric `isBreachInFlight` check to the `SharedCloseCoordinator` registry is a robust way to prevent double-closes across all producers.
* **Strict Adherence to Backtest Parity:** Ensuring that the time-stop decision is based on the `price.update` event timestamp (rather than `Date.now()`) and enforcing the "time-stop WINS" collision ordering guarantees that the live/paper decision logic perfectly mirrors the backtest reference.
* **Minimal Scope Creep:** The plan correctly identifies that the entry cashflow fix is a one-line change and explicitly forbids scope creep (e.g., reordering the arm/attach/record sequence).
* **Safe State Transitions:** Reusing the M31 `PENDING_OPEN → OPEN` promotion logic before closing ensures that positions don't end up in zombie states.

## 3. Risks & Concerns

### 3.1. Database Hammering via `findLiveRisk()` on Every Tick
**Risk:** The `PositionTimeStopEnforcer` is designed to call `PositionRepository.findLiveRisk()` on every `PRICE_UPDATE_EVENT`. In a live crypto trading environment, price updates can occur dozens or hundreds of times per second. Even though the maximum number of open positions is capped at 3, executing a database `SELECT` query on every single tick will generate massive, unnecessary database load and could block the Node.js event loop.
**Mitigation:** While the plan defers a full "In-memory deadline index" to tech debt (MEDIUM L1), a lightweight mitigation should be considered for this milestone. For example, the enforcer could maintain a simple in-memory variable `earliestKnownTimeStopMs`. On `price.update`, it only calls `findLiveRisk()` if `event.timestampMs >= earliestKnownTimeStopMs`. This would reduce DB queries from hundreds-per-second to almost zero, without requiring a complex index.

### 3.2. Lock Leaks in `SharedCloseCoordinator`
**Risk:** The plan states that the `SharedCloseCoordinator` slot is released on gate reject/abort, on `POSITION_STATE_TRANSITIONED_EVENT` to `CLOSED`, and on `ORDER_INTENT_EXPIRED_EVENT` (halted). However, if an order intent is approved by the gate but fails to execute downstream (e.g., exchange API timeout, network error, or insufficient margin), the position might revert to `OPEN` or get stuck in `CLOSING` without ever reaching `CLOSED`. If this happens, the lock in `SharedCloseCoordinator` will be held indefinitely, preventing any future SL/TP or time-stop from firing for that position.
**Mitigation:** Ensure that the registry listens to all terminal order intent events, including `ORDER_INTENT_REJECTED_EVENT` and `ORDER_EXECUTION_FAILED_EVENT` (or their equivalents in the codebase), to release the lock if the close fails to finalize.

### 3.3. Event Listener Ordering (`prependListener: true`)
**Risk:** Relying on `@OnEvent(PRICE_UPDATE_EVENT, { prependListener: true })` to guarantee that the time-stop enforcer runs before the `LocalProtectiveMonitor` is clever but slightly fragile. If another module later uses `prependListener: true` for the same event, the ordering becomes non-deterministic again.
**Mitigation:** The plan already mandates an adversarial test (`D-TS-5-adv`) to pin this behavior, which is good. Just ensure this test is robust enough to catch any future regressions in listener ordering.

### 3.4. Paper Mode Restart Re-arm
**Risk:** Task 5 persists `stop_loss_price` and `take_profit_price` on the position row at attach time, and widens boot phase 4c to re-arm paper `exchange_side` rows. If a position is partially reduced in paper mode, the SL/TP prices usually remain the same, but the quantity changes. The re-arm logic must ensure it picks up the correct remaining quantity, not the original open quantity.
**Mitigation:** Verify that `EngineBootstrapService.phase4cRearmLocalMonitor` correctly reads the current `qty` from the database row when re-arming, rather than assuming the full initial size.

## 4. Recommendations for Implementation

1. **Add a Fast-Path DB Bypass:** Even if a full in-memory index is deferred, implement a basic `if (event.timestampMs < nextSweepAllowedMs) return;` or track the `earliestDeadline` in memory to prevent querying the database on every single price tick.
2. **Audit Lock Release Paths:** During Task 3, audit all possible failure paths for a CLOSE intent after it has been approved by the `RiskGateService`. Ensure `SharedCloseCoordinator.release()` is called on every failure branch (exchange rejections, execution errors).
3. **Verify SL/TP Columns:** As noted in the plan, double-check that `positions.stop_loss_price` and `take_profit_price` actually exist in the schema before starting Task 5. If they don't, escalate immediately as it breaks the "no migration" constraint.
4. **Strictly Scope the Cashflow Fix:** Keep Task 1 to exactly the one line specified. Do not attempt to refactor `recordEntryTransaction`.