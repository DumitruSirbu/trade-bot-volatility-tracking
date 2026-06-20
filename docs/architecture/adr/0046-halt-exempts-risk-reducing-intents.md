# ADR 0046 — A halt blocks new risk only; risk-reducing closes are always permitted

- **Status:** Accepted
- **Date:** 2026-06-18
- **Milestone:** M40 (D1)
- **Supersedes / amends:** Restores an invariant ADR 0014 §1 and ADR 0021 §2.4/§2.5 already
  assumed but that the execution layer never enforced. Composes with ADR 0004 §2 (gate
  auto-approves de-risking), ADR 0008/0011 (protective monitor + last-line-of-defense),
  ADR 0033/0038 (M33 live time-stop enforcement), ADR 0045 (M38 D2 FLATTEN unwind).

> **ADR numbering note.** The next free number after `0045` is **0046**; this ADR uses it.

---

## 1. Context

A global halt (operator kill-switch or a programmatic market-stress / model-divergence /
loss-window halt) is meant to be a brake on **opening new exposure**. Two upstream layers
already encode that intent correctly:

- **ADR 0004 §2 — the risk gate auto-approves de-risking.** `RiskGateService.evaluate`
  short-circuits a CLOSE/REDUCE/FLATTEN intent to APPROVED without consulting the halt
  state. Both `PositionTimeStopEnforcer` and `LocalProtectiveMonitor` document a gate reject
  on a de-risking close as a *contract violation*.
- **ADR 0021 §2.4/§2.5 — the operator kill-switch.** `flattenOpenPositions: true` enqueues a
  `CLOSE` intent per open position "via the normal risk gate + executor path … The gate's
  'de-risking always allowed during halt' rule lets these through." §2.5 states the executor
  "refuses **exposure-increasing** intents while halted" — i.e., the halt refusal was always
  meant to be scoped to OPEN/ADD.

The **execution layer does not honor that scoping.** `ExecutionService.handleApproved`
(`apps/engine/src/execution/service/ExecutionService.ts:163`) short-circuits **every**
approved intent when `haltFlag.isHalted()`, regardless of `intentAction`:

```ts
if (this.haltFlag.isHalted()) {
    this.releaseReservationSafely(event.reservationId);
    this.events.emit(ORDER_INTENT_EXPIRED_EVENT, { ..., reason: ORDER_INTENT_EXPIRED_REASON_HALTED });
    return;
}
await this.executeLive(event, plan, nowMs);
```

The classifier `isOpenOrAddIntent(action)` (`:235`) already exists and is used downstream at
`:210` to keep reduce-family intents off the open/add path. The halt short-circuit simply
does not consult it.

### Production impact (2026-06-17 paper soak, position #101 INJ)

A `market_stress:multi` halt fired at 18:05. The open INJ long's **time-stop close** (due
18:15) and its **stop-loss breach close** were both blocked by this short-circuit and retried
unfilled for **2h12m**, until an operator manually hit `/v1/control/resume` at 20:17. The
position bled from entry 5.630 through its stop 5.439 to 5.398 with **no working protective
exit the entire time** (≈ −3.7 USDT beyond the stop, plus ≈2h of uncapped tail risk on a
~$508 notional during declared market stress). The kill-switch is currently **anti-safety for
open positions**: any halt freezes every open position's stop-loss and time-stop until resume.

The same gate also defeats:
- the M38 D2 FLATTEN unwind path (`FillAcceptanceUnwindService` synthetic FLATTEN — ADR 0045);
- the ADR 0021 §2.4 `flattenOpenPositions: true` operator force-flatten (its CLOSE intents are
  blocked downstream), meaning that documented feature is itself currently broken.

The forensic report distinguishes two readings of the fix:
- **Option A (exempt-closes):** a halt blocks OPEN/ADD only; de-risking always executes.
- **Option B (force-flatten):** on a market-stress halt, additionally **flatten** all open
  positions at halt time rather than merely letting their existing exits run.

---

## 2. Decision

### 2.1 ALL THREE executor halt gates are scoped to OPEN/ADD only (Option A)

The halt short-circuit is **not** a single line. The executor has **three** halt gates on the
live order path, and a de-risking close must pass **all three** to actually submit, fill, and
reach a CLOSED row. Narrowing only the first is insufficient — and self-defeating (see §2.3):

1. **`handleApproved` entry gate (`:163`)** — drops the intent before `executeLive`.
2. **`runSubmitStateMachine` per-attempt gate (`:565`)** — returns `ABORTED, fillSummary=null`
   *before `submitOnce` is ever called*, so the order never reaches `submitter.submit` (`:615`).
   A CLOSE that passes gate 1 but not gate 2 yields a null-fill reduce terminal → it escalates
   via `ORDER_INTENT_UNKNOWN_EVENT` → the row is moved to `RECONCILING` (which is a **no-op
   under PAPER**, `ReconciliationService.ts:433`) and **never closes** — strictly worse than the
   pre-fix retry loop, because the row has left the state the enforcer/monitor re-fire from.
3. **`resolveReduceTerminal` recursion guard (`:808`)** — aborts the reduce-remainder recursion
   mid-flight.

All three are scoped with the **same** existing classifier so an intent permitted at one gate is
not silently aborted at the next:

```ts
// :163 (handleApproved) and :565 (runSubmitStateMachine) — `event` is in scope at both:
if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(event.intent.intentAction)) {
    // short-circuit OPEN/ADD only
}

// :808 (resolveReduceTerminal) — NOTE: `event` is NOT in scope here; the method takes `intent`
// (IOrderIntent, which carries intentAction). The predicate MUST read `intent.intentAction`, not
// `event.intent.intentAction`, or it will not compile:
if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(intent.intentAction)) {
    // this path only ever runs for REDUCE_MARKET, so this stops aborting the de-risking close
    // entirely: the first reduce submission proceeds under halt rather than aborting before any fill.
}
```

> **Per-gate variable (MEDIUM, M40 review):** `:163` and `:565` have `event` in scope and read
> `event.intent.intentAction`; `:808` has only `intent` and reads `intent.intentAction`. Pin this
> in the impl brief so the predicate is not copy-pasted as `event.intent…` at `:808`.

REDUCE / CLOSE / FLATTEN therefore submit, recover, and fill **end-to-end** under a halt; only
OPEN / ADD are aborted, and at **every** gate. This restores the cross-layer invariant: **nothing
risk-increasing reaches the exchange under a halt; everything risk-reducing always can — and
reaches CLOSED**, not merely passes the first gate. It guarantees the time-stop enforcer, the
local protective monitor, the M38 D2 unwind, and the ADR 0021 operator force-flatten all survive
a concurrent halt to completion.

The classifier is the **single, uniform** halt-scoping authority across all three sites. Any
future `OrderIntentActionEnum` value is, by `isOpenOrAddIntent`'s inverted-whitelist semantics
(`:232`), treated as reduce-family and therefore *permitted* under halt at every gate — the safe
default for an unknown action is "allow de-risking," applied **identically** at `:163`, `:565`,
and `:808`. A value permitted at `:163` but aborted at `:565` would be an inconsistent
fail-direction and is explicitly forbidden.

### 2.1a Close-slot lifecycle — clean fill releases; non-clean-under-halt is a known residual

Today the shared close slot is released on a `reason=halted` / `dry_run` expiry
(`PositionTimeStopEnforcer.onOrderIntentExpired` `:322-343`,
`ReconciliationService.onOrderIntentExpired` `:322-343`). After §2.1 a de-risking close no longer
produces a `halted` expiry, so that release path stops firing for the close.

**Clean-fill path (the common case, fully handled).** A close that fills cleanly transitions the
row `CLOSING → CLOSED`, which fires `POSITION_STATE_TRANSITIONED_EVENT{toState: CLOSED}`. **Both**
close producers release the slot on that event:
- `PositionTimeStopEnforcer.onPositionStateTransitioned` (`:107`) — the time-stop path;
- `LocalProtectiveMonitor.onPositionStateTransitioned` (`:227-232`) — the SL/TP-breach path
  (the actual #101 case was an SL breach).

This is the correct release site post-fix and the milestone asserts the slot is not leaked on it.

**Non-clean-under-halt path (a KNOWN RESIDUAL, not solved by §2.1).** A permitted reduce/close that
does **not** cleanly fill — retry budget exhausted (`RECONCILE_REQUIRED`) or a TERMINAL/ABORTED
reject — routes to `handleReduceTerminal`'s non-clean branch (`:267-285`), which emits
`ORDER_INTENT_UNKNOWN_EVENT` and releases only the executor **order reservation** (`:285`), **not**
the close-coordinator slot. Neither close producer releases on UNKNOWN by design
(`PositionTimeStopEnforcer.onOrderIntentExpired` `:321` explicitly skips UNKNOWN; the monitor has no
UNKNOWN handler). Reconciliation moves the row to `RECONCILING`, but `runTickNow` is a **PAPER
no-op** (`:433`), so under a PAPER soak the slot stays held and the row parks in `RECONCILING` with
no driver to re-fire. **§2.1 does not fix this case** — it changes *where* the stuck state is
reached (after `submitter.submit`, on a genuine venue failure) but not *that* a non-clean close
under a no-reconciliation environment can park.

The genuinely-transient `RETRIABLE` reject is **not** affected: it is retried in-loop at `:564`
(re-submit on the next `attemptN`), never released-and-re-fired — so "release so the enforcer can
re-fire" is not the recovery mechanism for that case either.

**Ownership of the residual: D4's paper-safe stuck-row sweep.** The cleanup owner for a
`RECONCILING`-parked row with a held close slot under PAPER is **M40 D4's orphaned/stuck-row sweep**
(extended to cover `RECONCILING` rows older than the threshold, reclaiming the close slot and
finalizing the row). This ADR does not invent an executor-side recovery for the non-clean case; it
scopes the §2.1 guarantee to *opening the close path* and hands the rare non-clean-under-halt
residual to the D4 sweep, where it is acceptance-tested (M40 A6 / C8).

### 2.2 Force-flatten on market-stress halt stays OPT-IN, not default (Option B rejected as default)

A market-stress halt does **not** automatically flatten open positions. The project's settled
policy (ADR 0021 §2.4) is: *stop new risk, preserve existing stops.* Forced market exits into a
stressed tape routinely realise **worse** fills than the standing SL/time-stop, which is the
opposite of survival-first. The operator retains the explicit `flattenOpenPositions: true`
opt-in on `POST /v1/control/halt` (ADR 0021 §2.4) for the cases where flattening is warranted;
with §2.1 fixed, that opt-in **now actually works**.

This decision is deliberate and bounded: §2.1 is the prerequisite for *either* reading
(a force-flatten's CLOSE intents would be blocked by the same gate), and §2.1 alone fully
closes the safety hole — once de-risking executes, an open position during a halt closes on its
own time-stop or SL exactly as it would un-halted.

### 2.3 What stays unchanged

The OPEN/ADD abort semantics at all three gates are unchanged: an OPEN under halt still
short-circuits at `:163` (releases reservation, emits `ORDER_INTENT_EXPIRED_REASON_HALTED`) and,
were it to reach `:565`, still aborts there. Only the *predicate* changes — from "halted" to
"halted **and** OPEN/ADD" — so the abort still fires for opens and no longer fires for closes.

The `onOrderIntentExpired` release listeners in `PositionTimeStopEnforcer` (`:322-343`) and
`ReconciliationService` (`:322-343`) are not modified: they remain correct for the OPEN/ADD
`halted` expiry case. They simply stop being exercised by the *close* path, which now releases
its slot via the `CLOSED` transition (§2.1a) instead.

> **Correction (M40 review):** an earlier draft of this ADR asserted `:565` and `:808` "are
> already correct — no change." That was wrong: leaving them halted-for-all aborts the close
> before `submitter.submit`, parking the row in `RECONCILING` where a PAPER soak never reconciles
> it (§2.1, gate 2). The fix is incomplete unless all three gates are scoped together.

---

## 3. Consequences

- A halt is once again a brake on *opening* exposure only. An open position under a halt is
  protected by its time-stop and SL exactly as it is un-halted — the 2h12m unprotected window
  cannot recur.
- The ADR 0021 §2.4 operator force-flatten and the M38 D2 FLATTEN unwind both function under a
  concurrent halt for the first time.
- The change reuses an existing, tested classifier applied at three sites — no new state, no new
  enum, no shared-contract change, no migration. Larger than a one-liner, but still confined to
  the predicate on three halt gates in one file.
- A regression test becomes a permanent guard: *open position + halt active + time-stop or SL
  breach ⇒ the CLOSE submits, fills, and the row reaches CLOSED* (end-to-end, not merely past the
  first gate), with the shared close slot released on the CLOSED transition (§2.1a).
- **Determinism / parity unaffected.** The backtest never sets the live halt flag; the
  enforcer/monitor decisions are unchanged. The narrowed branch only removes a live-only
  short-circuit on the close path.
- **Money is `decimal`** throughout the close path; this ADR moves no numeric logic.

---

## 4. Alternatives considered

- **Force-flatten by default on every halt (Option B as default).** Rejected. Contradicts the
  settled ADR 0021 §2.4 "preserve existing stops" policy and the survival-first philosophy;
  forced exits into stress realise worse fills than standing protective orders. Retained as the
  operator opt-in only.
- **Leave the gates as-is and special-case the time-stop enforcer / monitor with a halt-bypass
  flag on the intent.** Rejected. It would push halt-awareness into every close *producer*
  (enforcer, monitor, M38 unwind, reconciliation flatten, operator flatten — five sites) and
  invite one of them to be missed. Scoping the executor's own three halt gates by the existing
  action classifier keeps the rule on the *consumer* side, where the order actually reaches the
  exchange — one classifier, applied uniformly, rather than a flag threaded through five
  producers (DRY + one reason to change).
- **Move the halt check entirely into the risk gate and drop it from the executor.** Rejected
  for this ADR. The gate already auto-approves de-risking (ADR 0004 §2), so adding the
  OPEN/ADD halt refusal there too is plausible, but the executor's flag-based refusal is the
  documented M5 boundary (ADR 0021 §2.5) and the last line before the exchange; removing it
  would widen the blast radius beyond the minimal fix. Tracked as a possible future
  consolidation, not done here.
- **A broader "intent risk-direction" enum (RISK_INCREASING | RISK_REDUCING) on the intent.**
  Rejected as over-engineering for two action classes already cleanly separated by
  `isOpenOrAddIntent`. Revisit only if a genuinely ambiguous action (e.g., a partial
  rebalancing flip) is ever introduced.
