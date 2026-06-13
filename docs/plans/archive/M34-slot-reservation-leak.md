---
adr: [0004, 0009, 0010, 0012]
modules: [risk, execution, position]
---

# M34 — Slot-reservation leak on the normal close path

**Status:** ACTIVE
**Type:** Bug-fix milestone. Engine-only. **No schema migration**. **No `packages/shared/` change** (verify in Wave 1 — the fix is contained in the engine risk/execution layer).
**Severity:** HIGH — a live production false-reject that silently halts new entries until an engine restart.

---

## Brief

A live production bug: after three positions closed normally (`take_profit`, `time_stop`), HYPE was rejected `max_positions_reached` ~40 minutes later **despite zero open positions in the DB**. An engine restart cleared the condition. The symptom is a slot/exposure-reservation that is created on OPEN, marked `CONFIRMED` on fill, and then **never released on the normal close path** — only the reconciliation path releases it. The in-memory `ReservationLedger` therefore accumulates stale `CONFIRMED` reservations that keep occupying slots A/B/C until the process is restarted.

This is a **survival-mandate bug**, not a returns bug: the engine becomes blind to its own free capacity and stops trading entirely after a few normal closes. It is exactly the class of silent-desync failure the conservative design is meant to prevent.

---

## Problem statement — the exact reservation-release gap

The in-memory reservation ledger (`ReservationLedger`, ADR 0004 §3) is the authoritative source for **slot occupancy** and **in-flight exposure**. Slot assignment in `RiskGateService.occupiedSlots()` unions two sets:

```
occupied = (open positions with a non-null slot) ∪ (ledger.listActive() reservations)
```

`ledger.listActive()` returns every reservation in state `PENDING` **or** `CONFIRMED` (`ReservationLedger.countsTowardCaps`). So a `CONFIRMED` reservation occupies its slot exactly as a live open position does.

The reservation lifecycle on a normal trade:

1. **OPEN approved** — `RiskGateService.reserveAndApprove` builds a reservation `reservationId = ${eventId}:${slot}`, state `PENDING`, and calls `ledger.reserve(...)`.
2. **Open fill confirmed** — `ExecutionService.openOrAddPositionAndAttachProtection` calls `confirmReservationSafely(event.reservationId)` → `ReservationLedger` transitions the reservation `PENDING → CONFIRMED`. It now counts toward caps and slot occupancy. (Per ADR 0004 §3 the position row is authoritative once the fill lands; the `CONFIRMED` reservation was meant to be "kept until M6 ties it to a position id, then dropped" — see Root cause.)
3. **Normal close** (time-stop or protective SL/TP) — `PositionTimeStopEnforcer.emitApprovedClose` / `LocalProtectiveMonitor` synthesize an `IOrderIntent(CLOSE)`, route it through `RiskGateService.evaluate`, and emit `ORDER_INTENT_APPROVED_EVENT` with `reservationId: decision.reservationId`.
4. **The close intent's `reservationId` is `null`.** `RiskGateService.approveDeRisking` (the path every `REDUCE`/`CLOSE`/`FLATTEN` takes) returns `{ outcome: APPROVED, reservationId: null, ... }`. De-risking intents do **not** reserve a new ledger entry, so there is no reservationId to carry.
5. **Execution release no-ops.** `ExecutionService.handleReduceTerminal` (and `processReduceFill` → `POSITION_CLOSED_EVENT`) calls `releaseReservationSafely(event.reservationId)` → `releaseReservationSafely(null)` → early-returns. The **original OPEN reservation** (`${openEventId}:${slot}`, state `CONFIRMED`) is **never touched**.

Result: the `CONFIRMED` reservation from the OPEN survives the close. It is not swept by `expireStaleReservations` either — that sweep only transitions `PENDING` reservations past TTL; a `CONFIRMED` reservation has no TTL backstop. The slot stays occupied for the life of the process.

After three normal closes, three `CONFIRMED` reservations occupy A, B and C. The fourth OPEN — HYPE — sees all three slots taken and rejects `MAX_POSITIONS_REACHED`, even though the DB has zero open positions. A restart rebuilds the ledger from empty (ADR 0004 §3: "a restart's correct behaviour is to reconcile against the exchange, not replay stale reservations") and the symptom vanishes — exactly the observed behavior.

### Why the reconciliation path masks it (and is the only path that releases)

`RiskGateService.reconcileClose(positionId)` — called from `ReconciliationService` for case-(b) closed-outside-the-bot positions — **does** release: it calls `releaseInFlightReservationFor(symbol, slot)` which scans `ledger.listActive()` for a `(symbol, slot)` match and releases it. A position that happens to be closed via the reconciliation path therefore frees its slot. A position closed via the **normal** time-stop / SL / TP path never reaches `reconcileClose`, so its reservation leaks. This asymmetry is the bug.

---

## Root cause

**The `CONFIRMED → RELEASED` lifecycle edge defined in ADR 0004 §3 has no production caller on the normal close path.**

ADR 0004 §3 locks two relevant edges:
- `PENDING --fill--> CONFIRMED` — "position row is now authoritative; **reservation kept until M6 ties it to a position id, then dropped**."
- `CONFIRMED --close--> RELEASED` — "reduce/close intent (§2) frees the closed notional."

Neither the "M6 ties it to a position id, then dropped" hand-off nor the `CONFIRMED → RELEASED` close edge was ever wired for the normal close path:

- There is **no `positionId` on the reservation** and **no path** that drops a `CONFIRMED` reservation when its OPEN fill becomes an authoritative position row. The reservation is keyed `${eventId}:${slot}`; nothing maps an open `positionId` back to its originating `eventId`/reservation.
- The `CONFIRMED → RELEASED` edge fires only when a release call presents the matching `reservationId`. On the normal close path the only release call is `releaseReservationSafely(event.reservationId)` with `event.reservationId === null` (the de-risking close carries no reservation). So the edge is never traversed.

The exact missing link in the call chain:

```
PositionTimeStopEnforcer / LocalProtectiveMonitor
   → RiskGateService.evaluate(CLOSE)  → approveDeRisking → reservationId: null
   → ORDER_INTENT_APPROVED_EVENT { reservationId: null }
   → ExecutionService.processReduceFill (closing fill)
        → finalizeRealizedPnl
        → emit POSITION_CLOSED_EVENT      ← carries positionId + symbol, NO reservationId
        → releaseReservationSafely(null)  ← NO-OP. ❮ leak here ❯
```

Nothing on this chain releases the original OPEN reservation. `POSITION_CLOSED_EVENT` is consumed by `RiskStateLifecycleListener` (which recomputes `risk_state.open_exposure` from DB rows — so **exposure accounting self-heals**, masking the leak in money terms) but **no consumer releases the slot reservation in the ledger**. Slot occupancy and exposure accounting diverge: exposure recovers, slots do not.

---

## Fix scope (minimal-touch — do NOT redesign the slot system)

The fix wires the existing `CONFIRMED → RELEASED` edge into the normal close path, mirroring what `reconcileClose` already does, so **both** paths release. The slot model, the ledger lifecycle, and the reservation shape are unchanged.

### Chosen approach: release-on-close via `(symbol, slot)` match in the position-closed handler

Reuse the already-proven matcher `RiskGateService.releaseInFlightReservationFor(symbol, slot)` — the same `(symbol, slot)` fallback `reconcileClose` uses. Add a single release call on the **durable close** signal so it fires for every normal close path exactly once.

Two candidate seams; the implementer selects in Wave 2 with architect sign-off, but the recommended seam is **(A)**:

- **(A) `RiskGateService.releaseSlotForClosedPosition(symbol, slot)`** invoked from a **dedicated** risk-side `@OnEvent(POSITION_CLOSED_EVENT)` listener. The handler reads `symbol` + the position's `slot` and calls the gate's release primitive. Idempotent: if no active reservation matches `(symbol, slot)`, it is a logged no-op (matches `reconcileClose`).
  - **Dedicated listener — do NOT co-locate in `RiskStateLifecycleListener` (logic review LOW).** `RiskStateLifecycleListener` has a documented invariant: it reads **no event fields** (it recomputes the full UTC-day rollup from authoritative DB rows, Option R). The slot release must read `event.positionSlot`, so co-locating would break that SRP boundary. Ship a separate `@OnEvent(POSITION_CLOSED_EVENT)` slot-release listener.
  - Requires `IPositionClosedEvent` to carry the **slot** (it currently carries `symbol` but not `positionSlot`). Adding `positionSlot` to the event payload is the one small surface change. The emitter (`ExecutionService.processReduceFill`) already has the position row in hand (`finalized` / `position`) and can read `positionSlot` from it. **This payload field lives in `apps/engine/src/common/interface/IPositionClosedEvent.ts` (engine-internal), not `packages/shared/` — confirm in Wave 1.**

- **(B)** Have the close-intent producers (`PositionTimeStopEnforcer`, `LocalProtectiveMonitor`) resolve the originating reservationId and pass it through `ORDER_INTENT_APPROVED_EVENT`. **Rejected** — there is no reverse map from `positionId`/`symbol`/`slot` to the OPEN's `eventId`, so this would itself require the `(symbol, slot)` scan, but executed in a more fragile place (pre-fill, before the close is durable). (A) fires on the durable `CLOSED` event, which is the correct release point per ADR 0004 §3 ("frees the closed notional" = at close finalization).

### The ADD multi-reservation leak — release ALL `(symbol, slot)` matches, biased CONFIRMED (quant BLOCKER, logic MEDIUM)

`releaseInFlightReservationFor` today uses `.find()` — it releases **only the first** matching `(symbol, slot)` reservation. This is insufficient, because **a single slot can hold more than one active reservation**:

- An **ADD** intent is `isOpening` (`OrderIntentActionEnum.ADD`), so it runs the full `evaluateEntry → reserveAndApprove → buildReservation` path and mints a **new** reservation keyed `${addEventId}:${slot}`, confirmed at `ExecutionService.ts:931`. The original OPEN reservation (`${openEventId}:${slot}`) is also CONFIRMED. **Both share the same `(symbol, slot)`.** On close, a `.find()`-based release frees one and leaves the other CONFIRMED forever — the identical leak, re-introduced for every position that was ever added to.

> The earlier plan claim that "the slot model forbids two occupants of one slot, so this cannot occur for CONFIRMED reservations" was **wrong**. The slot model forbids two **positions** in a slot; it does **not** forbid two **reservations** (the original OPEN + each ADD) keyed to the same `(symbol, slot)`. Corrected throughout.

**Decision (locked): release ALL active `(symbol, slot)` matches on close — loop, not `.find()`.** A position has exactly one slot; every active reservation on that `(symbol, slot)` belongs to the position that is now closing (its OPEN plus any ADDs), so releasing all of them is correct and complete. Approach over the rejected alternative (release/merge ADD reservations at ADD-confirm time): release-all-on-close keeps a single release site, needs no new ADD-path code, and is symmetric with how `reconcileClose` already scans `(symbol, slot)` — minimal-touch. The implementer changes `releaseInFlightReservationFor` (or the close-path call site) to iterate every match rather than return on the first.

**Matcher bias: prefer CONFIRMED over PENDING (logic MEDIUM).** A new OPEN can race and create a fresh **PENDING** on the same `(symbol, slot)` *before* the `POSITION_CLOSED_EVENT` listener for the just-closed position fires. The release-all loop must therefore **only release CONFIRMED reservations at the close-release call site** (or, if a single-target variant is retained anywhere, bias selection toward CONFIRMED). Releasing a fresh PENDING belonging to a *different, incoming* position would re-introduce a leak in the other direction. This is a **code-level requirement, not a deferred test**: the close-release call site filters to `state === CONFIRMED`. (`reconcileClose`'s own call site is unaffected — it is documented separately below.)

**Backtest parity for the multi-release (quant BLOCKER tail, logic HIGH).** The backtest release path (`BacktestOrchestrator.ts:297`, `ctx.reservationLedger.releaseReservation(decision.reservationId)`) releases by a **single** `reservationId`. If a backtested position is ADDed to, the backtest must also release all of that position's `(symbol, slot)` reservations on close — otherwise live and backtest slot accounting diverge and the determinism invariant breaks. Wave 2 must apply the multi-release semantics to the backtest close path too, or prove (with a test) that the backtest never mints a second reservation per slot. This is an explicit Wave-2 acceptance gate.

### Close-path completeness audit (mandatory — all paths must release exactly once)

The implementer must produce a release-table covering **every** way a slot reservation can be created and freed, and confirm exactly-once release.

**Key ordering correction (logic review HIGH):** `ReconciliationService` emits **zero** `POSITION_CLOSED_EVENT`s (confirmed by grep). The reconcile / zombie / exchange-SL/TP paths call `finalizeRealizedPnl` → `reconcileClose` directly and emit only `POSITION_STATE_TRANSITIONED_EVENT`. They **self-release via `reconcileClose`'s own `releaseInFlightReservationFor`** and therefore do **NOT** trigger the new `POSITION_CLOSED_EVENT` listener. The only paths that emit `POSITION_CLOSED_EVENT` are the executor reduce/close fills (`ExecutionService.processReduceFill`), i.e. the gate-routed normal closes (time-stop, local SL/TP) **and** FLATTEN/kill-switch. Consequently the two release paths are **largely disjoint**, and the double-release window is far narrower than first stated — it only opens if a normal close and a reconciliation pass both finalize the *same* position id (rare race), not as a routine overlap.

| Close path | Producer | Emits `POSITION_CLOSED_EVENT`? | Releases today? | After fix |
|---|---|---|---|---|
| Time-stop close | `PositionTimeStopEnforcer` → gate CLOSE → `processReduceFill` | Yes | **No (leak)** | Released via (A), all `(symbol, slot)` CONFIRMED matches |
| Protective SL/TP close (local monitor) | `LocalProtectiveMonitor` → gate CLOSE → `processReduceFill` | Yes | **No (leak)** | Released via (A), all `(symbol, slot)` CONFIRMED matches |
| FLATTEN / kill-switch close | gate FLATTEN → `applyReduceFillToPosition` → `processReduceFill` | Yes | **No (leak)** | Released via (A) — same listener |
| **ADD then any normal close** | OPEN + ADD each mint a CONFIRMED reservation on the same `(symbol, slot)`; close via `processReduceFill` | Yes | **No (leak, ×N reservations)** | Released via (A) **release-all loop** — every CONFIRMED match for the slot |
| Exchange-side SL/TP close (live) | exchange fills protective order → `ReconciliationService` → `reconcileClose` | **No** (only `POSITION_STATE_TRANSITIONED`) | Yes (`reconcileClose`) | **Self-releases via `reconcileClose` — NOT covered by new listener** |
| Closed-outside-bot / liquidation / manual | `ReconciliationService` → `reconcileClose` | **No** | Yes (`reconcileClose`) | **Self-releases via `reconcileClose` — NOT covered by new listener** |
| Zombie / orphan close | `ReconciliationService` (M31 lifecycle) → `reconcileClose` | **No** | Yes (`reconcileClose`) | **Self-releases via `reconcileClose` — NOT covered by new listener** |
| PENDING open never fills | `expireStaleReservations` TTL sweep | n/a | Yes (PENDING→EXPIRED) | Unchanged |
| Open/ADD-path failure or abort | `ExecutionService` catch → `releaseReservationSafely(reservationId)` (non-null on OPEN/ADD) | n/a | Yes | Unchanged |

The four `No (leak)` rows are the entire bug (time-stop, local SL/TP, FLATTEN, and the ADD multiplier on all of them). After the fix, every row releases exactly once across the position's reservations.

**Commit-then-emit ordering (quant HIGH) — Wave-2 acceptance check.** `POSITION_CLOSED_EVENT` is emitted inside `processReduceFill` **after** `finalizeRealizedPnl` (the `CLOSING → CLOSED` atomic write, line 445), so the DB row is durably `CLOSED` *before* the event fires and the slot is genuinely free at release time. This ordering is intentional and must be a Wave-2 acceptance check: on **every** path that emits `POSITION_CLOSED_EVENT`, the close DB-commit strictly precedes the emit. (No equivalent concern on the reconcile paths — they self-release inside `reconcileClose` after their own finalize.)

**Double-release guard test (narrowed scope):** a position that closes normally (emits `POSITION_CLOSED_EVENT` → listener releases) **and** is then also finalized by a racing reconciliation pass (`reconcileClose` releases) must not error or drive any counter negative. `ReservationLedger.transition` already treats `RELEASED → RELEASED` as a terminal no-op, so this is a confirm-and-test, not new code.

### Out-of-scope guardrails for the fix

- Do **not** add a DB table for reservations (ADR 0004 §3 keeps it in-memory — locked).
- Do **not** add a `positionId` column to the reservation or build a reverse `positionId → reservationId` map. The `(symbol, slot)` matcher is sufficient and already in production via `reconcileClose` — but it must release **all** CONFIRMED matches for the slot (loop, not `.find()`), since OPEN + each ADD mint separate reservations on the same `(symbol, slot)`.
- Do **not** change `countsTowardCaps`, the slot-assignment algorithm, or the TTL.
- Do **not** widen the release to also act on `POSITION_STATE_TRANSITIONED → CLOSING`; release on the durable `CLOSED` finalization only (avoid releasing a slot while a partial close is still in flight).

---

## Max-positions scaling — strict architectural opinion

> **Recommendation: DO NOT raise the concurrency cap to 5 or 10. Keep the architectural max at 3 (A/B/C). For restricted live, keep the effective cap at 1.** Raising it is not a config change — it is a redesign of a locked, safety-load-bearing decision, and it directly contradicts the conservative-survival mandate. Fixing the leak (above) restores the *intended* capacity of 3; that is the correct response to the incident, not an increase.

### What "raise to 5 or 10" actually means here

`MAX_OPEN_POSITIONS` exists in two distinct places and **neither one is a single knob that yields 5 or 10 live concurrent positions:**

1. **The architectural slot model (ADR 0004 §4, overview locked decision):** "Max open positions = **3** architectural max — slots A+B idiosyncratic, slot C BTC-correlated or borrowed by a third idiosyncratic." This is enforced in code by `SlotManager` over exactly three slots (`A`, `B`, `C` in `PositionSlotEnum`) and `MAX_IDIOSYNCRATIC_SLOTS = 2`. There is **no slot D**. To run 5 or 10 concurrent positions you must **redesign the slot model** — invent new slots, re-derive the correlation-bucketing rules (slot C exists specifically to cap BTC-correlated exposure at one position), and re-prove the same-bar single-candidate batching (ADR 0004 §4) at the new width. This is a new ADR and a multi-wave milestone, not a parameter bump.
2. **The `MAX_OPEN_POSITIONS` env var / `RateLimitPolicyService` invariant:** this value gates the per-symbol rate-limit budget (`PER_SYMBOL_ORDERS_SHARE × MAX_OPEN_POSITIONS ≤ 1.0`) and the strategy-version seed `max_open_positions: 3`. It is a **downstream consumer** of the slot count, not the source of truth. Raising it above the slot model's real capacity does nothing except risk a rate-limit invariant violation; it cannot create a 4th live slot because `SlotManager` rejects the 4th intent `MAX_POSITIONS_REACHED` regardless.

So the honest framing: **the question is "redesign the slot model to 5/10," not "change a number."**

### Current risk parameters (the envelope a wider cap would stress)

- **Capital per slot:** starting capital $500–$1,000 (overview locked); `RISK_PER_TRADE_PCT = 1%` of allocated capital risked per trade; `MAX_LEVERAGE = 3` (brief). At $1,000 and 1% risk, each slot risks ~$10 at the stop. Three slots = up to ~$30 concurrent risk before correlation.
- **Total exposure ceiling:** `MAX_EXPOSURE_PER_COIN_USDT = 250`, `MAX_SAME_DIRECTION_EXPOSURE_USDT = 600`. The same-direction cap ($600) is what actually bounds portfolio beta — at 3 slots it can already be hit by three same-side positions. It does **not** scale with slot count; more slots means the cap binds sooner, not that more risk is allowed. But more slots means more *small* positions each just under the per-coin cap, raising aggregate correlated drawdown in a single adverse market move.
- **Correlation risk:** slot C exists precisely because crypto alts are highly BTC-correlated; the model allows **at most one** BTC-correlated position. The 3-slot model is already a correlation-budget, not a diversification engine. Five or ten alt positions in a downturn behave like one big correlated position — the diversification is largely illusory (this is the core survival argument).
  - **Quantitative basis (the formula behind "stay at 3").** For `N` equal positions each with per-position variance `σ²` and pairwise correlation `ρ`, portfolio variance per unit is `σ²·(1/N + (N−1)/N·ρ)`. At `ρ ≈ 0.8` (a typical intraday alt-USDT-perp correlation in a BTC flush), going `3 → 5` slots cuts the **diversifiable** component from `0.0533·σ²` to `0.032·σ²` — but the **correlated floor** stays at `0.8·σ²`. So **≥95% of portfolio variance is undiversifiable at any N ≥ 3**: adding slots 4–10 buys a rounding-error reduction in risk while multiplying every operational and tail exposure above. This formula is the recorded quantitative justification for keeping the cap at 3 and goes into the ADR 0004 amendment.

### New risks that appear at 5 vs 10 slots

- **Correlated tail risk (the dominant one).** N alt-futures longs in a BTC flush is one trade with N× size. At 3 slots the same-direction cap + single-C rule bound this; at 5–10 the bot can assemble a portfolio that looks diversified and behaves as a single levered directional bet. This is the exact failure mode the conservative mandate exists to avoid.
- **Liquidity / depth concentration.** The per-coin depth floor (`COIN_DEPTH_FLOOR_10BPS_USDT`) gates *entry*; it does not model the *simultaneous exit* of 5–10 positions during a stress halt or a same-bar cascade. More open positions = more simultaneous market-impact on the way out, when liquidity is worst.
- **Reconciliation & rate-limit surface.** Each open position is an ongoing reconciliation obligation, a protective-order pair, and a share of the ORDERS rate-limit budget. `RateLimitPolicyService` already enforces `PER_SYMBOL_ORDERS_SHARE × MAX_OPEN_POSITIONS ≤ 1.0`; at 5–10 you must shrink the per-symbol share, slowing every order's retry/cancel budget exactly when (during stress) you most need responsiveness.
- **Same-bar batching blast radius.** The single-candidate correlated batch (ADR 0004 §4) was reasoned at width 3. At width 10 a single volatile bar can open many positions at once, concentrating entry timing — the opposite of the staggered, evidence-gated entry the design assumes.
- **Operational blast radius of *this very class* of bug.** The incident shows how a slot-accounting desync silently disables trading. Widening the slot space multiplies the surface for slot-accounting bugs while we have just demonstrated one in production. Widening before the accounting is proven stable under soak is precisely backwards.

### Prerequisites before *any* increase would even be on the table

An increase is a future milestone gated on **all** of:

1. **This leak fixed and soaked.** ≥30 days of paper/live soak with **zero** slot-accounting divergence (a new invariant check: distinct occupied-slot count must equal DB open-position count at reconciliation-pass quiescence — see Deliverables for the exact definition).
2. **Confirmed live edge at the current cap.** Per the overview: caps relax only after confirmed live edge. We do not have it. Restricted live is still 1 position, tier-1, isolated margin.
3. **A correlation-budget redesign, not a slot-count bump.** Any width > 3 needs an explicit portfolio-correlation ceiling (e.g. a netted-beta cap), not just more independent per-coin slots — otherwise step 1's "diversification" is fictional (see the `0.8·σ²` correlated floor above). New ADR required.
4. **Depth/exit modeling for simultaneous unwind (quant MEDIUM — concrete acceptance formula).** A depth guard that models `N` positions exiting **together** during a stress halt, not just per-coin entry depth. Acceptance formula a future width milestone must satisfy: for `N` concurrent positions each at `MAX_EXPOSURE_PER_COIN_USDT`, worst-case same-direction unwind inside one stress bar = `min(N·$250, $600 same-direction cap)`; modeled exit impact = `Σ (positionNotional / book_depth_coin)` across the open coins **at halt-time depth** (not entry-time depth). The width is only admissible if that aggregate impact stays within a documented slippage budget.
5. **Rate-limit headroom re-proven** at the new width (`RateLimitConfigInvariantException` must not be reachable under burst).
6. **Dedicated backtest-power analysis at the target width (quant MEDIUM).** "Soak passed" cannot prove expectancy at a wider cap — a soak at width 1–3 says nothing about the marginal positions 4–N. Any future increase requires a dedicated backtest-power / expectancy analysis sized for the new slots, with held-out validation, **before** the cap moves. Recorded here so the gate is not mistaken for "soak time elapsed".

### If NOT increasing now (the recommendation), what changes first

Nothing about the cap changes in M34. M34's job is to make the **existing** 3-slot capacity behave correctly. The path to a future, evidence-based reconsideration is: fix → soak → confirm live edge → propose a correlation-budget ADR. Until confirmed live edge exists, raising the cap trades the project's stated priority (survival) for unproven returns — a direct violation of the mandate. **The correct mental model: 3 is already aggressive for a survival-first bot; the live default of 1 is the real operating point. The incident is a reason to harden slot accounting, not to widen it.**

---

## Deliverables

**Implemented (engine-only):**
- Slot release wired into the normal close path (approach A): a **dedicated** `@OnEvent(POSITION_CLOSED_EVENT)` slot-release listener that calls a gate primitive (`releaseSlotForClosedPosition(symbol, slot)`), which releases **all CONFIRMED** reservations matching `(symbol, slot)` (loop, not `.find()`; filtered to CONFIRMED so a racing incoming PENDING is not freed).
- `IPositionClosedEvent` payload carries `positionSlot` (engine-internal interface; emitter reads it from the finalized position row).
- Backtest close path applies the same multi-release semantics (or a proof + test that the backtest never mints a second reservation per slot) — for live/backtest determinism parity.
- A **slot-accounting invariant check** in the reconciliation pass (quant HIGH — tightened definition):
  - Assert: `|distinct slots occupied in (ledger.listActive() ∪ open-position slots)| ≤ 3`, **and** each occupied slot maps to **≤ 1 open DB position**. Count **distinct occupied slots**, never raw reservation counts (an ADD legitimately yields 2 reservations for 1 position; a raw count would false-positive).
  - Evaluate **only at reconciliation-pass quiescence**, never mid-fill. Transient-OK (assertion suppressed) conditions, stated explicitly: (a) a `PENDING` reservation exists before its DB position row lands (open in flight); (b) `PENDING` + `CONFIRMED` co-exist on one slot during an ADD/re-entry window; (c) a `CONFIRMED` reservation co-exists with its DB `CLOSED` row in the gap between finalize and the listener release.
  - On a true divergence at quiescence: structured WARN (the standing detector that would have caught this incident in soak; prerequisite gate for any future cap discussion).

**Tested (adversarial QA — paired tests per fix item, per dev-qa-cycle):**
- Normal time-stop close releases the slot (regression for the exact incident: open 3 → close 3 → 4th OPEN approved, not `MAX_POSITIONS_REACHED`).
- Normal protective SL/TP close releases the slot.
- **ADD multi-release (BLOCKER regression):** open → add → close → 4th OPEN approved (slot fully free; **all** reservations for the slot released, not just one).
- **FLATTEN / kill-switch close** releases the slot (covered by the same listener).
- **Matcher CONFIRMED-bias (logic MEDIUM):** position on slot A closes while a fresh OPEN has already minted a PENDING on the same `(symbol, slot)`; the close-release frees the stale CONFIRMED and leaves the incoming PENDING intact.
- Reconciliation/zombie/exchange-SL-TP close still self-releases via `reconcileClose` (no regression) and does **not** double-release / error when racing a normal close (terminal `RELEASED → RELEASED` no-op).
- Idempotency: duplicate `POSITION_CLOSED_EVENT` (replay) releases once, never drives state illegally.
- `(symbol, slot)` matcher releases the correct reservations when two positions on different slots for related symbols are open.
- **Backtest parity:** an ADDed position closing in backtest releases all its slot reservations; the new live listener is not invoked on the backtest path.
- Slot-accounting invariant check fires on an injected divergence at quiescence and is silent (a) on a healthy ledger and (b) during each documented transient-OK window.
- Commit-then-emit ordering: on every `POSITION_CLOSED_EVENT`-emitting path the DB row is `CLOSED` before the event fires.

---

## ADRs to amend or create

- **ADR 0004 (risk management) §3 — amend.** The lifecycle table claims `CONFIRMED --close--> RELEASED` and "kept until M6 ties it to a position id, then dropped." Document that the production realization of `CONFIRMED → RELEASED` on the normal close path is the `POSITION_CLOSED_EVENT` → `releaseSlotForClosedPosition(symbol, slot)` hand-off, releasing **all** CONFIRMED reservations for the slot (OPEN + every ADD share one `(symbol, slot)`), the same matcher `reconcileClose` uses. Record explicitly that **a single slot can hold more than one active reservation** (one per OPEN/ADD), correcting the prior implicit "one reservation per slot" assumption. Add the slot-accounting invariant — defined over **distinct occupied slots**, asserted at reconciliation quiescence — as a named reconciliation check. Record that **`trades_count` is decoupled from the ledger** (logic MEDIUM): it is recomputed as `COUNT(*)` over closed-today position rows by `RiskStateLifecycleListener`, never derived from reservation state, so the leak never affected it (and future audits should not re-derive it from reservations). **Add an explicit "max-positions stays at 3" decision note** with the quantitative basis: portfolio variance `σ²·(1/N + (N−1)/N·ρ)` leaves a `0.8·σ²` correlated floor at `ρ ≈ 0.8`, so ≥95% of variance is undiversifiable at any `N ≥ 3`; the cap is architectural and survival-load-bearing; widening is a future correlation-budget ADR gated on soak + confirmed live edge + a dedicated backtest-power analysis — not a parameter change.
- **ADR 0009 (position state machine) §close — amend.** Note that the `CLOSED` finalization is the durable trigger for slot-reservation release on the executor close path (release fires from `POSITION_CLOSED_EVENT`, emitted strictly **after** the `CLOSING → CLOSED` commit), keeping slot accounting consistent with the position lifecycle.
- **ADR 0010 (reconciliation & drift policy) — amend.** Clarify that `reconcileClose` is no longer the *only* reservation-release path, but that the two paths are **largely disjoint**: reconcile/zombie/exchange-SL-TP closes emit **no** `POSITION_CLOSED_EVENT` and **self-release** inside `reconcileClose`; only executor reduce/close fills (normal time-stop, local SL/TP, FLATTEN) emit `POSITION_CLOSED_EVENT` and release via the new listener. Document the no-double-release contract for the narrow same-position race (terminal `RELEASED → RELEASED` no-op). Add the slot-accounting invariant check (quiescence-only, distinct-slot definition, with the stated transient-OK windows) to the reconciliation-pass contract.
- **ADR 0012 (funding & pnl) — no change expected.** Exposure accounting already self-heals via the `RiskStateLifecycleListener` recompute, and `trades_count`/PnL are DB-derived, not reservation-derived; confirm in Wave 1 that nothing in the cashflow/PnL path depends on reservation state. (Listed in frontmatter only as a read-context ADR.)
- **New ADR — not required.** The fix is a wiring correction within the locked ADR 0004 §3 lifecycle, not a new decision. The earlier rationale that "two same-symbol same-slot reservations cannot coexist" was **wrong** (OPEN + ADD coexist on one slot) — but the resolution stays within the existing lifecycle (release-all CONFIRMED matches), so no new reservation-identity scheme is needed. If Wave 1 nonetheless concludes the `(symbol, slot)` key is insufficient (e.g. a genuine need to disambiguate which reservation belongs to which position id), escalate to the architect before introducing a new identity scheme.

---

## Out of scope (explicitly deferred)

- Any change to `MAX_OPEN_POSITIONS` / the slot count / the slot model. (See the opinion above — deferred to a future correlation-budget milestone gated on soak + confirmed live edge.)
- Persisting the reservation ledger to the DB (ADR 0004 §3 keeps it in-memory — locked).
- Reverse `positionId → reservationId` mapping or a reservation `positionId` column.
- Changes to TTL, `countsTowardCaps`, exposure caps, or same-bar batching.
- The `packages/shared/` contract (the slot-bearing field is on the engine-internal `IPositionClosedEvent`; confirm in Wave 1).

---

## Risk assessment (what can go wrong)

- **Under-release on ADD (the BLOCKER).** A `.find()`-style single release leaves every extra ADD reservation CONFIRMED, re-introducing the leak. Mitigation: release **all** CONFIRMED `(symbol, slot)` matches on close; regression test `open → add → close → 4th OPEN approved`.
- **Wrong-reservation release via `(symbol, slot)` ambiguity.** A slot can hold multiple active reservations: OPEN + each ADD (all CONFIRMED), and transiently an incoming OPEN's fresh PENDING during a re-entry race. The close-release must release **only CONFIRMED** matches, so a racing incoming PENDING (a *different*, opening position) is never freed. Code-level requirement (CONFIRMED filter at the close-release call site), plus a targeted race test.
- **Double-release.** A normal close (listener) and a racing reconciliation (`reconcileClose`) finalize the same position id. Mitigation: `ReservationLedger.transition` treats `RELEASED → RELEASED` as a terminal no-op (already in code); add an explicit test. Window is narrow — the two paths are otherwise disjoint (reconcile paths emit no `POSITION_CLOSED_EVENT`). Safe.
- **Releasing too early.** Releasing on `CLOSING` (partial) instead of `CLOSED` (durable) could free a slot mid-unwind. Mitigation: release strictly on `POSITION_CLOSED_EVENT`, which is emitted only after the durable `CLOSING → CLOSED` commit (commit-then-emit, Wave-2 acceptance check). Locked in fix scope.
- **Missing slot on the event.** If `positionSlot` is null on the closed position (legacy/adopted rows), the matcher no-ops (matches `reconcileClose`'s null-slot guard). Acceptable — reconciliation remains the backstop; the slot-accounting invariant check will surface any residual divergence in soak.
- **Determinism / backtest parity.** The release is keyed off the same injected-clock event flow used in backtest replay; no wall-clock or RNG introduced. The backtest releases per-run via `ctx.reservationLedger.releaseReservation(decision.reservationId)` and does **not** go through `POSITION_CLOSED_EVENT`; Wave 2 must extend the backtest close path with the same **multi-release** semantics (or prove + test it never mints a second reservation per slot) so live and backtest slot accounting stay identical after an ADD.

---

## Dispatch

- **Wave 1 (architect):** Lock ADR 0004 §3 / 0009 / 0010 amendments + the max-positions decision note (with the variance-formula basis and the `trades_count` decoupling). Confirm the release-**all**-CONFIRMED `(symbol, slot)` decision, the CONFIRMED-bias rule, the narrow no-double-release contract (paths are disjoint), the dedicated-listener decision, and that the slot-bearing field stays engine-internal (no `packages/shared/` change).
- **Wave 2 (bot-engine-nestjs):** Wire `releaseSlotForClosedPosition` (release **all** CONFIRMED `(symbol, slot)` matches — loop, not `.find()`) + a **dedicated** `@OnEvent(POSITION_CLOSED_EVENT)` slot-release listener; add `positionSlot` to `IPositionClosedEvent`; apply multi-release semantics to the **backtest** close path; add the slot-accounting invariant check (distinct-slot, quiescence-only) to the reconciliation pass. Acceptance gates: (a) commit-then-emit ordering holds on every `POSITION_CLOSED_EVENT`-emitting path; (b) the new listener fires on the live path only, backtest per-run release stays the sole backtest release point.
- **Wave 3 (bot-qa-engineer):** Adversarial QA — incident regression (open 3 → close 3 → 4th approved), **ADD multi-release** (open → add → close → 4th approved), **FLATTEN/kill-switch** close, **CONFIRMED-bias** race, reconcile self-release no-regression, double-release race, idempotent replay, matcher correctness, backtest parity, invariant-check firing (and silence during each transient-OK window).
- **Wave 4 (reviewers ×4):** security, logic, clean-code, quant. Cycle until 0 blockers, 0 highs, majority of mediums resolved.
- **Wave 5 (bot-scribe):** close docs + milestone log + STATUS.

## Definition of Done

- Normal time-stop, local SL/TP, and FLATTEN closes release **all** the position's slot reservations (OPEN + every ADD); reconcile/zombie/exchange-SL-TP closes self-release via `reconcileClose`. Every path releases exactly once.
- Incident regression test passes: three normal closes do not leak slots; a fourth OPEN is approved.
- ADD multi-release test passes: open → add → close → 4th OPEN approved (slot fully free).
- Backtest parity holds: an ADDed position closing in backtest releases all its reservations; live listener not invoked on the backtest path.
- Slot-accounting invariant check (distinct-slot, quiescence-only) added to the reconciliation pass and tested (fires on divergence; silent on healthy ledger and during each documented transient-OK window).
- Commit-then-emit ordering verified on every `POSITION_CLOSED_EVENT`-emitting path.
- 0 blockers, 0 highs on reviewer pass.
- ADR 0004 §3 / 0009 / 0010 amendments locked, including the recorded "max-positions stays at 3" decision (variance basis + `trades_count` decoupling).
- Live smoke: open and normally-close several positions in sequence (including at least one ADDed position); confirm the next OPEN is not falsely rejected `max_positions_reached`.
