# ADR 0014 — Crash recovery & re-association (M6)

Status: Accepted (revised 2026-05-23 post-M6 review round 1; amended 2026-05-26 by the M11a paper-mode addendum (R0.4) to dispatch phase 1's state source on `EXCHANGE_ENV`)
Date: 2026-05-23 (amended 2026-05-26)
Milestone: M6 — Position management & reconciliation (amendment owned by M11a)

## Revision history

- **2026-05-23 (initial):** Ten-phase boot pipeline; orchestrator closed
  until phase 9; mid-recovery triggers rejected with
  `RECOVERY_IN_PROGRESS`. §4a excluded positions from `open_exposure`
  rebuild when `correlationMode IS NULL`.
- **2026-05-23 (post-M6 R1):**
  - §1 reject scope narrowed: `RECOVERY_IN_PROGRESS` rejects **only
    exposure-increasing intents** (`OPEN`, `ADD`). De-risking intents
    (`REDUCE`, `CLOSE`, `FLATTEN`) pass during recovery so case-(a)
    `flatten` policy works at boot and `LocalProtectiveMonitor` breaches
    between phase 4c and phase 9 are not silently dropped. Aligns with
    ADR-0004 §2 "de-risking can never be blocked." (Round-1 logic
    blockers #1 + #6.)
  - §4a exclusion key flipped from `correlationMode IS NULL` to
    `state = MANUAL_ADOPTED_UNMANAGED`. The "managed by the bot"
    question is structural, not derived. Operator-ack on a foreign
    position transitions `MANUAL_ADOPTED_UNMANAGED → OPEN` and assigns
    a default `correlationMode = CORRELATED` (conservative — uses slot
    C, single-correlated cap). (Round-1 logic high #L11.)
- **2026-05-26 (M11a paper-mode addendum R0.4):** Phase 1 amended to
  read durable account-state truth via an injected `IBootStateSource`
  dispatched on `EXCHANGE_ENV`. In LIVE/TESTNET it resolves to
  `ExchangeBootStateSource` (the historical behaviour — `fetchPositions
  / fetchOpenOrders / fetchBalance` against the configured ccxt
  exchange). In PAPER it resolves to `PaperBootStateSource`, which
  reads from `paper_account_state` + `paper_account_state_history` +
  `paper_account_snapshots` (per ADR 0032 §D16) so PAPER's crash
  recovery never touches the live exchange's account-state endpoints.
  Phases 2 (the exchange-truth-pull naming subsumed by the port),
  3 (drift-sweep — drift cases reused; PAPER drift handler severity is
  CRITICAL per ADR 0032 §D12), and 4–9 are otherwise unchanged. The
  D6 `boot_mode_history` HMAC-chain verification runs **before**
  phase 1 (as part of `EngineBootstrapService` start), so a mode
  mismatch aborts before any state read.

## Context

The engine is a single always-on Node process holding a Binance WS, an
in-memory exposure reservation ledger (ADR 0004 §3), an in-memory
`LocalProtectiveMonitor` arm map (ADR 0008), an in-memory cooldown table
(ADR 0004 §5), and an in-memory `PositionInstrumentor` accumulator (ADR
0013). A crash, OOM, deploy, or `docker compose down` wipes all of it.

The M6 brief: "positions survive a restart, match the exchange, and keep
their strategy/risk context." That is the contract this ADR locks.

The hard surface is **re-association**: a restarted engine sees a list of
open exchange positions (truth) and a list of open DB rows (what the bot
*believed* before crash). For each exchange position, it must find the DB
row whose strategy version, SL/TP, cooldown, and time-stop context applies
— so the resumed bot operates the position with full knowledge, not as a
stranger.

Constraints:

- **Exchange is truth** (ADR 0010 §1).
- **No order path bypasses the risk gate.** Even kill-switch flatten on a
  half-recovered position goes through the gate (ADR 0004 §2).
- **Idempotency on every action** (ADR 0006). The recovery sweep MUST NOT
  re-submit any order whose `clientOrderId` already terminal in the DB.
- **Determinism for backtest replay.** The M7 backtest can simulate
  "engine restarted at T" by replaying `tick_aggregates` and
  `transactions` rows; the recovery path must produce the same in-memory
  state from the same DB inputs.

## Decision

### 1. Restart phases — ordered, no I/O reordering allowed

The boot sequence is a strict pipeline. Each phase completes before the
next starts; phases beyond §1 do not begin until §1's reconciliation
sweep finishes.

```
Phase 0  module init                   (NestJS DI, repos, exchange client)
Phase 1  load durable state            (positions + risk_state + cooldowns + reservations-skeleton)
Phase 2  pull exchange truth           (fetchPositions, fetchOpenOrders, fetchBalance)
Phase 3  re-associate + apply drift    (per-position diff → state transitions per ADR 0010)
Phase 4  rebuild in-memory caches      (reservations from positions, cooldowns from risk_state, monitor arms)
Phase 5  rebuild SubscriptionRetainer  (retainer entries from non-closed positions; ADR 0011 §5)
Phase 6  subscribe market data         (price.update tape begins flowing)
Phase 7  write boot account_snapshot   (ADR 0012 §6)
Phase 8  start scheduled jobs          (reconciliation tick, instrumentation flush, snapshot scheduler)
Phase 9  open the orchestrator         (volatility.detected events now consumed)
```

**Reviewer rule:** the orchestrator MUST NOT consume `volatility.detected`
events until phase 9 starts. Phases 6–8 begin scheduling, but no new
trade-intent path runs until 9. If the engine sees a trigger mid-recovery
and tries to evaluate it, the gate rejects with a new
`RejectReasonEnum.RECOVERY_IN_PROGRESS` (added by
`bot-shared-maintainer`).

**Reject scope (revised post-M6 R1):** `RECOVERY_IN_PROGRESS` rejects
**only exposure-increasing intents** — `intentAction ∈ {OPEN, ADD}`.
De-risking intents — `intentAction ∈ {REDUCE, CLOSE, FLATTEN}` — pass the
recovery guard at every phase from phase 4c onward (when the local
monitor and reconciliation tick are live). Rationale:

- ADR-0004 §2 already mandates "de-risking can never be blocked." A
  blanket `RECOVERY_IN_PROGRESS` reject contradicts that invariant.
- Case-(a) `flatten` policy at boot emits a synthetic `CLOSE`. Blocking
  it would make the config flag inert during the only window it actually
  fires (boot drift sweep, phase 3).
- `LocalProtectiveMonitor` SL/TP breaches detected between phase 4c
  (re-arm) and phase 9 (orchestrator open) are real protective events.
  Silently dropping their close intents would violate the always-protected
  invariant (ADR-0008 §4).

The recovery guard's purpose is **"no new exposure during recovery"** —
narrow to that. Open-exposure intents stay rejected; everything else
passes. The phase ordering still holds: phases 4c → 8 only run
de-risking close paths originated by the boot sweep or the local monitor,
not strategy-originated `OPEN`/`ADD` intents (those wait for phase 9).

### 2. Phase 1 — load durable state (port-dispatched on `EXCHANGE_ENV`)

Sequence (all reads, no writes):

1. `bootStateSource.loadNonClosedPositions()` — rows in
   `state ∈ {pending_open, open, closing, reconciling}`. Dispatched per
   the table below.
2. `riskStateRepository.findToday()` — today's daily/weekly loss window.
   PAPER reads the same `risk_state` row family; risk-gate state is mode-
   neutral.
3. `transactionRepository.findRecentNonTerminalIntents(lookbackHours: 24)`
   — fills with no terminal record (entries to the `UNKNOWN_INTENT_OUTCOME`
   case-f handler). PAPER does not produce `transactions` rows (paper
   fills land in `paper_account_state_history`), so PAPER's source
   returns an empty set.
4. `bootStateSource.loadLatestAccountSnapshot()` — informational only
   (for drift-alert in phase 7). PAPER reads `paper_account_snapshots`.

**`IBootStateSource` dispatch (M11a R0.4 amendment):**

| `EXCHANGE_ENV` | Bound implementation | Position source | Latest snapshot source |
|---|---|---|---|
| `LIVE` | `ExchangeBootStateSource` | `positionRepository.findAllNonClosed()` | `accountSnapshotRepository.findLatest()` |
| `TESTNET` | `ExchangeBootStateSource` | same | same |
| `PAPER` | `PaperBootStateSource` | `paperAccountStateRepository.findAllOpen()` + closed-history join | `paperAccountSnapshotRepository.findLatest()` |

The port is bound once at NestJS module composition (Phase 0). The
dispatch is **structural**, not runtime: a PAPER boot cannot reach the
live exchange's `fetchPositions`/`fetchBalance` even by accident, because
the engine's recovery loop holds a reference to `IBootStateSource`, not
to `IExchangeClient` directly. This matches ADR 0032 §D14's runtime
guard against `ModuleRef.get(IExchangeClient)` from non-whitelisted
call sites.

These reads populate the engine's working set. No state transitions
happen yet.

### 3. Phase 2–3 — pull exchange truth and apply drift policy

Phase 2:

1. `exchange.fetchPositions()` — all open exchange positions.
2. `exchange.fetchOpenOrders()` — all resting orders (used for case-e
   protective drift).
3. `exchange.fetchBalance()` — for phase 7 snapshot.

Phase 3 — the **boot drift sweep**, identical to a regular
reconciliation tick (ADR 0010 §2) but run once before any other code
consumes state:

For each `(symbol, side)` pair in either set:

- Both have a record → `qty` diff check (case c).
- Exchange only → case (a) `EXCHANGE_NOT_IN_DB`. Boot policy is the
  config flag's value (`adopt_unmanaged` dev / `flatten` live, same as
  steady-state).
- DB only → case (b) `DB_OPEN_NOT_ON_EXCHANGE`. Transition to `closed`
  with `exit_reason = RECONCILED_MISSING`.

Additionally:

- For each `transactions` row from §2 step 3 with non-terminal status,
  run case (f) `UNKNOWN_INTENT_OUTCOME` — query `fetchOrder(clientOrderId)`,
  resolve terminal state, write the transaction row's final state. The
  query is per-row but small (< 50 rows expected in a 24h lookback).
- For each `state = pending_open` row in the DB whose protective attach
  was unconfirmed pre-crash: verify exchange-side SL/TP exist via the
  fetchOpenOrders cache. If present → flip `pending_open → open`,
  `protective_order_type = EXCHANGE_SIDE`, disarm-pending. If absent →
  flip `pending_open → open`, keep `protective_order_type = LOCAL_FALLBACK`,
  keep arm pending (the re-arm happens in phase 4).

### 4. Phase 4 — rebuild in-memory caches

After phase 3, the DB rows are authoritative. Now reconstruct memory:

#### 4a. Exposure reservations

The in-memory ledger was wiped. M4's `risk_state.open_exposure` in the DB
may be stale (includes exposures of positions that closed during the
crash). Authoritative rebuild:

```
open_exposure := SUM(positions.qty * positions.entry_price)        -- live residual notional
                 WHERE state IN ('pending_open', 'open', 'closing', 'reconciling')
                   AND state != 'manual_adopted_unmanaged'          -- structural exclusion (R1 high L11)
                 GROUP BY side / correlation_mode
                 (whatever the gate's exposure breakdown demands)
```

**Revised post-M6 R1:**

- Exclusion key is **`state`**, not `correlation_mode`. After an
  operator-ack on a `MANUAL_ADOPTED_UNMANAGED → OPEN` transition the
  `correlationMode` may still be null at the instant of the ack (the
  ack handler assigns a default, see below), so an exclusion keyed on
  `correlationMode IS NULL` would let a recently-acked managed position
  stay invisible to `open_exposure` forever. State-keyed exclusion is
  structural: only `manual_adopted_unmanaged` is excluded; every other
  non-closed state contributes regardless of correlation.
- Notional uses the **live residual** `qty * entry_price`, not the
  immutable `entry_notional` column. `entry_notional` is set at open
  and never decremented on partial reduces (it's an M8 analytic
  column); using it in the rebuild would over-state exposure for any
  partially-reduced position. (Round-1 quant high #Q1.)
- Operator-ack handler (`M9 endpoint /positions/:id/adopt --ack`) MUST
  assign a `correlationMode` value when transitioning
  `MANUAL_ADOPTED_UNMANAGED → OPEN`. Default is
  `CorrelationModeEnum.CORRELATED` — conservative (uses slot C,
  single-correlated cap, no idiosyncratic slot claim). Operator may
  override to `IDIOSYNCRATIC` if they accept the slot-A/B claim
  explicitly; default stays conservative.

The gate's `RiskStateRepository` is updated with the rebuilt value. **The
in-memory reservation ledger is left empty** — only `PENDING` reservations
are tracked there; `CONFIRMED` exposure lives implicitly in `positions`.
Any pre-crash `PENDING` reservation either (a) became a position
(included in the SUM above), or (b) never filled (orphan transactions
row from phase 3 case-f handling → already resolved).

**This is the authoritative release path for leaked reservations** (M6
brief, ADR 0010 §4). The rebuild ignores any pre-crash reservation
deltas entirely; the DB's `positions` table is the only source of truth
for current exposure.

#### 4b. Cooldown table

`risk_state` already persists cooldowns per ADR 0004 §5. The in-memory
cooldown map is rebuilt by reading the persisted cooldowns and filtering
to those whose `expiresAtMs > nowMs`. Expired cooldowns are not loaded.

#### 4c. LocalProtectiveMonitor arms

For each position in `state ∈ {pending_open, open, closing}` with
`protective_order_type = LOCAL_FALLBACK`:

- Read `stop_loss_price` and `take_profit_price` from the `positions`
  row (added in ADR 0011 §7).
- Call `LocalProtectiveMonitor.arm({ positionId, symbol, stopLossPrice,
  takeProfitPrice })`.

For positions in those states with `protective_order_type = EXCHANGE_SIDE`,
the monitor stays disarmed (exchange-side is active).

**Re-arm runs synchronously in phase 4, before phase 6 starts the
market-data tape.** This is the structural guarantee: no `price.update`
fires before every held position has a monitor entry (or a confirmed
exchange-side protector).

#### 4d. PositionInstrumentor accumulator

For each non-closed position, seed the instrumentor's in-memory state
from the persisted MAE/MFE/etc. columns (ADR 0013 §5). Updates resume
from the persisted floor; sub-flush-interval deltas from before the crash
are lost (acceptable per ADR 0013).

### 5. Phase 5 — SubscriptionRetainer rebuild

Per ADR 0011 §5 "Cleanup invariant":

```
for each position in state ∈ {pending_open, open, closing}:
    retainer.retain(symbol, OPEN_POSITION)
for each position in state = reconciling:
    retainer.retain(symbol, PENDING_RECONCILE)
for each position in state = manual_adopted_unmanaged:
    retainer.retain(symbol, FOREIGN_ADOPTED)
for each active cooldown (post-phase-4b):
    retainer.retain(symbol, COOLDOWN_ACTIVE)
```

Phase 6's market-data subscription set is the union of top-300 universe
and the retainer.

### 6. Orphans — what counts as one, and exact behaviour

An **orphan** is any of:

1. A `transactions` row with `clientOrderId` that resolves to a terminal
   exchange state but whose target `positions` row no longer matches the
   exchange — i.e. the fill happened but the position was closed by
   something else before we could see it. Handled as case-b drift (the
   position is gone; reconcile the DB row to closed).
2. An exchange position with no DB row whatsoever and no
   `transactions.clientOrderId` lineage — i.e. a manual trade or a
   foreign deposit. Handled as case-a drift per the foreign-position
   policy (`adopt_unmanaged` dev / `flatten` live).
3. A DB row in `state = pending_open` whose protective attach never
   completed AND whose entry fill is not present on the exchange — i.e.
   we wrote the position row but the fill was actually rejected /
   never materialized. Phase 3 detects this via fetchPositions returning
   zero qty for the symbol; transitioned to `closed` with
   `exit_reason = RECONCILED_MISSING`. The entry-side `transactions` row
   is left as audit, marked non-position-linked (ADR 0007 §3 already
   accepts zero-qty entries).
4. An in-memory reservation that referenced a position id — irrelevant
   post-restart because the ledger is empty (§4a).

**The boot sweep handles every orphan class above.** A reviewer rule:
"no DB row left in `pending_open` after phase 3 unless its fill is
genuinely indeterminate (case-f TTL window not yet expired)."

### 7. Idempotency across restarts

No order is re-submitted by the recovery path. Phase 3 only reads from
the exchange and updates DB state; it does not place orders, with one
exception: if case (e) protective drift is detected, the protective
*retry* (ADR 0010 §1e) fires on the next reconciliation tick — phase 8.
That retry uses the same deterministic `clientOrderId` scheme (ADR 0006
§1), so if the original protective order eventually resurfaces, the
exchange dedupes it.

**Reviewer rule:** phase 3 MUST NOT call `exchange.createOrder` or any
order-placement path. The recovery is read-only against the exchange
except for retries scheduled via the normal reconciliation cadence.

### 8. Determinism in backtest

M7 backtest replays "restart at tick T" by:

1. Reading the persisted `positions` / `transactions` / `risk_state`
   rows as of T.
2. Replaying the boot pipeline (phases 1–8) with the injected clock
   pinned at T and a synthetic `fetchPositions` derived from the
   recorded state at T (no live exchange call).
3. Resuming the replay from T.

Same code, same DB inputs, same in-memory state post-recovery. Live and
backtest crash-recovery match.

### 9. Reviewer rules consolidated

- Phases are strictly ordered. Phase N+1 starts only after phase N's
  promise resolves.
- The orchestrator is closed until phase 9. Mid-recovery triggers are
  rejected via `RECOVERY_IN_PROGRESS`.
- No order placement during phase 3.
- `open_exposure` is rebuilt from `SUM(positions.entry_notional)`,
  not from any cached value.
- Monitor re-arm runs in phase 4, before market-data subscription opens
  in phase 6. A position whose re-arm could race with `price.update` is
  a structural bug, not an ordering bug.
- `RECOVERY_IN_PROGRESS` rejects do not write `decisions` rows (would
  pollute the trigger evidence base for M8). They log only.
- The boot account_snapshot is the only snapshot for this minute even
  if the 60s scheduler tick lines up — the scheduler skips if a
  same-minute snapshot already exists. Avoids two snapshots per minute
  on boot.

## Consequences

- The engine startup time grows by the duration of phases 2–3 — typically
  < 2 seconds for a small position book on Binance Futures. Acceptable.
- A new `RejectReasonEnum.RECOVERY_IN_PROGRESS` and the existing
  `RECONCILING_HOLD` (ADR 0009) both signal "not now" to a trigger; the
  M8 analysis distinguishes them.
- The recovery pipeline is a top-level `EngineBootstrapService` (or
  similar), invoked from `onApplicationBootstrap` lifecycle hook in
  NestJS. Engine wave owns implementation; this ADR locks the contract.
- Backtest crash-recovery scenarios are first-class M7 test cases (a
  follow-up M7 plan item — not implemented here, but the contract is
  M7-ready).

## Alternatives considered

- **Recover lazily on first trigger after restart.** Rejected: the
  drift window between boot and first trigger could be minutes; a
  position could liquidate before recovery saw it. Eager boot sweep is
  the safer model.
- **Persist the reservation ledger to a `reservations` table so it
  survives restarts.** Rejected for the same reasons in M4 §3 and ADR
  0010 §4: durability buys nothing because reconciliation is the
  recovery mechanism; the persisted ledger would become a stale-data
  hazard.
- **Replay all `transactions` rows in time order to rebuild positions
  in memory.** Rejected: redundant with the durable `positions` table;
  also fragile against multi-version schema migrations.
- **Allow the orchestrator to consume triggers during phase 6 (price
  subscriptions live but no triggers evaluated until 9).** Functionally
  the same as the locked version; the explicit gate at phase 9 makes
  the "no trades during recovery" rule a structural assertion rather
  than a comment.
- **Use `Binance LISTEN_KEY` user-data stream to detect restart drift
  faster.** Deferred to M9: the REST poll suffices for M6's small
  position-book scale; the WS stream is a future scale enhancement.
- **Skip the re-arm of LocalProtectiveMonitor on boot and trust
  exchange-side protectors only.** Rejected: rows with
  `protective_order_type = LOCAL_FALLBACK` have no exchange protector;
  not re-arming would leave them unprotected post-restart — direct
  violation of the always-protected invariant.

## See also

- `docs/plans/archive/M6-position-management.md` (crash-recovery task)
- `docs/architecture/adr/0009-position-state-machine.md` (states the recovery reads/writes)
- `docs/architecture/adr/0010-reconciliation-and-drift-policy.md` (the drift cases the boot sweep applies)
- `docs/architecture/adr/0011-local-sltp-fallback-and-held-symbols.md` (monitor re-arm, SubscriptionRetainer rebuild)
- `docs/architecture/adr/0012-funding-and-pnl.md` §6 (boot account_snapshot)
- `docs/architecture/adr/0013-position-instrumentation.md` §5 (instrumentor seeding)
- `docs/architecture/adr/0006-idempotency-contract.md` §3 (timeout query protocol used in phase 3 case-f)
- `docs/architecture/adr/0004-risk-management.md` §3 (reservation ledger M6 seam)
