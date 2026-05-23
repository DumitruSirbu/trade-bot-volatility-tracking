# ADR 0006 — Idempotency contract (M5)

Status: Accepted
Date: 2026-05-23
Milestone: M5 — Execution (testnet)

## Context

`docs/plans/M5-execution-testnet.md` requires that **a restart or retry never doubles an
order**, and that the property hold for `open / add / reduce / close` — not just entries.
On an order whose final state is unknown (submit timeout), the executor must
`fetchOrder(clientOrderId)` first and only retry if the exchange has no record.

The match key for reconciliation is already locked by M2/M6: `transactions.client_order_id`
is the bot-controlled key (`exchange_order_id` is only set post-fill and is unique).
Binance USDT-M Futures accepts a user-supplied `newClientOrderId` on order submit and the
ccxt `createOrder({ clientOrderId })` call passes it through; `fetchOrder` accepts
`{ clientOrderId }` to look up by it. (Verified via context7 docs against ccxt 4.5.x and
the Binance USDT-M Futures spec used by `CcxtBinanceExchangeClient` in M1.)

## Decision

### 1. `clientOrderId` scheme — deterministic, replayable, ≤36 chars

The `clientOrderId` is the SHA-1 (first 20 hex chars, prefixed) of a canonical seed:

```
seed   = `${eventId}|${positionSlot}|${intentAction}|${attemptN}`
hash20 = sha1(seed).hex().slice(0, 20)
clientOrderId = `tbvt-${hash20}`
```

- **Prefix `tbvt-`** identifies the bot's orders during reconciliation (M6 ignores any
  exchange order without it as "manual / external" and routes to the drift policy).
- **24 chars total** (`tbvt-` + 20 hex) is safely within Binance's 36-char
  `newClientOrderId` limit.
- **`eventId`** is the per-trigger stable id ADR 0003 mints (one per VWAP event, persisted
  on `decisions.event_id`). It scopes uniqueness to a single signal.
- **`positionSlot ∈ {A, B, C}`** disambiguates two intents that legitimately share an
  `eventId` (e.g. an add into an already-open slot vs an open on a free slot).
- **`intentAction ∈ {open, add, reduce, close, flatten}`** disambiguates entry vs exit on
  the same position.
- **`attemptN`** is `0` on first submit, incremented **only after a confirmed permanent
  failure** (rejected by the exchange with a non-retriable error). It is **not**
  incremented after a timeout — a timeout reuses the same id so the recovery query
  (`fetchOrder`) finds any order that did make it through.

Properties:

- **Deterministic**: identical inputs → identical id. Backtest produces the same ids; tests
  pin against them. No UUID, no RNG, no `Date.now()`.
- **Idempotent at the exchange**: a duplicate submit with the same `clientOrderId` is
  rejected by Binance with `-5022 "Duplicate order id"` — the executor treats that error
  as "already submitted, fetch and reconcile" rather than as failure.
- **Auditable**: the seed can be reconstructed from persisted `decisions` +
  `transactions.type` + `positions.position_slot`, so reconciliation never depends on a
  separate id map.

### 2. Submit state machine

```
                  ┌─────────────────────────────────────────────────────┐
                  ▼                                                     │
PLANNED ──submit──► SUBMITTING ──ack──► OPEN ──fill──► FILLED ──persist──► DONE
   │                    │                  │                                ▲
   │                    │                  ├─partial→ PARTIAL ──(ADR 0007)──┤
   │                    │                  │
   │                    │                  └─cancel─► CANCELLED ──persist──►DONE
   │                    │
   │                    ├─timeout(no ack)──► UNKNOWN ──recovery(§3)──► OPEN / DONE / RECONCILE
   │                    │
   │                    └─reject(perm)─────► REJECTED ──attemptN++─► PLANNED   (bounded retries, §4)
   │
   └─pre-submit-fail──► ABORTED (no exchange call made)
```

- `UNKNOWN` is the only state from which a retry might double-fire. It is the protocol's
  most important transition; §3 owns it.
- `REJECTED` only loops back to `PLANNED` for **transient, permanent-but-classifiable**
  errors where a new `attemptN` is the right action (see §4). A permanent reject on the
  intent itself (e.g. "reduce-only would not reduce position") goes straight to `ABORTED`
  and a `transactions` row with `qty=0` plus the reject reason; the executor emits
  `order.intent.failed` so the gate releases the reservation.

### 3. Timeout-recovery protocol (binding)

When `createOrder` does not return an ack within `executionConsts.SUBMIT_NETWORK_TIMEOUT_MS`
(locked at **3,000 ms** — distinct from the policy timeout of ADR 0005 §3), the executor
enters `UNKNOWN` and runs:

1. **Wait for `RECOVERY_BACKOFF_MS`** (default `1,000 ms`) so the exchange has had time to
   apply the create if it did arrive. Backoff comes from `executionConsts`, not a magic
   number.
2. **`fetchOrder({ clientOrderId })`.** Binance USDT-M Futures returns the order if it
   exists, otherwise an `OrderNotFound` (ccxt-translated). Behaviour by result:
   - **Order exists, status ∈ {`new`, `partially_filled`, `filled`}** → adopt as the
     authoritative submission. Move to `OPEN` / `PARTIAL` / `FILLED` and continue normal
     handling. **Do not retry.**
   - **Order exists, status ∈ {`canceled`, `expired`, `rejected`}** → record the terminal
     `transactions` row and emit `order.intent.expired`/`failed`. **Do not retry** with
     the same id (would just collide); the orchestrator decides whether a fresh signal
     warrants a new intent (which gets a fresh `eventId`).
   - **Order not found** → it never reached the exchange. **Retry with the same
     `clientOrderId`** (same `attemptN`). The duplicate-id guard at the exchange protects
     against a delayed first submit racing the retry.
3. **Retry budget on `UNKNOWN`:** at most `MAX_UNKNOWN_RECOVERY_ATTEMPTS = 3` recovery
   cycles. After that, the executor gives up, persists a `transactions` row with
   `client_order_id` set, `qty=0`, and `position_id=NULL` (the schema relaxation in
   ADR 0007 §3), marks the intent as `RECONCILE_REQUIRED`, and emits
   `order.intent.unknown` (the engine constant `ORDER_INTENT_UNKNOWN_EVENT`) for M6 to
   resolve on its next reconciliation sweep (M6 owns the authoritative release path —
   ADR 0004 §3, M6 brief).

### 4. Reject-classification taxonomy (locked)

Every reject from the exchange is mapped to one of three classes by the **submitter
adapter**, not by the caller substring-matching error text. The classification surfaces
as a structured field on a domain exception:

```
class ExchangeRejectError extends Error {
    readonly class: 'RETRIABLE' | 'TERMINAL' | 'UNKNOWN';
    readonly venueCode: string;      // e.g. '-2010', '-1021'
    readonly venueMessage: string;
    readonly raw: unknown;           // original ccxt error, for diagnostics
}
```

The submitter inspects the ccxt error type and Binance numeric code (Binance USDT-M
Futures error code mapping verified against ccxt 4.5.x Binance USDT-M Futures docs; the
`Binance error codes` table is the authoritative source). The mapping is a pure
function — a table in `executionConsts.BINANCE_REJECT_CLASSIFICATION` — so backtest
failure-injection runs and live use the same classifier.

**Class `RETRIABLE`** — a fresh submission has a plausible chance to succeed.
`attemptN` increments and the submitter retries up to `MAX_PERMANENT_RETRY_ATTEMPTS`:

- `-1021` Timestamp outside recv window (clock drift; retry resyncs).
- `-1003` Too many requests (after the rate-limit backoff window honoured).
- `-1015` Too many new orders (same rate-limit family).
- `-1007` Timeout waiting for response from backend (server-side transient).
- `-1000` / `-1001` Unknown / disconnected (generic transient).
- ccxt `ExchangeNotAvailable`, `NetworkError`, `RequestTimeout` (5xx / TCP class).

**Class `TERMINAL`** — the intent itself is invalid; the same intent submitted again
will fail identically. No `attemptN` increment, no retry. Persist a `transactions` row
with `qty=0` and the venue code; emit `order.intent.failed`; release the reservation.

- `-2010` New order rejected (`reduce-only` would not reduce, or order would not pass
  initial checks).
- `-2011` Cancel order rejected (terminal for cancel calls, not entries).
- `-2013` Order does not exist (terminal for cancel/fetch under recovery — see §3 for
  the create-path interpretation).
- `-2018` Balance is insufficient.
- `-2019` Margin is insufficient.
- `-2020` Unable to fill (would self-trade).
- `-2021` Order would immediately trigger (relevant for protective orders — ADR 0008).
- `-2022` ReduceOnly order is rejected.
- `-2027` Exceeded the maximum allowable position.
- `-4131` `PERCENT_PRICE` filter / GTX would-cross (post-only that would take).
- `-4164` Order's notional must be no smaller than the minimum.
- ccxt `InsufficientFunds`, `OrderImmediatelyFillable` (post-only that would cross),
  `OrderNotFillable`, `InvalidOrder`, `BadSymbol`.

**Class `UNKNOWN`** — code not in the table. Treated as **terminal** for safety (we do
not retry into an unclassified condition that might be permanent), but logged at WARN
with the venue code so the table can be extended in a follow-up patch. M9 alerts on any
`UNKNOWN` rejection so unmapped codes surface immediately during testnet operation.

**Reuse rule (`UNKNOWN` recovery path, distinct from this class):** the `UNKNOWN`
*state* in §3 (submit-timeout / ack-loss) reuses the same `attemptN` so the recovery
`fetchOrder` query finds any order that did make it through. This is orthogonal to the
reject-classification `UNKNOWN` class above; the names overlap but the mechanisms are
disjoint. Reviewer must-fix: any code that conflates them by, say, incrementing
`attemptN` on a submit timeout or substring-matching `"timeout"` in the error message.

**Submitter contract (reviewer must-fix if violated):**

- The submitter exposes one method that returns `Promise<OrderAck>` or throws
  `ExchangeRejectError` with `class` set. Callers branch on `class`, never on
  `venueMessage` substrings.
- Substring matching on Binance error text in any caller is a must-fix — venue messages
  are not API.
- An `UNKNOWN`-class reject that retries is a must-fix (default is terminal).
- A `TERMINAL`-class reject that retries is a must-fix.
- A `RETRIABLE`-class reject that does not increment `attemptN` is a must-fix.

Retry budget: `MAX_PERMANENT_RETRY_ATTEMPTS = 2` (so `attemptN ∈ {0, 1, 2}` max). The
table and constants live in `executionConsts` per `code-conventions.md` §"Constants
Placement".

### 5. Persistence boundary — one transaction row per `(clientOrderId, terminalState)`

- The `transactions` row is **inserted at terminal state**, not at submit. `client_order_id`
  is the unique key inside the row; `exchange_order_id` is filled if the exchange ever
  assigned one. A duplicate insert with the same `client_order_id` is caught by a unique
  constraint and treated as idempotent (per `code-conventions.md` §"Error Handling").
- A **zero-fill terminal on an OPEN intent** still writes a `transactions` row (`qty=0`,
  `position_id = NULL`) so the audit trail records the missed entry. This requires
  `transactions.position_id` to be **nullable** — see ADR 0007 §3 for the schema decision
  and the M5 migration that relaxes the constraint.
- This means: replaying the same `order.intent.approved` event a second time produces at
  most **one** `transactions` row, regardless of whether the second pass hit the duplicate
  via the exchange (`-5022`) or via the local unique-constraint catch.

### 6. Cross-cutting reviewer rules

- Any code path that issues `createOrder` / `createOrderWithTakeProfitAndStopLoss` /
  `cancelOrder` without going through `ExecutionService.submit(intent)` is a must-fix —
  the deterministic-id property is meaningless if other callers exist.
- Any test that exercises the executor with a random or wall-clock-derived id is a
  must-fix — backtest replays would diverge.
- Any retry that increments `attemptN` on a timeout (rather than reusing it) is a must-fix
  — defeats §3 and risks double-submit.

## Consequences

- The `clientOrderId` is a function of *persisted* data (eventId + slot + action +
  attemptN). On crash recovery (M6), the executor and the reconciler reconstruct the same
  ids from the DB, so `fetchOrder({ clientOrderId })` works after any restart.
- Backtest can serialize every order it would have placed by computing the same ids — M7
  acceptance test pins live vs replay id-for-id.
- The duplicate-id guard at Binance becomes a *feature*, not a bug: it is the last line
  of defense against double-submit under network partitions.

## Alternatives considered

- **UUIDv4 `clientOrderId`.** Rejected: non-deterministic, breaks backtest parity,
  duplicates on retry would race instead of being prevented.
- **Increment `attemptN` on timeout.** Rejected: the timeout might mean the order *did*
  reach the exchange, so a new `attemptN` would create a second live order. Only a
  classified permanent reject is allowed to advance the attempt.
- **Persist `transactions` at submit and update on terminal.** Rejected: introduces a
  mutable "in-flight" row state, conflicts with the in-memory reservation ledger (ADR
  0004 §3) which already covers in-flight accounting. Single insert at terminal keeps
  `transactions` an append-only ledger.
- **Single global `attemptN` counter (Redis / DB sequence).** Rejected: violates
  "single-process, no external coordination needed for determinism" from `00-overview.md`,
  and the per-intent scoped attempt is enough.
- **No prefix on `clientOrderId`.** Rejected: M6 needs a cheap test for "is this order
  ours?" during reconciliation, especially after a restart where the in-memory
  reservation ledger is empty.

## See also

- `docs/plans/M5-execution-testnet.md`, `docs/plans/M6-position-management.md`
- `docs/architecture/adr/0005-execution-order-policy.md`
- `docs/architecture/adr/0007-partial-fill-semantics.md`
- `docs/architecture/adr/0004-risk-management.md` §3 (reservation ledger seam)
- `docs/best-practices/code-conventions.md` §"Error Handling" (duplicate-key idempotency)
