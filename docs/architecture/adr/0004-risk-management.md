# ADR 0004 — Risk management (M4)

Status: Accepted
Date: 2026-05-22
Milestone: M4 — Risk management

## Context

M3 ends at a recorded `decisions` row and emits **nothing** downstream
(`StrategyService.onVolatilityDetected` writes via `DecisionRepository.record` and stops).
M4 inserts the **central risk gate** between the strategy signal and execution (M5). It is
the single chokepoint the brief and the project invariants demand: *nothing reaches
execution without passing it, and no order action bypasses it* (open/add/reduce/close).

This ADR locks the gate's contract, the slot model, the in-flight reservation ledger, the
loss-window definitions, the stress-halt source, the live↔backtest determinism contract,
and the sizing seam. It writes **no application code** — it prescribes exactly what
`bot-shared-maintainer` adds to `packages/shared` and what `bot-engine-nestjs` builds in
`apps/engine/src/risk`.

Constraints that shape every decision (all non-negotiable, inherited from ADR 0001–0003 +
`code-conventions.md` + `00-overview.md`):

- **Same code live and in backtest.** The gate has unavoidable time/state dependencies
(now, `risk_state`, open positions, reservations) that the strategy does not. These are
**injected as data through ports**, never read via wall-clock or ambient I/O inside the
decision logic (§7).
- **All risk lives outside the strategy.** The strategy proposes (`ISignal` +
`IProposedExit`); the gate *decides*. The gate never flips `tradeSide` (ADR 0003 §2). It
may shrink size, clamp the stop, or reject.
- **Money is `decimal`, never float.** Sizing/exposure/PnL are `MoneyValue` (decimal.js)
inside the engine; only `string`-money crosses the shared boundary (§8).
- **No order path bypasses the gate**, including protective exits and the kill-switch
flatten (§2).
- **Existing schema is fixed** (M2): `risk_state(date UNIQUE, realized_pnl_day, open_exposure, trades_count, is_halted, halt_reason)`, `decisions.action ∈ open|add|reduce|close|skip`, `decisions.reason varchar`, `positions.position_slot ∈ A|B|C`, `positions.time_stop_at`, `positions.status ∈ open|closed`. M4 adds **no new
tables** (§3 keeps the reservation ledger in-memory).

## Decision

### 1. The risk-gate contract — synchronous in-process call, not an event

**The orchestrator calls the gate synchronously, immediately after `evaluate()`**, in the
same `onVolatilityDetected` handler, before it persists the decision. Rejected by-design:
risk subscribing to a `signal.produced` event.

Rationale:

- **The decision row must record the gate's verdict.** M3 already writes one decision per
trigger. The gate's outcome (approved slot, reject reason, sized notional) belongs *on
that same row* (`action`, `reason`, later `position_id`). A synchronous call lets the
orchestrator write one authoritative decision; an async event would either race the
decision write or force a second update.
- **Determinism / replay.** M7 backtest replays triggers through the same
orchestrator→gate call path. An in-process synchronous function is trivially
deterministic and ordered; an event bus introduces non-deterministic delivery ordering
that would break "same code live and backtest."
- **Ordering of concurrent same-bar signals** (§4) requires the gate to see signals in a
controlled batch. The orchestrator owns that batching; a fire-and-forget event does not.

The seam to execution (M5) stays an event: on **approval** the gate returns a result, and
the orchestrator (or a thin M5 publisher) emits `order.intent.approved` carrying the
approved intent. M4 itself never calls the exchange.

**Gate input — `IOrderIntent` (engine-internal, carries `MoneyValue`):**

The orchestrator assembles this from the M3 `ISignal` + sizing + slot reservation request.
It is engine-internal (like `ISignal`) because it carries `MoneyValue` and is never sent to
the dashboard. The dashboard reads the persisted `decisions`/`positions` rows.

```
interface IOrderIntent {
    readonly intentAction: OrderIntentActionEnum;   // open|add|reduce|close|flatten  (§2)
    readonly symbol: string;
    readonly eventId: string;                       // ties back to the trigger / decision
    readonly tradeSide: PositionSideEnum;           // long|short, set by the strategy; gate NEVER flips
    readonly signalScore: number;                   // 0–100, drives same-bar candidate selection (§4)
    readonly correlationMode: CorrelationModeEnum;  // idiosyncratic|correlated (drives slot eligibility)
    readonly coinTier: CoinTierEnum;
    readonly proposedExit: IProposedExit;           // strategy SL/TP/time-stop (ADR 0003 §3)
    readonly openPosition: IOpenPositionState | null; // for add/reduce/close; null for open
    readonly sizing: IIntentSizing;                 // §8 — concrete decimal sizing
}

interface IIntentSizing {
    readonly qty: MoneyValue;                        // base-asset quantity, step-rounded
    readonly notional: MoneyValue;                   // USDT notional reserved against caps
    readonly leverage: DecimalValue;                 // ≤ 3
    readonly riskPerTradeUsdt: MoneyValue;           // the dollar risk this size implies (sizing audit)
}
```

**Gate output — `IRiskDecision` (engine-internal):**

Command-Query Separation: the gate *returns a value* and performs the reservation as a
controlled side effect on its own ledger (§3) only on approval. It writes no DB rows and
emits no events — the orchestrator persists and emits.

```
interface IRiskDecision {
    readonly outcome: RiskOutcomeEnum;               // approved | rejected
    readonly rejectReason: RejectReasonEnum | null;  // non-null IFF rejected
    readonly approvedSlot: PositionSlotEnum | null;  // A|B|C, non-null IFF approved & opening
    readonly approvedSizing: IIntentSizing | null;   // post-clamp sizing (funding 50% cut etc.)
    readonly clampedExit: IProposedExit | null;      // SL possibly tightened to sit inside liquidation
    readonly reservationId: string | null;           // ledger handle (§3), non-null IFF approved
}
```

`**RejectReasonEnum` — every reason in the brief, enumerated once (SHARED).** It is
persisted to `decisions.reason` and surfaced by the M9 read API / M10 dashboard, so it
lives in `packages/shared/src/enum/`, exactly as `SkipReasonEnum` did (ADR 0003 §2). It is
distinct from `SkipReasonEnum`: a `skip` is the strategy declining; a `reject` is the gate
vetoing a would-be trade. Both end up in `decisions.reason`, but `decisions.action` differs
(`skip` vs the attempted `open/add/...`).

```
enum RejectReasonEnum {
    MAX_POSITIONS_REACHED='max_positions_reached',                  // all 3 slots full
    BTC_CORRELATED_NOT_BEST_CANDIDATE='btc_correlated_not_best_candidate', // §4 single-candidate
    BTC_CORRELATED_SLOT_TAKEN='btc_correlated_slot_taken',          // slot C already holds a correlated pos
    NO_ELIGIBLE_SLOT='no_eligible_slot',                            // idiosyncrasy too low for A/B and C taken
    MARKET_STRESS='market_stress',                                  // §6, overrides ADX
    OI_UNAVAILABLE='oi_unavailable',                                // require_oi_available && OI missing
    SPREAD_TOO_WIDE='spread_too_wide',                              // tier spread ceiling exceeded
    BELOW_UNIVERSE_FLOOR='below_universe_floor',                    // symbol dropped out of universe since refresh
    FUNDING_SUPPRESSED='funding_suppressed',                        // funding_annualized > 30% → suppress entry
    COOLDOWN_ACTIVE='cooldown_active',                              // post-loss re-entry window on symbol
    DAILY_LOSS_LIMIT='daily_loss_limit',                            // §5
    WEEKLY_LOSS_LIMIT='weekly_loss_limit',                          // §5
    CONSECUTIVE_LOSS_HALT='consecutive_loss_halt',                  // N losses same UTC day
    MAX_TRADES_PER_SYMBOL_PER_DAY='max_trades_per_symbol_per_day',  // overtrading cap
    MAX_TRADES_PER_BAR_UNIVERSE='max_trades_per_bar_universe',      // overtrading cap (per 5m bar)
    SAME_DIRECTION_EXPOSURE_CAP='same_direction_exposure_cap',      // portfolio same-side cap
    EXPOSURE_CAP_PER_COIN='exposure_cap_per_coin',                  // max exposure per coin
    TIME_STOP_MISSING_OR_INVALID='time_stop_missing_or_invalid',    // v1 mandatory time-stop check
    SL_OUTSIDE_LIQUIDATION='sl_outside_liquidation',                // SL cannot be made safe at this size
    TIER3_NOT_VALIDATED='tier3_not_validated',                      // no unvalidated tier-3 live
    MODEL_DIVERGENCE_HALT='model_divergence_halt',                  // slippage/distribution kill switch (M9-fed)
    GLOBAL_HALT='global_halt',                                      // kill-switch / risk_state.is_halted set
}
```

**Shared vs engine-internal split (locked):**

- **Shared** (`packages/shared/src/enum/`): `RejectReasonEnum`, `RiskOutcomeEnum`,
`OrderIntentActionEnum`. These are *vocabulary* persisted to `decisions`/`positions` and
read by the dashboard; they carry no money. Same rule that put `SignalActionEnum` /
`SkipReasonEnum` in shared (ADR 0003 §2).
- **Engine-internal** (`apps/engine/src/risk/interface/`): `IOrderIntent`, `IIntentSizing`,
`IRiskDecision`, plus the reservation ledger types (§3) and the determinism ports (§7).
These carry `MoneyValue`/`DecimalValue` and must not leak decimal.js across the wire.

### 2. The gate covers ALL order actions — reduce/close/flatten always pass, still routed through

`OrderIntentActionEnum = { OPEN, ADD, REDUCE, CLOSE, FLATTEN }`. The gate is the *only*
producer of an approved order intent for every one of them.

- `**OPEN` / `ADD`** run the full check chain (slot, caps, stress, funding, spread, OI,
loss windows, cooldown, time-stop, SL-inside-liquidation, sizing). `ADD` additionally
checks per-coin exposure against the *existing* position plus the add.
- `**REDUCE` / `CLOSE` / `FLATTEN*`* are **always approved** (de-risking can never be
blocked), but they **still call `RiskGateService.evaluate`** so that: (a) the action is
recorded as a `decisions` row with `outcome=approved`, (b) the reservation ledger and
`risk_state.open_exposure` are *released* for the reduced/closed notional, and (c)
cooldown is armed on a closed loss (§ cooldown). A reduce/close that skipped the gate
would leak reservations and desync exposure accounting. **Reviewer rule:** any code path
that reduces/closes a position without going through `RiskGateService` is a must-fix
(mirrors ADR 0003's "strategy never reaches execution" rule, one layer down).
- `FLATTEN` is the kill-switch path: emitted by M9, it passes the gate unconditionally and
releases all reservations and exposure for the symbol(s). The gate does not *originate*
the halt; it honours `is_halted` for new entries and lets flattens through.

The check chain is a single ordered pipeline (`open`/`add` only); the first failing check
short-circuits and returns its `RejectReasonEnum`. De-risking actions branch out of the
pipeline before the entry-only checks. Order of checks is fixed for replay determinism:
global-halt → stress → universe-floor → OI-available → spread → cooldown → loss-windows
(daily/weekly/consecutive) → overtrading caps → slot/candidate selection → funding
size/suppress → time-stop validity → SL-inside-liquidation → exposure caps → reserve.

### 3. In-flight exposure reservation ledger — in-memory service state, not a table

**The ledger lives in `RiskGateService` in-memory state** (a `Map<reservationId, IExposureReservation>`), **not** a new DB table.

Rationale:

- It is **transient by definition** — a reservation exists only between approval and
fill/fail, typically seconds. Persisting it adds write amplification and a second source
of truth for exposure (the durable source is `risk_state.open_exposure` + open
`positions`).
- The engine **runs as a single always-on process** holding in-memory state (overview:
"never scale-to-zero", "holds in-memory state"). A restart's correct behaviour is to
reconcile against the exchange (M6 owns this), *not* to replay stale reservations. So
durability buys nothing and risks resurrecting phantom reservations.
- M6 is the durable backstop: on TTL expiry / unknown-outcome it reconciles the position
against the exchange and corrects `risk_state.open_exposure`.

```
interface IExposureReservation {
    readonly reservationId: string;       // gate-minted opaque id (deterministic seed in backtest, §7)
    readonly symbol: string;
    readonly slot: PositionSlotEnum;
    readonly tradeSide: PositionSideEnum;
    readonly notional: MoneyValue;        // reserved against per-coin + portfolio caps
    readonly correlationMode: CorrelationModeEnum;
    readonly createdAtMs: number;         // injected clock (§7)
    readonly expiresAtMs: number;         // createdAtMs + RESERVATION_TTL_MS
    state: ReservationStateEnum;          // pending | confirmed | released | expired
}
```

**Lifecycle / state transitions (locked):**

```
(approval)        → PENDING        reserve notional + claim slot; counts against caps & §4 same-bar selection
PENDING  --fill-->  CONFIRMED      position row is now authoritative; reservation kept until M6 ties it to a position id, then dropped
PENDING  --fail-->  RELEASED       fill rejected/expired by execution → free notional + slot immediately
PENDING  --ttl --> EXPIRED         expiresAtMs passed with no fill confirmation → M6 reconciles vs exchange, then RELEASED or CONFIRMED
CONFIRMED--close-> RELEASED        reduce/close intent (§2) frees the closed notional
```

`PENDING` and `CONFIRMED` reservations both count toward exposure caps and the position
count (so concurrent same-bar approvals cannot collectively breach the 3-slot cap or
per-coin exposure — the brief's "evaluated against confirmed + submitted-but-unfilled
intents"). `RELEASED`/`EXPIRED` do not.

**M6 seam (define, do not implement):** M4 exposes `releaseReservation(reservationId)` and
`expireStaleReservations(nowMs)` on the gate. M6's reconciliation loop calls
`expireStaleReservations` (TTL sweep) and, on resolving an unknown outcome against the
exchange, calls either `releaseReservation` (fill never happened) or hands the gate the
real `position_id` to mark `CONFIRMED→dropped`. M4 ships the methods + the in-memory ledger
and unit-tests the transitions with an injected clock; the *scheduled* sweep wiring is M6.

### 4. Slot model ownership — M4 owns real assignment + same-bar candidate batching

M3's `buildMarketSnapshot` hardcodes `position_slot=A` and `active_positions_count=0` as
placeholders. **M4 owns real slot assignment** and overwrites those snapshot fields with
the gate's verdict before the decision is persisted.

**Slot model (locked):**

- **Slot A, Slot B** — idiosyncratic only. Eligible iff
`idiosyncrasy_score ≥ params.idiosyncrasy_min_score` AND
`correlation_mode === idiosyncratic`. At most 2 concurrent A/B positions.
- **Slot C** — at most 1 BTC-correlated position (`max_btc_correlated_positions: 1`). Slot
C is *available to an idiosyncratic trade* when no BTC-correlated position is open (the
brief). So a third concurrent idiosyncratic position may take C iff C is free of a
correlated position.
- **Concurrency cap: 3 total positions across A+B+C. The fourth concurrent intent — idiosyncratic or correlated — rejects `MAX_POSITIONS_REACHED`.**

**Assignment algorithm (deterministic; reads live state via §7 ports):**

```
occupiedSlots = slots held by open positions (positions.status=open) + PENDING/CONFIRMED reservations
if intent.correlationMode == correlated:
    if slot C occupied by a correlated position → reject BTC_CORRELATED_SLOT_TAKEN
    else candidate slot = C  (subject to §4 same-bar single-candidate selection below)
else (idiosyncratic):
    if idiosyncrasy_score < idiosyncrasy_min_score → reject NO_ELIGIBLE_SLOT
    pick first free of [A, B]      (deterministic A-before-B ordering)
    else if C free of a correlated position → assign C
    else → reject MAX_POSITIONS_REACHED
```

**BTC-correlated same-bar single-candidate selection — the batching/windowing decision.**
Signals arrive per-event (one `volatility.detected` per symbol per closed bar), so the gate
cannot decide "the single best correlated candidate" from one event in isolation. Lock:

- **The orchestrator buffers correlated-mode `OPEN` intents by bar window** keyed on
`entryCandleOpenTime` (the closed-bar open time already on the event; all triggers for
one 5m bar share it). It does **not** call the gate for a correlated `OPEN` immediately;
it appends to a per-bar buffer.
- **At the deterministic bar-close boundary** (`barCloseMs = entryCandleOpenTime + CANDLE_INTERVAL_MS`, the same `nowMs` ADR 0003 derives) the orchestrator flushes the
buffer: it sorts buffered correlated candidates by `signalScore` descending (ties broken
by `symbol` ascending — deterministic), submits the **single highest** to the gate for
slot C, and writes **all others** as `decisions` with `action=open`,
`outcome=rejected`, `reason=btc_correlated_not_best_candidate`. Result: at most one new
correlated position per bar window.
- **Idiosyncratic and de-risking intents are not buffered** — they go through the gate
immediately (slots A/B are not contended by the single-candidate rule).
- **Live vs backtest:** the flush boundary is the injected clock's notion of bar close, not
wall time — backtest flushes when its simulated bar closes, live when the real bar
closes. Identical ordering because both sort the same buffered set by the same keys.

A bar-window batch buffer is **per-orchestrator in-memory state**, like the reservation
ledger; it never persists (a restart loses at most one bar's pending correlated entries,
which is the safe outcome — no phantom positions).

### 5. Window definitions — daily UTC midnight, weekly rolling 7 days from `risk_state` rows

- **Daily window** = the UTC calendar day `[00:00:00Z, 24:00:00Z)`. The `risk_state.date`
column (`type 'date'`) is the UTC date key. `realized_pnl_day`, `trades_count`,
`open_exposure`, `is_halted` are read/written for **today's** row, upserted on the
`uq_risk_state_date` UNIQUE constraint. The "today" date is derived from the **injected
clock** (§7: `nowMs → toUtcDateString(nowMs)`), never `new Date()`.
- **Daily loss limit** breaches when `realized_pnl_day ≤ -daily_loss_limit` → block new
entries (`DAILY_LOSS_LIMIT`); reduce/close still pass.
- **Consecutive-loss halt** is tracked per UTC day. The count of consecutive closed losses
is derived from today's closed `positions` (ordered by `closed_at`), not stored as a
column — keeps `risk_state` minimal and replayable. After
`params.consecutive_loss_halt` consecutive losses → block entries for the rest of the UTC
day (`CONSECUTIVE_LOSS_HALT`). A win resets the streak.
- **Weekly window** = a **rolling 7-day** sum of `realized_pnl_day` over the last 7
`risk_state` rows ending at today (inclusive), i.e. `[today-6d, today]` by UTC date. Not
ISO week; rolling. Breaches when the 7-day sum `≤ -weekly_loss_limit` →
`WEEKLY_LOSS_LIMIT`. Read via a `RiskStateRepository.sumRealizedPnlSince(dateString)`
query (new repository method; M4 adds it).

Boundary handling: a position opened on day N and closed on day N+1 books realized PnL to
**day N+1** (close date), matching how exchanges settle and keeping the daily row a clean
"what was realized today" ledger.

### 6. Stress-halt source — M1 fast-stress snapshot fields, overrides ADX

The global market-stress halt reads **only fields already on the market snapshot** (M1
fast-stress inputs), so it is deterministic and replayable with no extra I/O:

- `btc_1m_move_pct`, `btc_5m_move_pct`, `eth_5m_move_pct` — index return shock.
- `market_breadth_5m_up_pct` — breadth collapse/surge.
- `same_bar_trigger_count` — universe-wide simultaneous triggering.
- `open_interest_change_5m_pct` — OI shock.
- `funding_rate_annualized` — funding extreme.
- `bid_ask_spread_pct`, `book_depth_10bps_usdt` — spread-widening / depth-collapse.

Thresholds are the existing risk-only params (`stress_btc_1m_shock_pct`,
`stress_eth_1m_shock_pct`, `stress_breadth_pct`, `stress_same_bar_trigger_count`) plus
named `riskConsts` for the OI/funding/spread/depth limits (no inline magic numbers,
per conventions §"Constants Placement").

**Override rule (locked):** when stress indicates trend-initiation, the gate **rejects
mean-reversion entries with `MARKET_STRESS` regardless of the ADX/`regime_label`
"ranging" verdict.** ADX is lagging and labels a market "ranging" exactly as a new trend
begins; the fast-stress inputs lead it. The stress check sits **before** any
regime/slot logic in the pipeline (§2), so it short-circuits ahead of ADX-derived
eligibility. The halt is recorded on `risk_state` (`is_halted=true`,
`halt_reason='market_stress'`) and is visible to M9 (Telegram alert).

### 7. Live-vs-backtest contract — ports for time and state, pure decision core

The gate's decision logic is a **pure function of injected inputs**; everything
time/state/I/O dependent is injected through narrow ports so M7 backtest swaps the
implementation without touching the decision code.

**Injected as data (never read via ambient I/O inside the decision logic):**

- `**nowMs`** — the deterministic clock, bar-close-derived (`entryCandleOpenTime + CANDLE_INTERVAL_MS`), exactly as ADR 0003 §1. Used for cooldown windows, reservation TTL,
the UTC-date key, and the same-bar flush boundary. **No `Date.now()` / `new Date()` in
the gate** — reviewer must-fix, identical to the strategy rule.
- **State ports** (interfaces the gate depends on, concrete in live, fake/in-memory in
backtest):
  - `IRiskStatePort` — `getDay(dateString)`, `upsertDay(...)`, `sumRealizedPnlSince(...)`.
  Live: `RiskStateRepository`. Backtest: in-memory map seeded from the replay.
  - `IOpenPositionsPort` — current open positions + their slots/sides/notional. Live:
  `PositionRepository.findOpen...`. Backtest: the simulated book.
  - `IReservationLedgerPort` — the §3 in-memory ledger (same impl live and backtest; it is
  already pure in-memory state).
  - `IInstrumentPort` — step/min-notional/tick for sizing (§8). Live: `instruments` table.
  Backtest: replayed `instruments` snapshot.
- **Reservation ids** are minted from a deterministic seed in backtest
(`${eventId}:${slot}`) so a replay produces byte-identical ledgers; live may use the same
scheme (no UUID/RNG needed — `eventId` is already unique per trigger).

**Read via I/O only at the orchestrator boundary, then passed in:** the orchestrator loads
open positions and risk-state rows and hands them to the gate; the gate never reaches into
TypeORM directly inside `evaluate`. This mirrors ADR 0003 §1 (the orchestrator does the
impure reads; the decision core stays pure). The result: a backtest constructs the gate
with fake ports + a clock driver and gets identical verdicts to live.

### 8. Sizing math seam — decimal throughout, instrument-constrained, ≤3× leverage

**Sizing is a pure `MoneyValue` computation** in a dedicated `PositionSizer`
(`risk/service/PositionSizer.ts`), all arithmetic in decimal.js:

```
riskPerTradeUsdt = allocatedCapital * params.riskPerTradePct          // default 1%
positionNotional = riskPerTradeUsdt / (atr_14 * params.atr_stop_multiplier)   // ATR-based
qty              = positionNotional / entryPrice
```

Then constrained, in order, against the `instruments` row (via `IInstrumentPort`):

1. **Step rounding** — `qty` rounded **down** to `step_size` (never round up exposure).
2. **Min-notional** — if `qty * price < min_notional`, the trade is **skipped/rejected**,
  not bumped up (bumping would exceed the risk budget). Reuses
   `SkipReasonEnum.MOVE_OUT_OF_BAND`-style handling at the orchestrator, or a dedicated
   reject if it reaches the gate — locked as a **pre-gate orchestrator check** producing a
   decision with the existing below-min reason rather than a new enum value.
3. **Max leverage 3×** — required margin = `notional / leverage`; if implied leverage
  `> 3`, clamp `notional` so `leverage ≤ 3`. Isolated margin by default for live
   (overview locked decision); cross only with a documented reason.
4. **Funding adjustment (§ funding filter):** if funding is unfavourable and
  `abs(funding_rate) ≥ funding_rate_suppress_threshold`, **halve** `notional` (and `qty`)
   before step-rounding; if `funding_rate_annualized > 30%`, **suppress** entirely
   (`FUNDING_SUPPRESSED`). The 30% and the 50%-cut are `riskConsts` named constants.

**SL-inside-liquidation validation:** sizing must guarantee the proposed `stopLossPrice`
(ADR 0003 `IProposedExit`) triggers **before** the liquidation price for the chosen
leverage, accounting for worst-case adverse move + funding drag. If it cannot at the
clamped size, the gate either tightens the stop within the allowed buffer
(`clampedExit`) or rejects `SL_OUTSIDE_LIQUIDATION`. Unit-pinned per the brief.

The sizing output is the `IIntentSizing` the orchestrator puts on `IOrderIntent`; it is
logged per trade and stamped onto `positions` entry-time columns (`signal_score_at_entry`,
`slippage_model_pct`, etc.) by M5/M6. `**riskPerTradePct` and `allocatedCapital` are new
config/params** — see Conflicts.

## M4 contract handoff

### `bot-shared-maintainer` adds to `packages/shared` (serial, first)

New enums under `src/enum/` (barreled from `src/enum/index.ts`), carrying **no money** —
these are persisted vocabulary read by M8/M9/M10:

1. `**RejectReasonEnum`** — the full list in §1 (22 values). Drives `decisions.reason` for
  gate rejections.
2. `**RiskOutcomeEnum**` — `{ APPROVED='approved', REJECTED='rejected' }`.
3. `**OrderIntentActionEnum**` — `{ OPEN='open', ADD='add', REDUCE='reduce',
  CLOSE='close', FLATTEN='flatten' }`. Note it extends` SignalActionEnum`'s order verbs  with` FLATTEN`(kill-switch) and drops`SKIP`(a skip never becomes an intent). Keep it  a **separate enum**, not a reuse of`SignalActionEnum`, because the two vocabularies  diverge (`skip`vs`flatten`).

No new shared interfaces, schema, or utils. `IOrderIntent` / `IRiskDecision` /
`IExposureReservation` / the ports are **engine-internal** (they carry `MoneyValue`).
`strategyParamsSchema` gains **two new keys** only if the main session approves the
sizing-param conflict below (`risk_per_trade_pct`, `daily_loss_limit` / `weekly_loss_limit`
are candidates — see Conflicts; flagged, not silently added).

### `bot-engine-nestjs` builds in `apps/engine/src/risk`

1. `risk/interface/` (+ barrel): `IOrderIntent.ts`, `IIntentSizing.ts`, `IRiskDecision.ts`,
  `IExposureReservation.ts`, and the ports `IRiskStatePort.ts`, `IOpenPositionsPort.ts`,
   `IReservationLedgerPort.ts`, `IInstrumentPort.ts`. Engine-internal; `MoneyValue`-typed.
2. `risk/const/riskConsts.ts` (+ barrel): `RESERVATION_TTL_MS`, the stress OI/funding/
  spread/depth thresholds, tier spread ceilings (0.15/0.30/0.50%), `MAX_LEVERAGE=3`,
   `FUNDING_SIZE_CUT_FACTOR=0.5`, `FUNDING_ANNUALIZED_SUPPRESS_PCT=30`,
   `COOLDOWN_AFTER_LOSS_MS`. No inline magic numbers.
3. `risk/service/RiskGateService.ts` — the synchronous gate (§1, §2): the ordered check
  pipeline, slot assignment (§4), reservation ledger ops (§3), returns `IRiskDecision`.
4. `risk/service/PositionSizer.ts` — pure decimal sizing (§8).
5. `risk/service/StressHaltEvaluator.ts` — §6 (snapshot fields → halt verdict, overrides
  ADX), updates `risk_state.is_halted/halt_reason`.
6. `risk/service/SlotManager.ts` (or fold into the gate) — §4 assignment + same-bar buffer
  flush. The **bar-window buffer + flush** wiring sits in the orchestrator
   (`StrategyService`) since it owns the per-event entry point and the clock.
7. `RiskStateRepository` gains `sumRealizedPnlSince(dateString)` and an `upsertDay(...)`
  (idempotent on `uq_risk_state_date`).
8. `StrategyService` change: after `evaluate()`, build `IOrderIntent` (with `PositionSizer`
  output), buffer correlated opens by bar (§4) or call the gate for idiosyncratic /
   de-risking intents, stamp the gate verdict onto the snapshot (`position_slot`,
   `active_positions_count` now real), persist the decision with `action` +
   `reason=rejectReason`, and on approval emit `order.intent.approved` (the M5 seam — no
   exchange call in M4).
9. QA: unit-pin the 3-slot cap and the BTC-correlated-1 cap independently; the same-bar
  single-candidate selection (N correlated candidates → 1 approved, N-1
   `btc_correlated_not_best_candidate`); each overtrading cap blocks the (N+1)th; daily &
   weekly windows on synthetic `risk_state`; SL-inside-liquidation; mandatory time-stop
   reject; stress overrides ADX; reduce/close pass through the gate and release
   reservations; no reservation leak across approve→fail→release; sizing respects
   step/min-notional/3× with an injected clock for determinism.

## Conflicts surfaced (for the main session)

1. **Sizing inputs absent from params/config.** The brief's sizing formula needs
  `riskPerTradePct` (default 1%) and an `allocatedCapital` figure; neither is in
   `strategyParamsSchema` nor a known config key. The daily/weekly loss limits and the
   per-coin / same-direction exposure caps are likewise unspecified as concrete numbers.
   **Resolution proposed:** these are **operator-level risk config**, not strategy params
   (they are not part of "the strategy"), so they belong in engine config / `riskConsts`
   keyed by environment (restricted-live vs testnet), NOT in `strategy_versions.params`.
   This keeps "all risk lives outside the strategy" honest. If instead the team wants them
   per-version-comparable, they go in `strategyParamsSchema` (shared) — that is a schema
   change requiring `bot-shared-maintainer`. **Flagged for the main session to choose**
   before the engine builds sizing.
2. `**risk_state` has no `weekly` or `consecutive_loss` column.** Resolved without a
  migration: weekly is a rolling sum over daily rows (§5); consecutive-loss is derived
   from today's closed `positions`. No schema change needed. Flagged so reviewers do not
   expect new columns.
3. `**decisions.reason` mixes two vocabularies** (`SkipReasonEnum` from M3,
  `RejectReasonEnum` from M4) in one `varchar`. Resolved by `decisions.action`
   disambiguating: `skip`→skip reason, `open/add/...`+`outcome rejected`→reject reason.
   No column split. Flagged so M8 queries group on `(action, reason)`.
4. **Tier-3-not-validated gate needs a "validated" flag.** `TIER3_NOT_VALIDATED` requires
  knowing whether the active version is validated for tier-3 live. No such field exists
   on `strategy_versions` (`status ∈ draft|active|archived`). **Resolution proposed:** gate
   on a `riskConsts`/config allow-list of validated tier-3 version ids for live, defaulting
   to empty (reject all tier-3 live). Flagged — a `strategy_versions` column is an
   alternative the main session may prefer.

## Alternatives considered

- **Risk subscribes to a `signal.produced` event (async).** Rejected: the gate's verdict
must land on the same `decisions` row, same-bar candidate selection needs ordered
batching, and replay must be deterministic — an event bus adds non-deterministic delivery
ordering. Synchronous in-process call (§1).
- **Reservation ledger as a DB table.** Rejected: reservations are transient (seconds), the
durable exposure source is `risk_state` + open `positions`, the process is single-instance
always-on, and a restart must reconcile against the exchange (M6) not replay stale
reservations. In-memory with an M6 reconciliation backstop (§3).
- **Decide the single BTC-correlated candidate from one event in isolation.** Rejected:
signals arrive per-symbol-per-bar; you cannot know the best of the bar from one event.
Buffer correlated opens per bar window, flush at the deterministic bar-close boundary
sorted by `signalScore` (§4).
- **ISO calendar week for the weekly limit.** Rejected: the brief locks *rolling 7 days*;
ISO weeks reset mid-streak. Rolling sum over the last 7 daily `risk_state` rows (§5).
- **Trust ADX's "ranging" label for mean-reversion eligibility.** Rejected outright: ADX
lags and labels a market "ranging" exactly as a trend initiates. The M1 fast-stress
inputs lead it and override it (§6).
- **Read the clock / DB inside the gate's decision logic.** Rejected: destroys
determinism and breaks "same code live and backtest." `nowMs` and all state arrive via
injected ports (§7), exactly as the strategy gets `nowMs` (ADR 0003 §1).
- **Bump sub-min-notional sizes up to the exchange minimum.** Rejected: that exceeds the
per-trade risk budget. Below-min trades are skipped, not inflated (§8).
- **Put `IOrderIntent` / `IRiskDecision` in `packages/shared`.** Rejected: they carry
`MoneyValue`; the dashboard reads the persisted `decisions`/`positions` rows. Only the
money-free vocabulary enums go shared — same rule as ADR 0003 §2.

## See also

- `docs/plans/M4-risk-management.md` (milestone brief), `docs/plans/00-overview.md`
(locked decisions, data model, RiskModule paragraph)
- `docs/architecture/adr/0003-strategy-engine.md` (`ISignal`/`IProposedExit`/`nowMs` the
gate consumes), `0002-persistence-and-data-model.md` (`risk_state`/`positions`/`decisions`
schema + shared-enum placement rule), `0001-exchange-and-market-data.md`
(`IVolatilityDetectedEvent` fast-stress fields, closed-bar rule)
- `docs/best-practices/code-conventions.md` (constants placement, enums, control flow,
decimal money — authoritative)

