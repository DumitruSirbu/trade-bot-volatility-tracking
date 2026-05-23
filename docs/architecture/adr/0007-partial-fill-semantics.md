# ADR 0007 — Partial-fill semantics (M5)

Status: Accepted
Date: 2026-05-23
Milestone: M5 — Execution (testnet)

## Context

The M5 brief is explicit: **filled qty (not intended qty) drives position notional, SL
distance, TP distance, and exposure accounting**. Partial fills are common on
USDT-M Futures, particularly under the order policies of ADR 0005 (marketable-limit-IOC
that crosses thin depth; post-only maker that fills as the book scratches the price).
Getting this wrong is a survival-class bug: an SL sized to the intended qty leaves a
position over-stopped (SL further from price than the risk budget allows) or under-stopped
(SL too tight, triggers on noise) when the actual fill is smaller.

This ADR locks how the executor reads fills, updates positions/reservations/exits, and
handles the unfilled remainder. It binds tightly to ADR 0005 (which orders even get
placed), ADR 0006 (which ids identify them), and ADR 0008 (which protective orders
attach).

## Decision

### 1. Filled qty is authoritative for **every** downstream quantity

Whenever the executor records a fill (entry or exit), it computes:

```
filledQty       = sum of trade fills tied to this clientOrderId       (decimal)
filledNotional  = sum(fillPrice_i * fillQty_i)                         (decimal)
avgFillPrice    = filledNotional / filledQty                           (decimal)
```

These three numbers — never `intent.sizing.qty`, `intent.sizing.notional`, or the
limit/ref price — feed:

- `positions.qty` (post-open: `filledQty`; post-add: `previousQty + filledQty`; post-reduce:
  `previousQty - filledQty`).
- `positions.entry_price` and `positions.entry_notional` (qty-weighted average on add).
- The **SL price recomputation** when the strategy's `proposedExit.stopLossPrice` is
  defined in **ATR multiples from entry** (ADR 0003 §3): the SL recomputes from
  `avgFillPrice ± atr * atrStopMultiplier`. The SL **distance** the strategy asked for is
  preserved; the **absolute price** moves with the actual fill.
- The **TP price recomputation** by the same rule.
- The **risk-gate reservation update** (ADR 0004 §3): the reservation is
  partially-confirmed for `filledNotional` and the remainder either stays `PENDING` (if
  the order is still alive) or releases (if cancelled/expired) — never both.
- **`positions.entry_notional` for the exposure-cap accounting** that the gate enforces on
  any future `ADD` against this position.

The intended qty/notional are kept only as `decisions.market_snapshot.intended_*` for
audit. They never reach SL/TP math or exposure caps. Reviewer must-fix: any code path that
computes a protective price from `intent.sizing` instead of the fill record.

### 2. Fill arrival model — accumulate, then resolve at terminal

Binance USDT-M Futures emits fills via the user-data WebSocket (`ORDER_TRADE_UPDATE`
events with execution type `TRADE`) before the order moves to a terminal state. The
executor:

1. Subscribes to the user-data stream (already provisioned in M1's `ExchangeModule`).
2. Accumulates per-order fills into an in-memory `FillAccumulator` keyed by
   `clientOrderId`. Each `TRADE` event contributes `(qty, price, fee, feeCcy, ts)`.
3. **Does not write a `transactions` row per partial.** ADR 0006 §5 locks one
   `transactions` row per terminal state per `clientOrderId`; the partials roll up into
   the single row at terminal.
4. At terminal (`FILLED`, `PARTIALLY_FILLED + canceled/expired`, or the recovery path of
   ADR 0006 §3), the executor:
   - Persists the one `transactions` row with `qty = filledQty`, `price = avgFillPrice`,
     `fee = sum(fees)`.
   - Updates `positions` per §3 below.
   - Attaches/refreshes the protective orders per ADR 0008.
   - Resolves the reservation per §4 below.

The accumulator is **in-memory only** (same rationale as the risk-reservation ledger in
ADR 0004 §3: transient, single-process, recovery owned by M6). A restart mid-fill is
handled by M6's reconciliation: `fetchOrder(clientOrderId)` returns the exchange-side
`executedQty` + `cumQuote`, which becomes the recovered `filledQty`/`filledNotional`.

### 3. Position-state transitions on partial fills

The state machine for an open `positions` row is driven by fill events, not by intent
events:

```
(no row) ──first-fill on OPEN──► OPEN qty=f1                 row created at first fill
OPEN qty=q ──fill on ADD─────► OPEN qty=q+f, weighted-avg entry_price recomputed
OPEN qty=q ──fill on REDUCE──► OPEN qty=q-f  (if q-f > 0)
OPEN qty=q ──fill on REDUCE──► CLOSED qty=0  (if q-f == 0 or close intent)
OPEN qty=q ──fill on CLOSE───► CLOSED qty=0
OPEN qty=q ──fill on FLATTEN─► CLOSED qty=0, exit_reason='kill_switch'
```

**Locked invariants:**

- **The position row is created on the first fill of an `OPEN`, not on submit.** A
  zero-filled `OPEN` (missed entry) leaves no `positions` row — only a `decisions` row
  with `action=open, outcome=approved` and a `transactions` row with
  `qty=0, position_id=NULL`. This keeps the open-positions table free of phantom
  entries that complicate M6 reconciliation.
- **Schema relaxation: `transactions.position_id` is nullable.** ADR 0006 §1 mandates
  one terminal row per `clientOrderId` including zero-fill outcomes, but a zero-fill
  OPEN has no position to reference. M5 ships a forward migration that drops `NOT NULL`
  on `transactions.position_id` (reversible: the down migration backfills `NULL` rows
  is impossible without data loss, so the down path drops the zero-fill audit rows
  before re-applying the constraint — documented in the migration header). A
  `transactions.position_id IS NULL` row is **only** valid when
  `transactions.qty = 0 AND transactions.type IN ('open','add')` — a CHECK constraint
  enforces this so partial-fill / reduce / close rows still require a position. The
  alternative (a separate `missed_entries` audit table) was considered and rejected:
  it introduces a second source of truth for client-order-id uniqueness and complicates
  M6 reconciliation's join, with no upside over the nullable-FK + CHECK approach.
- **Weighted-average entry on ADD:** `newEntryPrice = (oldQty*oldEntryPrice +
  filledQty*avgFillPrice) / (oldQty + filledQty)`, decimal throughout. The SL/TP **do not
  re-anchor on ADD by default** — the original entry SL/TP stay (otherwise an ADD into a
  loser would tighten the SL toward worse prices, which is exactly the trap an
  add-to-loser tries to escape). Versions that want re-anchoring set
  `params.reanchorSlOnAdd=true`; M5 default is `false`.
- **Reduce/close use the position's current `qty` as the size cap.** A reduce intent
  whose `intent.sizing.qty > positions.qty` is clamped to `positions.qty` at the executor
  boundary (the gate already approves de-risking unconditionally — ADR 0004 §2).
- **`exit_price` / `realized_pnl` on close** are computed from `avgFillPrice` of the
  closing transaction(s), accumulated across any partial closes.

### 4. Unfilled-remainder policy — `awaitPolicyTimeout` branches per policy, not one shared cancel path

The remainder policy is a pure function of the order policy that filled (so backtest
mirrors live). Round-1 reviewers flagged that a single shared "cancel-then-classify"
path is not safe — the three policies have structurally different terminal-decision
rules. Locked, explicit per-policy paths:

**`MARKETABLE_LIMIT_IOC` — exchange auto-cancels, executor only fetches terminal state.**

- The exchange enforces IOC: any unfilled remainder is auto-cancelled on the exchange
  side at the moment of submission's last fill attempt. The executor's
  `ORDER_TIMEOUT_MS` (2,000 ms — ADR 0005 §3) is a defensive backstop in case the ack
  itself was lost.
- On timeout, the executor **does not call `cancelOrder`** (no remainder is alive). It
  calls `fetchOrder(clientOrderId)` to discover the terminal state (filled / partially
  filled then auto-cancelled / never reached the exchange — the latter is the §3
  recovery path of ADR 0006).
- Outcome: persist one `transactions` row at whatever `filledQty` came back (zero or
  partial); attach SL/TP per ADR 0008 if `filledQty > 0`; release reservation per §5.

**`POST_ONLY_MAKER` — cancel-then-classify, no remainder re-evaluation, no chase.**

- On timeout the executor calls `cancelOrder(clientOrderId)`, then `fetchOrder` to
  resolve the terminal state (the cancel can race a late fill).
- If `filledQty > 0`: keep the filled portion as the position; SL/TP sized to
  `filledQty × avgFillPrice` per §1. **Do not re-evaluate the remainder.** Do not
  emit a new intent for the missed portion; do not re-submit at a different price.
  This is the no-chase invariant from ADR 0005 §4 applied at the partial level.
- If `filledQty == 0`: no position, full reservation release, `transactions` row with
  `qty=0, position_id=NULL` (per §3 schema relaxation).

**`REDUCE_MARKET` — retry remainder until filled or budget exhausts, then escalate.**

- On timeout the executor calls `cancelOrder` then `fetchOrder` to determine the
  remainder. If `remainderQty > 0`, the executor immediately re-submits a new
  `REDUCE_MARKET` order for `remainderQty` with **`attemptN++`** and therefore a fresh
  `clientOrderId` (ADR 0006 §1). The new submission is again subject to its own
  `ORDER_TIMEOUT_MS` (5,000 ms — ADR 0005 §3).
- The retry loop is bounded by `MAX_PERMANENT_RETRY_ATTEMPTS` (ADR 0006 §4) **plus** a
  separate `MAX_REDUCE_REMAINDER_ATTEMPTS = 3` ceiling on the remainder-retry count
  specifically (preventing pathological partial-fill loops from exhausting the
  permanent-reject budget that other paths need). When either budget exhausts on a
  reduce/close path that has not fully exited, the executor escalates by emitting
  `ORDER_INTENT_UNKNOWN_EVENT` (the same event name §3 of ADR 0006 uses for
  unrecoverable submit states) so M6's reconciliation + local monitor take ownership.
  De-risking that **cannot** complete via the normal path is the worst outcome the
  system tolerates, and M6 is the layer that owns that worst case.

The per-policy branching lives in `ExecutionService.awaitPolicyTimeout` as a switch on
`OrderPolicyEnum`. Reviewer must-fix: a default branch that applies one shared "cancel
then classify" path to all three policies — the three are not structurally equivalent.

Why "cancel, don't re-evaluate" for maker partials:

- Re-evaluating means asking the strategy again, which would consume a new event (the
  trigger conditions have moved on). The strategy's pure-function contract (ADR 0003) is
  not "given a half-filled position, what now?" — it's "given current market state, what
  signal?".
- Leaving a resting remainder beyond the policy timeout violates the no-chase invariant
  (ADR 0005 §4) by definition.
- The filled portion is a complete, smaller position with its own SL/TP. The strategy
  may produce a *new* `ADD` intent on a *new* event if conditions warrant.

For `REDUCE_MARKET`, retry-the-remainder is mandatory because the only worse outcome than
slippage on a reduce is **not exiting** — escalation continues until M6's local monitor
takes over (ADR 0008 §rejection-path).

### 5. Reservation reconciliation against partial fills

Couples to ADR 0004 §3's reservation lifecycle:

- On **first fill** of an `OPEN`: the `PENDING` reservation transitions to a hybrid where
  `confirmedNotional = filledNotional`, `pendingNotional = remainderNotional`. Both still
  count against exposure caps (so a concurrent same-bar candidate sees the right number).
- On **terminal with partial fill**: `confirmedNotional` is kept (now anchored to the
  real position id), `pendingNotional` is released — single ledger update, no leakage.
- On **terminal with zero fill**: full release.

The risk gate exposes `confirmReservation(reservationId, confirmedNotional, positionId)`
and `releasePending(reservationId)` on top of the existing `releaseReservation` — these
are additive to ADR 0004 §3's seam, not a redesign. M5 wires them; M4 stays unchanged.

### 6. Audit trail

For every terminal, the `transactions` row's `client_order_id` ties the filled qty back
to the originating `decisions.event_id` (via the seed in ADR 0006 §1) and to the
`positions.id` (via FK). M8 comparisons and M9 observability can answer "for this event,
what was intended vs filled vs realized?" by joining on those keys; no separate "intent
log" table is needed.

## Consequences

- Position SL/TP, exposure accounting, and reservation accounting are all driven by the
  same single source — the fill record. No two views of "how much position is open".
- The strategy never has to handle "half a position" semantically: it sees positions of
  qty `q` (whatever that turned out to be) and reasons from there.
- M7 must replay fills in the same accumulate-then-resolve pattern — single
  `transactions` row per terminal — to keep PnL math byte-identical.

## Alternatives considered

- **Drive SL/TP from intended qty.** Rejected: silently breaks the risk budget on every
  partial fill. Reviewer must-fix.
- **Write a `transactions` row per partial fill.** Rejected: introduces N-to-1 join
  complexity for PnL and conflicts with ADR 0006's "one row per terminal" idempotency
  contract. The audit detail (per-fill prices) is recoverable from the exchange's
  `myTrades` endpoint if ever needed; we do not duplicate it locally.
- **Leave maker remainders resting past the policy timeout.** Rejected: violates the
  no-chase invariant (ADR 0005 §4) and creates an open order whose origin event has
  decayed.
- **Re-anchor SL/TP on every ADD by default.** Rejected: encourages add-to-losers
  behaviour. Opt-in per version.
- **Cancel a partial-filled OPEN's filled portion too.** Rejected: a position exists once
  any qty has been bought. Closing it requires a reduce intent through the risk gate
  (ADR 0004 §2) — not a magical "un-fill". The smaller-than-intended position is a real
  position with real SL/TP.

## See also

- `docs/plans/M5-execution-testnet.md`
- `docs/architecture/adr/0005-execution-order-policy.md` (policy → timeout behaviour)
- `docs/architecture/adr/0006-idempotency-contract.md` (one transaction row per terminal)
- `docs/architecture/adr/0008-sl-tp-attach.md` (protective orders sized from filled qty)
- `docs/architecture/adr/0004-risk-management.md` §3 (reservation seam)
- `docs/architecture/adr/0003-strategy-engine.md` §3 (`proposedExit` shape)
