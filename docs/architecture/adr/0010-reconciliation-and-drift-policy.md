# ADR 0010 — Reconciliation & drift policy (M6)

Status: Accepted (revised 2026-05-23 post-W4 surface)
Date: 2026-05-23
Milestone: M6 — Position management & reconciliation

## Revision history

- **2026-05-23 (initial):** Six drift cases enumerated; §1b had
  `reconcileClose` releasing a reservation by id; §1f promised precise-id
  release via `releaseReservation`. §4 named the boot-rebuild + TTL sweep
  as the authoritative release path.
- **2026-05-23 (post-W4 surface):** §1b clarified to make reservation
  release best-effort (in-memory only) and to align with §4. §1f rewritten:
  precise reservation-id release was an internal contradiction with §4 and
  has been removed; TTL sweep + boot-rebuild are the only release paths.
  Persisting `reservationId` deferred with M7 W0 as named owner, only if
  surfaced by an adversarial test. New §7 below pins the new API surface
  that engine W4a/W4b introduce.
- **2026-05-23 (post-M6 R1):**
  - §1b: `reconcileClose` release amount uses live residual
    `qty * entry_price`, not `entry_notional`. `entry_notional` is an
    M8 analytic column (immutable at open/add), not a live exposure
    counter. (Round-1 quant high #Q1.)
  - §1b: case-(b) transition routing made explicit for non-OPEN
    source states. `PENDING_OPEN` orphans go via `pending_open →
    reconciling → closed` (two legal arrows, both written);
    `RECONCILING` rows go via the existing `reconciling → closed`
    arrow; `MANUAL_ADOPTED_UNMANAGED` rows are **skipped** by case-(b)
    (operator alert only, bot does not auto-close foreign rows that
    disappeared from the exchange). (Round-1 logic blocker #2.)
  - §5: `ReconciliationOutcomeEnum.FLATTENED` added — bot-initiated
    foreign-position flatten under case-(a) `flatten` policy. Distinct
    from `RECONCILED_MISSING` (DB row disappeared from exchange).
    (Round-1 logic blocker #3.)
  - §7 (new event): `IExchangeOverfillDriftEvent` added — emitted by
    ExecutionService when fill qty/cashflow exceeds expected and the
    recorded values are clamped. Feeds M4 model-divergence counter via
    the same channel as `recordExposureDrift`. (Round-1 quant high #Q2.)
  - §7 (matcher tightening): `releaseInFlightReservationFor` matches
    on `(eventId, slot)` not `(symbol, slot)` to avoid releasing a
    fresh reservation when two coexist on the same slot. Schema-side
    `reservationId` linkage stays deferred (M7 W0 contingent). (Round-1
    logic blocker #5.)

## Context

The bot's DB and the exchange are two independent state stores that can drift:
network timeouts on order submission leave the final state unknown (ADR 0006
§3), manual trades on the same account create exchange positions the bot did
not place, an exchange-side liquidation can close a position the bot still
thinks is open, and rounding/locale differences can produce a small qty
mismatch. The M6 brief requires:

> Match exchange orders/positions to DB rows via **`client_order_id ↔
> transactions.client_order_id`** … Enumerate every drift case and its action
> … Release leaked exposure reservations … Exchange is truth.

Constraints binding on this ADR:

- **Match key is `clientOrderId`, not `exchangeOrderId`.** The bot mints the
  client id deterministically (ADR 0006 §1) and queries by it (`fetchOrder
  ({clientOrderId})`) even when the original POST timed out and we never saw
  the exchange id. `exchangeOrderId` is a *post-fill* unique record, not the
  match key.
- **Exchange is truth.** When DB and exchange disagree, exchange wins. The bot
  never overrides exchange state.
- **Reservations have a TTL** (ADR 0004 §3): `PENDING/EXPIRED` reservations
  must be released by reconciliation as the canonical path. M4 exposed
  `releaseReservation` and `expireStaleReservations` for this; M6 wires them.
- **No bypassing the risk gate.** Reconciliation-originated closes (case b
  below) emit a synthetic `CLOSE` intent through the gate so exposure
  accounting stays consistent; reconciliation never updates `risk_state`
  directly without going through the gate's release path.
- **Pure / deterministic.** Reconciliation reads `nowMs` from the injected
  clock so backtest replays of "the engine restarted mid-trade and reconciled"
  are reproducible (M7).

## Decision

### 1. Drift cases — enumerated, with the locked action per case

The shared `DriftCaseEnum` (added by `bot-shared-maintainer` before engine
work) names every case the engine must handle. **Anything not in this enum is
a reviewer must-fix discovery, not a silent default branch.**

```
enum DriftCaseEnum {
    EXCHANGE_NOT_IN_DB        = 'exchange_not_in_db',          // case (a)
    DB_OPEN_NOT_ON_EXCHANGE   = 'db_open_not_on_exchange',     // case (b)
    QTY_MISMATCH              = 'qty_mismatch',                // case (c)
    SIDE_MISMATCH             = 'side_mismatch',               // case (d) — derived case for safety
    PROTECTIVE_ORDER_DRIFT    = 'protective_order_drift',      // case (e) — SL/TP missing on exchange
    UNKNOWN_INTENT_OUTCOME    = 'unknown_intent_outcome',      // case (f) — ADR 0006 §3 timeout queries
}
```

#### Case (a) — `EXCHANGE_NOT_IN_DB`: exchange position with no matching DB row

Triggered when `exchange.fetchPositions()` returns a non-zero-qty position for
a symbol/side with no `positions` row in `state ∈ {pending_open, open,
closing, reconciling}` and no `transactions.client_order_id` whose
`exchange_order_id` matches the most recent fill on that symbol.

**Policy (locked, config-driven):**

- **Default (`reconciliation.foreign_exchange_position_policy = 'adopt_unmanaged'`):**
  1. Insert a new `positions` row with:
     - `state = manual_adopted_unmanaged` (ADR 0009 §1)
     - `strategy_version_id = NULL` (no strategy owns it) — schema change
       required: relax `strategy_version_id` to nullable, OR insert a sentinel
       `strategy_version` row with `name='manual_adopted'`. Recommendation:
       sentinel row, no DDL change. Surfaced for `bot-shared-maintainer`.
     - `protective_order_type = LOCAL_FALLBACK` default (the bot is not
       protecting it; the value is meaningless but the column is NOT NULL).
     - `entry_price`, `qty`, `side` from exchange snapshot.
     - `opened_at = nowMs` (the bot's first-seen timestamp; entry timestamp is
       not retrievable from `fetchPositions`).
     - All `*_at_entry` analysis columns NULL (no snapshot exists for a foreign
       fill).
  2. Emit `IPositionAdoptedEvent` to the M9 alert channel (Telegram + UI):
     "ALERT: foreign position adopted, awaiting operator ack — symbol=X,
     qty=Y, side=Z." High-priority alert.
  3. The bot does **not** open the same symbol on a fresh signal while a
     `manual_adopted_unmanaged` row exists for it (the risk gate rejects with
     `RejectReasonEnum.FOREIGN_POSITION_HOLD` — added by
     `bot-shared-maintainer`).
  4. Operator ack via M9 endpoint `/positions/:id/adopt --ack` flips the row
     to `state = open` (ADR 0009 §4). Cancel/flatten flips it to `closing`
     through the risk gate.

- **Alternative (`reconciliation.foreign_exchange_position_policy = 'flatten'`):**
  Recommended for go-live restricted profile per `00-overview.md`. The
  reconciliation service emits a synthetic `CLOSE` intent via the risk gate
  for the foreign position immediately, no `manual_adopted_unmanaged` row
  ever exists. Operator is alerted post-flatten, not pre. This is the safer
  default for the unattended live profile.

The config flag is per-environment, set in `executionConsts.ts`-style config
(operator-owned, not strategy params). Default in dev/test: `adopt_unmanaged`.
Default in live: `flatten`.

#### Case (b) — `DB_OPEN_NOT_ON_EXCHANGE`: DB row in `open`/`closing` not on exchange

Triggered when a DB row in `state ∈ {open, closing}` has a symbol/side whose
exchange position qty is zero (or sign-opposite — see case d).

**Policy (locked):**

1. The position was closed outside the bot (liquidation, exchange-side SL/TP
   triggered, manual close, or a successful close the bot saw the intent for
   but missed the fill due to a crash window).
2. Transition `state → closed` via `PositionService.transition`:
   - `closed_at = nowMs` (the bot's reconciliation timestamp).
   - `exit_reason = ExitReasonEnum.RECONCILED_MISSING` (new value, see ADR
     0012). The original cause (liquidation vs manual) is not recoverable
     without an account-history poll; the M9/M11 milestone may enrich this.
   - `exit_price = NULL` (unknown without account-history; M9 can backfill).
   - `realized_pnl = NULL` initially; **reconciliation triggers an
     account-history poll for the symbol** (best-effort) and, if the close
     fills are recoverable, backfills `exit_price` and `realized_pnl` in a
     subsequent reconciliation pass. If unrecoverable, the row stays
     PnL-null and the operator is alerted (account-snapshot equity drift
     will catch the dollar impact).
3. **Synthetic close intent through the gate** is **not** emitted in this case
   (the position is already gone; there is nothing to close). Instead the
   reconciliation service directly calls `RiskGateService.reconcileClose
   (positionId)` — a new method that:
   - decrements `risk_state.open_exposure` by **`position.qty *
     position.entry_price`** (live residual notional, revised post-R1 per
     #Q1). NOT `entry_notional`, which is set at open/add and not
     decremented on partial reduces — using it would over-decrement after
     reductions.
   - releases the in-memory reservation **if one is still in memory** (best
     effort; the in-memory ledger is transient per ADR 0004 §3, so this is a
     no-op when the position outlived its reservation TTL or the engine
     restarted — see §4 for the authoritative cross-crash release path),
   - writes a `decisions` row with `action=close`, `reason=reconciled_missing`
     for audit,
   - does **not** place an order.
4. Disarm the LocalProtectiveMonitor if armed.

**Transition routing by source state (revised post-R1, blocker #2):**

The case-(b) handler is called only for rows discovered via `findAll
NonClosed()`, so the source state is one of `{pending_open, open,
closing, reconciling, manual_adopted_unmanaged}`. The state graph (ADR
0009 §3) rejects most arbitrary `→ closing` transitions; the handler
must route per source state:

- `state = open` or `state = closing`: existing path —
  `transition(positionId, CLOSING, ...)` then `transition(positionId,
  CLOSED, ...)` once the case handler's side effects complete.
  (Legal arrows: `open → closing → closed`.)
- `state = pending_open`: orphan path per ADR-0014 §6 — two-step
  transition `pending_open → reconciling → closed`. Both arrows legal.
  The reconciling step is a single logical write that is immediately
  followed by `→ closed` with `exit_reason = RECONCILED_MISSING`. Do
  not invent a `pending_open → closing` arrow; the graph stays as ADR
  0009 §3 specifies.
- `state = reconciling`: one-step transition via the existing
  `reconciling → closed` arrow.
- `state = manual_adopted_unmanaged`: **skip**. Case-(b) does NOT
  auto-close foreign-adopted rows that disappeared from the exchange.
  Instead emit `IPositionAdoptionVanishedEvent` (new — see §5) for
  operator alert. The operator decides whether to dismiss the row
  (manual transition to closed via M9 endpoint) or investigate. The bot
  does not manage rows it didn't open; that includes their cleanup.

#### Case (c) — `QTY_MISMATCH`: same symbol/side both sides, qty differs

Triggered when DB position qty ≠ exchange position qty (by more than
`reconciliation.qty_tolerance_steps = 1` step — to absorb rounding).

**Policy (locked):**

1. **Exchange wins.** Update `positions.qty` to the exchange qty.
2. Log a structured WARN with both qtys, the delta, and the inferred cause
   class:
   - Δ > 0 (exchange has more): a previous `ADD` fill was missed by the bot.
     This is unusual — flag for M9 alert escalation.
   - Δ < 0 (exchange has less): a previous `REDUCE` fill was missed, or
     exchange-side SL/TP partially fired. More common; INFO-level if magnitude
     is < 1% of position, WARN if larger.
3. **Recompute downstream state:**
   - If the position is on `protective_order_type=local_fallback`, the
     monitor's SL/TP **prices** are unaffected (they are anchored at entry).
     But the monitor's notion of "the position's qty" must update so a close
     intent uses the right qty.
   - If exchange-side protective orders are attached with
     `closePosition=true` (ADR 0008 §1), Binance auto-adjusts the protective
     qty; no action needed.
   - The exposure reservation is **not** re-sized on a mismatch — the
     reservation captures the *intended* exposure at risk-gate time, and
     recovery from a wrong intended size is a strategy-bug investigation
     (alert), not an automated correction. The risk gate is alerted via a
     new `RiskGateService.recordExposureDrift(positionId, dbQty, exchangeQty)`
     method that increments a divergence counter feeding the
     `MODEL_DIVERGENCE_HALT` (ADR 0004 §6).
4. The position stays in its current `state` after the qty correction (no
   transition to `reconciling` for a clean mismatch — the case resolves
   atomically). Only ambiguous cases (case f, unknown intent outcome) park in
   `reconciling`.

#### Case (d) — `SIDE_MISMATCH`: same symbol both sides, opposite sides

This is *not* in the M6 brief but emerges from case-c handling: if the bot
thinks it's long and exchange shows short, treating it as a "qty diff" would
take the long position to negative qty (nonsense). Locked policy:

1. Treat as **two independent drift cases**: the bot's long position is
   `DB_OPEN_NOT_ON_EXCHANGE` (case b) and the exchange's short position is
   `EXCHANGE_NOT_IN_DB` (case a). Process them in that order: close the bot
   row first (release the slot), then handle the foreign row per case-a
   policy.
2. **High-severity alert** regardless of foreign-position policy — a side
   flip on the same symbol is almost certainly a strategy or risk-gate bug,
   not a normal drift. The operator must investigate.

#### Case (e) — `PROTECTIVE_ORDER_DRIFT`: SL/TP missing on exchange

Triggered when `positions.protective_order_type = exchange_side` but a
`fetchOpenOrders` call for the symbol returns no matching SL or TP order with
the expected `clientOrderId` suffix (`-sl` / `-tp`, ADR 0008 §1 step 3).

**Policy (locked):**

1. **Immediate fallback to local protection:** flip `protective_order_type →
   local_fallback`, arm the monitor (idempotent — ADR 0008 §2 guarantees it
   was already armed in the pending_open window; this re-arms after disarm).
2. Emit the M9 alert: "protective order vanished, monitor engaged — symbol=X,
   position_id=Y."
3. Retry the exchange-side attach once at the next reconciliation tick
   (`RETRY_PROTECTIVE_MS = 5000ms` per ADR 0008 §3 step 4). If it succeeds,
   flip back to `exchange_side` and disarm. If it fails, stay on local
   protection.

#### Case (f) — `UNKNOWN_INTENT_OUTCOME`: ADR 0006 §3 timeout query result

Triggered for any `transactions` row whose intent submission timed out (ADR
0006 §3) and whose subsequent `fetchOrder(clientOrderId)` query returns a
non-terminal state, OR the order was never seen by the exchange.

**Policy (locked, revised 2026-05-23 post-W4 surface):**

The reservation release for case (f) is **not** by precise id. Reservation
ids are not persisted (ADR 0004 §3: the ledger is in-memory and transient);
attempting precise release would require a new schema column for a problem
the TTL sweep + boot-rebuild already cover (§4). The handler is therefore
narrower than originally drafted — it resolves the intent's terminal state
and updates the position row; reservation release happens through the two
canonical paths in §4.

1. The position row (if any) is transitioned to `state = reconciling` (ADR
   0009 §4).
2. Reconciliation re-queries `fetchOrder(clientOrderId)` on each cadence tick
   until a terminal state is reached.
3. On terminal state:
   - `closed/filled` with qty > 0 → resolve to `open` (or stay in `closing`
     if the original intent was a reduce/close), update qty from the fill
     via `PositionService.adjustQty` (case (c) primitive; see §1c).
   - `cancelled/expired/rejected` with qty = 0 → if the position had no other
     fills (this was the entry), no row was written; if this was an
     add/reduce, the position stays in its prior state with no change.
4. **Reservation release is implicit via §4 paths**, not a §1f
   responsibility:
   - If the engine has been continuously up since the intent was approved,
     the in-memory reservation's TTL expires it via
     `RiskGateService.expireStaleReservations(nowMs)` swept every tick (§4
     step 1). The release is by `reservationId` known only to the gate's
     own ledger — reconciliation does not need that id.
   - If the engine restarted between approval and resolution, the in-memory
     ledger is gone; the boot-time `open_exposure` rebuild (ADR 0014 §4a)
     is the release path. Reconciliation does nothing for that case.
5. **TTL backstop** (`reconciliation.unknown_intent_ttl_ms = 5 minutes`): if
   the query keeps returning non-terminal for the TTL, the operator is
   alerted as "exchange status unresolved." The position row, if any, stays
   in `reconciling` pending operator intervention; the bot does not invent a
   resolution. The reservation has long since expired via §4 by this point.

**Deferred (named owner: M7 W0, only if surfaced by an adversarial test):**
precise reservation-id linkage on the `transactions` row at approval time,
to enable point-release within the TTL window. Not required by the always-
protected invariant or the exposure-accounting correctness contract; the
TTL window is bounded by `RESERVATION_TTL_MS` (M4 §3) and exposure cannot
drift past it. Adding the schema column would be premature optimization.

### 2. Cadence — periodic poll + on-restart full sweep

**Periodic reconciliation tick: every `RECONCILIATION_TICK_MS = 30 seconds`**
under normal operation. The interval is config-driven (`reconciliationConsts.ts`
in M6); 30s is the working default — short enough to catch drift quickly,
long enough to be polite to the exchange rate limits (Binance Futures REST
weight budget: a single `fetchPositions` is weight 5, well within limits even
at 30s cadence).

**Reconciliation pass (one tick):**

1. `exchange.fetchPositions()` — single call, returns all open positions.
2. `exchange.fetchOpenOrders()` — single call, returns all resting orders
   (used for case e protective-drift checks).
3. `positionRepository.findAllNonClosed()` — DB rows in
   `state ∈ {pending_open, open, closing, reconciling}`.
4. Build the diff:
   - For each exchange position, look up the matching DB row by
     **`symbol + side`** (the natural key for a perp futures position; the
     `client_order_id` lineage in `transactions` is for *fill* matching, not
     *position* matching — they collapse onto the same DB row).
   - For each DB row not matched, run case (b) logic.
   - For each exchange position not matched, run case (a) logic.
   - For matched pairs with qty delta, run case (c) logic.
   - For each `EXCHANGE_SIDE` DB row, verify SL/TP orders present — case (e).
5. Sweep stale reservations: `riskGate.expireStaleReservations(nowMs)`.
6. Sweep `state=reconciling` rows for resolution attempts (case f).

**On-restart full sweep:** identical pass, **executed before** the engine
begins consuming new market data (ADR 0014 §1). The restart sweep is the
canonical release path for reservations leaked across the crash window: the
in-memory ledger is gone, so the gate's `open_exposure` from `risk_state` is
authoritative — but it may include exposure for a position that closed during
the crash, so the sweep reconciles it down. (See ADR 0014 for the full restart
sequence.)

**Frequency upper bound:** the reconciliation service must not poll more
often than `RECONCILIATION_MIN_INTERVAL_MS = 5 seconds` even if requested
manually — protects against accidental rate-limit storms.

### 3. The match key — `clientOrderId` is for fills, `(symbol, side)` is for positions

The M6 brief specifies `client_order_id ↔ transactions.client_order_id` as
the match key. This ADR refines: **the match key has two layers, used at
different reconciliation points.**

- **Position-level matching** (between `exchange.fetchPositions()` and the
  `positions` table) keys on **`(symbol, side)`**. Binance Futures returns
  one position per `(symbol, positionSide)` pair (in `oneWay` mode, side is
  implicit by the sign of qty; in `hedged` mode, side is explicit). The DB's
  `positions` table is also keyed by `(symbol, side, state ∈ {non-closed})`
  for the open slot. There is no `clientOrderId` on a position; that id is
  per-order.
- **Fill / intent-level matching** (between exchange order records and
  `transactions` rows) keys on **`clientOrderId`** — exactly as the M6 brief
  states, and exactly the lookup ADR 0006 §3 already mandates. This is what
  resolves case (f), what idempotency uses, and what backfills missing
  `exchange_order_id` values.

The position-level lookup never needs `clientOrderId` because positions are
*aggregates* of fills, and the aggregate identity is `(symbol, side)`. The
two layers compose: position-level diff finds a drift case; fill-level
lookup resolves which intent produced or failed to produce it.

### 4. Authoritative release path for leaked reservations

The M6 brief is explicit:

> reservation has a TTL; reconciliation is the authoritative release path.

This ADR locks the contract M4 exposed (`releaseReservation`,
`expireStaleReservations`) into reconciliation's tick loop:

1. **TTL sweep first.** Every tick, `riskGate.expireStaleReservations(nowMs)`
   moves any PENDING reservation past `expiresAtMs` to EXPIRED and reduces
   `risk_state.open_exposure` by its notional. The in-memory ledger removes
   the entry.
2. **Then the diff sweep.** Drift cases (a)–(c) may identify additional
   reservations (held in memory) that don't match any extant position; they
   are released via `releaseReservation`.
3. **Cross-restart leak source.** A reservation that existed pre-crash is
   already gone from memory post-restart (ledger is in-memory, ADR 0004 §3).
   The leak lives in `risk_state.open_exposure` — the DB column was bumped
   when the intent was approved. The restart sweep (ADR 0014) rebuilds
   `open_exposure` from `SUM(positions.entry_notional WHERE state IN
   open/closing/reconciling)`, ignoring any pre-crash reservation deltas.
   **This rebuild is the authoritative release path across crashes.** ADR
   0014 specifies the exact procedure.

### 5. Reconciliation events (SHARED contracts)

Three new shared event payloads, added by `bot-shared-maintainer` before
engine work:

```
interface IReconciliationDriftDetectedEvent {
    readonly positionId: number | null;        // null for case (a) before adoption
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly driftCase: DriftCaseEnum;
    readonly dbQty: string | null;             // string-decimal across shared boundary
    readonly exchangeQty: string | null;
    readonly detectedAtMs: number;
}

interface IReconciliationResolvedEvent {
    readonly positionId: number;
    readonly driftCase: DriftCaseEnum;
    readonly outcome: ReconciliationOutcomeEnum;
    readonly resolvedAtMs: number;
}

enum ReconciliationOutcomeEnum {
    CONFIRMED_PRESENT  = 'confirmed_present',      // case (a/c/e) → open
    RECONCILED_MISSING = 'reconciled_missing',     // case (b) → closed; DB row disappeared from exchange
    FLATTENED          = 'flattened',              // case (a) flatten policy — bot deliberately closed a foreign position (R1 #3)
    ADOPTED_FOREIGN    = 'adopted_foreign',        // case (a) adopt_unmanaged policy → manual_adopted_unmanaged
    QTY_ADJUSTED       = 'qty_adjusted',           // case (c) — no state change
    PROTECTIVE_REPAIRED = 'protective_repaired',   // case (e) — exchange_side restored
    PROTECTIVE_FALLBACK = 'protective_fallback',   // case (e) — flipped to local_fallback
    INTENT_TERMINAL    = 'intent_terminal',        // case (f) — query resolved
    UNRESOLVED_TTL     = 'unresolved_ttl',         // case (f) — gave up, alerted
}

interface IPositionAdoptedEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly qty: string;
    readonly entryPrice: string;
    readonly detectedAtMs: number;
}

// Operator alert: a manual_adopted_unmanaged row disappeared from the
// exchange (operator may have closed it externally). Bot does NOT
// auto-close — case (b) skips manual_adopted_unmanaged rows per §1b
// transition routing. Operator decides via M9 endpoint.
interface IPositionAdoptionVanishedEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly detectedAtMs: number;
}

// Emitted by ExecutionService when an exchange fill exceeds the
// expected qty/cashflow and the recorded transaction values are
// clamped to the position's expected residual. Feeds the M4 model-
// divergence counter (ADR 0004 §6) via the same channel as
// recordExposureDrift. (R1 quant high #Q2.)
interface IExchangeOverfillDriftEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly expectedQty: string;
    readonly observedQty: string;
    readonly clampedQtyDelta: string;            // observed − expected, always positive
    readonly clampedCashflowDelta: string;       // analogous on the cashflow side
    readonly observedAtMs: number;
}
```

The engine adds an internal `IReconciliationPass` summary (counters per drift
case per tick) but does not export it.

### 6. Reviewer rules

- No code path mutates `risk_state.open_exposure` outside `RiskGateService`.
  Reconciliation's release path goes through the gate methods, not direct SQL.
- No code path transitions a `positions` row out of `reconciling` outside the
  reconciliation service's resolution handler.
- No code path calls `exchange.fetchPositions()` or `fetchOpenOrders()`
  outside the reconciliation service (other readers consume the in-memory
  cache). One source of truth pull per tick.
- Foreign-position adoption defaults differ live vs dev — must be set
  explicitly in env config; defaulting to `adopt_unmanaged` in live is a
  reviewer must-fix.

### 7. New API surface (added by W4a/W4b) — pinned

The reconciliation service depends on the following methods. Each is
introduced as part of the M6 W4a/W4b wave breakdown, not pre-existing.

**Exchange port (W4a, `IExchangeClient`):**

- `fetchPositions(): Promise<readonly IPositionSnapshot[]>` — wraps ccxt
  `fetchPositions`. Returns one entry per non-zero `(symbol, side)` pair.
  `IPositionSnapshot` is a new engine-internal interface in
  `apps/engine/src/exchange/interface/` carrying `{ symbol, side, qty,
  entryPrice, markPrice, liquidationPrice, marginType, leverage }`.
- `fetchOpenOrders(): Promise<readonly IOpenOrderSnapshot[]>` — wraps ccxt
  `fetchOpenOrders`. Used by case (e) protective-drift detection.
  `IOpenOrderSnapshot` carries at minimum `{ clientOrderId, symbol,
  reduceOnly, type, status }`.

**Risk gate (W4b, `RiskGateService`):**

- `reconcileClose(positionId: number): Promise<void>` — case (b) primitive.
  Decrements `risk_state.open_exposure` by **`position.qty *
  position.entry_price`** (live residual; not `entry_notional`), writes a
  `decisions` row (`action=close`, `reason=reconciled_missing`),
  best-effort releases the in-memory reservation if any (matcher in next
  bullet). Does not place an order.
- `releaseInFlightReservationFor(positionId, eventId, slot)` — match key
  is **`(eventId, slot)`**, not `(symbol, slot)` (revised post-R1
  blocker #5). The reservation's `reservationId` is deterministically
  seeded from `eventId` (ADR-0004 §3 / §7); matching on `eventId + slot`
  uniquely identifies one reservation even when two coexist on the same
  slot. Persisting `reservationId` on `positions` stays deferred (M7 W0
  contingent); if adversarial QA still surfaces a collision with the
  tightened matcher, M7 W0 owns the schema fix.
- `recordExposureDrift(positionId: number, dbQty: MoneyValue, exchangeQty:
  MoneyValue): void` — case (c) primitive. Increments the model-divergence
  counter (ADR 0004 §6) and emits a divergence alert event. Pure
  in-memory; no DB write (`risk_state` is touched via `adjustQty` on the
  position, not via the gate for qty mismatches).
- `expireStaleReservations(nowMs: number): void` — pre-existing (M4); the
  reconciliation tick calls it as §4 step 1.

**Position service (W4b, `PositionService`):**

- `adjustQty(positionId: number, newQty: MoneyValue, reason:
  QtyAdjustmentReasonEnum): Promise<void>` — case (c) and case (f)
  qty-mutation primitive. Single atomic `UPDATE`, mirrors the
  DB-first-then-cache ordering of `transition` (ADR 0009 §2, §6.1).
  Does **not** change `state`; combining state + qty mutation would
  violate CQS and force `transition` to do two things. The cache update
  follows the DB write. New shared enum `QtyAdjustmentReasonEnum =
  { RECONCILED_FILL_DRIFT | LATE_FILL_RESOLVED | EXCHANGE_QTY_CORRECTION
  }` is added by `bot-shared-maintainer` before W4b.
  `ExecutionService.applyReduceFillToPosition` is refactored to route
  through `adjustQty` as part of W4b (one of W4b's files).

**Reconciliation service (W4a/W4b, new):**

- `tick(): Promise<IReconciliationPass>` — one pass, callable by
  scheduler and by tests. Returns a summary counter per drift case for
  observability.
- `forceTick(): Promise<IReconciliationPass>` — bypasses the
  `RECONCILIATION_MIN_INTERVAL_MS` lower bound; for tests + operator
  endpoint.

**Subscription retainer / cooldown release sweep (W4a, on the existing
W2 retainer):**

- `releaseExpiredCooldownRetentions(nowMs: number): void` — internal
  method on the reconciliation tick. Iterates retainer entries with
  reason `COOLDOWN_ACTIVE`, calls
  `riskGateService.isCooldownActive(symbol, nowMs)` (existing
  derivative read), and `retainer.release(symbol, COOLDOWN_ACTIVE)` if
  the cooldown has elapsed. **No new risk-gate API; cooldown stays
  derivative per ADR 0004 §5.** This corrects an inconsistency between
  ADR-0011 §5 (which implied cooldown arm/expire events) and M4's
  derivative cooldown design — see ADR-0011 revision history.

## Consequences

- The risk gate gains two new reasons (`RECONCILING_HOLD`,
  `FOREIGN_POSITION_HOLD`) and one new method (`reconcileClose`). These are
  shared-contract changes routed through `bot-shared-maintainer`.
- The exit-reason vocabulary gains `RECONCILED_MISSING` (ADR 0012). This is a
  shared enum addition.
- The reconciliation service is a new top-level engine module
  (`apps/engine/src/reconciliation/`). It depends on Exchange, Position,
  and Risk modules.
- Account-history backfill (recovering close prices for `RECONCILED_MISSING`
  rows) is deferred to M9 — listed in M6's "deferred" section.

## Alternatives considered

- **Always-flatten any unmatched exchange position.** Rejected for dev/test
  (operator hand-traded positions on the testnet account would be wiped); kept
  as the live default via the policy flag.
- **Use a single `(clientOrderId)` key for both position- and fill-level
  matching.** Rejected: positions are aggregates and don't have a single
  client id; the brief's wording is about *fills*, position matching is
  necessarily `(symbol, side)`.
- **Continuous WS-driven reconciliation instead of periodic poll.** Rejected
  for M6: Binance Futures user-data stream (account/position updates via
  `LISTEN_KEY`) is the right long-term path but introduces stream-reconnect
  drift surface. Periodic REST poll is simpler, sufficient at 30s cadence,
  and orthogonal to the WS path; M9 may add WS as an *additional* event
  source that feeds the same reconciliation diff logic.
- **Reservation TTL release without reconciliation (pure timer).** Rejected:
  TTL alone cannot distinguish "fill never happened" from "fill happened, ack
  lost." Reconciliation against the exchange is necessary; TTL is only the
  upper bound on how long to wait before forcing a reconciliation pass.
- **Persist the reservation ledger to DB** so reservations survive a crash.
  Rejected at M4 (§3 rationale: durability buys nothing because reconciliation
  is the recovery mechanism); this ADR confirms the choice and codifies the
  restart sweep as the leak-release path.

## See also

- `docs/plans/archive/M6-position-management.md`
- `docs/architecture/adr/0009-position-state-machine.md` (the `reconciling` state)
- `docs/architecture/adr/0014-crash-recovery.md` (restart sweep, exposure rebuild)
- `docs/architecture/adr/0006-idempotency-contract.md` §3 (timeout query protocol; case f)
- `docs/architecture/adr/0004-risk-management.md` §3 (reservation ledger + M6 seam),
  §6 (model-divergence kill switch fed by drift counters)
- `docs/architecture/adr/0008-sl-tp-attach.md` §3 (case e fallback policy)
- `docs/architecture/adr/0012-funding-and-pnl.md` (`RECONCILED_MISSING` exit reason)
