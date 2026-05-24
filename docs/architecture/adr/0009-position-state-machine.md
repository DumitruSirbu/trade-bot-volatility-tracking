# ADR 0009 — Position state machine (M6)

Status: Accepted (revised 2026-05-23 post-W1)
Date: 2026-05-23
Milestone: M6 — Position management & reconciliation

## Revision history

- **2026-05-23 (initial):** Single-column form — `positions.status` only,
  enum domain grown to six values.
- **2026-05-23 (post-W1):** §1 revised to formally adopt the two-column
  form the W1 engine wave shipped (`positions.state` carrying
  `PositionStateEnum`, `positions.status` retained as deprecated alias).
  Drop of `status` named as M7 W0 follow-up task. §2 wording updated to
  reference `state`. §6 grew clause §6.1a calling out the entry-path
  start state at `pending_open` (landed by W1.5 between W1 and W2). The
  state diagram (§3) and transition table (§4) are unchanged.
- **2026-05-23 (post-W4 surface):** §6 grew clause §6.1b — single
  qty-mutation API (`PositionService.adjustQty`) added by W4b. Mirrors
  the §6.1 single-transition rule; required because `ExecutionService`
  mutates qty directly today, which violates the same DB-first-atomic
  invariant the state machine relies on.

## Context

Through M5 the schema has only `positions.status ∈ {open, closed}` (shared
`PositionStatusEnum`). That two-value enum is sufficient while a position lives
purely under the bot's control, but M6 introduces the cases that break it:

- An entry order has a fill recorded **before** its protective orders are confirmed
  resting (ADR 0008 §2). During that window the position exists but is not yet
  "open and unattended" — a restart needs to tell the difference.
- A reduce/close intent is in flight: the position is still open on the exchange,
  but a closing trajectory has been committed (idempotency rows already written,
  ADR 0006 §5).
- Reconciliation finds drift (ADR 0010): an exchange position with no DB row, a DB
  row with no exchange position, a qty mismatch. Each case temporarily places the
  row in a state where the engine **must not** issue new intents until drift is
  resolved.
- The operator imports an exchange position the bot did not place (manual hedge,
  pre-bot leftover). M6's drift policy demands the bot manage such rows only after
  a human ack — they exist in the DB but are intentionally inert.

`docs/plans/M6-position-management.md` requires "authoritative, crash-safe position
state that always matches the exchange" and an explicit reconciliation drift
policy. The state model is the substrate both rest on.

Project invariants this ADR is bound by:

- **Same code live and backtest** (`00-overview.md`). Backtest replays fills into
  the same state machine; the machine must be pure with respect to wall-clock and
  RNG. Time comes through the `nowMs` port (ADR 0004 §7), I/O via repositories.
- **No order path bypasses the risk gate** (`CLAUDE.md`). Transitions that
  *originate* an order intent (e.g. local-monitor breach in `open`, kill-switch
  flatten) call `RiskGateService.evaluate` like everything else.
- **The DB row is canonical state, not the in-memory cache** — a restart must
  resume from the row alone (M6 brief: "positions survive a restart").

## Decision

### 1. State enum — six states (SHARED), two columns during the grace window

**Revised 2026-05-23 (post-W1):** the M6 W1 engine wave shipped a two-column
schema (`positions.state` carrying `PositionStateEnum`, `positions.status`
retained as the legacy `PositionStatusEnum ∈ {open, closed}` alias).
**Architecturally adopted as the canonical form**, superseding the earlier
"single column, grown enum domain" wording of this clause. Rationale for the
revision (the shipped form is strictly better):

- **Type-safe migration boundary.** Legacy readers compiled against
  `PositionStatusEnum` keep working without silently receiving a
  `pending_open` they cannot interpret. With a single grown-domain column,
  every legacy reader would either need to become exhaustive immediately
  (broad refactor) or accept silent truncation (correctness hazard).
- **Discoverability.** Every read site against `positions.state` is
  grep-flagged as "M6+ aware"; reads against `positions.status` are
  grep-flagged as "needs migration." Audit surface is explicit, not implicit.
- **Atomic drop later.** The legacy column gets a clean drop migration once
  all readers migrate. Single-column cleanup would require rewriting every
  consumer first and then declaring done — verifiable only by absence.
- **Non-destructive add.** The earlier draft cited "destructive migration"
  as the reason to avoid a column rename; that argument does not apply to
  *adding* a new column with `NOT NULL DEFAULT 'open'` alongside the legacy
  one. The objection was misapplied.

**Locked schema shape:**

```
positions.state  NOT NULL DEFAULT 'open'   -- PositionStateEnum (six values)
positions.status NOT NULL                  -- PositionStatusEnum (legacy: 'open' | 'closed')
```

**Locked enum domain (shared):**

```
enum PositionStateEnum {
    PENDING_OPEN              = 'pending_open',
    OPEN                      = 'open',
    CLOSING                   = 'closing',
    CLOSED                    = 'closed',
    RECONCILING               = 'reconciling',
    MANUAL_ADOPTED_UNMANAGED  = 'manual_adopted_unmanaged',
}
```

**Dual-write contract (M6 grace window):**

- `PositionService.transition(positionId, newState, event)` writes **both**
  columns in the same SQL `UPDATE`. The `status` value is derived from
  `state` via the projection table below.
- Reads SHOULD prefer `state`. New code MUST read `state`. Legacy M2/M3/M4/M5
  reads against `status` continue to function; each is tracked for migration
  in W11.

**Projection — `state` → `status`:**

| `state` | `status` |
|---|---|
| `pending_open` | `open` |
| `open` | `open` |
| `closing` | `open` |
| `closed` | `closed` |
| `reconciling` | `open` *(the position still exists; the gate's own `RECONCILING_HOLD` reject keeps it inert)* |
| `manual_adopted_unmanaged` | `open` *(it exists on the exchange; the gate's `FOREIGN_POSITION_HOLD` keeps it inert)* |

Rationale for the projection: `status` is binary "is this row consuming a
slot from the exchange's perspective?" For every non-`closed` state the
answer is yes, so `status = 'open'`. This keeps legacy callers
arithmetically correct (slot counts, open-symbol queries) without forcing
them to learn the new vocabulary.

**Drop-`status` follow-up (named):** **M7 W0 task —
*"drop `positions.status` after grace window"*.** Sequence: (1) M7 sweep
verifies zero readers remain on `positions.status` via codebase grep + a
read-site lint that fails on `status` access; (2) drop migration
`<timestamp>-DropPositionsStatusLegacyColumn.ts`. Listed in
`docs/plans/M7-backtesting.md` task list (W0) and in `00-overview.md`
cross-cutting risks. If M7 lands before all readers migrate, the drop slips
forward; `bot-shared-maintainer` removes the `PositionStatusEnum` export at
the same time.

`PositionStatusEnum` stays exported as a deprecated alias through the M6 →
M7 window so M2's repositories compile.

**State meanings (locked):**

| State | Position exists on exchange? | Position counts vs. slot caps? | Risk gate may originate new intents on it? | Local monitor armed? |
|---|---|---|---|---|
| `pending_open` | Maybe (fill recorded; protective attach not yet confirmed) | Yes (reservation already CONFIRMED at fill, ADR 0004 §3) | No (no add/reduce until OPEN) | **Yes** (ADR 0008 §2: synchronous arm before attach) |
| `open` | Yes | Yes | Yes (add / reduce / close) | Yes if `protective_order_type=local_fallback`; otherwise disarmed |
| `closing` | Yes (qty > 0 remaining or close order in flight) | Yes (until terminal) | No new `OPEN`/`ADD`; further `REDUCE`/`CLOSE` allowed; kill-switch `FLATTEN` allowed | Yes until last fill |
| `closed` | No | No | No | No |
| `reconciling` | Unknown (under investigation by ADR 0010) | Yes (treated as occupied until resolved) | **Blocked** — no new intents issued until reconciliation resolves to `open`/`closed`/`manual_adopted_unmanaged` | Frozen (existing arm/disarm state preserved, no changes) |
| `manual_adopted_unmanaged` | Yes | **No** (excluded from slot model — see ADR 0010 §1a) | No (the bot does not trade on rows it didn't place) | No |

### 2. Authoritative source — DB row only; in-memory cache is a derived view

**`positions.state` is the single source of truth** (with `positions.status`
dual-written per §1 for the grace window). Every transition writes the new
state to the row before the in-memory cache is updated; if the DB write
fails, the cache is not updated and the transition is retried from the
prior state. Concretely:

- `PositionService` exposes `loadOpenPositions(): Promise<PositionEntity[]>` and a
  Map-backed cache keyed by `positionId`. The cache is rebuilt from the DB on
  boot (M6 crash-recovery, ADR 0014) and on every transition.
- Readers (RiskGate slot-counting, LocalProtectiveMonitor, dashboard projections)
  consume the cache; the cache always equals "all DB rows with
  state ∉ {closed}".
- **No transition is "complete" until the DB row reflects it.** A crash between
  cache-update and DB-write is impossible because the order is DB-first.

This is the same rule the strategy/risk modules already follow (`decisions` row
is canonical, not the in-memory event); applied here so reconciliation can pull
state from one place rather than reconciling DB-against-cache as a separate
problem.

### 3. Legal transitions — directed graph; everything else is illegal

```
                    +--- (drift unresolved indefinitely)  --+
                    v                                       |
   <create>  ──▶  pending_open  ──(both SL+TP acked OR     |
                       │           local_fallback armed)──▶ open
                       │                                       │
                       │ (entry-side terminal with filledQty=0 │
                       │  — never created in the first place;  │
                       │  no row written, ADR 0007 §3)         │
                       │                                       │
                       │ (entry rejected after fill — impossible)
                       │                                       │
                       │ (reconciliation drift: not on exchange)
                       └──────────────────────────────────────▶ reconciling
                                                                 │
                                                                 ▼
                                       open ──(reduce/close intent emitted)──▶ closing
                                        │                            │
                                        │                            │ (last fill terminal → qty=0)
                                        │                            ▼
                                        │                          closed
                                        │
                                        │ (reconciliation drift any kind)
                                        ▼
                                    reconciling
                                        │
                                        │ (drift resolved: confirmed on exchange) ──▶ open
                                        │ (drift resolved: not on exchange)       ──▶ closed (reason=reconciled_missing)
                                        │ (drift resolved: foreign / unrecognised) ──▶ manual_adopted_unmanaged
                                        ▼
                                    (one of the three above)

   manual_adopted_unmanaged ──(operator runs `/positions/:id/adopt --ack` CLI/M9)──▶ open
                            ──(operator runs `/positions/:id/flatten`)──▶ closing
```

**Illegal transitions (reviewer must-fix if observed in code):**

- `closed → *` (a closed position is immutable; a new entry creates a new row).
- `pending_open → closing` directly (must transition through `open` first; this
  guards against issuing a reduce before protection is confirmed).
- `open → pending_open` (no "re-pending" — re-arming protection on an open
  position is internal to the protection layer, not a state regression).
- `manual_adopted_unmanaged → closed` directly (only through an operator-issued
  `FLATTEN` that goes through the risk gate → `closing` → `closed`).
- Any transition originated by code that **did not** go through
  `PositionService.transition(positionId, newState, event)`. The single
  transition API is the only legal mutation site.

### 4. Events that drive each transition

The state machine is event-driven; every transition has exactly one event class.
Events are domain events on the in-process bus (`@nestjs/event-emitter`), already
established in M0.

| From → To | Triggering event | Producer | Notes |
|---|---|---|---|
| `<none> → pending_open` | `fill.recorded` (entry, `filledQty > 0`) | ExecutionService via FillAccumulator | Created by `PositionService.createFromFill` (ADR 0008 §2). |
| `pending_open → open` | `protective.attached` (exchange-side, both SL+TP acked) OR `protective.local_fallback_engaged` (attach failed, monitor remains armed) | ProtectiveOrderAttacher | Both paths legal; whichever fires first wins. The transition flips `protective_order_type` per ADR 0008 §1 step 4. |
| `open → closing` | `order.intent.approved` with `intentAction ∈ {REDUCE, CLOSE, FLATTEN}` | RiskGate (after evaluate) | Multiple `REDUCE` intents can land while in `closing`; staying in `closing` is the contract. |
| `closing → open` | `order.intent.rejected` *after* the position briefly entered closing on intent emission, AND no fill landed | RiskGate / ExecutionService | Edge case: reduce intent rejected post-emission. State rolls back so future reduces work. |
| `closing → closed` | `position.qty_terminal` (cumulative fills net to zero) | FillAccumulator | Writes `closed_at`, `exit_price` (vol-weighted average of close fills), `realized_pnl`, `exit_reason` (ADR 0012). |
| `open → reconciling` AND `closing → reconciling` | `reconciliation.drift_detected` | ReconciliationService | One event per drift case (ADR 0010); the event payload carries the `DriftCase`. |
| `pending_open → reconciling` | Same — `reconciliation.drift_detected` | ReconciliationService | Edge: restart sees a pending_open row whose protective attach status is unknown. |
| `reconciling → open` | `reconciliation.resolved` with `outcome=confirmed_present` | ReconciliationService | Drift was a transient view mismatch; nothing actually wrong. |
| `reconciling → closed` | `reconciliation.resolved` with `outcome=reconciled_missing` | ReconciliationService | Position not on exchange → mark closed; `exit_reason=manual` (closed outside the bot), `closed_at = nowMs`, realized PnL left null (the bot didn't see the fills). |
| `reconciling → manual_adopted_unmanaged` | `reconciliation.resolved` with `outcome=adopted_foreign` | ReconciliationService | Foreign exchange position promoted to a DB row (ADR 0010 §1a). |
| `manual_adopted_unmanaged → open` | `position.adopt_acked` | M9 operator endpoint | Requires explicit human confirmation; alarms otherwise (no auto-promotion). |
| Any state → `closed` (catastrophic) | `kill_switch.flatten_completed` | RiskGate + ExecutionService | Kill-switch path: emits `FLATTEN` through the gate (ADR 0004 §2), `exit_reason=kill_switch`. State must still pass through `closing` first; the "any state" arrow here is the *intent-emission* — the row only reaches `closed` once fills terminal. |

The shared event payload shapes (`IReconciliationDriftDetectedEvent`,
`IReconciliationResolvedEvent`, `IPositionStateTransitionedEvent`) are added to
`packages/shared/src/event/` by `bot-shared-maintainer` before engine work. See
the M6 plan punch list.

### 5. State and protective-order-type interaction

`protective_order_type` is orthogonal to `state` but constrained:

- `state = pending_open` → `protective_order_type` is always `LOCAL_FALLBACK`
  initially (ADR 0008 §4 default), upgraded to `EXCHANGE_SIDE` only on the
  `protective.attached` event that also flips to `open`.
- `state = open` and `protective_order_type = local_fallback` → the
  LocalProtectiveMonitor must be armed (ADR 0008 §4). M6's evaluation loop reads
  exactly this slice.
- `state = closing` → protective orders (exchange-side `STOP_MARKET` /
  `TAKE_PROFIT_MARKET` with `closePosition=true`) auto-cancel when the position
  flattens (ADR 0008 §1). The monitor's arm is dropped when state reaches
  `closed`, not when `closing` is entered (a reduce may not be a full close).
- `state = reconciling` → the monitor stays in whatever arm state it had. No
  arm/disarm calls during reconciliation; reconciliation only mutates `state`
  and `qty`, never `protective_order_type` (ADR 0010 §1c).
- `state = manual_adopted_unmanaged` → `protective_order_type` is meaningless
  for the bot's monitor (the bot does not protect rows it didn't open). The
  column stays at its default; the monitor is not armed.

### 6. Lifecycle invariants (reviewer must-fix)

1. **Single transition API.** Every state change goes through
   `PositionService.transition(positionId, newState, event)`. Direct
   `repository.update({state: ...})` or `repository.update({status: ...})`
   calls outside that method are must-fix. The transition method writes
   **both** `state` and `status` in one `UPDATE` per §1's dual-write
   contract; callers must not split the write.

1a. **Entry path starts at `pending_open`, not `open`.** Per §3 and §4,
   `PositionService.createFromFill` (the entry-fill writer; currently
   `ExecutionService.createPositionFromFill` in M5 code) MUST insert new
   rows with `state = pending_open`. The transition to `open` happens on
   `protective.attached` (exchange-side success) or
   `protective.local_fallback_engaged` (attach failure). Any code path
   that inserts a position row directly at `state = open` is must-fix —
   it skips the `pending_open` window during which the local monitor's
   arm is the only protection (ADR 0008 §2). M6 W1.5 lands this; W2+
   reviewers cite this clause.

1b. **Single qty-mutation API.** Every `positions.qty` change goes through
   `PositionService.adjustQty(positionId, newQty, reason)` — added by
   M6 W4b (see ADR-0010 §7). It is a separate method from `transition`
   because changing state and changing qty are two distinct concepts
   (CQS). Atomic single `UPDATE`, DB-first-then-cache ordering. Direct
   `repository.update({qty: ...})` outside `adjustQty` is must-fix. The
   pre-W4b path of mutating qty inside
   `ExecutionService.applyReduceFillToPosition` is rerouted through
   `adjustQty` in W4b.
2. **DB-first ordering.** The transition method writes the row first, then
   updates the cache, then emits the `position.state.transitioned` event. A
   crash between DB write and cache update is recoverable (cache rebuilds on
   restart from the row); the reverse is not.
3. **No skipping states.** `pending_open → closing` direct is illegal; the
   monitor would not yet know which path to use. If a kill-switch flatten fires
   on a `pending_open` row, the gate moves it `pending_open → open → closing`
   in two transitions, both written.
4. **`reconciling` is a hold, not a destination.** Code that emits a new order
   intent on a `reconciling` row is must-fix. The gate enforces this with an
   explicit reject reason (added to `RejectReasonEnum` by
   `bot-shared-maintainer`: `RECONCILING_HOLD`).
5. **Determinism.** The transition method takes `nowMs` from the injected clock
   (ADR 0004 §7), never `Date.now()`. Backtest replays the exact same
   transitions on the same fills.

## Consequences

- The state machine is now a primary documentation artefact reviewers cite by
  name. Any new code path that touches `positions.status` must reference the
  diagram in §3.
- M6's reconciliation service does not need a separate "in-reconciliation" flag
  table; the state encodes it. This keeps the durable source of truth in one
  column.
- The `closed` state acquires three distinct semantic flavours, separated by
  `exit_reason` (ADR 0012): `take_profit`/`stop_loss`/`signal` (normal),
  `time_stop`/`manual`/`kill_switch` (intervention), and the M6-introduced
  `reconciled_missing` (drift cleanup). The state column doesn't grow; the
  reason column carries the nuance.
- Persistence migration: M2 has `positions.status varchar`, no DB enum type
  enforced. Adding the new states is a code-only change (no DDL needed). A
  follow-up DB CHECK constraint may be added in M9 hardening but is not
  required at M6.

## Alternatives considered

- **Keep `status ∈ {open, closed}` and use a separate `lifecycle_phase`
  column for the M6 states.** Rejected: two columns expressing one concept is
  a classic split-state bug source. The first time someone forgets to update
  one, the bot acts on a phantom state. One column, expanded enum.
- **Use a dedicated DB enum type (`CREATE TYPE position_state AS ENUM (...)`).**
  Rejected for M6: forces a migration any time the enum domain grows (e.g. M11
  may add `migrating_exchange`). `varchar` + shared enum keeps the schema
  stable while the typed safety lives at the application boundary.
- **Make `pending_open` a derived view of `open AND protective_order_type
  is not yet exchange_side`.** Rejected: hides a critical "do not issue new
  intents" guard inside a query. The risk gate would need to know about the
  combined condition; encoding it as a first-class state makes the gate's
  check trivial (`if (position.state !== open) reject;`).
- **Treat `reconciling` as a side-table lock rather than a state.** Rejected:
  the lock would need to be checked by every reader, and a leaked lock (process
  crash during reconciliation) becomes a recovery problem. Encoding it in
  `status` means the recovery is the normal boot-time state load.
- **Auto-adopt foreign exchange positions (skip
  `manual_adopted_unmanaged`).** Rejected as a safety regression: the bot has
  no idea what strategy/SL/TP context applies to a position it did not place.
  Auto-managing it could trivially produce a wrong-side close. Human ack is
  mandatory per the M6 brief.

## See also

- `docs/plans/M6-position-management.md` (the brief)
- `docs/architecture/adr/0010-reconciliation-and-drift-policy.md` (drift events that drive `reconciling` transitions)
- `docs/architecture/adr/0011-local-sltp-fallback-and-held-symbols.md` (monitor arm/disarm coupling to state)
- `docs/architecture/adr/0012-funding-and-pnl.md` (`exit_reason` enum extensions; realized PnL written at `closing→closed`)
- `docs/architecture/adr/0014-crash-recovery.md` (boot-time state rebuild from the DB row)
- `docs/architecture/adr/0008-sl-tp-attach.md` §2 (the `pending_open` window the new state encodes)
- `docs/architecture/adr/0006-idempotency-contract.md` §5 (one transaction row per `(clientOrderId, terminalState)`, unchanged)
- `docs/architecture/adr/0004-risk-management.md` §2 (gate covers all actions), §3 (reservation ledger M6 seam)
