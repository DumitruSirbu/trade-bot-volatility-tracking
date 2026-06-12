# Independent Review - M31 Zombie Positions and Broken Lifecycle

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M31-zombie-positions-and-broken-lifecycle.md`  
**Date:** 2026-06-11

## Verdict

**Do not dispatch as written. Approve the diagnosis and urgency, but amend the plan first.**

M31 is the right emergency milestone. The plan correctly identifies a survival-class defect:
`pending_open` rows can receive a protective close, have qty zeroed and a close transaction written,
then fail the illegal `pending_open -> closing` transition. That creates exactly the kind of phantom
risk state this project has zero tolerance for.

The direction is right: preserve ADR 0008's always-protected invariant, keep `pending_open -> closing`
illegal, repair the three corrupt paper rows after a dump, and harden live-risk reads against qty=0
residue.

I would not dispatch the current text because four implementation details are unsafe or internally
inconsistent:

1. Task 1 says to promote `pending_open -> open` before `transition(CLOSING)`, but the current close
   branch has already zeroed qty, disarmed, saved the row, and written the close transaction before
   that transition point. If implemented literally, the same half-committed zombie window remains.
2. Task 4 cannot make `risk_state.open_exposure` track within a run if it only listens on close.
   Happy-path opens still do not increment `risk_state.open_exposure`, so a later close decrement just
   clamps zero to zero.
3. Task 4 claims idempotency but offers "rely on the event firing exactly once" as an option. That is
   not idempotency, and duplicate close events would double-book realized PnL and trade count.
4. The plan uses `entry_notional` as live exposure in places where ADR 0014 and existing
   `RiskGateService.reconcileClose` use residual notional (`qty * entry_price`). `entry_notional` is
   immutable/cumulative after adds and partial reduces, so it is not generally the live exposure.

---

## Must-Fix Before Dispatch

### H1 - Task 1 promotes too late unless the mutation order is rewritten

The plan's chosen state-machine shape is correct: a reduce-family terminal on a `pending_open` row
should go through `pending_open -> open -> closing -> closed`, not add `pending_open -> closing`.
That matches ADR 0009 section 6.3.

The problem is the exact insertion point described in Task 1:

> before the existing `transition(..., CLOSING)` call, branch on the source state...

In current `ExecutionService.applyReduceFillToPosition`, the existing `transition(CLOSING)` call is
after all of these irreversible writes:

- `position.qty = 0`
- `localProtectiveMonitor.disarm(position.id)`
- `await this.positions.save(position)`
- `await this.transactions.recordTerminal(...)` for the close/reduce row

So if an engineer inserts `pending_open -> open` immediately before the current `transition(CLOSING)`,
a failure in the promote step still leaves a qty=0 non-terminal row plus a close transaction. Emitting
`ORDER_INTENT_UNKNOWN_EVENT` makes it louder, but it does not prevent the corrupt durable state.

**Required amendment:** Task 1 must explicitly move the `pending_open -> open` promote before qty is
zeroed, before monitor disarm, and before the close transaction is inserted. Alternatively, wrap the
entire close mutation in one DB transaction that can roll back qty, close tx, and state together.

The safer minimal ordering is:

1. Load position.
2. If source is `pending_open`, perform `transition(OPEN, eventClass='execution.reduce.fill.terminal.pending_promote')`.
3. Re-read or use the transitioned row as the source for close math.
4. Then zero qty/disarm/save, record close transaction, `OPEN -> CLOSING`, finalize `CLOSING -> CLOSED`.

Add an adversarial test that forces the promote transition to throw and asserts no close transaction
and no qty=0 save were committed before the failure.

### H2 - Close-only `risk_state` booking cannot satisfy the stated success criteria

The plan says M31 should make `risk_state` track live exposure/PnL/trade count within a run. Task 4
only books on `POSITION_CLOSED_EVENT`.

Current code does not increment `risk_state.open_exposure` on happy-path open. Exposure used by the
gate comes from durable open positions plus the in-memory reservation ledger; `risk_state.open_exposure`
is only rebuilt at boot by `EngineBootstrapService.phase4aRebuildOpenExposure`.

That means after the M31 repair sets today's `risk_state.open_exposure = 0`, the next paper open will
still leave `risk_state.open_exposure = 0` during the run. When it closes, the proposed close listener
subtracts notional from zero and clamps to zero. The dashboard/risk_state row never shows the open
exposure while the position is live, and the plan's first-fill watch cannot pass as written.

**Required amendment:** choose one coherent accounting model:

- Preferred: add a small risk-side lifecycle synchronizer that recomputes today's `open_exposure` from
  current live-risk positions after open/add/reduce/close lifecycle events, and recomputes
  `realized_pnl_day`/`trades_count` from closed positions for the UTC day. This is naturally
  idempotent and avoids per-event arithmetic drift.
- Or, if incremental accounting is kept, explicitly book exposure increases on open/add and decreases
  on reduce/close, with tests for open, add, partial reduce, full close, duplicate event, and restart.

Do not state that close-only booking makes `risk_state.open_exposure` correct within a run.

### H3 - Task 4's idempotency contract is not real

Task 4 says:

> Idempotency: key the booking on the positionId so a duplicate event cannot double-book - e.g., guard
> with a "already-booked" check or rely on the event firing exactly once...

There is no durable per-position risk-state booking key in the current schema, and relying on an event
firing exactly once is the opposite of an idempotency guarantee. A duplicate `POSITION_CLOSED_EVENT`
would add realized PnL again and increment `trades_count` again.

**Required amendment:** remove "rely on exactly once" as an allowed implementation. Either:

- recompute the whole UTC-day risk row from durable `positions` after each lifecycle event, or
- introduce a real durable idempotency marker.

Because the plan is explicitly no-migration, recomputation from durable rows is the cleaner fit.

### H4 - `entry_notional` is not generally the live exposure to release or rebuild

The plan repeatedly uses `entry_notional` as the exposure amount:

- Task 4 decrements `open_exposure` by the position's `entry_notional`.
- Task 6 preserves the existing boot rebuild shape of summing `entry_notional`, plus a qty=0 guard.

That is not the live residual exposure contract. ADR 0014 section 4a says boot exposure rebuild should
use:

```text
open_exposure := SUM(positions.qty * positions.entry_price)
```

and explicitly explains that `entry_notional` overstates exposure after partial reduces. Current
`RiskGateService.reconcileClose` also uses `position.qty * position.entryPrice`, not
`entry_notional`, when releasing exposure on reconciliation close.

For a simple never-reduced full close, `entry_notional` may happen to match. For a position with ADDs
and partial REDUCEs, it does not. M31 should not encode a new accounting bug while fixing the zombie
bug.

**Required amendment:**

- Task 6 should change boot rebuild to sum `qty * entryPrice` for qty-positive, non-closed,
  non-`manual_adopted_unmanaged` rows.
- Task 4 should release residual exposure, not immutable entry notional. If using an event payload,
  carry a field named for the actual concept, e.g. `exposureReleasedNotional`, captured before qty is
  zeroed. If recomputing the risk row from positions, no event notional is needed.

### H5 - Task 2 conflicts with ADR 0008 unless ADR 0008 is amended

Task 2 moves `recordEntryTransaction` before `localProtectiveMonitor.arm` and says this preserves ADR
0008 because arm still precedes exchange-side attach.

ADR 0008 is stricter than that. Section 2 locks:

```text
positions row inserted -> LocalProtectiveMonitor.arm(...) [SYNCHRONOUS] -> protectiveAttacher.attach(...)
```

and section 4 says the local monitor is armed at the same instant `positions` is written, not after
another awaited DB write. Current source comments in `ExecutionService` also say arm happens before
"any awaited I/O - including the transaction-record insert."

Moving an awaited transaction insert between the position row insert and monitor arm widens the
unprotected crash window. The fact that the insert is local DB I/O does not make it free from crash or
latency.

**Required amendment:** either:

- keep arm immediately after position creation and solve the missing-open-transaction issue another
  way, or
- explicitly amend ADR 0008 and get architect sign-off that one awaited local audit write may precede
  arm.

Given the survival invariant, I recommend not moving the audit insert before arm until the Defect 2 log
investigation proves the missing open rows are caused by this ordering.

---

## High-Priority Plan Corrections

### M1 - Defect 2 should remain investigation-first

The plan correctly says the missing open transaction mechanism is not provable from static source.
Task 2 then still prescribes a risky ordering change.

Keep the log investigation as the first Wave A step and make the code change conditional on evidence.
If the open-tx insert did not run, fix the actual exception/order path. If it did run but no row exists,
the repository/idempotency path needs inspection. If logs are missing, add fail-loud audit telemetry
without changing the arm-before-audit ordering.

### M2 - Task 4 contradicts the milestone-scope paragraph

Task 4 chooses:

> Add `readonly entryNotional: MoneyValue` to `IPositionClosedEvent`

But the milestone-scope section later says:

> The `IPositionClosedEvent` payload change ... is avoidable by reading the position row back; default
> to the no-shared-change path...

Those cannot both be the dispatch instruction. Pick one. If the plan adopts risk-row recomputation,
the event field is unnecessary. If it keeps incremental booking, rename the field to the actual
released exposure concept and make it required at every emit site.

### M3 - `findOpenBySymbolAndSlot` also needs qty semantics, not only `findOpen`

Task 5 narrows `PositionRepository.findOpen()` to `qty > 0`. The reduce path loads its target through
`findOpenBySymbolAndSlot`, which currently also means `state != closed` only.

For normal close handling, this may still be acceptable because a just-loaded position is expected to
have qty > 0 before applying the fill. For zombie avoidance and duplicate close protection, the plan
should explicitly review all "open" repository methods:

- `findOpen`
- `findOpenBySymbol`
- `findOpenBySymbolAndSlot`

If `findOpenBySymbolAndSlot` remains non-closed-only for reconciliation or late-fill handling, name
that deliberately and add a guard in the reduce path for `position.qty <= 0` that escalates to
reconciliation instead of writing another close row.

### M4 - Data repair should use UTC day predicates

The repair SQL uses `closed_at::date = CURRENT_DATE`. For a `timestamptz`, that cast depends on the
database session timezone. The engine and risk-state keys are UTC-day based.

Use an explicit UTC day range for the risk-state rebuild, or define that the operator must set the DB
session timezone to UTC before running the repair. This is not the main risk, but this repair is
manual and one-time; it should be exact.

### M5 - The manual repair should verify row counts on every UPDATE

The repair transaction says to repeat the `UPDATE positions ... WHERE positions_id = :id AND state =
'pending_open' AND qty = 0` for each row. Add a requirement that each position UPDATE affects exactly
one row and the `risk_state` UPDATE affects exactly one row. If any count is zero or greater than one,
rollback.

---

## Strengths

### 1. The root-cause diagnosis is code-accurate

The state graph forbids `pending_open -> closing`, while the close branch currently tries to transition
to `closing` after already mutating qty and writing the close transaction. That matches the observed
zombie shape.

### 2. The chosen state-machine shape preserves the right invariants

Keeping `pending_open -> closing` illegal and using `pending_open -> open -> closing` is the right
contract. It preserves ADR 0009's graph and ADR 0008's always-protected intent better than adding a
broad direct edge.

### 3. The plan correctly rejects fabricated historical open transactions

Not back-filling the missing open rows is the right audit decision. A known one-legged ledger is ugly
but honest; a synthetic entry leg without trustworthy exchange/client order identity would be worse.

### 4. The qty=0 live-risk read hardening is necessary

`findOpen()` returning every non-closed row is too permissive for live-risk surfaces. Adding qty-positive
semantics, or splitting `findLiveRisk()` from `findNonTerminal()`, is the right direction.

### 5. The deploy sequence respects the repository's DB safety rules

The plan correctly requires `pg_dump`, engine stop before repair, no volume-destructive commands, and a
10-minute smoke after restart.

---

## Recommended Plan Amendments

1. Rewrite Task 1 to promote `pending_open -> open` before qty zeroing, monitor disarm, and close-tx
   insert, or require one DB transaction for the terminal close mutation.
2. Replace close-only `risk_state` booking with an idempotent lifecycle sync. Prefer recomputing the
   UTC-day risk row from durable positions on lifecycle events.
3. Remove "rely on event firing exactly once" from Task 4. It is not an idempotency strategy.
4. Use residual notional (`qty * entryPrice`) for exposure rebuild/release, not `entry_notional`, except
   where explicitly analyzing gross historical entry notional.
5. Do not move `recordEntryTransaction` before monitor arm without an ADR 0008 amendment and architect
   sign-off. Make Defect 2 investigation-first.
6. Clarify whether `IPositionClosedEvent` is widened or avoided; the current plan says both.
7. Expand repository/query hardening beyond `findOpen()` to all live-risk "open" readers, especially
   `findOpenBySymbolAndSlot`.
8. Tighten the manual repair SQL with UTC-day predicates and exact row-count assertions.

## Conclusion

M31 should happen before any further soak interpretation or strategy work. The plan is directionally
sound and already catches the most important architectural constraint: do not weaken protection to make
the state graph easier.

But dispatching it as written risks replacing one zombie bug with a quieter accounting bug. The two
highest-risk changes are the close-path mutation ordering and the non-idempotent `risk_state` close
listener. Fix those in the plan first, then dispatch the engine waves with adversarial tests around
crash windows, duplicate close events, partial reduce residual exposure, and ADR 0008 arm ordering.
