# M31 — Zombie positions & broken position-lifecycle

**Status:** DONE — implementation complete, all reviewers clean, 3406 tests passing
**Type:** Bug-fix milestone. Engine-only. **No schema migration** (see §8).
**Source defect doc:** `docs/wip/first-three-paper-fills-and-zombie-positions.md`
**Owns ADR amendments:** 0009 (state graph), 0012 (recompute-based risk_state booking on open+close), 0014 (boot hardening: residual notional + qty=0 exclusion). 0008 reaffirmed and unchanged in the default path; the gated Task 2 reorder would require a separate ADR 0008 §2 amendment + architect sign-off (default path needs none).

---

## Goal

The first three gate-approved paper fills (2026-06-11) each received a full close fill but never finalized: all three rows are stuck at `state=pending_open`, `qty=0`, with a `close` transaction booked, no `open` transaction, and `risk_state` reporting `open_exposure=1508.35` / `realized_pnl_day=0` / `trades_count=0` while the account is economically flat. The dashboard and `findOpen()` therefore report phantom live risk, and every downstream funnel/edge query built on today's `risk_state` is corrupt. The root cause is a state-machine incompatibility: the protective monitor is armed during `pending_open` (ADR 0008 §2), but a breach close drives `pending_open → closing`, which the graph forbids (ADR 0009 §3) — the transition throws **after** the close transaction and `qty=0` save have already committed, and the top-level error handler only logs. M31 makes the close path `pending_open`-safe, wires happy-path `risk_state` close-booking, hardens boot against qty=0 zombies, and repairs the three live rows. It is safe without a migration: every fix is logic over existing columns; the three corrupt rows are repaired with one-time UPDATEs, not a schema change.

This is a **survival-class state-machine fix** (`dev-qa-cycle.md` §Why: "zero tolerance for phantom positions"). Adversarial QA on the crash-window between awaited I/O is the bar for done.

---

## Scope

**In:** `apps/engine/src/execution/service/ExecutionService.ts`, `apps/engine/src/position/const/positionStateGraph.ts`, `apps/engine/src/risk/service/RiskGateService.ts`, `apps/engine/src/risk/repository/RiskStateRepository.ts` (`upsertDay` reuse for the recompute — see Task 4), a new risk-side lifecycle listener (NOT alert-module `RiskListeners` — see Task 4), `apps/engine/src/bootstrap/service/EngineBootstrapService.ts`, `apps/engine/src/position/repository/PositionRepository.ts` (`findOpen` narrowing + `findNonTerminal`/`findLiveRisk` — see Task 5), `apps/engine/src/position/service/ReconciliationService.ts` (`loadNonClosedPositions` repoint — see Task 5).

**Out:** dashboard, `packages/shared/` (no contract change is required — confirmed in §3 per task), backtest fidelity, true 5-slot expansion, Defect-6 same-bar resume unless §3 confirms it is live-broken.

**Dispatch shape:** split across **two engine waves** (≤5 files each per `dev-qa-cycle.md` §1.1) with a mini-review between:
- **Wave A (state machine + audit):** Tasks 1, 2, 3 (the zombie root cause).
- **Wave B (accounting + boot + API):** Tasks 4, 5, 6.

---

## Defects — confirmed / corrected against source

Every claim below was verified against the actual source. File + line citations are to the code read for this plan.

### Defect 1 (P0) — Close path leaves `pending_open` zombies — **CONFIRMED**

The WIP root cause is correct and complete. Verified chain:

1. Open path: `ExecutionService.createPositionFromFill` inserts at `PENDING_OPEN` (`ExecutionService.ts:966`), arms the monitor synchronously (`:822`), then transitions to `OPEN` only after `protectiveAttacher.attach` settles (`:867`). Until that transition lands the row is `pending_open`.
2. The local monitor is armed and active during `pending_open` (`LocalProtectiveMonitor.onPriceUpdate` has no state guard — `:157-175`). On an SL/TP breach it synthesizes a CLOSE intent → gate auto-approves de-risking (`RiskGateService.approveDeRisking`, `:411`) → re-emits `ORDER_INTENT_APPROVED_EVENT` (`LocalProtectiveMonitor.ts:325`). (Note: under PAPER the same close can also originate from `StreamingFillAdapter`'s intra-bar SL/TP path — the downstream zombie mechanism is identical.)
3. That CLOSE re-enters `ExecutionService.onOrderIntentApproved` → `handleReduceTerminal` → `applyReduceFillToPosition`. There it: zeros qty + `disarm` + `save` (`:336-345`), writes the **close** transaction (`:360`), then calls `transition(..., CLOSING)` (`:380`).
4. `positionStateGraph.ts:22` allows `pending_open → {open, reconciling}` only. `transition(CLOSING)` from `pending_open` throws `IllegalStateTransitionException` (`PositionService.ts:153-157`).
5. The throw propagates to `onOrderIntentApproved`'s catch (`ExecutionService.ts:104-109`) which logs and releases the reservation — **no rollback**. The `qty=0` save and the close tx are already committed. Permanent zombie.

The three incompatible constraints the WIP names are real and exactly as stated (ADR 0008 §2 arm during `pending_open`; ADR 0009 forbids `pending_open → closing`; execution close assumes a CLOSING-reachable source state). Resolution in §State-machine fix.

### Defect 2 (P0) — Missing `open` transaction rows — **PARTIALLY CONFIRMED; mechanism not provable from static read**

Confirmed: every open fill **must** book an `open` transaction (`recordEntryTransaction`, `ExecutionService.ts:916-937`, awaited at `:831` before attach). Confirmed the table holds only `close` rows.

**Correction to the WIP's implied cause:** the WIP lists "paper submit bypasses `recordEntryTransaction`" as a dig item. That is **not** the cause. Paper soak runs with `EXECUTION_MODE=live` (`AppConfigService.isExecutionLive` = `EXECUTION_MODE===LIVE`, `:274` — independent of `EXCHANGE_ENV`), so opens run the full `executeLive` → `openOrAddPositionAndAttachProtection` path and DO call `recordEntryTransaction`. The `PaperExecutionClient` only substitutes the exchange client; it does not bypass the executor's tx-record step.

I **cannot** prove the omission mechanism from the source alone. Two candidate mechanisms, neither dismissable statically:
- (a) `recordEntryTransaction` ran but its insert raised a unique-violation on `client_order_id` and was swallowed as an idempotent no-op (`TransactionRepository.recordTerminal:67-69`) — would require a prior row under that `clientOrderId`, which the query says does not exist, so this is unlikely.
- (b) `createPositionFromFill` persisted the row, but the breach-close interleaved and an exception was thrown on the OPEN-event task **before** `recordEntryTransaction`'s await resolved/committed. The open path arms the monitor at `:822` and only then `await`s `recordEntryTransaction` at `:831`; a breach firing on the next price tick runs on a separate event-handler task, but it cannot by itself abort the OPEN task's already-issued insert.

**Investigation step (Wave A, before coding Task 2):** grep the 2026-06-11 09:30–11:35 UTC engine logs for `transaction recorded positionId=` (the success line at `ExecutionService.ts:933`), `unhandled execution failure`, and `duplicate transaction for clientOrderId=`. The presence/absence of the success line for the three positions decides between (a)/(b)/(c=a real throw inside `recordTerminal` that escaped). Task 2's fix (move `recordEntryTransaction` before `arm`, and make it fail-loud on a genuine error) is correct regardless of which mechanism the logs confirm, but the ordering choice in Task 2 must respect ADR 0008 §2 — see Task 2.

### Defect 3 (P1) — `risk_state` accounting is wrong — **CONFIRMED, with one correction**

Confirmed: nothing on the happy-path close updates `risk_state`. `RiskListeners.onPositionClosed` (`:153-172`) is alert-only — it books neither `realized_pnl_day` nor `trades_count` and does not decrement `open_exposure`. No other `POSITION_CLOSED_EVENT` listener writes `risk_state` (grep confirmed). `reconcileClose`/`adjustOpenExposure` (`RiskGateService.ts:265,382`) are reconciliation-only paths, never invoked by `applyReduceFillToPosition`.

**Correction / sharpening of the WIP:** the WIP frames `open_exposure` as kept alive "by zombies." More precisely: `open_exposure` is **never** incremented on a happy-path open either — exposure lives only in the in-memory `ReservationLedger` during a run, and `risk_state.open_exposure` is rebuilt **only at boot** by `phase4aRebuildOpenExposure` summing `entry_notional` over non-closed rows (`EngineBootstrapService.ts:209-222`, calling `setOpenExposureFromBoot`, `RiskGateService.ts:188`). So the `1508.35` is a **boot artifact**: a restart on 2026-06-11 summed the three zombie rows' `entry_notional`. This means even a fully-correct close today would NOT decrement `risk_state.open_exposure` during the run — the field is only ever boot-rebuilt, and a close-only decrement is therefore incoherent (it would subtract from an `open_exposure` the open side never raised). Task 4 must therefore keep `open_exposure` correct on **both** the open and the close side within a run — book realized PnL + trade count on close, AND reflect live exposure on open — so the field is correct **within** a run, not just after the next boot. The chosen mechanism is a recompute on both lifecycle events (see Task 4, Option R).

### Defect 4 (P1) — Position row incomplete (`stop_loss`/`take_profit`=null, decision not linked) — **CONFIRMED as a downstream symptom of Defect 1, NOT an independent defect**

Confirmed `stop_loss_price`/`take_profit_price` are not written by `createPositionFromFill` (`:962-979` does not set them). They are intended to be persisted by `applyProtectiveAttachResult` / the `PENDING_OPEN → OPEN` transition step (`:854-870`), which never ran because the breach-close threw first (Defect 1). So Defect 4 is the same root cause: protection-attach + OPEN transition never completed.

**Correction:** the WIP also flags `decisions.position_id` "not linked." This is a **pre-existing, separate gap** — there is no live writer that stamps `decisions.position_id` from the execution path (grep found only the entity definition `DecisionEntity.ts:46` and migrations; no service stamps it on fill). It is NOT caused by Defect 1 and is **out of scope for M31** (it requires threading the eventId→positionId link through the decision-capture path; log as MEDIUM tech-debt). M31 fixing Defect 1 will cause `stop_loss_price`/`take_profit_price` to populate going forward, but will not link `decisions.position_id`.

### Defect 5 (P2) — `findOpen()` mislabels qty=0 zombies as open — **CONFIRMED**

`PositionRepository.findOpen` filters `state != closed` (`:25`). Any qty=0 non-closed row matches. After Defect 1 is fixed, no new zombies are created, but the filter is still structurally permissive (a future partial-failure could reintroduce one). Task 5 narrows the live-risk read.

### Defect 6 (P2?) — Same-bar halt not auto-resuming when calm — **UNCONFIRMED from static read; needs runtime evidence**

The M28 resume path is present and wired: `resolveDayHalt` → `resumeProfileFor(same_bar)` → `isSameBarStillStressed` with `SAME_BAR_RESUME_CLEAR_TICKS` clean ticks (`RiskGateService.ts:562-619`). The WIP's own hypothesis-2 is the most likely explanation and is **a real structural property, not a bug**: the resume counter only advances inside `resolveDayHalt`, which runs only on the **halt branch of an `action=open` gate evaluation** (`firstFailingHaltCheck` → only entered for OPEN/ADD intents; de-risking short-circuits at `evaluate:224`). If the post-halt session produced few/no `action=open` evaluations (most triggers `skip` before reaching the halt check, or the universe went quiet), the clean-tick counter never advanced and the day stayed locked — **working as designed**, not a defect. Additionally the in-memory `stressClearCount` resets to 0 on restart (`:131`, no persistence), so a restart during the calm window discards progress.

**Decision:** do NOT change resume logic in M31 without runtime evidence. **Investigation step:** count `action=open` gate evaluations between the 12:25 engage and 14:05 for the affected day; if there were ≥ `SAME_BAR_RESUME_CLEAR_TICKS` clean ones and it still did not resume, escalate to the architect as a real M28 bug and add a separate task. If there were not enough open-evaluations, this is expected behavior — document it and close Defect 6 as "not a defect." The current corrupt `risk_state` (1508.35 phantom exposure → `exposure_cap_per_coin` rejects) may itself be suppressing the `action=open` evaluations that would tick the counter; repairing the zombies (Task 6 SQL) may clear this symptom on its own.

**Soak-integrity consequence (independent of root cause):** because the halt held from 12:25 through ≥14:05 on calm tape, all three 2026-06-11 fills come from the high-vol opening window only. This makes the day regime-biased and it must be excluded from any strategy-version promotion sample — see §Post-deploy / soak data integrity. This constraint binds whether or not Defect 6 turns out to be a real bug.

---

## State-machine fix — option evaluation (Defect 1)

The three options from the WIP, evaluated against ADR 0008 §2 and ADR 0009 §3:

- **(A) Add `pending_open → reconciling` edge already exists; route the protective exit via `reconciling` two-step.** `pending_open → reconciling` is already legal (`positionStateGraph.ts:22`), and `reconciling → closed` is legal (`:25`). But `reconciling` is defined as a **drift-hold** state (ADR 0009 §1: "Blocked — no new intents until reconciliation resolves") and its `→ closed` semantics carry `exit_reason=reconciled_missing` with `realized_pnl` left null (ADR 0009 §4). Routing a **known, fully-filled protective close** through `reconciling` would mislabel a clean SL/TP exit as a drift cleanup and **discard realized PnL** — a worse correctness outcome than the zombie. Rejected.

- **(B) Add `pending_open → closing` edge (relax ADR 0009 §3).** Minimal graph change (one Set entry). But ADR 0009 §3/§6.3 explicitly forbids it with a stated safety rationale: "guards against issuing a reduce before protection is confirmed" — a `pending_open` row may not have a confirmed protective geometry, and allowing a direct reduce could fire on an unprotected/half-attached position. Relaxing it weakens the guard for **all** `pending_open` reduces, not just monitor breaches. Rejected as too broad.

- **(C) Delay arming the monitor until `OPEN` is confirmed.** Directly violates ADR 0008 §2/§4 — the single most important survival invariant ("no open position is ever left unprotected, even for one tick"). The arm is mandatory and synchronous **during** `pending_open` precisely so a crash or slow attach cannot leave the position unprotected. Rejected — never weaken the always-protected invariant.

### Chosen approach — **(A′) two-step through `open`, mirroring ADR 0009 §6.3's own prescription**

ADR 0009 §6.3 already states the intended resolution verbatim: *"If a kill-switch flatten fires on a `pending_open` row, the gate moves it `pending_open → open → closing` in two transitions, both written."* The same rule applies to a monitor-breach close. The fix is to make `applyReduceFillToPosition` (and any reduce-family terminal landing on a `pending_open` source) **first transition `pending_open → open`** (a legal edge, `:22`) before the existing `→ closing → closed` sequence. This:
- preserves ADR 0008 §2 (monitor stays armed throughout — no change to arming),
- preserves ADR 0009 §3 (`pending_open → closing` stays illegal; we never take that edge),
- reuses the existing legal edges (`pending_open → open`, `open → closing`, `closing → closed`),
- correctly books realized PnL via the normal `finalizeRealizedPnl` close path (no `reconciled_missing` mislabel).

**ADR update required:** ADR 0009 §6.3 currently describes this only for the kill-switch flatten case. Add an explicit clause generalizing the `pending_open → open → closing` two-step to **any** reduce-family terminal whose source row is still `pending_open` (monitor breach, strategy close racing the open), and name `ExecutionService.applyReduceFillToPosition` as the enforcing site. The `pending_open → open` transition in this case uses `eventClass='execution.reduce.fill.terminal.pending_promote'` and does **not** require protective-attach to have completed (the position is being closed in the same tick, so the always-protected window collapses). No graph edge is added or removed.

---

## Ordered fix tasks

### Wave A

#### Task 1 — Make the reduce-family close path `pending_open`-safe (Defect 1)
- **File:** `ExecutionService.ts`, `applyReduceFillToPosition` (`:255-417`), specifically the closing-fill branch (`:335-410`).
- **CRITICAL — insertion point (corrected).** In the current source the `transition(..., CLOSING)` call (`:380`) runs **after** all four irreversible writes of the closing-fill branch: `position.qty = 0` (`:336`), `disarm` (`:343`), `await positions.save` (`:345`), and `await transactions.recordTerminal(close)` (`:360`). Inserting the `pending_open → open` promote immediately before `transition(CLOSING)` would therefore do **nothing** to close the zombie window — the qty=0 save and the committed close-tx already exist by then, so a promote failure still leaves a flat, close-tx'd, non-terminal row. The promote MUST run **before** any of those writes.
- **Change — minimal correct ordering for the closing-fill branch when source state is `PENDING_OPEN`:**
  1. **Before** zeroing qty, before `disarm`, and before the close-tx insert: branch on `position.state`. If `position.state === PENDING_OPEN`, call `positionService.transition(position.id, OPEN, { nowMs, eventClass: 'execution.reduce.fill.terminal.pending_promote' })`.
  2. If that promote throws: emit `ORDER_INTENT_UNKNOWN_EVENT` (positionId set, reason e.g. `'pending_promote_failed'`), log error-level with positionId + source state, release the reservation, and **return** — **no** qty mutation, **no** `disarm`, **no** close-tx committed. Nothing is written, so the failure is clean.
  3. Only on promote success (or when source state is already `OPEN`/`CLOSING`, which behave exactly as today): proceed to zero qty, `disarm`, `save`, write the close tx, `transition(OPEN → CLOSING)`, then `finalizeRealizedPnl(CLOSING → CLOSED)` unchanged.
  - Restructure so the promote is a guard at the **top** of the closing-fill block, not a wrapper around the existing write sequence. The existing `transition(CLOSING)`/`finalize` errors remain logged + escalated as before, but the load-bearing safety is that the promote precedes every write.
- **Why minimal:** reuses three existing legal edges; the key insight is that the promote runs **before any write**, so a promote failure leaves nothing committed (clean abort) — unlike the current code where a `CLOSING`-transition failure leaves an already-committed qty=0 save and close-tx (the exact zombie). On promote success the close path proceeds normally. No graph change, no new state, no shared-type change. Directly implements ADR 0009 §6.3's own prescription.
- **Cross-cutting:** none. No shared-type change.

#### Task 2 — Guarantee the entry transaction is booked and fail-loud (Defect 2) — **investigation-first**
- **Pre-req (Wave A pre-step, blocking):** the log investigation in §Defect 2. Grep the 2026-06-11 09:30–11:35 UTC logs for the three positions; determine whether `recordEntryTransaction`'s insert ran-but-was-swallowed, threw, or never ran.
- **File:** `ExecutionService.ts`, `openOrAddPositionAndAttachProtection` (`:793-874`).
- **DEFAULT change (strictly safer minimal — do this regardless of log outcome):** make `recordEntryTransaction` **fail-loud without moving the arm**. If `recordTerminal` throws for a non-duplicate reason, log at error level and emit `ORDER_AUDIT_PERSIST_FAILED_EVENT` (the same event the zero-fill path already uses, `:1074`) so a missing open-tx is never silent again. Additionally: because a throw here on a **live** exchange fill leaves the engine holding an **unprotected/unaudited live position** (Gemini), this path MUST emit a critical alert and trigger immediate reconciliation (escalate via `ORDER_INTENT_UNKNOWN_EVENT` with positionId set, or the established recon trigger) — this requirement holds whether the arm is before or after the tx insert. The arm ordering stays exactly as today (`:821-829`); only the audit log becomes louder.
- **CONDITIONAL change (arm/tx reorder — gated, do NOT do by default):** moving `recordEntryTransaction` ahead of `localProtectiveMonitor.arm` is **only** justified if the logs show the tx insert never ran (threw) AND it requires an explicit **ADR 0008 §2 amendment in the same diff plus architect sign-off**. ADR 0008 §2 locks the arm **before any awaited I/O** — not merely before the exchange-side attach — so moving the awaited tx insert ahead of `arm` widens the unprotected-crash window (DB row exists, monitor not yet armed, no protection during the tx-insert await). That is a real safety regression and must not be made silently.
- **State explicitly in the diff/PR:** "Do NOT move arm-after-tx-insert without an explicit ADR 0008 §2 amendment in the same diff and architect sign-off. Default path is fail-loud only; arm ordering unchanged."
- **Why minimal:** the default is an error-escalation on an existing helper — no new event type, no ordering change. The reorder is escalation-gated and may be rejected outright in favor of the fail-loud-only path.
- **Cross-cutting:** **STOP and ping the architect** before landing the conditional reorder — the arm/attach/record ordering is governed by ADR 0008 §2 (`dev-qa-cycle.md` §1.3). The fail-loud default needs no ADR change; the reorder needs an ADR 0008 §2 amendment + sign-off or must be dropped.

#### Task 3 — (graph) confirm no edge change; add a documentation comment
- **File:** `positionStateGraph.ts`.
- **Change:** **none to the edge set.** Add a one-line comment at the `PENDING_OPEN` entry noting that a reduce-family close on a `pending_open` row promotes through `open` first (Task 1), so `pending_open → closing` stays deliberately absent. This prevents a future reviewer from "fixing" the graph by adding the forbidden edge.
- **Why minimal:** zero behavior change; encodes the ADR 0009 §6.3 rationale at the code site.

### Wave B

#### Task 4 — Book `risk_state` on lifecycle events (Defect 3)
- **Accounting model — Option R (recompute), chosen.** The plan must state a *coherent* model because `risk_state.open_exposure` is **never incremented on a happy-path open during a run** — it is only ever boot-rebuilt (`phase4aRebuildOpenExposure`, `EngineBootstrapService.ts:209-222`). A close-only decrement is therefore incoherent: after the repair SQL sets `open_exposure=0`, the next paper open would not increment it, so when that position later closes a close-only listener would subtract from 0 and clamp to 0 — `open_exposure` would never reflect the live position, and the success criterion ("`risk_state` tracks live exposure within a run") would be unsatisfiable. We choose **recompute** because it is naturally idempotent and avoids incremental-drift + duplicate-event problems entirely.
- **Confirmed event landscape:** `POSITION_OPENED_EVENT` (`execution.position.opened`) exists and is emitted reliably at `ExecutionService.ts:873` after the `PENDING_OPEN → OPEN` transition — but it carries only `{ positionId, symbol }` (no notional). `POSITION_CLOSED_EVENT` fires at `:402`. Option I (incremental) would require widening **both** payloads and durable idempotency guards on both sides; recompute needs neither, so Option I is rejected for M31.
- **Files:** a small risk-side listener (preferred: a new `RiskStateLifecycleListener` in the risk module, or extend an existing risk-side listener — NOT `RiskListeners` in the alert module, which is alert-only by design per its header). Uses `RiskStateRepository.upsertDay`.
- **Change:** subscribe to **both** `POSITION_OPENED_EVENT` and `POSITION_CLOSED_EVENT`. On either event, run a lightweight recompute of the UTC-day row and upsert it:
  - `open_exposure = SUM(qty * entryPrice) WHERE state != CLOSED AND qty > 0` (live residual notional across all live-risk rows — uses the residual formula, *not* `entry_notional`; see below).
  - `realized_pnl_day = SUM(realized_pnl) WHERE state = CLOSED AND closed_at UTC-day = today`.
  - `trades_count = COUNT(*) WHERE state = CLOSED AND closed_at UTC-day = today`.
  - This is one DB read per lifecycle event (acceptable at paper-soak fill frequency). Reuse `PositionRepository.findClosedOnUtcDay` for the close-side aggregates; add a small live-risk aggregate query (or reuse the `qty > 0 AND state != CLOSED` predicate from Task 5's `findLiveRisk`).
- **Idempotency is automatic.** The recompute is a pure SELECT-then-upsert: it is always correct and can run N times for the same event with no double-book. **Do NOT "rely on the event firing exactly once"** — that is not an idempotency guarantee and is removed from this plan.
- **Residual notional, not `entry_notional`.** `entry_notional` is immutable after ADDs and is **not** reduced on partial reduces (only `qty` changes via `adjustQty`), so for any position with ADDs/partial-reduces it overstates live exposure. The live-exposure recompute therefore sums `qty * entryPrice` (the residual, matching `reconcileClose`, `RiskGateService.ts:286`), evaluated over the current DB rows at recompute time. Because recompute re-derives from the live `qty` of every row, a closed row (qty=0) naturally drops out — there is no "read-back reads qty=0" hazard here (that hazard only applied to the rejected incremental close-side decrement).
- **Partial reduces out of scope for M31.** The recompute keeps `open_exposure` correct for full opens and full closes within a run. A *partial* reduce changes `qty` but does not currently fire a lifecycle event the listener subscribes to, so the recompute will not run until the next OPEN/CLOSE — between a partial reduce and the terminal close, `open_exposure` will overstate by the partially-closed residual. This is acceptable for M31 (paper soak runs full opens/closes); add a MEDIUM tech-debt entry to fire a recompute on the partial-reduce path in M32.
- **Why minimal:** one listener on two existing events + one live-risk aggregate query; reuses `upsertDay`; naturally idempotent; coherent for both the open and close side of the run. No event-payload change, no shared-type change.
- **Cross-cutting:** none to `packages/shared/`. No `IPositionClosedEvent` / `IPositionOpenedEvent` payload change is required (recompute reads the DB, not the payload).

#### Task 5 — Distinguish live risk from lifecycle residue (Defect 5)
- **Files:** `PositionRepository.ts` (`findOpen` `:24-26`, `findOpenBySymbolAndSlot` `:35-37`), `ReconciliationService.ts` (`loadNonClosedPositions` `:1418-1422`), `ExecutionService.ts` (`applyReduceFillToPosition`, the reduce-target load `:257`).
- **`findNonTerminal()` is MANDATORY, not conditional.** `ReconciliationService.loadNonClosedPositions()` **currently calls `findOpen()`** (confirmed `:1419`). If `findOpen` is narrowed to `qty > 0`, reconciliation goes **blind to qty=0 zombies** — the exact failure mode M31 exists to detect. So this is not optional:
  - Add `findNonTerminal()` → `state != CLOSED`, **any qty** (the broad recon view).
  - Add `findLiveRisk()` → `qty > 0 AND state != CLOSED` (the live-risk view), **or** narrow `findOpen` itself to `qty > 0 AND state != CLOSED` and have the live-risk callers use it. Either way the two semantics must be distinct named methods.
  - **Wire in the same Wave B diff:** point `ReconciliationService.loadNonClosedPositions()` at `findNonTerminal()` (so recon still sees zombies); point boot exposure rebuild (`phase4aRebuildOpenExposure`), slot-occupancy (`RiskGateService.occupiedSlots`), Task 4's live-exposure recompute, and the read-API `/v1/positions/open` at the `qty > 0` view (live risk only).
- **`findOpenBySymbolAndSlot` (GBT M3 — review in the same scope).** The reduce path loads its target through `findOpenBySymbolAndSlot` (`ExecutionService.ts:257`), which is `state != CLOSED` only (no qty guard). Decide one of:
  - keep it non-closed-only (so an ADD can still target a `pending_open` row), **and** add a guard in `applyReduceFillToPosition` — if the loaded `position.qty <= 0`, do **not** write another close row; escalate to reconciliation (`ORDER_INTENT_UNKNOWN_EVENT`, positionId set) instead. This protects against applying a second close to an already-flat row; **chosen** (less invasive than changing the shared lookup the ADD path also uses).
  - (rejected) add `qty > 0` to `findOpenBySymbolAndSlot` directly — it would break the ADD-onto-`pending_open` lookup if that ever has qty already set, and silently turn a flat-row reduce into a "missing position" instead of an explicit escalation.
- **Why minimal:** two named repository methods with distinct, intention-revealing predicates + one explicit recon wiring + one flat-row guard on the reduce path. Each caller gets the semantics it actually wants.
- **Cross-cutting:** none to `packages/shared/`. Verify every `findOpen` caller is repointed correctly in the same diff (orchestrator-verified).

#### Task 6 — Boot hardening: zombie-safe exposure rebuild + monitor re-arm (boot)
- **File:** `EngineBootstrapService.ts`, `phase4aRebuildOpenExposure` (`:209-222`) and `phase4cRearmLocalMonitor` (`:235-261`).
- **Change (4a):** two corrections. (i) **Use the residual formula** — sum `qty * entryPrice` (the live residual notional, matching `reconcileClose` `RiskGateService.ts:286` and ADR 0014 §4a), **not** `entry_notional`, over all qty-positive, non-closed, non-`MANUAL_ADOPTED_UNMANAGED` rows. `entry_notional` is immutable after ADDs and not reduced on partial reduces, so summing it overstates exposure for any post-ADD/post-reduce row; the residual is the correct boot exposure. (ii) **Exclude `qty.lessThanOrEqualTo(0)` rows** (in addition to the existing `MANUAL_ADOPTED_UNMANAGED` exclusion) — a flat row contributes zero real exposure; summing its notional is exactly what produced `1508.35` (and with the residual formula a flat row contributes `0 * entryPrice = 0` anyway, but keep the explicit guard for clarity/defense-in-depth). If Task 5 narrows the live-risk view, phase 4 should load via that `qty > 0` view — but keep the explicit qty guard here regardless (boot must be correct independent of the repository method used).
- **Change (4c):** skip re-arming the monitor for `qty.lessThanOrEqualTo(0)` rows — a flat position has nothing to protect; arming it re-creates a dead armed entry that could fire a spurious breach. Add `if (position.qty.lessThanOrEqualTo(0)) continue;` alongside the existing state/protective-type guards (`:242-248`).
- **Why minimal:** two `continue` guards; no new query. Makes boot idempotent against any qty=0 residue that escapes Task 1.
- **Cross-cutting:** **STOP and ping the architect** — boot exposure rebuild is governed by ADR 0014 §4a. This plan pre-blesses the qty=0 exclusion; ADR 0014 gets the amendment in §ADRs.

---

## Tests required (scenario descriptions — adversarial is the bar)

All must pass before merge. Each fix item ships with a paired happy-path + adversarial test (`dev-qa-cycle.md` §2).

- **D1 (Task 1, happy):** a position in `PENDING_OPEN` receives a monitor SL/TP breach close fill → ends `CLOSED` with `closed_at`, `exit_reason`, `realized_pnl` set; monitor disarmed; `POSITION_CLOSED_EVENT` emitted; **no row left at `pending_open` with qty=0**.
- **D1-adv (Task 1) — pre-write failure:** a position in `PENDING_OPEN` whose `pending_open → open` promote transition itself throws (forced) → assert **zero close transactions were committed** for that positionId, the row is **NOT** at `qty=0` with a non-terminal state (no writes happened), and the failure is escalated via `ORDER_INTENT_UNKNOWN_EVENT` (positionId set). This is the case the prior plan did not cover: the promote runs before any write, so a promote failure must leave nothing committed.
- **D1-adv-2 (Task 1):** same-tick race — the strategy close intent and the monitor breach both land on a `pending_open` row → exactly one close completes, no double-close, no zombie. **Assert the occupied slot count never exceeds 1** across the full `pending_open → open → closing` promote window (the two-step promote must not transiently double-count the slot while both intents are in flight) — not merely that no double-close occurs.
- **D2 (Task 2, happy):** every OPEN fill produces exactly one `open` transaction row; the success log line fires.
- **D2-order (Task 2, ordering clarification):** assert the **default** path keeps arm ordering unchanged — `localProtectiveMonitor.arm` is invoked **before** `recordEntryTransaction` (matching today's `:821→:831` order). The reorder is escalation-gated and NOT part of the default diff; this test pins that the default change does not move the arm.
- **D2-adv (Task 2):** `recordEntryTransaction` raises a non-duplicate DB error on an open fill → `ORDER_AUDIT_PERSIST_FAILED_EVENT` is emitted at error level **and** a reconciliation escalation fires (`ORDER_INTENT_UNKNOWN_EVENT`, positionId set) — no silent one-legged ledger, and an unprotected/unaudited live position is never left un-escalated.
- **D3 (Task 4, happy — recompute):** open one position (full open), then close it. After `POSITION_OPENED_EVENT` the recompute sets `risk_state.open_exposure = qty * entryPrice` (the live residual, non-zero) within the run. After `POSITION_CLOSED_EVENT` the recompute sets `open_exposure = 0` (no live-risk rows remain), `trades_count = 1`, and `realized_pnl_day = realized_pnl`. Assert the open-side exposure equals `qty * entryPrice` (residual formula, NOT `entry_notional`) and the close-side exposure returns to 0 — all within the same run, no boot.
- **D3-adv (Task 4 — idempotency by recompute):** firing the same `POSITION_CLOSED_EVENT` twice (or a `POSITION_OPENED_EVENT` followed by a duplicate) leaves `trades_count`, `realized_pnl_day`, and `open_exposure` **identical** to the single-fire result — the recompute is a SELECT and cannot double-book. Assert no negative `open_exposure` and no double-count across the duplicate.
- **D3-residual (Task 4 — residual vs entry_notional):** a position that had an ADD (so `entry_notional` > `qty * entryPrice` would diverge — construct entry_notional to overstate the residual) → after close, assert the open-side recompute used `qty * entryPrice`, not `entry_notional` (i.e. the live exposure while open equaled the residual, not the gross-at-open).
- **D4 (Task 6, boot):** boot does NOT re-arm the monitor on a qty=0 `pending_open` row, and `phase4aRebuildOpenExposure` rebuilds `open_exposure` as `SUM(qty * entryPrice)` over qty-positive non-closed rows (a DB with three qty=0 zombies rebuilds `open_exposure=0`, not 1508.35). Add a case with one live qty-positive row that had an ADD → assert the rebuilt exposure equals `qty * entryPrice` (residual), NOT `entry_notional`.
- **D5 (Task 5):** the live-risk view (`findLiveRisk()` / narrowed `findOpen`) does not return qty=0 rows; slot-occupancy and exposure callers see only live-risk rows.
- **D5-adv (Task 5 — recon must still see zombies):** a qty=0 `pending_open` zombie is **visible to reconciliation** via `findNonTerminal()` (so the reconciler can take ownership) but **absent** from the live-risk view (`findOpen`/`findLiveRisk`) and from slot occupancy. This pins that narrowing the live-risk read does NOT blind reconciliation — `ReconciliationService.loadNonClosedPositions()` is wired to `findNonTerminal()`.
- **D5-flat-reduce (Task 5, GBT M3):** a reduce/close fill lands on a row whose `qty` is already `<= 0` (flat) → `applyReduceFillToPosition` does **NOT** write a second close transaction; it escalates via `ORDER_INTENT_UNKNOWN_EVENT` (positionId set) to reconciliation instead.
- **D6 (only if §Defect 6 runtime evidence confirms a real bug):** after engage, N=`SAME_BAR_RESUME_CLEAR_TICKS` consecutive calm `action=open` evaluations auto-resume the same-bar halt. If runtime evidence shows the resume path is correct and the day simply lacked open-evaluations, **no test is added** — close Defect 6 as not-a-defect with a work-log note.

---

## Milestone scope — code-only, no migration

**Code-only. No schema migration.** Every fix operates over existing columns (`state`, `qty`, `entry_price`, `entry_notional`, `realized_pnl`, `risk_state.*`). No column is added or altered. Task 4 uses Option R (recompute) and reads the DB, so **no event-payload change and no `packages/shared/` change** are needed; M31 stays engine-only (no `bot-shared-maintainer` dispatch). The three corrupt live rows are repaired by one-time UPDATEs (§Data repair), which are **not** a migration and are run manually after a dump.

---

## Data repair SQL (one-time; current soak DB only — NOT a migration)

Run **after** the pg_dump (CLAUDE.md hard-rule 9) and **after** the engine is stopped for the restart, so no concurrent writer races the repair. These flip the three zombies to a correct terminal state and rebuild `risk_state` to economic reality.

### Detect first (from the WIP, plus added cross-checks)

```sql
-- (1) Zombies: flat qty but non-closed
SELECT positions_id, symbol, state, qty, entry_notional, opened_at
FROM positions
WHERE state <> 'closed' AND qty = 0;

-- (2) One-legged audit: close without open
SELECT p.positions_id, p.symbol, p.state,
       SUM(CASE WHEN t.type = 'open'  THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN t.type = 'close' THEN 1 ELSE 0 END) AS closes,
       SUM(CASE WHEN t.type IN ('reduce','close') THEN t.cashflow ELSE 0 END) AS close_cashflow,
       SUM(CASE WHEN t.type <> 'funding' THEN t.fee ELSE 0 END) AS fees
FROM positions p
LEFT JOIN transactions t ON t.position_id = p.positions_id
GROUP BY p.positions_id, p.symbol, p.state
HAVING SUM(CASE WHEN t.type = 'close' THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN t.type = 'open'  THEN 1 ELSE 0 END) = 0;

-- (3) Exposure lie
SELECT date, open_exposure, realized_pnl_day, trades_count, is_halted, halt_reason
FROM risk_state WHERE date = CURRENT_DATE;

-- (4) ADDED — derive the correct realized PnL per zombie from its ledger (fee-net),
--     and the correct vol-weighted exit price, so the row repair is exact not eyeballed.
--     NOTE on cashflow semantics: a close-tx `cashflow` is the side-aware realized PnL
--     delta per `pnlMath.computeFillCashflow` (LONG: (exitPrice - entryPrice) * qty) —
--     it is NOT gross notional. With only the close leg present, this query's fee-net
--     sum IS the correct realized PnL; it is not inflated by position size.
SELECT t.position_id,
       SUM(CASE WHEN t.type IN ('reduce','close') THEN t.cashflow ELSE 0 END)
         - SUM(CASE WHEN t.type <> 'funding' THEN t.fee ELSE 0 END)
         + SUM(CASE WHEN t.type = 'funding' THEN t.cashflow ELSE 0 END) AS realized_pnl,
       SUM(CASE WHEN t.type IN ('reduce','close') THEN t.price * t.qty ELSE 0 END)
         / NULLIF(SUM(CASE WHEN t.type IN ('reduce','close') THEN t.qty ELSE 0 END), 0) AS exit_price,
       MAX(t.created_at) FILTER (WHERE t.type IN ('reduce','close')) AS closed_at
FROM transactions t
WHERE t.position_id IN (1, 2, 3)
GROUP BY t.position_id;

-- (5) ADDED — confirm there is no live exchange position for these symbols before
--     marking closed (economic-reality guard; PAPER has no exchange, so this is a
--     sanity check on paper_account_state instead — confirm flat).
SELECT * FROM paper_account_state;  -- expect no open position for VVV / XMR / ORCL
```

### Repair (run inside a single transaction; replace literals with query-(4) outputs)

**UTC-day note:** engine and `risk_state` keys are UTC-day based. Do NOT use `closed_at::date = CURRENT_DATE` — `CURRENT_DATE` is session-timezone dependent and will mis-bucket rows near the UTC day boundary. Either `SET TIME ZONE 'UTC'` for the session, or use the explicit UTC half-open range shown below.

**Row-count assertions:** each individual position UPDATE must affect **exactly 1** row, and the `risk_state` UPDATE exactly 1 row. If any count is 0 (wrong id / state drifted) or >1 (predicate too broad), ROLLBACK and re-inspect — never COMMIT a repair that touched the wrong number of rows. A `DO` block with `ASSERT` (or `GET DIAGNOSTICS ... ROW_COUNT` + explicit `RAISE`) enforces this atomically inside the txn.

```sql
BEGIN;

-- Repair each zombie row: set CLOSED + terminal fields from its own ledger (query 4).
-- exit_reason = 'stop_loss' for the two SL exits and the TP exit respectively —
-- read the breach kind from logs; default to 'signal' only if logs are ambiguous.
-- Each UPDATE must affect EXACTLY 1 row — assert and ROLLBACK otherwise.
DO $$
DECLARE affected integer;
BEGIN
  UPDATE positions SET
    state = 'closed', status = 'closed',
    closed_at = :closed_at, exit_price = :exit_price,
    realized_pnl = :realized_pnl, exit_reason = :exit_reason
  WHERE positions_id = :id AND state = 'pending_open' AND qty = 0;
  GET DIAGNOSTICS affected = ROW_COUNT;
  ASSERT affected = 1, format('position repair :id touched %s rows (expected 1)', affected);
END $$;
-- repeat the DO block for ids 2 and 3 (each asserts exactly 1).

-- Rebuild today's risk_state to economic reality:
--   open_exposure  -> 0 (account is flat)
--   realized_pnl_day -> SUM of the three FEE-NET realized PnLs (query-4 output).
--     Note: +4.07 +3.12 -6.07 = +1.12 is the GROSS (pre-fee) close cashflow per the WIP
--     table. The repaired realized_pnl_day will be BELOW +1.12 by the sum of trading
--     fees across all three positions. Do NOT expect it to equal +1.12 — verify only
--     that query-4 / query-(4-net) returns a non-zero net value, not a specific figure.
--   trades_count   -> 3
-- UTC-day predicate uses an explicit half-open range, NOT closed_at::date = CURRENT_DATE.
-- The risk_state UPDATE must affect EXACTLY 1 row — assert and ROLLBACK otherwise.
DO $$
DECLARE
  affected integer;
  utc_day_start timestamptz := DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC');
BEGIN
  UPDATE risk_state SET
    open_exposure = 0,
    realized_pnl_day = (SELECT COALESCE(SUM(realized_pnl), 0) FROM positions
                        WHERE state = 'closed'
                          AND closed_at >= utc_day_start
                          AND closed_at <  utc_day_start + INTERVAL '1 day'),
    trades_count = (SELECT COUNT(*) FROM positions
                    WHERE state = 'closed'
                      AND closed_at >= utc_day_start
                      AND closed_at <  utc_day_start + INTERVAL '1 day')
  WHERE date = (utc_day_start)::date;
  GET DIAGNOSTICS affected = ROW_COUNT;
  ASSERT affected = 1, format('risk_state repair touched %s rows (expected 1)', affected);
END $$;

-- Re-run detector queries (1)–(3) inside the txn; if zombies = 0 and exposure = 0, COMMIT.
COMMIT;  -- else ROLLBACK and re-inspect.
```

The missing `open` transaction rows are **not** back-filled — there is no trustworthy entry-fill `client_order_id`/`exchange_order_id` to synthesize, and a fabricated audit row is worse than an acknowledged gap. The one-legged-audit detector (query 2) will continue to flag these three historical positions; that is acceptable and documented. **Consequence for analysis:** with no entry leg, these three positions cannot supply entry-slippage or decision→fill geometry and are excluded from M27/M30 idiosyncrasy entry-leg queries (close-side realized PnL only) — see §Post-deploy / soak data integrity.

---

## Deploy / repair sequence

1. **pg_dump** (CLAUDE.md hard-rule 9): `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`; prune to 2 most recent. Show the operator the path; get explicit confirmation.
2. **Stop the engine** (no concurrent writer during repair). No `down -v`, no volume ops (hard-rule 8).
3. **Run detector queries** (1)–(5); record outputs.
4. **Run the repair transaction**; re-run detectors inside the txn; COMMIT only if zombies = 0 and `open_exposure = 0`.
5. **Merge M31** (after both engine waves + full review converge to zero blockers/highs, majority mediums — CLAUDE.md hard-rule 6).
6. **Restart the engine.** Boot phase 4a now rebuilds `open_exposure = 0` (no zombies remain; qty=0 guard is defense-in-depth). Phase 4c arms nothing dead.
7. **10-min live smoke** (memory: milestone-app-smoke): confirm boot completes (`engine boot pipeline COMPLETE`), `risk_state.open_exposure = 0`, no `IllegalStateTransition` in logs, no spurious breach from a re-armed dead row.
8. **First-fill watch:** on the next gate-approved paper open, confirm: an `open` transaction row appears; the row reaches `OPEN`; `risk_state.open_exposure` rises to `qty * entryPrice` on the open (recompute on `POSITION_OPENED_EVENT`); then on exit the row reaches `CLOSED` with terminal fields and the recompute returns `open_exposure` to 0 and increments `trades_count` — all **within the run** (no boot needed).

**Success criteria:** zero rows match detector query (1) going forward; every open fill has an `open` tx (query 2 finds no NEW one-legged positions); `risk_state` tracks live exposure/PnL/trade-count within a run **on both the open and close side** — `open_exposure` rises to `SUM(qty * entryPrice)` on a fresh open (recompute on `POSITION_OPENED_EVENT`) and falls to 0 on full close, with `trades_count`/`realized_pnl_day` booked on close — no boot required; query-4 (fee-net) returns a non-zero net `realized_pnl_day` (do NOT gate on it equaling +1.12 — see data-repair note); `/v1/positions/open` shows only live-risk rows; reconciliation still sees qty=0 zombies via `findNonTerminal()`.

---

## Post-deploy / soak data integrity

The three 2026-06-11 paper fills are real economic events, but the surrounding data is too degraded to feed the edge-evaluation pipeline cleanly. Two hard constraints bind any downstream use of this soak window:

- **Regime-truncated window — EXCLUDE from any v(n)/v(n+1) promotion decision.** The same-bar halt engaged at 12:25 UTC and persisted through ≥14:05 on calm tape (Defect 6). All three fills are therefore drawn exclusively from the high-volatility opening window; the post-engage calm session produced no fills. This is **survivorship/regime bias**: the edge-vs-random comparison (M27/M30) over this window is not representative of the strategy's full-day behavior. **Regardless of whether Defect 6 is ultimately a bug or working-as-designed, the 2026-06-11 soak window MUST be excluded from any strategy-version promotion (v(n) → v(n+1)) decision.** Flag this as a soak-integrity prerequisite before any version promotion: the M27/M30 promotion gate query must filter this date out (or the operator must confirm the window is not part of the promotion sample).
- **Three positions excluded from idiosyncrasy entry-leg analysis (M27/M30).** Because the `open` transaction rows for positions 1–3 are missing and cannot be trustfully back-filled (§Data repair), these three trades **cannot supply entry-slippage or decision→fill reconciliation** — only close-side realized PnL is recoverable from the ledger. Therefore: the three 2026-06-11 positions **are excluded from idiosyncrasy entry-slippage analysis and from any decision→fill geometry reconciliation** (M27/M30 queries). They **MAY** contribute their (close-side) realized PnL to cumulative PnL tracking, but **MUST NOT** be used for entry-slippage or decision→fill-geometry metrics. Any M27/M30 idiosyncrasy query that joins on the entry leg must left-anti-join these three position ids.

---

## ADRs to amend

- **ADR 0009 (state machine) §6.3:** generalize the existing kill-switch `pending_open → open → closing` two-step to **any** reduce-family terminal whose source row is `pending_open` (monitor breach, strategy close racing the open). Name `ExecutionService.applyReduceFillToPosition` as the enforcing site. State explicitly that `pending_open → closing` remains illegal and the graph is unchanged. Add the `pending_open → open` promote `eventClass='execution.reduce.fill.terminal.pending_promote'`.
- **ADR 0012 (funding & PnL) §5:** add a clause that `risk_state.realized_pnl_day` / `trades_count` / `open_exposure` are kept current within a run by a **recompute** on `POSITION_OPENED_EVENT` and `POSITION_CLOSED_EVENT` (Task 4, Option R), not only via reconciliation (`reconcileClose`) and boot rebuild. Document: (i) pre-M31 these fields were only boot-rebuilt, which is why exposure was stale within a run; (ii) the recompute derives `open_exposure` as `SUM(qty * entryPrice)` over qty-positive non-closed rows (residual notional, matching `reconcileClose` and ADR 0014 §4a), never `entry_notional`; (iii) the recompute is naturally idempotent (SELECT-then-upsert), so duplicate events cannot double-book.
- **ADR 0014 (crash recovery) §4a:** (i) change the phase-4a `open_exposure` rebuild to sum the **residual** `qty * entryPrice` (matching `reconcileClose`), not `entry_notional` — `entry_notional` overstates exposure for post-ADD/post-reduce rows; (ii) add the qty=0 exclusion to the phase-4a rebuild and the phase-4c monitor re-arm. Rationale: a flat (qty=0) non-closed row carries zero real exposure and nothing to protect; including it rebuilt phantom exposure and re-armed dead positions.
- **ADR 0008 (SL/TP attach):** **no change in the default path** — §2 (arm during `pending_open`, before any awaited I/O) is preserved: Task 2's default is fail-loud-only with the arm ordering unchanged. The **conditional** reorder (move the entry-tx insert ahead of `arm`) is NOT consistent with §2 as written — §2 locks arm before any awaited I/O, not merely before the exchange-side attach — so it requires an explicit ADR 0008 §2 amendment in the same diff plus architect sign-off, or must be dropped. Do not treat the reorder as a free work-log note.

## Out of scope / follow-on tech-debt

- **`decisions.position_id` not linked** (Defect 4 correction): pre-existing capture gap, no live writer stamps it. Log MEDIUM tech-debt; needs the eventId→positionId link threaded through decision capture.
- **ADD and partial-reduce `open_exposure` recompute** (Task 4 scope cut): the Option-R recompute only runs on `POSITION_OPENED_EVENT` / `POSITION_CLOSED_EVENT`. `applyAddToExistingPosition` emits no lifecycle event and does not re-emit `POSITION_OPENED_EVENT`, so an ADD that increases `qty` (and therefore residual notional) will not trigger a recompute — `open_exposure` *understates* by the added residual until the next OPENED or CLOSED event. Symmetrically, a *partial* reduce changes `qty` without firing either event, so `open_exposure` *overstates* by the partially-closed residual until the terminal close re-triggers the recompute. Both gaps are acceptable for M31 (paper soak runs full opens/closes; per-coin cap is the binding control). Log MEDIUM tech-debt: fire a recompute (or a dedicated ADD/reduce lifecycle event) on the ADD and partial-reduce paths in M32.
- **Defect 6 same-bar resume:** gated on runtime evidence (§Defect 6). If confirmed a real bug, separate task; if expected behavior, close with a work-log note.
- **Missing historical `open` tx rows** for positions 1–3: acknowledged gap, not back-filled.
- **`closed_at` UTC-bucket watch item** (low frequency): `positions.closed_at` is set from `nowMs = Date.now()` at transition/finalize — wall-clock at close, not fill-event time. A close fill arriving seconds before 00:00 UTC but processed after could bucket into the wrong UTC day in Task 4's recompute (`realized_pnl_day`/`trades_count`). Low frequency at paper soak cadence; no code change for M31, but monitor on any day where soak runs through the UTC midnight boundary.
