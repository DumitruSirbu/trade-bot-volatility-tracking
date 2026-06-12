# ADR 0011 — Local SL/TP fallback & held-symbol subscription (M6)

Status: Accepted (revised 2026-05-23 post-W4 surface)
Date: 2026-05-23
Milestone: M6 — Position management & reconciliation

## Revision history

- **2026-05-23 (initial):** §5 retainer-caller table listed
  "Cooldown armed (post-loss) → retain" and "Cooldown expires → release"
  as if cooldown were a ledger with arm/expire events.
- **2026-05-23 (post-W4 surface):** §5 wiring corrected to match M4's
  derivative cooldown design (ADR 0004 §5): cooldown is **computed per
  call** from the last losing close's timestamp, not stored. Retain is
  driven off `position.state.transitioned → closed` with a loss-class
  exit reason. Release is driven by a periodic sweep on the reconciliation
  tick that queries `riskGateService.isCooldownActive(symbol, nowMs)` and
  releases when false. No new gate API needed. See ADR-0010 §7
  (`releaseExpiredCooldownRetentions`).

## Context

Two M6 brief items collapse into a single ADR because they share the same
underlying invariant — **"a held position is fully tracked and protected,
always, regardless of universe churn or exchange-side protective failures"**:

1. **Local SL/TP monitor (fallback):** when exchange-side protection is
   unavailable, the local monitor closes the position **through the risk
   gate**, never directly. M5 already shipped the arm/disarm seam
   (`LocalProtectiveMonitor`) but no evaluation loop and no breach-close
   producer. M6 adds them.
2. **Held symbols stay subscribed:** when MarketDataModule's universe-refresh
   drops a coin out of the top-300, any position the bot holds in that
   symbol must continue receiving price updates and protective monitoring
   until the position closes.

Both are reviewer **blockers** flagged in the M5 outcome and the M6 brief:
"otherwise positions are unprotected" / "universe churn must not drop
tracking." This ADR locks the contract.

Constraints:

- **No order path bypasses the risk gate.** A breach close emitted by the
  monitor goes through `RiskGateService.evaluate` like every other intent
  (ADR 0004 §2 — reduce/close auto-approved but still routed).
- **Determinism / live=backtest.** The monitor reads price from the same
  in-memory channel the strategy reads (`price.update`). In backtest, the
  replay sends `price.update` events from `tick_aggregates`; the monitor
  fires deterministically off the same tape.
- **Money is decimal.** SL/TP prices live as `MoneyValue` in memory;
  comparisons use decimal.js comparison (`gte`, `lte`), not `Number`.

## Decision

### 1. Reuse the M5 seam — arm/disarm contract stays as-is

`LocalProtectiveMonitor` in `apps/engine/src/execution/service/` already
provides:

- `arm({ positionId, symbol, stopLossPrice, takeProfitPrice })` — constant-time
  in-memory map insert, called synchronously between `positions.insert` and the
  exchange-side protective attach (ADR 0008 §2).
- `disarm(positionId)` — called only by the protective attacher's success path
  when both SL+TP are confirmed exchange-side (ADR 0008 §2 step 4) and by the
  position lifecycle on `state → closed`.
- `isArmed(positionId)` / `listArmed()` — read accessors used by the
  evaluation loop and by reconciliation (ADR 0010 case e).

**M6 does not change this contract.** Gaps M5 deferred to M6 (per M5 outcome):

- The **evaluation loop** itself (M5 ships only the seam).
- The **breach-close producer** that submits a `CLOSE` intent through the
  risk gate.
- **Boot-time re-arm** from the DB (ADR 0014 §3).
- **Side-aware comparison** (long vs short have opposite SL/TP semantics).

### 2. Evaluation loop — driven by `price.update`, not by a timer

The monitor subscribes to the existing `price.update` event from
MarketDataModule (the same event the strategy consumes — `00-overview.md`).
Every tick:

```
on price.update({ symbol, markPrice, lastPrice, ts }):
    for each armed position with .symbol == symbol:
        if isBreached(position, markPrice):                  // §3
            if not breachInFlight(position.id):
                markBreachInFlight(position.id)
                emit close intent through RiskGateService    // §4
```

**Why mark-price, not last-price:** ADR 0008 §1 already mandates mark-price
triggers exchange-side (`workingType: 'MARK_PRICE'`) to match how liquidation
works and avoid wick-driven false triggers. The local monitor uses the same
reference so a fallback close fires at the same level the exchange-side
order would have. `price.update` already carries both (`markPrice`,
`lastPrice`); the monitor reads `markPrice` exclusively for the breach
check and records `mark_vs_last` divergence for instrumentation (ADR 0013).

**Why event-driven, not timer:** every protective decision must align with
the same price the strategy sees. A timer-driven loop would either lag
(missed breach) or race (race with the strategy seeing the same tick). The
existing event bus already orders ticks per symbol (`@nestjs/event-emitter`
is synchronous in-process); using it gives free determinism.

**Backtest parity:** the M7 backtest replays `tick_aggregates` into the same
`price.update` event. The monitor's loop runs identically; live and backtest
breach times match to the tick.

### 3. Breach semantics — side-aware, decimal-safe

For a position with `side`, `stopLossPrice` (SL), `takeProfitPrice` (TP):

| side  | SL breach condition          | TP breach condition          |
|-------|-------------------------------|-------------------------------|
| LONG  | `markPrice.lte(stopLossPrice)` | `markPrice.gte(takeProfitPrice)` |
| SHORT | `markPrice.gte(stopLossPrice)` | `markPrice.lte(takeProfitPrice)` |

Equality is a breach (the exchange-side `STOP_MARKET` fires at-or-past, so
the fallback matches).

Both SL and TP cannot logically fire on the same tick for the same position
(SL is below entry for LONG; TP is above; mark price is a single number).
The check order is **SL first, then TP** — survival before opportunity. If
both somehow match (price gapped through both — extreme degenerate case),
SL wins and `exit_reason = STOP_LOSS`.

`stop_gap_pct` instrumentation (ADR 0013) is recorded as
`abs(fillPrice - stopLossPrice) / stopLossPrice` when the close fills,
capturing the slippage between the level the monitor fired at and the
actual fill on the gate-routed close.

### 4. Close intent goes through the risk gate — non-negotiable

The monitor **never** calls `ExecutionService` directly. On breach:

```
1. Construct an `IOrderIntent` with:
   - intentAction = OrderIntentActionEnum.CLOSE
   - symbol, tradeSide (the OPPOSITE of position.side — close direction)
   - openPosition = the IOpenPositionState for this position
   - signalScore = 0 (not a signal-driven decision; gate doesn't use it for closes)
   - sizing = full remaining qty at last known mark
   - eventId = `local-monitor-breach-${positionId}-${triggerKind}` (deterministic, replay-safe)
2. Call `riskGate.evaluate(intent)`.
3. The gate auto-approves de-risking (ADR 0004 §2) and returns an approved decision.
4. Orchestrator emits `order.intent.approved` → ExecutionService submits
   `REDUCE_MARKET` (ADR 0005 row 7) with deterministic clientOrderId
   (ADR 0006 §1).
```

**Bypassing the gate is a reviewer must-fix** (ADR 0008 §6, restated). The
gate is the only place that releases the reservation and the only place
that records the close `decisions` row.

**Idempotency on the breach:**

- `breachInFlight` is an in-memory flag per `positionId`, set when the
  intent is emitted and cleared on `position.state → closed`.
- A repeat `price.update` past the SL while the close is mid-flight does
  not re-emit. The deterministic `clientOrderId` from ADR 0006 §1 would
  also dedupe at the exchange even if the flag misfired, but the in-memory
  flag avoids hammering the gate with duplicates per tick.
- On engine restart, the flag is cleared (in-memory). The boot-time
  reconciliation pass (ADR 0014) detects whether a close was already in
  flight via the `transactions` row's `clientOrderId` lookup and updates
  state accordingly before the monitor starts evaluating new ticks.

### 5. SubscriptionRetainer contract — held symbols stay subscribed

The M6 brief: "a coin leaving the top-300 universe must keep its price
subscription + SL/TP monitoring until its position closes." This is a new
contract between `MarketDataModule` and `PositionService` / `RiskGate`.

**Locked contract:**

`SubscriptionRetainer` (new, lives in `apps/engine/src/marketdata/` —
MarketDataModule's domain) is a registry of symbols the engine *must* keep
subscribed regardless of universe membership.

```
interface SubscriptionRetainer {
    retain(symbol: string, reason: RetainReasonEnum): void;
    release(symbol: string, reason: RetainReasonEnum): void;
    isRetained(symbol: string): boolean;
    listRetained(): readonly { symbol: string; reasons: ReadonlySet<RetainReasonEnum> }[];
}

enum RetainReasonEnum {
    OPEN_POSITION       = 'open_position',         // §5a
    PENDING_RECONCILE   = 'pending_reconcile',     // §5b
    FOREIGN_ADOPTED     = 'foreign_adopted',       // §5c
    COOLDOWN_ACTIVE     = 'cooldown_active',       // §5d (M4 cooldown still wants price for read API)
}
```

Multiple reasons can simultaneously retain the same symbol; the symbol is
released from the retainer only when **all** reasons have called `release`.
Internally a `Map<string, Set<RetainReasonEnum>>`.

**Coupling to MarketDataModule's universe refresh:**

- The universe refresh job builds the desired subscription set from top-300
  filter + retainer.listRetained(). Symbols in the retainer that are *not*
  in the top-300 are added to the subscription set with a `retained=true`
  flag (not visible to the strategy — the strategy still trades only the
  top-300 universe; the retained symbol's price tape exists only so the
  monitor / PnL / reconciliation can read it).
- A retained symbol that re-enters the top-300 organically is no longer
  "retained" — its subscription is now part of the regular universe; the
  retainer's tracking is independent and persists until release.

**Who calls retain / release:**

| Event                          | Caller             | Action                                            |
|--------------------------------|--------------------|---------------------------------------------------|
| `position.state.transitioned → pending_open` | PositionService    | `retain(symbol, OPEN_POSITION)`                  |
| `position.state.transitioned → closed`       | PositionService    | `release(symbol, OPEN_POSITION)`                 |
| `position.state.transitioned → reconciling`  | PositionService    | `retain(symbol, PENDING_RECONCILE)`              |
| `reconciliation.resolved` (any outcome)      | ReconciliationService | `release(symbol, PENDING_RECONCILE)`         |
| `position.adopted_foreign` (case a)          | ReconciliationService | `retain(symbol, FOREIGN_ADOPTED)`            |
| `position.adopt_acked` or flatten resolved   | PositionService    | `release(symbol, FOREIGN_ADOPTED)`                |
| `position.state.transitioned → closed` with a loss-class exit reason (`STOP_LOSS`, `TIME_STOP` with PnL < 0, `SIGNAL` with PnL < 0, `LIQUIDATED`) | PositionService    | `retain(symbol, COOLDOWN_ACTIVE)` — cooldown is derivative (ADR 0004 §5); arming the retention here piggybacks on the close event since no separate cooldown-armed event exists |
| Reconciliation tick                          | ReconciliationService | `releaseExpiredCooldownRetentions(nowMs)` — iterates `COOLDOWN_ACTIVE` retentions, calls `riskGateService.isCooldownActive(symbol, nowMs)`, releases when false. See ADR-0010 §7. |

**Cleanup invariant:** on boot, the retainer is rebuilt from the DB — any
symbol with a non-closed position row gets `OPEN_POSITION` retained; any
`reconciling` row gets `PENDING_RECONCILE`; any `manual_adopted_unmanaged`
row gets `FOREIGN_ADOPTED`. A retainer leak is therefore self-healing on
restart.

**Funding-rate and OI subscriptions follow the same retainer:** funding-rate
WS subscriptions and OI REST polling for a held symbol continue regardless
of universe membership (funding affects PnL, OI feeds case-e reconciliation
of flow context for late-add ADD intents). The retainer is the single
registry for "this symbol must stay live."

### 6. Gaps from M5 to close in M6

1. **Evaluation loop** — `LocalProtectiveMonitor` becomes an
   `@OnEvent('price.update')` consumer, side-aware.
2. **Breach-close producer** — emits `IOrderIntent` through the risk gate;
   never calls ExecutionService directly.
3. **Boot-time re-arm** — `PositionService.bootstrap()` reads every
   non-closed position from the DB, recomputes SL/TP prices from the
   immutable `*_at_entry` columns (or re-reads them off the existing row's
   `stopLossPrice`/`takeProfitPrice` columns — schema reference below) and
   calls `arm` for each. Re-arm runs before the engine subscribes to
   `price.update` (ADR 0014 §3).
4. **SubscriptionRetainer integration** — new contract from MarketDataModule
   side.

### 7. Schema: where do SL/TP live?

This ADR surfaces (does not resolve) a schema concern: M2's `positions` row
carries `*_at_entry` analysis columns and the lifetime-instrumentation
columns, but **does not carry the SL/TP prices** as first-class columns.
ADR 0008 §1 step 2 computes them from `avgFillPrice` and `proposedExit`
distance at attach time; they are then submitted as exchange-side orders
and live in `transactions` rows for the `-sl` / `-tp` clientOrderId-suffixed
entries.

For local-fallback monitoring to re-arm on boot, the SL/TP **prices** must
be retrievable. Options:

- **(a) Add nullable columns** `positions.stop_loss_price` and
  `positions.take_profit_price`, populated at protective-attach time.
  Recommended — makes the invariant structural, and they're naturally
  immutable per position (SL/TP can be tightened by the strategy on a
  subsequent decision, but the persisted value is the active one).
- **(b) Re-derive at boot from `transactions` rows** by finding the
  `-sl`/`-tp` rows for the position. Fragile if those rows are missing
  (case e drift, or local_fallback never put them in transactions).

**Decision:** option (a). `bot-shared-maintainer` adds the columns + a
small M6 migration (this is the only schema change M6 requires). Surfaced
in the M6 plan punch list as a shared/persistence pre-engine item.

### 8. Reviewer rules

- The monitor MUST NOT call `ExecutionService` directly. Any direct call is
  must-fix.
- The monitor MUST NOT mutate `positions` rows. State transitions go
  through `PositionService.transition` only.
- Universe refresh MUST consult `SubscriptionRetainer.listRetained()` before
  finalizing the subscription set. A test asserts the dropped-symbol-with-
  open-position case (ADR 0010 contract surface).
- The retainer is consulted, never bypassed. Reads to `markPrice` for a
  held symbol that is no longer in the universe must work (the test fixture
  for case e drift exercises this).

## Consequences

- The retainer is a small but high-leverage contract: a single registry
  removes the "ghost-symbol" failure class permanently.
- Funding-rate and OI tracking for held symbols are now first-class
  retainer concerns, simplifying the PnL accounting in ADR 0012 (no
  separate "did we have funding rate data?" branch).
- The SL/TP-on-position schema change (option a) is small but binding:
  `bot-shared-maintainer` must land it before the engine wave.

## Alternatives considered

- **Run the local monitor on a 100ms timer instead of the event bus.**
  Rejected: lag / race with the strategy on the same tick; backtest
  determinism breaks.
- **Last-price triggers for the local monitor.** Rejected: misaligned with
  the exchange-side `MARK_PRICE` reference; would produce different breach
  prices in live vs the exchange-side equivalent.
- **No retainer — solve universe-churn by simply never dropping a coin from
  the subscription if a position is open.** Functionally equivalent but
  scattered: every consumer (funding, OI, depth-snapshots, cooldown)
  re-implements the "is this symbol held?" check. A single retainer is
  cleaner and the right place for the boot-time rebuild.
- **Make `OPEN_POSITION` retention only — skip cooldown / foreign / pending
  reasons.** Rejected: a held foreign position needs price tracking for the
  alert / ack flow, and cooldown needs price for the dashboard read API.
- **Compute SL/TP prices on the fly from `*_at_entry` columns at boot
  time.** Possible but couples the monitor's boot-arm to the
  exit-distance-config code. Persisting the SL/TP price keeps it as data,
  not derived; cleaner separation.

## See also

- `docs/plans/archive/M6-position-management.md` (held-symbol blocker)
- `docs/architecture/adr/0008-sl-tp-attach.md` §2/§3 (arm/disarm seam, fallback path)
- `docs/architecture/adr/0009-position-state-machine.md` §5 (state↔monitor coupling)
- `docs/architecture/adr/0010-reconciliation-and-drift-policy.md` case (e) (protective drift)
- `docs/architecture/adr/0013-position-instrumentation.md` (mark/last divergence, stop-gap)
- `docs/architecture/adr/0014-crash-recovery.md` (boot-time re-arm sequence)
- `docs/architecture/adr/0004-risk-management.md` §2 (close intents always route through gate)
