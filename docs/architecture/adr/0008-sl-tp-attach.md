# ADR 0008 — SL/TP attach & protective-order fallback (M5)

Status: Accepted
Date: 2026-05-23
Milestone: M5 — Execution (testnet)

## Context

`docs/plans/archive/M5-execution-testnet.md` requires that **every open position be protected,
even for one tick**: SL/TP attached exchange-side at entry by default; when that path is
unavailable or rejected, M6's local price-driven monitor takes over and exits **through
the risk gate** at the level. `positions.protective_order_type ∈ {exchange_side,
local_fallback}` is already in the schema (M2) to record which path is active.

Binance USDT-M Futures supports `STOP_MARKET` and `TAKE_PROFIT_MARKET` orders with
`reduceOnly=true` and `closePosition=true`, and the order can use mark price as the
trigger reference (`workingType=MARK_PRICE`) — the right default to avoid wick-driven
liquidations from a tape outlier. (Cross-checked against ccxt's Binance USDT-M Futures
spec for `createOrder` with `type='STOP_MARKET'` / `'TAKE_PROFIT_MARKET'`.)

The invariant this ADR defends is the single most important survival rule in the system:

> **No open position is ever left unprotected, even for one tick.**

## Decision

### 1. Preferred path — exchange-side mark-price triggers, attached after entry fill confirmation

Sequence at entry (locked):

1. **Entry order submits and reaches a terminal state** (ADR 0006 §2 state machine). If
   terminal with `filledQty > 0`, proceed; otherwise no position, no protective attach
   needed.
2. **Compute SL/TP prices from `avgFillPrice`** (ADR 0007 §1), not from the intended
   entry. The SL/TP **distance** comes from the strategy's `proposedExit` (ADR 0003 §3),
   which the risk gate has already validated as inside-liquidation (ADR 0004 §8).
3. **Submit `STOP_MARKET` (SL) and `TAKE_PROFIT_MARKET` (TP)** with:
   - `reduceOnly: true`
   - `closePosition: true` (so the order's qty automatically matches the live position,
     handling future partial reduces without our re-sizing it — critical for ADR 0007's
     partial semantics)
   - `workingType: 'MARK_PRICE'` (avoids wick-driven false triggers from the last-price
     feed; matches the mark-vs-last divergence instrumentation M6 already records)
   - `timeInForce: 'GTE_GTC'` (good-till-cancel, exchange-managed lifetime)
   - Each carries its **own `clientOrderId`** built from the same seed scheme as the entry
     (ADR 0006 §1) with `intentAction='close'` and a stable `attemptN=0`, plus a suffix
     `-sl` / `-tp` appended **inside the 20-hex slice** so both ids stay distinct and
     reproducible. Recovery (`fetchOrder(clientOrderId)`) works for protective orders as
     it does for entries.
4. **Persist `positions.protective_order_type = 'exchange_side'`** only after both submits
   ack. While either is unconfirmed, the position is **provisionally** under the local
   monitor (§3 below) — the schema column flips to `exchange_side` only once both are
   confirmed-resting at the exchange.

### 2. Bracketing the entry — submit SL+TP **before** acknowledging the position as open

The position is not considered "open and unattended" until protection is on. Concretely
the executor's open-confirmation order is:

```
fill recorded → positions row inserted (qty, entry_price)
              → LocalProtectiveMonitor.arm(positionId, proposedExit)     [SYNCHRONOUS]
              → protectiveAttacher.attach(positionId, ...)                [exchange-side submits]
              ↓
              while SL+TP not both confirmed: position is under LOCAL monitor (§3)
              ↓
              both SL+TP confirmed → LocalProtectiveMonitor.disarm(positionId)
              ↓                       positions.protective_order_type='exchange_side'
              ↓
              order.position.opened emitted
```

**Arming is mandatory and synchronous, fires unconditionally regardless of attach
outcome.** The Round-1 reviewers flagged that the prior implementation only emitted the
arm signal **on attach-failure**, which leaves a window where, if attach succeeds
slowly, the position is unprotected by either layer for the duration of the exchange
round-trip. Locked behaviour:

- `PositionService.createFromFill` performs, in order, within the same logical step:
  1. `positionsRepository.insert(positionRow)` (DB write).
  2. `localProtectiveMonitor.arm(positionId, proposedExit)` (in-memory map write —
     cannot fail; not awaited on I/O).
  3. `protectiveAttacher.attach(positionId, ...)` (exchange-side SL/TP submit; may
     succeed, fail, or timeout).
- Steps 1 and 2 are **not** conditional on each other's outcome beyond step 1
  succeeding — step 2 runs whether attach later succeeds or fails.
- The **success path** of attach calls `localProtectiveMonitor.disarm(positionId)` and
  flips `protective_order_type` to `exchange_side` only after **both** SL and TP acks
  arrive (ADR 0008 §1 step 4). The disarm is the only way the monitor stops watching
  a position; attach failures never disarm it, so the local layer takes over by simply
  remaining armed.
- The monitor's evaluation loop is started at module bootstrap (not per-position), so
  `arm` is a constant-time map insert — there is no async startup latency between
  `arm` and "monitor sees the position".

This closes the "one tick unprotected" window structurally: the in-memory arm
completes before any exchange call is initiated. Reviewer must-fix: any code path
that arms the monitor only inside the attach-failure branch, or that awaits attach
acks before arming.

### 3. Rejection / unavailable path — local monitor (M6) takes over and exits through the gate

The protective submit can fail for several reasons; all collapse to the same fallback:

- Exchange returns a permanent reject on the SL/TP (e.g. `-2021 Order would immediately
  trigger` — happens if price moved through the SL during entry-fill latency).
- Exchange-side `closePosition` orders are temporarily unavailable (rate limited,
  endpoint degraded — ccxt surfaces these as `ExchangeNotAvailable`).
- The protective order ack-times-out under ADR 0006's `SUBMIT_NETWORK_TIMEOUT_MS`.
- For tier-3 instruments where mark-price stop-market is restricted by the venue (M11
  go-live hardening).

Fallback behaviour (locked):

1. **`positions.protective_order_type = 'local_fallback'`** is written immediately.
2. **An alert fires** (M9 Telegram) so the operator sees the degraded protection in
   real-time. This is not a silent fallback — operating under local protection should be
   rare and visible.
3. **The local monitor** (owned by M6, described in `M6-position-management.md`)
   continuously evaluates each open position's mark price against its SL/TP. On a breach
   it constructs a `REDUCE`/`CLOSE` `IOrderIntent` and **submits it through
   `RiskGateService.evaluate` like any other exit** — the gate auto-approves de-risking
   (ADR 0004 §2) and releases the reservation, ExecutionModule submits a
   `REDUCE_MARKET` order (ADR 0005 row 7).
4. **Retry of the exchange-side attach** is attempted once at `RETRY_PROTECTIVE_MS = 5,000
   ms`. If the retry succeeds, `protective_order_type` flips back to `exchange_side` and
   the local monitor stands down for that position. If the retry fails, the position
   stays on local protection for its life and the alert escalates to "WARN — position
   ${id} running on local-only protection".

### 4. The invariant defended

> **No open position is ever left unprotected, even for one tick.**

This is upheld by the following structural rules, each of which is a reviewer must-fix
if violated:

- **The local monitor is armed at the same instant `positions` is written.** Not after
  SL/TP submit, not after SL/TP ack. The monitor's tick loop starts on
  `position.created`, so even if every exchange-side attach attempt fails, protection
  exists from tick #1.
- **There is no code path that writes a `positions` row without arming the monitor.** The
  position row is written by `PositionService.createFromFill`, which calls
  `LocalProtectiveMonitor.arm(positionId, proposedExit)` as part of the same transaction
  (logical, not necessarily DB-transactional — the arm is an in-memory map write that
  cannot fail).
- **`protective_order_type` is never `null` for an open position.** The schema enforces
  it via `NOT NULL` and a default — set to `local_fallback` at row creation, upgraded to
  `exchange_side` only on ack. (M2 already has the column; the `NOT NULL` + default of
  `local_fallback` is the additional constraint to add — flagged as a schema concern in
  §5.)
- **`FLATTEN` from the kill switch (ADR 0004 §2) bypasses nothing.** Even kill-switch
  exits go through `REDUCE_MARKET` via the gate; the local monitor is the producer of
  the close intent in the fallback case.

### 5. Schema concern surfaced (not auto-resolved)

`positions.protective_order_type` is currently nullable per M2's schema (ADR 0002 +
00-overview.md data model). The "always-protected" invariant is much easier to enforce if
the column is `NOT NULL` with default `'local_fallback'`. **Flagged for the main session:**
either (a) add a small migration in M5 to set `NOT NULL` + default, or (b) keep nullable
and enforce the invariant in code only. Recommendation: (a) — make the impossible state
unrepresentable. Cross-cutting, so listed in `00-overview.md`'s risks alongside this ADR.

### 6. Cross-cutting reviewer rules

- Any code path that opens a position (writes a `positions` row) without arming the local
  monitor is must-fix.
- Any local-monitor exit path that calls `ExecutionService` directly without going
  through `RiskGateService` is must-fix — it would violate ADR 0004 §2 and double-count
  reservations.
- Any code that flips `protective_order_type` to `exchange_side` before both SL and TP
  acks are received is must-fix.

## Consequences

- The local monitor is a permanent component of the system, not a temporary fallback. It
  runs always; in the happy path it observes that exchange-side protection is in place
  and does nothing.
- `protective_order_type` becomes a real operational signal: persistent `local_fallback`
  on tier-1 instruments is an exchange-degradation alarm worth investigating.
- M6 owns the monitor; M5 owns arming it at the right instant and the exchange-side
  attach. The seam between the two is the `LocalProtectiveMonitor.arm/disarm` interface.

## Alternatives considered

- **Attach SL/TP atomically with the entry (OCO / `STOP_LOSS_LIMIT` + entry bracket).**
  Rejected: Binance USDT-M Futures bracket semantics around partial fills are fragile,
  and ADR 0007 requires SL/TP prices computed from `avgFillPrice` — we cannot know that
  pre-fill. The two-step attach is intentional.
- **Local-only protection always (skip exchange-side).** Rejected: exchange-side
  protection survives a bot crash; local-only does not. Local is the fallback, not the
  default.
- **Exchange-side only; alert + flatten if attach fails.** Rejected: flattening on every
  ack-timeout is too aggressive (Binance occasionally rate-limits the protective endpoint
  without the position being in actual danger). A fallback monitor is strictly safer.
- **Use last-price (not mark-price) as the trigger reference.** Rejected: last-price
  spikes from low-volume tape outliers regularly cross sensible stops without affecting
  mark; mark-price-triggered stops match how liquidation works and match the slippage
  model assumed in M7.
- **Make `protective_order_type` nullable and reason about it in code.** Rejected
  (see §5): NOT NULL + default makes the invariant structural.

## See also

- `docs/plans/archive/M5-execution-testnet.md`, `docs/plans/archive/M6-position-management.md`
- `docs/architecture/adr/0005-execution-order-policy.md` (REDUCE_MARKET for local-monitor
  exits)
- `docs/architecture/adr/0006-idempotency-contract.md` (`clientOrderId` for SL/TP suffix)
- `docs/architecture/adr/0007-partial-fill-semantics.md` (filled qty drives SL/TP prices)
- `docs/architecture/adr/0004-risk-management.md` §2 (de-risking always passes the gate),
  §8 (SL-inside-liquidation pre-validated)
- `docs/architecture/adr/0003-strategy-engine.md` §3 (`proposedExit` distance contract)
