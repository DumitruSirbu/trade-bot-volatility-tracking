# Review: M31 — Zombie positions & broken position-lifecycle

**Reviewer:** Gemini 3.1 Pro
**Date:** 2026-06-11
**Target Plan:** `docs/plans/M31-zombie-positions-and-broken-lifecycle.md`

## Overall Assessment

The M31 plan is exceptionally well-researched, thorough, and accurately diagnoses the root causes of the zombie positions and broken lifecycle. The proposed fixes are minimal, targeted, and strictly adhere to the existing architecture and ADRs (specifically ADR 0008 and 0009). The division into two waves is logical and minimizes risk.

The plan is approved for dispatch, subject to consideration of the edge cases and recommendations detailed below.

## Strengths

1. **State-Machine Fix (Task 1):** The decision to route the protective close through `pending_open -> open -> closing` (Option A') is the correct architectural choice. It avoids introducing forbidden edges (ADR 0009 §3) and perfectly mirrors the existing kill-switch flatten logic (ADR 0009 §6.3).
2. **Exposure Decrement Logic (Task 4):** The identification of the `qty * price` bug (where reading `qty` after the zero-save would result in a 0 decrement) is an excellent catch. Using the `entryNotional` from the event payload is the correct and robust solution.
3. **Boot Hardening (Task 6):** Excluding `qty <= 0` rows from the boot exposure rebuild and monitor re-arm provides excellent defense-in-depth against any future state-machine leaks.
4. **Data Repair Strategy:** Repairing the data via targeted SQL rather than a schema migration is appropriate for this specific, isolated incident.

## Areas for Improvement & Edge Cases to Consider

### 1. Task 4: Partial Reduces and Exposure Decrement
The plan specifies decrementing `risk_state.open_exposure` on `POSITION_CLOSED_EVENT`. However, it does not explicitly address **partial reduces**. 
* **Issue:** If a position is partially closed, does `open_exposure` get decremented? If `POSITION_CLOSED_EVENT` only fires on a terminal close (when `qty` reaches 0), partial reduces will leave `open_exposure` overstated until the final close.
* **Recommendation:** Clarify if partial reduces occur in the system and if they need to update `risk_state.open_exposure`. If they do, ensure there is a mechanism (e.g., a `POSITION_REDUCED_EVENT`) to decrement the exposure by the partially closed notional amount. If the system only executes full closes, state this explicitly as the rationale for only hooking `POSITION_CLOSED_EVENT`.

### 2. Data Repair SQL: `realized_pnl` Calculation
In the Data Repair SQL section, query (4) calculates `realized_pnl` as follows:
```sql
SUM(CASE WHEN t.type IN ('reduce','close') THEN t.cashflow ELSE 0 END)
  - SUM(CASE WHEN t.type <> 'funding' THEN t.fee ELSE 0 END)
  + SUM(CASE WHEN t.type = 'funding' THEN t.cashflow ELSE 0 END)
```
* **Issue:** Because the `open` transactions are missing for these 3 positions, you must be absolutely certain about the definition of `t.cashflow` for `close`/`reduce` transactions. If `cashflow` represents the **gross notional value** of the trade (e.g., `qty * price`), summing it without subtracting the corresponding `open` transaction's cashflow will result in a massively inflated `realized_pnl` (essentially the entire position size, not the profit/loss).
* **Recommendation:** Verify that `t.cashflow` on a close transaction natively represents the exchange-calculated realized PnL. If it represents gross cashflow, you will need to manually calculate the PnL using the entry price (from the position row) and the exit price, rather than summing the transaction cashflows.

### 3. Task 5: `findOpen()` vs. Reconciliation
The plan notes: *"If any caller legitimately needs all non-closed rows (e.g. reconciliation), add a separate `findNonTerminal()` method and point only that caller at it — do not overload `findOpen`."*
* **Issue:** Reconciliation is the exact mechanism designed to catch and clean up anomalies like zombies. If reconciliation uses `findOpen()` after this change, it will become blind to zombies (`qty = 0` but `state != closed`), defeating its purpose.
* **Recommendation:** Do not leave this as an "if". Proactively implement `findNonTerminal()` (or `findUnreconciled()`) in Task 5 and explicitly audit the reconciliation service to use it. Guarantee that the reconciliation loop will still detect rows where `state != closed`.

### 4. Task 2: Entry Transaction Failure Handling
* **Issue:** Moving `recordEntryTransaction` before `localProtectiveMonitor.arm` is correct for ensuring the audit log exists. However, if `recordEntryTransaction` throws a non-duplicate error, the plan specifies emitting `ORDER_AUDIT_PERSIST_FAILED_EVENT`. At this point, the exchange order has already been filled (since this is post-fill), but the local DB has failed to record the transaction and the monitor will not be armed.
* **Recommendation:** Ensure that `ORDER_AUDIT_PERSIST_FAILED_EVENT` routes to a critical alert channel and triggers an immediate reconciliation cycle. The system now has a live, unprotected exchange position that the local engine failed to persist properly.

## Conclusion
The plan is highly rigorous and ready for implementation. Addressing the `realized_pnl` calculation in the repair SQL and proactively implementing `findNonTerminal()` for the reconciliation loop will ensure the fix is completely bulletproof.