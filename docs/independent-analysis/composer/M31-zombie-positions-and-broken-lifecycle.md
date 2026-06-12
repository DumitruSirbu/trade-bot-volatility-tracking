# Independent Review — M31 Zombie Positions & Broken Position-Lifecycle

**Plan reviewed:** `docs/plans/M31-zombie-positions-and-broken-lifecycle.md`  
**Codebase snapshot:** 2026-06-11 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M31 is an **exceptionally well-researched survival-class fix** for a real, code-verified defect chain: protective monitor breach on a `pending_open` row drives `applyReduceFillToPosition` to commit `qty=0` + close transaction, then throws on illegal `pending_open → closing`, leaving permanent zombies. The chosen **Option A′** (`pending_open → open → closing` two-step) matches ADR 0009 §6.3 verbatim and is the only fix that preserves ADR 0008 §2 (arm during `pending_open`) without mislabeling exits as `reconciled_missing`.

The plan’s **Wave A / Wave B split**, adversarial test bar, one-time SQL repair (not migration), and soak-integrity exclusions for 2026-06-11 are all appropriate. Defect 6 deferral and Defect 4 scoping (`decisions.position_id` as pre-existing tech-debt) are correct.

**Assessment:** **Approve with amendments** — dispatch after locking five implementation details below. The plan is ready for Wave A once Task 2’s ADR 0008 ordering change is architect-signed, Task 5 mandates `findNonTerminal()` for reconciliation (not optional), and Task 4’s exposure decrement uses **residual notional** (not blind `entry_notional`) to stay consistent with `reconcileClose`.

| Area | Grade | Assessment |
|------|-------|------------|
| Root-cause diagnosis (Defect 1) | A+ | Full chain verified in `ExecutionService`, graph, and top-level catch. |
| State-machine fix (Option A′) | A | Matches ADR 0009 §6.3; rejects A/B/C for sound reasons. |
| Defect 2 analysis | A | Correctly debunks “paper bypasses recordEntryTransaction”; log grep pre-req is right. |
| Defect 3 / Task 4 direction | B+ | Happy-path booking gap confirmed; **`entry_notional` decrement is wrong after partial reduce or ADD+partial path**. |
| Task 2 reorder | B | Logically fixes interleave; **conflicts with current ADR 0008 comment** (arm before *all* awaited I/O). Needs explicit ADR note. |
| Task 5 / reconciliation | B- | Plan says “if any caller needs non-terminal…” — **must be mandatory**; reconciliation today uses `findOpen()`. |
| Boot hardening (Task 6) | A | qty=0 exclusion in 4a/4c is defense-in-depth; aligns with ADR 0014 amendment. |
| Data repair SQL | A- | Fee-net ledger aggregation is sound; `cashflow` is PnL delta not gross notional (verified). |
| Test plan | A- | D1-adv-2 slot assertion is valuable; add partial-reduce exposure test for Task 4. |
| Scope / dispatch | A | Engine-only, no shared package, two waves ≤5 files, architect STOP points documented. |

**Bottom line:** **Yes, ship M31 with Option A′ + risk_state close listener + boot guards + SQL repair.** **Amend Task 4** to carry **`closingExposureNotional`** (computed as `qty × entryPrice` immediately before the qty=0 save) on `IPositionClosedEvent`, mirroring `reconcileClose` semantics. **Amend Task 5** to **require** `findNonTerminal()` and rewire `ReconciliationService.loadNonClosedPositions()`. **Do not merge Task 2** until architect confirms tx-before-arm does not weaken the always-protected invariant beyond the accepted micro-window.

---

## Verified Current State

### Defect 1 chain is exact

`positionStateGraph.ts` allows `pending_open → {open, reconciling}` only — no `closing`:

```21:23:apps/engine/src/position/const/positionStateGraph.ts
const LEGAL_TRANSITIONS: ReadonlyMap<PositionStateEnum, ReadonlySet<PositionStateEnum>> = new Map([
    [PositionStateEnum.PENDING_OPEN, new Set<PositionStateEnum>([PositionStateEnum.OPEN, PositionStateEnum.RECONCILING])],
    [PositionStateEnum.OPEN, new Set<PositionStateEnum>([PositionStateEnum.CLOSING, PositionStateEnum.RECONCILING])],
```

On a closing fill, `applyReduceFillToPosition` zeros qty and saves **before** `transition(..., CLOSING)`:

```335:383:apps/engine/src/execution/service/ExecutionService.ts
        if (isClosingFill) {
            position.qty = clampedQty;
            // ...
            this.localProtectiveMonitor.disarm(position.id);
            await this.positions.save(position);
        }
        // ...
        await this.transactions.recordTerminal({ /* close tx */ });
        if (isClosingFill) {
            // ...
            await this.positionService.transition(position.id, PositionStateEnum.CLOSING, {
                nowMs,
                eventClass: 'execution.reduce.fill.terminal',
            });
```

From `pending_open`, that `CLOSING` transition throws; the outer handler logs and releases the reservation only:

```102:109:apps/engine/src/execution/service/ExecutionService.ts
    async onOrderIntentApproved(event: IOrderIntentApprovedEvent): Promise<void> {
        try {
            await this.handleApproved(event);
        } catch (cause) {
            this.logger.error(`unhandled execution failure for event=${event.intent.eventId}: ${this.describe(cause)}`);
            this.releaseReservationSafely(event.reservationId);
        }
    }
```

No rollback — zombie is guaranteed.

### ADR 0009 §6.3 already prescribes the fix

The plan’s Option A′ is not novel; it is the documented kill-switch pattern:

> If a kill-switch flatten fires on a `pending_open` row, the gate moves it `pending_open → open → closing` in two transitions, both written.

Generalizing to monitor breach is the correct ADR amendment, not a graph change.

### Defect 3 — `risk_state` is boot-rebuilt only today

`phase4aRebuildOpenExposure` sums `entryNotional` over non-closed rows at boot; no happy-path increment/decrement during the run:

```209:220:apps/engine/src/bootstrap/service/EngineBootstrapService.ts
    async phase4aRebuildOpenExposure(positions: readonly PositionEntity[], nowMs: number): Promise<void> {
        let total = new Money(0);
        for (const position of positions) {
            if (position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
                continue;
            }
            total = total.plus(position.entryNotional);
        }
        await this.riskGate.setOpenExposureFromBoot(total, nowMs);
```

`RiskListeners.onPositionClosed` is alert-only (no `risk_state` write) — plan Defect 3 confirmation is accurate.

`reconcileClose` **does** decrement exposure, but uses **residual** `qty × entryPrice`, not `entry_notional`:

```280:287:apps/engine/src/risk/service/RiskGateService.ts
        const residualNotional = position.qty.times(position.entryPrice);
        await this.adjustOpenExposure(residualNotional.negated(), nowMs, `reconcileClose:${positionId}`);
```

This matters for Task 4 (see Amendments).

### Defect 2 — current open path order

Today: `createPositionFromFill` → **sync `arm`** → **await `recordEntryTransaction`** → await attach → `PENDING_OPEN → OPEN`.

```821:831:apps/engine/src/execution/service/ExecutionService.ts
        if (isOpenIntent) {
            this.localProtectiveMonitor.arm({ /* ... */ });
        }
        await this.recordEntryTransaction(positionRow.id, event, submitResult, fillSummary);
```

The inline comment explicitly requires arm **before** the tx insert. Task 2’s proposed swap is a **documented ADR 0008 interpretation change**, not a no-op reorder — architect STOP is mandatory.

### `findOpen()` is structurally permissive

```24:26:apps/engine/src/position/repository/PositionRepository.ts
    async findOpen(): Promise<PositionEntity[]> {
        return this.repository.find({ where: { state: Not(PositionStateEnum.CLOSED) } });
    }
```

Reconciliation loads via `findOpen()`:

```1418:1421:apps/engine/src/position/service/ReconciliationService.ts
    private async loadNonClosedPositions(): Promise<PositionEntity[]> {
        const rows = await this.positions.findOpen();
        return rows.filter((row) => row.state !== PositionStateEnum.CLOSED);
    }
```

Narrowing `findOpen()` to `qty > 0` **without** a parallel `findNonTerminal()` would blind reconciliation to qty=0 zombies — the plan flags this but leaves it conditional; it should be **required**.

### Repair SQL `cashflow` semantics are safe

Close/reduce `cashflow` is side-aware PnL delta (`computeFillCashflow`), not gross notional:

```57:71:apps/engine/src/position/util/pnlMath.ts
//   LONG:  (exitPrice - entryPrice) * qty
//   SHORT: (entryPrice - exitPrice) * qty
export function computeFillCashflow(side, entryPrice, exitPrice, qty): MoneyValue {
    const delta = side === PositionSideEnum.LONG ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);
    return delta.times(qty);
}
```

With only a close leg (no open tx), query (4)’s fee-net sum is the correct realized PnL for repair — **not** inflated by position size.

---

## Strengths

1. **Option evaluation is rigorous.** Rejecting `reconciling` shortcut (PnL mislabel), forbidden edge relaxation (ADR 0009 §3 guard), and delayed arming (ADR 0008 violation) shows the plan author read the ADRs, not just the WIP.

2. **Task 4 qty-after-zero trap is an excellent catch.** Reading `qty` post-save for exposure decrement would silently no-op; carrying notional on the event is the right pattern.

3. **Defect 6 discipline.** Treating same-bar non-resume as likely working-as-designed until runtime evidence avoids another M28-style false fix. Linking phantom exposure suppressing open-evaluations is a useful post-repair hypothesis.

4. **Soak-integrity section is load-bearing.** Excluding 2026-06-11 from promotion samples and entry-leg idiosyncrasy analysis prevents corrupted data from poisoning M27/M30 gates.

5. **Deploy sequence is safe.** pg_dump → stop engine → detect/repair → merge → restart respects CLAUDE.md DB rules.

---

## Required Amendments

### 1. Task 4 — use residual notional, not `entry_notional` blindly

`entry_notional` is incremented on ADD (`applyAddToExistingPosition`) but **not reduced on partial REDUCE** (only `qty` changes via `adjustQty`). For a position that ADDed or partially reduced before terminal close, `entry_notional` can **overstate** live exposure versus `qty × entryPrice`.

**Recommendation:** At the emit site in `applyReduceFillToPosition`, capture `closingExposureNotional = position.qty.times(position.entryPrice)` **before** the qty=0 assignment (line ~336). Add that field to engine-local `IPositionClosedEvent`. The listener decrements by that value — aligned with `reconcileClose` and correct for partial-reduce paths the executor already supports.

For the three zombie repairs and typical paper soak (full SL/TP close, no partial), `entry_notional` equals residual notional; the amendment is forward-proofing, not blocking soak repair.

### 2. Task 5 — mandate `findNonTerminal()`, not “if needed”

Reconciliation **must** continue to see qty=0 non-closed rows (zombies, crash windows, partial failures). Change Task 5 acceptance criteria to:

- Add `findNonTerminal()` (`state != closed`, any qty).
- Point `ReconciliationService.loadNonClosedPositions()` at it.
- Narrow `findOpen()` to live risk (`qty > 0` AND `state != closed` — confirm whether `CLOSING` with qty>0 should remain; plan implies yes).

Add test **D5-adv:** a qty=0 `pending_open` zombie is visible to reconciliation via `findNonTerminal()` but absent from `findOpen()` and slot occupancy.

### 3. Task 2 — quantify the protection window tradeoff

Moving `recordEntryTransaction` before `arm` introduces a new window: **DB row exists, monitor not armed**, during the await on `recordTerminal`. Today the monitor **is** armed during that await.

The plan’s rationale (breach interleave between arm and tx) is valid for Defect 2, but the engineer must not land the swap without architect sign-off that:

- the micro-window without local monitor is acceptable because exchange fill already occurred and attach still follows arm; and
- ADR 0008 §2 comment at `:810-815` is updated to reflect “arm before exchange-side attach; local audit tx may precede arm.”

If architect rejects, alternative: keep arm-first but make `recordEntryTransaction` **synchronous with respect to breach** via DB transaction wrapping create+tx (heavier) or accept Defect 2 as log-only if logs show tx never ran.

### 4. Task 4 — partial reduces and `trades_count`

`POSITION_CLOSED_EVENT` fires only on terminal close — correct for `trades_count`. Partial reduces do **not** decrement `open_exposure` today (pre-M31: nothing does during run). Post-M31, if partial reduces occur in live/paper, exposure stays overstated until terminal close unless a **`POSITION_QTY_ADJUSTED`** or reduce-fill hook decrements by `filledQty × entryPrice`.

**Recommendation:** Add one sentence to Task 4 scope: “Partial reduces are out of scope for M31; exposure decrement on reduce-family non-closing fills is deferred tech-debt unless soak proves partial reduces occur.” If code path exists, add a single MEDIUM tech-debt entry now to avoid silent over-exposure after first partial.

### 5. Task 1 — promote timing relative to qty=0 save

The plan places promote before `transition(CLOSING)` but **after** qty=0 save. That yields a brief `OPEN` row with `qty=0`. Acceptable if transitions are fast, but:

- Ensure `finalizeRealizedPnl` still receives a coherent `CLOSING → CLOSED` path from that promoted `OPEN`.
- D1-adv-2 slot test should assert **reservation ledger + DB slot count ≤ 1** for the symbol/slot, not only absence of double-close — two racing breach intents could otherwise double-emit before idempotency guards.

---

## Additional Observations

### Task 4 idempotency

Plan relies on “event fires exactly once.” NestJS `EventEmitter2` is in-process and `finalizeRealizedPnl` is single-writer, so duplicates are unlikely. For defense-in-depth, consider idempotency keyed on `(utcDate, positionId)` in the risk_state upsert or a lightweight “closed booking” marker — optional for M31 but worth a follow-on if replay/reconciliation can re-emit close.

### `findOpenBySymbolAndSlot` unchanged

Reduce lookup uses `state != CLOSED` without qty filter — correct: a `pending_open` row with qty>0 must remain findable for breach close. Task 5 narrowing applies to aggregate “live risk” queries, not slot-scoped execution lookup.

### Defect 6 and repair ordering

Repairing zombies (Task 6 SQL) may restore `open_exposure=0` and unblock `action=open` evaluations that tick same-bar resume — good experiment after repair, before any M28 logic change.

### Missing open tx — analysis impact

Plan correctly refuses fabricated open legs. Composer agrees: one-legged audit detector staying red for ids 1–3 is honest; M27/M30 entry-leg exclusions are mandatory.

---

## Test Plan Additions

| ID | Scenario |
|----|----------|
| **D3-partial** | OPEN → partial REDUCE (qty halved) → terminal close: `open_exposure` decrements by **remaining** `qty × entryPrice` at close, not full `entry_notional`. |
| **D5-adv** | qty=0 `pending_open` visible to `findNonTerminal()` / reconciliation; excluded from `findOpen()` and gate slot count. |
| **D2-order** | After Task 2 reorder: assert monitor is **not** armed until after `recordEntryTransaction` resolves; assert breach during tx insert cannot produce close tx without open tx. |

---

## Dispatch Checklist

- [ ] Wave A pre-step: log grep for three positions (Defect 2 investigation).
- [ ] Architect sign-off: Task 2 arm/tx ordering vs ADR 0008 §2.
- [ ] Architect sign-off: Task 6 boot qty=0 exclusion vs ADR 0014 §4a (plan pre-blesses).
- [ ] Implement Task 4 with **`closingExposureNotional`**, not raw `entryNotional`, unless architect explicitly accepts full-notional decrement and documents partial-reduce exclusion.
- [ ] Task 5: **`findNonTerminal()` required**; rewire reconciliation in same diff.
- [ ] ADR amendments 0009 §6.3, 0012 §5, 0014 §4a per plan.
- [ ] pg_dump + repair SQL before restart; verify detectors (1)–(3) post-repair.
- [ ] Post-deploy: first fill watch (open tx + in-run risk_state decrement + no zombie detector hits).

---

## Conclusion

M31 is **among the strongest milestone plans in this repo**: accurate root cause, minimal fix surface, correct ADR alignment, and honest soak-data caveats. The zombie defect is **real, reproducible from code, and survival-critical**.

Ship after amending Task 4’s exposure field to **residual notional**, making Task 5’s reconciliation split **mandatory**, and obtaining architect approval on Task 2’s ordering change. No blockers to dispatch once those three items are locked.
