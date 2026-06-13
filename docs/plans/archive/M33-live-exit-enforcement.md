---
adr: [0008, 0011, 0012, 0015]
modules: [execution, position, risk]
---

# M33 — Live exit enforcement (time-stop + paper protective simulation + entry cashflow)

**Status:** DONE (2026-06-13)  
**Type:** Bug-fix milestone. Engine-only. **No schema migration**. **No `packages/shared/` change**.  
**Source defect doc:** `docs/wip/done/live-exit-enforcement-gap.md`  
**Outcome:** See `docs/milestone-log/archive/M33.md`

---

## Brief

Three linked enforcement gaps in live/paper mode prevented positions from closing via their declared exits (SL, TP, time-stop):

1. **Missing live time-stop enforcer** — no component compared `now` to `positions.time_stop_at` and emitted a gated CLOSE. Positions with passing deadlines were held indefinitely.
2. **Paper + `exchange_side` exit vacuum** — after exchange-side protective attach success, `LocalProtectiveMonitor` was disarmed, but paper had no exchange matching engine to fire the simulated SL/TP orders.
3. **Entry transaction `cashflow` null** (audit gap) — `recordEntryTransaction` omitted `cashflow`, causing entry-fill rows to fail insertion due to NOT NULL column.

## Design decisions

### 1. Event-driven time-stop enforcer (`PositionTimeStopEnforcer`)

- **Subscribed to `price.update`:** every tick, check if any open position's `timeStopAtMs` deadline has passed.
- **In-memory deadline index:** `Map<symbol, Map<positionId, timeStopAtMs>>` with a scalar `earliestTimeStopMs` fast-path (one comparison per tick across all symbols).
- **Synchronous `SharedCloseCoordinator.tryAcquire` before any `await`:** the enforcer acquires a slot synchronously before submitting to `RiskGateService`, ensuring time-stop WINS over concurrent `LocalProtectiveMonitor.handleBreach` on the same tick.
- **Gate-routed close intent:** constructs an `IOrderIntent` with `intentAction = CLOSE`, `eventId = time-stop-${positionId}-${tickMs}`, routes through `RiskGateService.evaluate` (no direct `ExecutionService` bypass). Emits `exitReason = TIME_STOP`.

**Collision ordering (locked):** when a tick arrives, if the enforcer's `tryAcquire` succeeds, the monitor finds the slot held and skips (via `isHeld(positionId)` check). Time-stop always takes precedence on the same tick.

### 2. Paper mode SL/TP persistence and re-arm

In `EXCHANGE_ENV=paper`, `ExecutionService.applyProtectiveAttachResult` no longer disarms `LocalProtectiveMonitor` after a successful exchange-side attach. The monitor remains armed and continues to evaluate SL/TP breaches via `price.update`, in parity with backtest `IntrabarStopSimulator`.

**Restart re-arm (Option A):** SL/TP prices are persisted at `createPositionFromFill` time (alongside `timeStopAt`, before the protective attach), closing a pre-attach crash window. On boot, `phase4cRearmLocalMonitor` re-arms `PENDING_OPEN` rows (all envs) and paper `exchange_side` rows from persisted prices. LIVE/testnet `exchange_side` rows are not re-armed (the exchange holds protection).

### 3. Entry cashflow explicit zero

`ExecutionService.recordEntryTransaction` now explicitly passes `cashflow: new Money(0)` in the `recordTerminal` call (matching the reduce path's pattern). Closes the NOT NULL insertion failure.

### 4. Shared close-in-flight registry (`SharedCloseCoordinator`)

All gate-routed close producers (enforcer, monitor, reconciliation, future flatten) use a single `SharedCloseCoordinator` to prevent concurrent double-close on the same position per tick. `tryAcquire` is synchronous and must be called before emitting the intent. Releases happen on:

- **Primary:** `POSITION_STATE_TRANSITIONED → CLOSED` event (durable close).
- **Exception safety:** try/catch wrapping the gate call releases on unexpected throw.
- **Never on disarm:** the monitor's disarm does not release the slot.
- **Never on unknown intents:** reconciliation owns the slot until a durable event writes.

## ADR amendments (locked)

- **ADR 0008 §7 (new):** Paper mode SL/TP persistence and re-arm logic.
- **ADR 0011 §9 (new):** Live time-stop enforcer + shared close-in-flight registry.
- **ADR 0012 §1c (new):** Explicit zero cashflow for entry transactions.
- **ADR 0015 §4.6.1 (new subsection):** Live-vs-backtest fill-price divergence for time-stop exits (acceptable, documented).

## Files expected to change

**Engine only (no shared, no migration):**
- `apps/engine/src/execution/service/PositionTimeStopEnforcer.ts` (new, ~127 lines)
- `apps/engine/src/execution/service/SharedCloseCoordinator.ts` (new, ~43 lines)
- `apps/engine/src/execution/service/ExecutionService.ts` (recordEntryTransaction: add cashflow; applyProtectiveAttachResult: paper disarm condition)
- `apps/engine/src/position/service/LocalProtectiveMonitor.ts` (paper disarm suppression)
- `apps/engine/src/position/repository/PositionRepository.ts` (findTimeStopCandidatesBySymbol: new query)
- `apps/engine/src/boot/` (phase4cRearmLocalMonitor: add SL/TP re-arm logic)
- `apps/engine/src/execution/listener/` (exception handlers for coordinator releases)

**ADRs:**
- `docs/architecture/adr/0008-sl-tp-attach.md` (§7)
- `docs/architecture/adr/0011-local-sltp-fallback-and-held-symbols.md` (§9)
- `docs/architecture/adr/0012-funding-and-pnl.md` (§1c)
- `docs/architecture/adr/0015-backtest-module.md` (§4.6.1)

## Dispatch

Wave 1 (architect): ADR amendments 0008/0011/0012/0015 locked.  
Wave 2 (bot-engine-nestjs): Implementation of enforcer/coordinator/re-arm/cashflow.  
Wave 3 (bot-qa-engineer): Adversarial QA on idempotency, same-tick collision, paper/live parity.  
Wave 4 (reviewers × 4): Security, logic, clean-code, quant.  

## Definition of Done

- All three sub-problems resolved (enforcer, paper, cashflow).
- 0 blockers, 0 highs on reviewer pass.
- 27+ new adversarial tests covering D-TS, D-CO, D-FL, D-PP, D-CF series.
- Live smoke: position closing at its time-stop deadline on the first post-deploy tick, `exitReason = TIME_STOP`.
- ADR amendments locked.
