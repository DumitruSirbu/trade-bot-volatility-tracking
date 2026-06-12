# First Three Paper Fills — What Is Incorrect (Soak 2026-06-11)

**Date:** 2026-06-11  
**Status:** DONE — fixed in **M31** (`docs/plans/archive/M31-zombie-positions-and-broken-lifecycle.md`). Archived under `docs/wip/done/`.  
**Context:** First gate-approved paper trades after M29/M30 deploy. Operator saw three "open" positions and a global halt. **This doc records the defect analysis that M31 addressed (zombie lifecycle), not the separate live exit-enforcement gap** — see [live-exit-enforcement-gap.md](../live-exit-enforcement-gap.md).

---

## Incorrect system state (right now)

The database and API report a fiction: **three open positions and ~$1,508 exposure**, while the economic reality is **flat with three close fills already booked**.

| Layer | What it says | What actually happened |
|-------|--------------|------------------------|
| `positions.state` | `pending_open` × 3 | Should be `closed` × 3 |
| `positions.qty` | `0` on all three | Consistent with flat, **inconsistent** with `pending_open` + dashboard "open" |
| `positions.stop_loss` / `take_profit` | `null` | Never persisted despite decisions carrying SL/TP geometry |
| `positions.closed_at` / `exit_reason` / `realized_pnl` | `null` | Close path never finalized |
| `transactions` | 3 × `close` only | **Zero** `open` rows — audit trail is one-legged |
| `risk_state.open_exposure` | **1508.35** | Should be **~0** if flat |
| `risk_state.realized_pnl_day` | **0** | Should reflect ~**+1.12** cashflow (pre-fee) |
| `risk_state.trades_count` | **0** | Should be **3** |
| `/v1/positions/open` | Returns 3 rows | Misleading — none are live |
| Gate after 11:05 | `exposure_cap_per_coin` × 11 rejects | Likely **wrong inputs** — inflated `open_exposure` from zombies |

**Net:** Soak telemetry, risk limits, and operator UI are all reading **corrupt position lifecycle state**. Any funnel or edge analysis built on today's `risk_state` / position counts is unreliable until this is fixed.

---

## Defect 1 (P0) — Close path leaves `pending_open` zombies

### What is incorrect

A position that received a **full close fill** must end in `state = closed` with `closed_at`, `exit_reason`, and `realized_pnl` set (ADR 0009 §6.1, ADR 0012 §5). All three positions violate that:

- `qty = 0` (close applied)
- `state = pending_open` (terminal transition never ran)
- Close transaction row exists with non-zero qty and cashflow

The dashboard and `PositionRepository.findOpen()` (`state != 'closed'`) therefore **lie about live risk**.

### Root cause (high confidence)

**State-machine mismatch between entry protection and exit handling.**

1. **Entry path** (`ExecutionService.openOrAddPositionAndAttachProtection`):
   - Inserts at `PENDING_OPEN`
   - Arms `LocalProtectiveMonitor` **before** protective attach
   - Only then calls `recordEntryTransaction`, attach, and `PENDING_OPEN → OPEN`

2. **Exit path** (`ExecutionService.applyReduceFillToPosition` on full close):
   - Zeros `qty`, saves row
   - Writes close transaction
   - Calls `transition(..., CLOSING)` then `finalizeRealizedPnl` → `CLOSED`

3. **Transition graph** (`positionStateGraph.ts`) allows:
   ```
   pending_open → open | reconciling
   ```
   **Not** `pending_open → closing`.

So if the local monitor fires SL/TP while the row is still `pending_open` (7–25 min holds are plenty of time), step 3 throws `IllegalStateTransitionException`. Steps 1–2 are **already committed**.

4. **Error handling makes it worse** (`onOrderIntentApproved`):
   ```typescript
   try { await this.handleApproved(event); }
   catch { log; releaseReservation; }  // no rollback
   ```
   Partial failure → permanent zombie.

### Why this is a design bug, not bad luck

ADR 0008 §2 **requires** arming the monitor during `pending_open`. ADR 0009 **forbids** `pending_open → closing`. Execution close logic **assumes** `OPEN` (or at least a state that can reach `CLOSING`). Those three constraints are **incompatible** unless close explicitly handles `pending_open` (e.g. via `reconciling` two-step, same as `ReconciliationService`).

### Where to dig

| Priority | File | Question |
|----------|------|----------|
| 1 | `apps/engine/src/execution/service/ExecutionService.ts` | `applyReduceFillToPosition` (~335–392): branch on `position.state` before `CLOSING` |
| 2 | `apps/engine/src/position/const/positionStateGraph.ts` | Should protective exit add `pending_open → reconciling`? |
| 3 | `apps/engine/src/execution/service/LocalProtectiveMonitor.ts` | Does breach fire without checking state? Should it? |
| 4 | `apps/engine/src/execution/service/ExecutionService.ts` | `onOrderIntentApproved` catch: partial-write safety |
| 5 | `apps/engine/bootstrap/` phase 4c | Boot re-arms monitor on flat `pending_open` rows — extends the lie after restart |

### Tests that should exist but likely don't

- Monitor breach on `PENDING_OPEN` before attach completes → must end `CLOSED`, never `pending_open` + `qty=0`.
- Failed `transition(CLOSING)` must not leave committed close tx without terminal state (rollback or compensating `reconciling → closed`).

---

## Defect 2 (P0) — Missing `open` transaction rows

### What is incorrect

ADR 0007 / M5 contract: **every filled intent** has a terminal `transactions` audit row. The entire `transactions` table contains **only three `close` rows** — no `open`, no `add`, no zero-fill audit.

`ExecutionService` calls `recordEntryTransaction` **after** `createPositionFromFill` and **before** attach (~831). With real fills and position rows present, **open rows should exist**. They do not.

### What this breaks

- `finalizeRealizedPnL` aggregates `SUM(cashflow)` over position transactions (ADR 0012 §5). With close-only rows, PnL math may still work for the close leg but **entry leg is unaccounted** in the ledger.
- M27/M30 soak analysis cannot reconcile decision geometry → fill → position.
- Idempotency/replay: no `client_order_id` for entry fills to match against exchange.

### Where to dig

| Priority | File | Question |
|----------|------|----------|
| 1 | `ExecutionService.recordEntryTransaction` (~916) | Was it reached? Did it throw? |
| 2 | `ExecutionService.openOrAddPositionAndAttachProtection` (~805–831) | Order: create → arm → **record** → attach. Failure between create and record? |
| 3 | `apps/engine/src/paper-mode/` | Does paper submit bypass `recordEntryTransaction` on open? |
| 4 | Engine logs 09:30–11:35 UTC | `transaction recorded positionId=`, `unhandled execution failure`, `IllegalStateTransition` |
| 5 | `TransactionRepository.recordTerminal` | Unique violation swallowed as no-op — could open row exist under different `position_id`? (Query says no.) |

**Open question:** If open tx failed, how did close tx get correct `position_id` and qty matching the approved decision? Suggests qty **was** on the row at close time, then zeroed — open tx omission is a **separate** failure mode from the zombie transition.

---

## Defect 3 (P1) — `risk_state` accounting is wrong

### What is incorrect

| Field | Actual | Correct if lifecycle completed |
|-------|--------|--------------------------------|
| `open_exposure` | 1508.35 | ~0 |
| `realized_pnl_day` | 0 | ~+1.12 (from close cashflows) |
| `trades_count` | 0 | 3 |

### Why

Happy-path close never emitted `POSITION_CLOSED_EVENT` because `finalizeRealizedPnl` never ran (Defect 1).

`RiskGateService.reconcileClose` / `adjustOpenExposure` decrement exposure on reconciliation drift paths — **not** on execution happy-path close. So zombies keep `entry_notional` alive in exposure math.

Boot calls `setOpenExposureFromBoot` summing `entry_notional` of all non-`closed` rows — **rebuilds the wrong number from zombies** on every restart.

### Downstream incorrect gate behavior

**11 `exposure_cap_per_coin` rejects today** may be partly driven by **phantom ~$1,508 open exposure** rather than real positions. The gate is doing its job against **bad state**, not bad config.

### Where to dig

| File | Question |
|------|----------|
| `RiskGateService.adjustOpenExposure` | Who increments on open confirm? Is decrement only on `reconcileClose`? |
| `PositionService.finalizeRealizedPnl` | What updates `risk_state` today — anything, or only listeners? |
| `RiskListeners` `@OnEvent(POSITION_CLOSED_EVENT)` | Does it book `realized_pnl_day` / `trades_count`? |
| `EngineBootstrapService` | `setOpenExposureFromBoot` should exclude `qty=0` zombies or `pending_open` with close txs |

---

## Defect 4 (P1) — Position row incomplete vs approved decision

### What is incorrect

Approved decisions (1887, 1889, 1895) carry full geometry:

- `notional`, `qty`, `stop_loss`, `take_profit`, `leverage`

Position rows have:

- `entry_notional` / `entry_price` populated
- `qty = 0`, `stop_loss_price = null`, `take_profit_price = null`
- `decisions.position_id` **not linked** (no decision row points at position 1/2/3)

M27 decision capture is **disconnected** from the position lifecycle for the only three trades that matter today.

### Where to dig

- `StrategyService` / decision persistence: when is `position_id` stamped?
- `PositionService.createOpen` / `applyProtectiveAttachResult`: when are SL/TP columns written?
- Likely only on `PENDING_OPEN → OPEN` — which never happened if close fired first or transition failed.

---

## Defect 5 (P2) — API semantics mislabel zombies as open

### What is incorrect

`PositionRepository.findOpen()`:

```typescript
find({ where: { state: Not(PositionStateEnum.CLOSED) } })
```

This includes `pending_open`, `closing`, `reconciling`, `manual_adopted_unmanaged`. After Defect 1, **flat zombies match this filter** and surface on `/v1/positions/open`.

Operator cannot distinguish "live risk" from "broken lifecycle residue" without reading `qty` and transactions manually.

### Where to dig

- `apps/engine/src/position/repository/PositionRepository.ts`
- Read API: `apps/engine/src/read-api/` — expose `state`, filter, or separate `/positions/live` vs `/positions/non-terminal`
- Dashboard: does it show `pending_open` with zero qty as open?

---

## Defect 6 (P2?) — Same-bar halt may not be auto-resuming when calm

### What is incorrect (or at least unverified)

By **14:05 UTC**, `same_bar_trigger_count = 1` on recent decisions (calm). `risk_state` still shows `is_halted = true`, `halt_reason = market_stress:same_bar`.

M28 contract: with `MARKET_STRESS_AUTO_RESUME_ENABLED=true`, halt should clear after **2** consecutive evaluations where same_bar is below resume threshold (12).

**If** calm conditions persisted for hours and halt never cleared, one of these is wrong:

1. Auto-resume not running (flag, leg classifier, `isStressLegAutoResumeEligible`)
2. Resume counter not advancing (only `action=open` evaluations count — **skips don't help**)
3. `clearHaltForDate` not persisting / boot re-engaging stale halt
4. Engine restart resetting in-memory `stressClearCount` without enough post-restart open evaluations

**Note:** Engaging at count 24 ≥ 20 is **correct**. Staying halted through a long calm window is **not**.

### Where to dig

- `RiskGateService.resolveDayHalt` / `autoResumeMarketStress` (~562–688)
- Logs: `market_stress auto-resumed leg=same_bar`
- Whether post-halt session has enough `action=open` gate evaluations (not just `skip`) to tick the resume counter

---

## Not incorrect (for clarity)

- **Same-bar engage at 12:25** (`count=24`, threshold 20): working as designed (M28).
- **Post-halt `global_halt` / `market_stress` rejects**: correct given `risk_state.is_halted`.
- **Gate approved three opens pre-halt**: funnel did fire; defects are **post-approval execution/accounting**, not signal starvation.

---

## Evidence tables (2026-06-11 UTC)

### Positions vs transactions

| id | Symbol | state | qty | close tx qty | close cashflow | hold |
|----|--------|-------|-----|--------------|----------------|------|
| 1 | VVV | pending_open | 0 | 36.58 | +4.07 | 7 min |
| 2 | XMR | pending_open | 0 | 1.424 | +3.12 | 13 min |
| 3 | ORCL | pending_open | 0 | 2.75 | −6.07 | 25 min |

### `risk_state`

```
is_halted=true  halt_reason=market_stress:same_bar
open_exposure=1508.35  realized_pnl_day=0  trades_count=0
```

---

## Fix dig order

1. **Reproduce in test:** `PENDING_OPEN` + monitor breach → assert no zombie; assert `CLOSED` + `POSITION_CLOSED_EVENT`.
2. **Fix close path** for `pending_open` source state (graph edge or `reconciling` route).
3. **Fix or explain** missing open transactions.
4. **Wire `risk_state` decrement/PnL** on successful close even if reached via protective exit.
5. **Harden boot** — don't rebuild exposure from `qty=0` / close-tx zombies; don't re-arm monitor on flat rows.
6. **API** — don't expose flat `pending_open` as open without explicit "stale" flag.

---

## SQL — incorrect-state detectors

```sql
-- Zombies: flat qty but non-closed
SELECT positions_id, symbol, state, qty, entry_notional
FROM positions
WHERE state <> 'closed' AND qty = 0;

-- One-legged audit: close without open
SELECT p.positions_id, p.symbol, p.state,
       SUM(CASE WHEN t.type = 'open' THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN t.type = 'close' THEN 1 ELSE 0 END) AS closes
FROM positions p
LEFT JOIN transactions t ON t.position_id = p.positions_id
GROUP BY p.positions_id, p.symbol, p.state
HAVING SUM(CASE WHEN t.type = 'close' THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN t.type = 'open' THEN 1 ELSE 0 END) = 0;

-- Exposure lie
SELECT date, open_exposure, realized_pnl_day, trades_count, is_halted, halt_reason
FROM risk_state WHERE date = CURRENT_DATE;
```

---

## References

- ADR 0009 — state machine; `pending_open` cannot reach `closing` directly
- ADR 0008 §2 — monitor armed during `pending_open`
- ADR 0012 §5 — finalize bundles close fields; tx ordering
- ADR 0004 §6e — same_bar halt/resume
- Prior WIP — `docs/wip/slot-model-and-correlated-leg-gaps.md`
