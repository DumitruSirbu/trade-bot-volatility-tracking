# ADR 0013 — Lifetime position instrumentation (M6)

Status: Accepted
Date: 2026-05-23
Milestone: M6 — Position management & reconciliation

## Context

M2 added seven lifetime-instrumentation columns to `positions` for M6 to
populate (PositionEntity.ts lines 128–152):

```
mae_pct
mfe_pct
time_to_reversion_secs
stop_gap_pct
protective_order_type           (already populated since M5)
mark_vs_last_max_divergence_pct
min_liquidation_distance_pct
```

The M6 brief: "these are the primary evidence for whether the strategy is
actually low-risk (feeds M8 tail-risk metrics and the M4 model-divergence
kill switch)."

The values are statistics-over-the-life-of-the-position; each requires:
- a sampling decision (which event drives the update),
- an update rule (max/min/first/last + decimal-safe),
- a persistence decision (when to write the column).

This ADR locks each.

Constraints:

- **Money is decimal.** All comparisons use `MoneyValue` / `DecimalValue`
  comparators. Percentages stored as `NUMERIC(18, 8)` decimals (e.g.
  `0.02500000` = 2.5%).
- **Same code live and backtest.** Sampling is event-driven from
  `price.update` and from `transactions` rows; both fire identically in
  live and replay.
- **Determinism.** No wall-clock reads; `nowMs` is injected (ADR 0004 §7).
- **Write amplification budget.** A position can live for hours under 30s+
  `price.update` cadence — instrumentation updates **must not** write the
  DB on every tick. Locked: in-memory accumulator, flushed at coarse
  cadence + state transitions (§4).

## Decision

### 1. Each metric — definition, sample event, update rule

Notation: `P` is the position; `entry = P.entryPrice`; `markPrice` /
`lastPrice` come from `price.update`. Percentages are signed (positive =
favorable, negative = adverse) **from the position's perspective** — for a
LONG, `(markPrice - entry) / entry`; for a SHORT, `(entry - markPrice) /
entry`.

#### 1a. `mae_pct` — Max Adverse Excursion

> The deepest unrealized drawdown the position ever showed, as a percent
> of entry price. Negative or zero.

- **Sample event:** every `price.update` for `P.symbol` while
  `P.state ∈ {pending_open, open, closing}` (not `reconciling` — drifted
  state is not real exposure for instrumentation).
- **Computation:** `excursion = side-aware-pct(markPrice, entry)` per the
  notation above (negative = adverse).
- **Update rule:** `mae_pct = min(mae_pct ?? 0, excursion)`. Initial value
  is `0` (entry). Decimal `min` via `MoneyValue.lt` comparator.
- **Reviewer rule:** `mae_pct` is **non-positive** at all times. A
  positive `mae_pct` is a sign-bug; integration test must assert this.

#### 1b. `mfe_pct` — Max Favorable Excursion

Symmetric to MAE:

- **Sample event:** same as MAE.
- **Computation:** `excursion = side-aware-pct(markPrice, entry)`.
- **Update rule:** `mfe_pct = max(mfe_pct ?? 0, excursion)`.
- **Reviewer rule:** `mfe_pct ≥ 0` at all times.

#### 1c. `time_to_reversion_secs` — seconds from entry to first close-to-VWAP

> For mean-reversion strategies (v1, v3), how long did the price take to
> return to VWAP after the entry trigger?

The M6 brief lists this as a single int column; the definition is
strategy-flavored:

- **Sample event:** every `price.update` for `P.symbol`. Reads
  `vwap_at_entry` (immutable, written at open) and the current `vwap`
  from MarketDataModule's per-symbol state.
- **Computation:** "reverted" = the markPrice crossed back to the entry's
  VWAP for the first time post-entry, in the direction the strategy was
  fading. For a SHORT entry triggered by VWAP-deviation upside, reversion
  is `markPrice.lte(vwap_at_entry)`. For a LONG entry triggered by VWAP-
  deviation downside, reversion is `markPrice.gte(vwap_at_entry)`.
- **Update rule:** first time the reversion condition is true while
  `time_to_reversion_secs IS NULL`, write
  `(nowMs - P.opened_at_ms) / 1000` rounded to int seconds. Then **stop
  updating** (it's a first-time-only stat).
- **Edge:** for a momentum strategy (v2) the concept "reversion to VWAP"
  is inverted. **Locked:** the column is computed identically (cross-back
  to entry-VWAP from the deviation side) regardless of strategy
  direction; for v2 a positive reversion is a sign the trade went *against*
  the momentum thesis. The M8 analysis flips the sign based on
  `strategy_versions.direction`. The instrumentor stays direction-agnostic.

#### 1d. `stop_gap_pct` — fill slippage beyond the stop

> When the position closes via stop-loss, how much further did the fill
> price go past the SL level?

- **Sample event:** on the `closing → closed` transition with
  `exit_reason = STOP_LOSS` (ADR 0012 §5).
- **Computation:** `gap = side-aware-pct(actualFillPrice, stopLossPrice)`,
  signed positive when the fill was worse than the level (i.e. extra
  slippage past the stop).
- **Update rule:** write once at close; never updated otherwise.
- **Reviewer rule:** for any other `exit_reason`, `stop_gap_pct` stays
  NULL.

#### 1e. `protective_order_type` — already-populated since M5

The column is set at open (`LOCAL_FALLBACK` default per ADR 0008 §4) and
flips to `EXCHANGE_SIDE` on successful attach. M6 does not change this;
listed here for completeness and because it is part of the M2
instrumentation block. Reads `protective_order_type` as the final value
at `closed` — useful for the M8 metric "what fraction of trades ran on
local protection?"

#### 1f. `mark_vs_last_max_divergence_pct` — max divergence between mark and last

> A monitor for ADR 0008's mark-price choice: if mark and last divergence
> widens often, the choice is operationally critical (last-driven stops
> would have fired falsely).

- **Sample event:** every `price.update`.
- **Computation:** `div = abs(markPrice - lastPrice) / markPrice`
  (always non-negative). Both come from the same `price.update` payload
  (M1 already enriches with both fields).
- **Update rule:** `mark_vs_last_max_divergence_pct = max(prev ?? 0,
  div)`.
- **Reviewer rule:** non-negative. Used by M8 to validate the mark-price
  choice; outsized values flag exchange tape weirdness.

#### 1g. `min_liquidation_distance_pct` — closest the position got to liquidation

> A safety metric: did this trade ever get dangerously close to
> liquidation? Feeds the M4 model-divergence kill switch.

- **Sample event:** every `price.update`. Liquidation price is read from
  `exchange.fetchPosition({ symbol })` cache (Binance returns
  `liquidationPrice` in position metadata). Refreshed every reconciliation
  tick (30s) — sufficient because the liquidation price moves slowly with
  notional/margin changes, not with price.
- **Computation:** `distance = side-aware-pct(liquidationPrice,
  markPrice)`, signed positive when mark is on the safe side of
  liquidation, negative if past (impossible without close — alert).
- **Update rule:** `min_liquidation_distance_pct = min(prev ?? +inf,
  distance)`. Initial value: the distance at entry (computed when the
  liquidation price is first known, typically within one tick of open).
- **Reviewer rule:** non-negative on a non-liquidated position; a
  recorded negative value indicates a reconciliation lag (the position
  was liquidated and the bot has not yet seen the case-b drift). M4's
  divergence counter triggers at `min_liquidation_distance_pct <
  WARN_LIQUIDATION_DISTANCE_PCT = 0.05` (5% buffer) for any open
  position — separate from this column, but consumes the same metric.

### 2. Sampling cadence — `price.update`, **not** every tick

`price.update` from M1 is per-symbol, per-mark-tick, typically 1–2 Hz on
liquid symbols, faster on volatility. The instrumentor:

- Subscribes to `price.update` via `@OnEvent` like the strategy and the
  local monitor.
- Filters to events for symbols with a non-terminal position
  (`state ∈ {pending_open, open, closing}`). The
  `SubscriptionRetainer` (ADR 0011 §5) guarantees these events still
  arrive even after universe drop.
- **`reconciling` positions are skipped** — instrumentation on drifted
  state would corrupt the metric.

`price.update` is the *only* sampling event for §§1a/1b/1c/1f/1g. The
remaining metrics (§§1d/1e) are driven by state transitions, not price
events.

### 3. The writer — a dedicated `PositionInstrumentor` service

**Locked: a separate `PositionInstrumentor` service, not
`PositionService`.**

Rationale:

- **Single Responsibility.** `PositionService` owns *state transitions*
  and *the canonical DB row*. The instrumentor owns *derived statistics
  over the position's life*. Co-locating them would make
  `PositionService` a god class.
- **Write-amplification isolation.** The instrumentor batches in-memory
  and flushes on cadence (§4); `PositionService.transition` writes
  immediately. Separating them keeps the transition write path tight
  and predictable.
- **Testability.** The instrumentor is pure-function logic (in →
  updated-accumulator); easy to unit-test boundary cases (entry tick,
  reversal crossings, post-close residual ticks ignored, side flips
  rejected).

**Location:** `apps/engine/src/position/service/PositionInstrumentor.ts`
(domain-owned, lives next to `PositionService`).

**Interface contract:**

```
class PositionInstrumentor {
    onPositionOpened(position: PositionEntity): void;     // seeds accumulator
    onPriceUpdate(event: IPriceUpdateEvent): void;        // §1a/b/c/f/g
    onPositionClosed(position: PositionEntity, finalFillPrice: MoneyValue, exitReason: ExitReasonEnum): void;  // §1d, flush
    flushPending(): Promise<void>;                        // §4 periodic flush
}
```

The accumulator is an in-memory `Map<positionId, IInstrumentationState>`
holding the running min/max values. Constant-time updates per tick.

### 4. Persistence cadence — batched flush, not per-tick

**Locked write cadence:**

- **Periodic flush:** every `INSTRUMENTATION_FLUSH_INTERVAL_MS = 10
  seconds` the instrumentor writes any *changed* values to the DB
  (`UPDATE positions SET mae_pct=?, mfe_pct=?, mark_vs_last_max_divergence_pct=?, min_liquidation_distance_pct=?, time_to_reversion_secs=COALESCE(time_to_reversion_secs, ?) WHERE id=?`).
  A "changed" check (in-memory dirty flag) avoids no-op writes.
- **State-transition flush:** at `closing → closed` (any path), the
  instrumentor flushes synchronously *before*
  `PositionService.finalizeRealizedPnl` runs, so the final row has the
  full lifetime instrumentation values when the close event fires.
- **`stop_gap_pct`** is written in the `closing → closed` flush only,
  driven by the exit reason and final fill price (§1d).

10s flush cadence is a deliberate trade-off: any individual position
can be "out of date" in the DB by up to 10s, but the values are
non-critical-to-trading (informational / analytic). The dashboard live
view (M9/M10) can either read the in-memory accumulator directly via a
read-API method, or accept the 10s staleness — recommendation: read the
accumulator via a `getLifeStats(positionId)` method on the instrumentor.

**Reviewer rule:** the instrumentor MUST NOT update the DB on every
`price.update`. A test asserts that for N synthetic ticks within a
flush window, exactly one UPDATE statement is issued.

### 5. Recovery: instrumentation across restarts

The in-memory accumulator is **not** restored on restart; the persisted
row is the recovery floor. The instrumentor seeds the accumulator from
the DB row's current values when `PositionService.bootstrap()` re-loads
each non-closed position (ADR 0014 §3). Loss of unflushed deltas
(typically <10s of ticks pre-crash) is acceptable for analytic
metrics; the M8 evidence is unaffected.

**Reviewer rule:** the instrumentor MUST seed from `positions.mae_pct`
etc. on bootstrap, not from defaults. Re-seeding a halfway-trade with
defaults would forget prior MAE/MFE.

### 6. Reviewer rules consolidated

- One writer. Only `PositionInstrumentor` writes the seven columns.
  `PositionService` reads them (to surface in alerts / read API) but
  does not mutate them.
- No `Math.max` / `Math.min` on prices. Decimal comparators only.
- `reconciling` positions are not instrumented (drift-state stats
  corrupt the analysis).
- Instrumentation MUST NOT influence trading decisions. The strategy
  doesn't read these columns; the gate doesn't read these columns. They
  are evidence, not signal. The one exception is the M4 model-divergence
  kill switch, which consumes `min_liquidation_distance_pct` from the
  instrumentor's in-memory cache via an event, not via the DB column
  (already documented in ADR 0004 §6).

## Consequences

- A new domain service (`PositionInstrumentor`) lives in the
  PositionModule. Lightweight: in-memory map + event subscriber + a
  10-second batched UPDATE.
- The M9 read API can surface live MAE/MFE/min-liq-distance per
  position from the instrumentor's in-memory cache without DB hits.
- M4's model-divergence kill switch becomes more concrete: it reads
  `min_liquidation_distance_pct` via an event the instrumentor emits
  when a threshold is crossed (not implemented in M6 — the contract is
  defined here, the kill-switch wiring stays M4's already-shipped
  surface).
- M2 schema is untouched. All columns already exist; only the writer
  is new.

## Alternatives considered

- **Have `PositionService` own the instrumentation.** Rejected: violates
  SRP; `PositionService` already owns state transitions + reconciliation
  glue. Two responsibilities = two reasons to change.
- **Write on every tick.** Rejected: 10× DB write rate vs. current,
  zero analytic gain (no consumer needs subsecond freshness on these
  values).
- **Write only at close.** Rejected: a crash mid-trade loses the entire
  position's MAE/MFE/min-liq history. The 10s flush is a reasonable
  durability/cost compromise.
- **Persist instrumentation to a separate `position_instrumentation`
  table.** Rejected: M2 already has the columns on `positions`; adding
  a side table would force a join on every read. The columns are
  one-row-per-position, append-only conceptually but updated-in-place
  in this design — `positions` is the right home.
- **Skip `time_to_reversion_secs` because it's strategy-flavored.**
  Rejected: the M8 analysis explicitly demands it for v1/v3 evaluation;
  computing it direction-agnostic (per §1c) keeps the instrumentor
  generic while the M8 SQL flips the sign per strategy.
- **Compute live MAE/MFE from `tick_aggregates` post-hoc rather than
  in-memory.** Rejected: requires the M7 backtest to also run post-hoc
  for these values, breaking the "same code live and backtest" rule.
  In-memory accumulator works identically in both.

## See also

- `docs/plans/archive/M6-position-management.md` (instrumentation task)
- `docs/architecture/adr/0009-position-state-machine.md` (states the instrumentor reads)
- `docs/architecture/adr/0011-local-sltp-fallback-and-held-symbols.md` (mark/last divergence under fallback)
- `docs/architecture/adr/0012-funding-and-pnl.md` (close transition; instrumentation flushes before finalize)
- `docs/architecture/adr/0008-sl-tp-attach.md` (mark-price reference, stop-gap context)
- `docs/architecture/adr/0004-risk-management.md` §6 (model-divergence kill switch consumer)
