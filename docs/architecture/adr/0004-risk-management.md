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
  **(M21 supersedes — see §6c.)** Both index legs now evaluate on the **5m** horizon
  (`btc_5m_move_pct` / `eth_5m_move_pct`); `btc_1m_move_pct` has **exited the stress-halt
  contract** and is no longer a stress input. It stays on the snapshot for
  telemetry/idiosyncrasy only.
- `market_breadth_5m_up_pct` — breadth collapse/surge.
- `same_bar_trigger_count` — universe-wide simultaneous triggering.
- `open_interest_change_5m_pct` — OI shock.
- `funding_rate_annualized` — funding extreme.
- `bid_ask_spread_pct` — spread-widening (market-wide liquidity-shock proxy).

> **M19 amendment — `book_depth_10bps_usdt` is no longer a global stress input.**
> Book depth is a **per-coin property**, not a market-wide signal. Wiring it into the
> global halt meant the first thin tier-2 alt to trigger on a UTC day flipped
> `risk_state.is_halted=true` and rejected every subsequent signal that day — even
> deep-book tier-1 majors — as `global_halt`. Depth is therefore removed from the
> stress-input list above and re-homed as a per-coin eligibility guard (§6a). The
> global liquidity-shock signal that remains is **spread widening** (a market-wide
> spread blowout is genuinely systemic and still halts).

Thresholds are the existing risk-only params (`stress_btc_1m_shock_pct`,
`stress_eth_1m_shock_pct`, `stress_same_bar_trigger_count`) plus named `riskConsts` for
the OI/funding/spread limits and the breadth-halt distance (`STRESS_BREADTH_DISTANCE_PCT`,
see §6b) — no inline magic numbers, per conventions §"Constants Placement".

> **M21 supersedes the index-shock thresholds in this paragraph — see §6c.** The two
> index legs are no longer threshold-driven by `stress_btc_1m_shock_pct` /
> `stress_eth_1m_shock_pct` (now **deprecated** strategy params). The active, authoritative
> index-shock thresholds are the engine consts `STRESS_BTC_5M_SHOCK_PCT = 1.5` and
> `STRESS_ETH_5M_SHOCK_PCT = 2.5`, both on the 5m horizon. `stress_same_bar_trigger_count`
> and the OI/funding/spread/breadth thresholds in this paragraph are unchanged.

**Override rule (locked):** when stress indicates trend-initiation, the gate **rejects
mean-reversion entries with `MARKET_STRESS` regardless of the ADX/`regime_label`
"ranging" verdict.** ADX is lagging and labels a market "ranging" exactly as a new trend
begins; the fast-stress inputs lead it. The stress check sits **before** any
regime/slot logic in the pipeline (§2), so it short-circuits ahead of ADX-derived
eligibility. The halt is recorded on `risk_state` (`is_halted=true`,
`halt_reason='market_stress'`) and is visible to M9 (Telegram alert).

### 6a. Book depth — per-coin eligibility guard, NOT a global halt (M19)

`book_depth_10bps_usdt` is enforced as a **per-coin, tier-keyed eligibility skip** inside
the per-coin tier-filter group (`firstFailingTierFilter`), adjacent to the spread-ceiling
check. It runs **after** the halt checks, so it can only skip the one thin coin — it can
never persist a halt or block other coins for the rest of the day.

> **M22 amendment — floors recalibrated to book-consumption anchor (2026-06-04).**
> The M19 floors (`{ tier1: 20_000, tier2: 10_000, tier3: 5_000 }`) were conservative
> round numbers, explicitly not derived from a depth-vs-slippage relationship. After the
> M19/M20/M21 halt miscalibrations were fixed and the soak produced trade-flow evidence,
> M22 replaces them with **book-consumption-ratio-anchored** floors. The correct anchor:
> the floor is chosen so a max-size order (up to `MAX_EXPOSURE_PER_COIN_USDT = 250`)
> consumes a **small, bounded fraction** of the **one-sided** resting 10bps book.

- **Floors (risk-only const, computed enum keys) — M22 values (authoritative):**
  ```
  COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
      [CoinTierEnum.TIER_1]: 10_000,
      [CoinTierEnum.TIER_2]:  2_500,
      [CoinTierEnum.TIER_3]:  2_000,
  }
  ```

  **Book-consumption ratios (one-sided, $250 max order):**

  | Tier   | Floor   | Consumption | Entry-slippage hint |
  |--------|---------|-------------|---------------------|
  | tier1  | $10,000 | 2.5%        | ~conservative       |
  | tier2  |  $2,500 | 10%         | ~2 bps              |
  | tier3  |  $2,000 | 12.5%       | ~2.5 bps            |

  All ratios are against the **one-sided** resting 10bps book (`book_depth_10bps_usdt` is
  assumed to be **one-sided** resting notional within 10bps of mid (see ADR 0001 line 289;
  the 14-day post-deploy fills will confirm the actual measurement direction)). Note: many fills
  land **below** $250 after funding halving and sizing; using the cap as anchor is
  **conservative** (actual book consumption is lower).

  **Per-tier rationale:**
  - **tier1 $10,000** is non-binding for any genuine tier1 coin (BTC/ETH 10bps depth is
    hundreds of thousands of USDT). It filters volume-mis-ranked tier1 impostors (e.g.,
    coins ranked tier1 by 24h volume despite books in the $500–$5,000 range). This is a
    cheap defence against the volume-only tier-ranking weakness (MEDIUM tech-debt). A
    $5,000 tier1 floor would pass a $5,380-depth impostor; $10,000 does not.
  - **tier2 $2,500** (~10% one-sided, ~2bps entry) corrects the incoherence in the M19
    floors, where tier2 was held to tier1 strictness ($10,000 = 2.5% consumption identical
    to the new tier1 floor). There is no reason a tier2 coin should face the same depth bar
    as a tier1 major.
  - **tier3 $2,000** holds consumption at ~12.5% one-sided (~2.5bps entry), keeping a
    margin against the exit-gap risk that the entry-depth metric does not measure. A $1,000
    floor would yield ~25% one-sided (~5bps entry), and tier3 alts are exactly the coins
    whose books evaporate on a stop-loss exit. `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` is the
    only reactive backstop for exits; the floor is the only proactive guard at entry.

- **Soak evidence (2026-06-04, 10 `coin_book_too_thin` rejections):**
  - **7 unblocked** at the new floors: observed depths **$3,468–$9,174** — tier1/tier2
    coins with real books that the M19 floors over-rejected at 4–80× the $250 max order
    size.
  - **3 still blocked** at the new floors: observed depths **$529, $681, $2,321** —
    genuinely illiquid; correctly rejected under both old and new floors.
  This is one calm day (n=10) — sufficient to prove the M19 floors were overcautious; not
  sufficient to prove the new floors optimal. The 14-day post-deploy slippage telemetry
  below is the mandatory re-calibration step before any scale-up.

- **Reject reason:** `coin_book_too_thin` (`RejectReasonEnum.COIN_BOOK_TOO_THIN`) — a
  per-coin skip, distinct from `market_stress`. The decision funnel and dashboard
  reject-reason tooltip surface it so operators do not misread a thin-coin skip as a halt.

- **Boundary rule (explicit, locked):** depth **at** the floor is rejected — the
  comparison is `depth <= floor` (`new Money(depth).lessThanOrEqualTo(floor)`). Depth
  exactly at the floor → `coin_book_too_thin`. Depth one cent above → passes this guard.
  This is the **opposite** boundary convention from the spread ceiling, which uses strict
  `>` (spread exactly at the ceiling passes). The two are intentionally asymmetric: a book
  exactly at the depth floor is "not deep enough"; a spread exactly at the ceiling is "not
  too wide yet".

- **One-sided measurement (operator-calibration note, locked):** all floors and
  book-consumption ratios in this section are computed against the **one-sided** resting
  10bps notional (`book_depth_10bps_usdt`). An operator cross-checking these ratios
  against a two-sided order-book view will see approximately double the depth — the
  consumption percentages will look half as large. Use the one-sided figure.

- **Fail-closed (locked):** invalid, missing, empty, unparseable, non-positive depth, or
  an unknown `coinTier`, all resolve to **too-thin → reject** (`coin_book_too_thin`). The
  guard mirrors `isSpreadTooWide`'s `Number.isFinite` defense: it never throws out of the
  gate and never passes-open on bad input. Bad depth data can only cost a single skip,
  never an erroneous fill.

- **14-day post-deploy slippage-telemetry requirement (mandatory calibration condition).**
  For 14 days after the M22 engine restart, record (read-only):
  - Per-fill `book_depth_10bps_usdt` at entry (`decisions.market_snapshot`).
  - Realized entry and exit slippage (`positions`).
  Watch for fills where **realized slippage > modeled** — those signal the floor was set
  too low for that tier. Track near-miss bands per tier (depths just above each new floor).
  **Re-calibrate the floors against the realized-slippage distribution before any scale-up
  — not against another short calm soak.** The tech-debt items this telemetry informs:
  - **Volume-only tier ranking (MEDIUM):** coins ranked by 24h volume may be mis-ranked
    tier1 despite thin books; the $10k tier1 floor defends the symptom, not the ranking.
  - **Entry-vs-exit depth gap (MEDIUM):** `book_depth_10bps_usdt` measures entry liquidity
    and does not proxy exit liquidity. A coin can pass entry and gap on stop-loss exit when
    its book thins. `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` is the only reactive backstop;
    real fills from M22's 14-day window begin sizing the eventual exit-liquidity-aware fix.

### 6b. Breadth halt — risk-only distance const, decoupled from the flow-routing param (M19)

The breadth-collapse **halt** fires when breadth is far from the neutral midpoint:

- `MARKET_BREADTH_NEUTRAL_PCT = 50` — neutral midpoint of the 0–100 breadth scale.
- `STRESS_BREADTH_DISTANCE_PCT = 40` — halt distance from neutral. The halt fires when
  `|market_breadth_5m_up_pct − 50| >= 40`, i.e. at breadth **≤ 10** (broad selloff) or
  **≥ 90** (broad melt-up).

This **replaces** the previously dead test that read the `stress_breadth_pct` strategy
param (=70) as a distance: because breadth is 0–100, the max possible distance from 50 is
50, so `|breadth − 50| >= 70` could **never** fire. The breadth halt was permanently dead
until M19.

> **Decoupling — DO NOT re-couple (locked).** `STRESS_BREADTH_DISTANCE_PCT` (risk-only
> const, =40) and `stress_breadth_pct` (strategy param, =70) are **two different knobs
> with two different meanings**, and they must stay separate:
> - `STRESS_BREADTH_DISTANCE_PCT` is a **risk-gate halt distance** — how far breadth must
>   stray from neutral before the gate halts the whole market.
> - `stress_breadth_pct` is a **strategy-signal threshold** consumed by
>   `classifyFlowType()` (ADR 0003) to route `MARKET_BETA` flow. It is unchanged by M19.
>
> They once shared a name and a numeric source. Re-seeding the param 70→30 to "fix" the
> halt would have silently changed `MARKET_BETA` flow classification — a strategy-signal
> change masquerading as a risk fix. A future reader must **not** merge these back into a
> single value or read the param inside the breadth halt. The halt reads the const; flow
> classification reads the param; neither sees the other.

Both §6a and §6b are **code-only** — the floors and the breadth distance are `riskConsts`,
not `strategy_versions.params`. M19 writes nothing to the DB (no migration, no params
re-seed).

### 6c. Index-shock horizon alignment — both legs on the 5m window (M21)

**This subsection supersedes the §6 index-shock threshold bullets.** Where §6 (and its
threshold paragraph) still describe `stress_btc_1m_shock_pct` against `btc_1m_move_pct` as
the active BTC shock path, **that description is stale**. The active index-shock contract is
the one defined here. M21 is **code-only and migration-free** (a const swap, an evaluator
field swap, and deprecation comments — no DB write, no schema change; an engine restart picks
it up).

**Both index legs now evaluate on the 5-minute horizon (authoritative active thresholds):**

- **BTC:** `isIndexShock` reads `btc_5m_move_pct` against the engine const
  `STRESS_BTC_5M_SHOCK_PCT = 1.5`.
- **ETH:** `isIndexShock` reads `eth_5m_move_pct` against the engine const
  `STRESS_ETH_5M_SHOCK_PCT = 2.5` (raised from 2.0).

Both are **engine-side `riskConsts`** (operator-level risk config, outside the strategy),
**not** strategy params. Before M21 the two legs measured different time windows (BTC on 1m,
ETH on 5m) — a structural inconsistency that also left the BTC leg empirically inert. Aligning
both to 5m removes that inconsistency.

**Calibration evidence (5-day M19/M20 paper soak):**

- **BTC 1m leg never fired in 5 days.** Observed peak `btc_1m_move_pct` was **0.56%** —
  only 56% of the old 1.0% floor. The 1m BTC leg was **empirically inert** as a stress signal
  at that granularity. Moving BTC to 5m @ 1.5% is therefore **activating a previously dead
  sensor**, not loosening a working halt — expect *more* BTC-driven index halts on volatile
  macro/liquidation weeks; that is the intended trade, not a regression.
- **BTC 5m peak was 1.04%.** The new `STRESS_BTC_5M_SHOCK_PCT = 1.5` sits well above observed
  normal-market movement, giving a real buffer while still catching a genuine index shock. On
  the compressed post-ETF vol regime a ~1.5% rolling-5m BTC move is multi-σ — genuine stress,
  not microstructure noise. It is a **reasonable first cut on five calm days, not a proven
  optimum** (hence the post-deploy telemetry below).
- **ETH only observed near-event was 2.12%** (a single occurrence in 5 days). The old 2.0%
  floor classified that one-off as stress (a false positive); **2.5% lifts the gate above it.**
  Per ETH's ~1.2–1.5× short-horizon beta to BTC, a beta-consistent ETH floor against BTC 1.5%
  lands ~**1.8–2.25%**, so 2.5% is **slightly conservative** — appropriate given the penalty is
  a **full UTC-day halt** of all mean-reversion entries. The breadth halt (§6b) backstops the
  same class of market-wide event.

**Inclusive `>=` boundary (locked).** Both legs use `>=`: `Math.abs(move) >= threshold` →
stressed. **At exactly the const → stressed; just below → silent.** QA must use this same
boundary as the existing ETH tests (e.g. `btc_5m_move_pct = 1.5` → stressed; `= 1.49` →
silent; `eth_5m_move_pct = 2.5` → stressed; `= 2.49` → silent).

**Rolling-window measurement, NOT candle close-to-close (operator-calibration note).**
`btc_5m_move_pct` / `eth_5m_move_pct` are the **rolling N-minute tape move at bar-close**
(sourced from `MarketContextService.referenceMove`, 5m window) — the **same rolling-window
semantics the idiosyncrasy numerator uses at trigger time**. They are **not** OHLC
close-to-close candle returns. An operator calibrating these floors from a candle chart will
misread the observed peaks (1.04% / 2.12%) unless they read the rolling-window move, not the
candle body.

**`btc_1m_move_pct` exits the stress-halt contract entirely.** It **remains on the snapshot**
for telemetry and idiosyncrasy use, but it is removed from **both** `isIndexShock` **and**
`hasInvalidStressInputs`. There is no longer any stress-halt consumer of the 1m BTC field. A
future engineer must **not** "restore" it into the stress gate without first wiring a genuine
consumer and a calibrated threshold. Correspondingly, the `stress_btc_1m_shock_pct` and
`stress_eth_1m_shock_pct` **strategy params are deprecated** (annotated in
`strategyParamsSchema.ts`, **not removed**): the keys are retained and stay validated/readable
so historical replay and backtest fixtures do not error on them.

**Atomicity (fail-closed guarantee, locked).** `hasInvalidStressInputs` (the fail-closed
NaN/non-finite guard) and `isIndexShock` were changed in the **same commit** (M21). The guard
moved its BTC check from `btc_1m_move_pct` → `btc_5m_move_pct` atomically with the
`isIndexShock` field swap. This closes the window in which a NaN/garbage `btc_5m_move_pct`
could flow into `isIndexShock` while the guard still watched the (now unused) 1m field — the
gate would otherwise have silently stopped failing closed on a malformed BTC 5m value. The QA
wave pins this with a `NaN btc_5m_move_pct → halts via hasInvalidStressInputs` test that fails
if either edit is dropped.

**Flash-crash sub-minute blind spot — accepted deferral (MEDIUM tech-debt).** A spike that
blows out and recovers **within** a 5-minute window is invisible to the 5m gate. This is a
**conscious deferral**, not an oversight: the 1m leg it replaces was empirically
non-functional (never fired in 5 days, peak 0.56%), and **spread-widening (§6) plus the
same-bar trigger count are better fast-stress proxies** for genuine microstructure shock.
Logged as **MEDIUM tech-debt** for a future dedicated fast-stress signal — not a go-live
blocker.

**Post-deploy calibration telemetry (14-day near-miss band monitoring).** BTC 1.5% is a
first cut on calm data, so for **14 days** after deploy, track (read-only) the daily max
`|btc_5m_move_pct|` and `|eth_5m_move_pct|` from `decisions.market_snapshot` and count
index-leg halts. Watch the near-miss bands `|btc_5m| ∈ [1.2, 1.5)` and `|eth_5m| ∈ [2.0, 2.5)`.
If the BTC leg fires on days with **no** concurrent breadth/OI/spread co-stress (a sign of
remaining miscalibration), revisit the floors **before any cloud-soak scale-up** — and revisit
against that distribution, not another short calm soak. Next BTC adjustment band:
**1.75–2.0%** if it fires too often, **1.25%** if it stays too quiet (but not below soak peak +
epsilon without longer telemetry). **Do NOT re-tighten ETH toward 2.0%** — that repeats the
soak failure mode the ETH 2.5% floor exists to fix.

### 6d. Breadth-stress adaptive auto-resume (M23)

**This subsection adds an adaptive auto-resume to the §6 market-stress halt; it does not
change any engage semantics in §6/§6b/§6c.** Before M23 every `market_stress` trip was a
full-UTC-day lock (`firstFailingHaltCheck` returns the day-halt early return on every
subsequent tick until UTC rollover). M23 shortens that lock for **breadth-triggered** stress
halts only, replacing the day-lock with a consecutive-clean-tick auto-resume gated by
hysteresis and a per-day re-halt cap. M23 is **code-only and migration-free** — no schema
change, no new column; `halt_reason` carries a richer string in the existing varchar, and the
counters are in-memory. An engine restart picks it up.

**Scope (locked).** Auto-resume applies to **breadth-sole** `market_stress` halts and nothing
else:

- **Eligible:** a halt whose sole engaging global leg is breadth collapse/surge.
- **Full-day locked (unchanged):** BTC 5m shock, ETH 5m shock, OI shock, funding extreme,
  market-wide spread blowout, same-bar trigger saturation, NaN fail-closed engage, and any
  snapshot where two or more global legs engage together. **(M28 supersedes the `same_bar` entry —
  same-bar saturation became resume-eligible; see §6e.)**
- **Out of scope entirely (full-day lock unchanged):** loss-based halts —
  `consecutive_loss_halt`, `daily_loss_limit`, `weekly_loss_limit`, `model_divergence_halt`.
  These never auto-resume regardless of clean-tick count; a cooling-off to UTC rollover is the
  deliberately conservative shape for a persistent-edge problem.

The survival-first rationale: auto-resume *loosens* the penalty, so it applies only when the
cause is unambiguously the single fast mean-reverting signal (breadth). Breadth
(`market_breadth_5m_up_pct`) is a count statistic — the fraction of tracked coins up over 5m —
that can collapse to single digits on a momentary correlated flush and recover within minutes;
the day-lock is the wrong shape for it. Every other leg is slower or trendier (or had zero
events in the calibration dataset), so it keeps the day-lock.

**`halt_reason` canonical encoding (locked — single source of truth).** `risk_state.halt_reason`
is a free-form varchar already written by `persistHalt`. M23 extends the written value to carry
the trigger leg as a colon-suffix. `persistHalt` writes exactly one of these strings, and the
resume branch parses exactly these strings — engage writer, resume parser, and alert/telemetry
vocabulary stay in sync:

| `halt_reason` value | Trigger leg | Resume policy |
|---------------------|-------------|---------------|
| `market_stress:breadth` | breadth collapse/surge, **sole** engaging global leg | **resume-eligible** |
| `market_stress:btc_shock` | BTC 5m index shock (§6c) | full-day lock |
| `market_stress:eth_shock` | ETH 5m index shock (§6c) | full-day lock |
| `market_stress:oi` | OI 5m shock | full-day lock |
| `market_stress:funding` | funding extreme | full-day lock |
| `market_stress:spread` | market-wide spread blowout | full-day lock |
| `market_stress:same_bar` | `same_bar_trigger_count` saturation | **resume-eligible (M28 — see §6e)** |
| `market_stress:invalid` | NaN fail-closed engage | full-day lock (conservative) |
| `market_stress:multi` | **two or more** global legs on the same snapshot | full-day lock |
| `market_stress` (bare, legacy) | written before M23 | full-day lock (fail-safe) |

**Leg-classifier completeness and multi-leg precedence (locked).** The classifier that produces
the suffix MUST enumerate **every** engage path in the `isStressed()` disjunction — invalid
inputs, BTC 5m shock, ETH 5m shock, breadth, `same_bar`, OI, funding, spread — so no engage is
silently misclassified. It returns a **single canonical suffix** per the
**most-conservative-leg-wins** rule: tag `:breadth` **or** `:same_bar` (both resume-eligible since
M28 — see §6e) **only when that leg is the sole engaging global leg**; if it engages alongside any
other global leg on the same snapshot, tag `:multi` (full-day lock). **Fail-safe parse (M28
update):** the recognised **resume-eligible** suffixes are `{ :breadth, :same_bar }`. Any
`market_stress` reason whose suffix is not in that set — `:multi`, `:invalid`, every other
single leg (`:btc_shock`, `:eth_shock`, `:oi`, `:funding`, `:spread`), and the legacy bare
`market_stress` — defaults to full-day lock (unknown/non-eligible suffix → no auto-resume). This
preserves backward compatibility with rows already in the soak DB.

**No-double-prefix contract (locked — restore/flag round-trip).** `risk_state.halt_reason` is the
single source of truth and stores the full string `market_stress:<leg>`. The in-memory halt flag
must round-trip that string cleanly:

- **`HaltStateRestoreService` passes the persisted reason as-is** to `haltFlag.halt(...)`. When the
  reason already begins with the source token (`market_stress:`), restore does **not** re-concatenate
  `source:reason`. The in-memory flag therefore reads `market_stress:breadth`, identical to the
  persisted row — never the corrupt `market_stress:market_stress:breadth`.
- **`resolveProgrammaticSource` keeps splitting on the first colon** (unchanged): prefix
  `market_stress` → `HaltSourceEnum.MARKET_STRESS`; the suffix is ignored for source resolution.
- **`HaltFlagService.haltedLeg` holds the bare leg token** (`breadth`), parsed from the suffix —
  not the full string. `getHaltedLeg()` returns `breadth`, never `market_stress:breadth`. The full
  reason stays available via the existing reason accessor. `haltedLeg` is set on `halt()` and cleared
  on `resume()` (Command-Query Separation preserved — `halt`/`resume` stay state-changers; the new
  `getHaltedLeg()` is a query).

**Resume predicate — `isGlobalStressed()` (breadth-only + NaN fail-closed).** A new method on
`StressHaltEvaluator`. It checks **only the global breadth leg** at the **resume** threshold
(`|breadth − 50| > MARKET_STRESS_RESUME_BREADTH_DISTANCE`), distinct from the full `isStressed()`
disjunction. It preserves NaN fail-closed: a non-finite `market_breadth_5m_up_pct` (or, for safety,
the BTC/ETH 5m fields the engage path also reads) is treated **as stressed** → counter reset.
Funding and per-coin spread remain at the per-entry eligibility gate (`FUNDING_SUPPRESSED`,
`SPREAD_TOO_WIDE`) and play **no** role in auto-resume — reusing the full disjunction would let a
single coin's funding/spread perpetually reset the counter even though the global breadth cause
cleared, so the bot would never resume.

**Hysteresis — engage ≠ resume threshold (locked).** Engage and resume thresholds differ so the
gate does not chatter at the boundary:

- **Engage (unchanged, §6b):** halt when `|breadth − 50| >= STRESS_BREADTH_DISTANCE_PCT (40)` —
  breadth `<= 10` (collapse) or `>= 90` (surge).
- **Resume:** require breadth back inside the inner band
  `|breadth − 50| <= MARKET_STRESS_RESUME_BREADTH_DISTANCE (30)` — breadth in **[20, 80]**.
- **Hysteresis buffer:** a reading in the gap `(10, 20)` or `(80, 90)` is below the engage
  threshold but **not** clean enough to count toward resume — it does **not** advance the counter
  (it resets it). This 10-point gap on each side is the buffer.

**Consecutive-clean-tick confirmation (locked).** An in-memory consecutive counter on
`RiskGateService`, incremented on a clean global tick (breadth in the inner band) and **reset to 0**
on any non-clean tick, NaN fail-closed, or stress recurrence mid-window. It is **not** persisted; on
restart it resets to 0 (conservative — one fresh full confirmation cycle is required before resume).
The confirmation count is `MARKET_STRESS_RESUME_CLEAR_TICKS = 3`. **N = 3 is a configurable starting
point, NOT a validated calibration** — the original 3 was sampled at fixed +5/+10/+15m offsets on a
6-day, single-regime, zero-out-of-sample dataset and does not demonstrate 3 *consecutive* clean
bars. A proper per-bar consecutive-clean-bars-until-next-breach analysis with a held-out sub-period
is owed (logged as tech-debt); operators tune N against the post-deploy paper soak.

**Per-day re-halt cap (locked).** `MARKET_STRESS_MAX_DAILY_REHALT = 3`. Chatter is itself a regime
signal. Track the per-UTC-day breadth re-halt count; on the **3rd** breadth re-halt in one UTC day,
the gate **falls back to the full-day lock** for the remainder of that day (auto-resume disabled,
the halt persists to rollover exactly like a loss halt). The counter is in-memory and resets at UTC
rollover (same lifecycle as the existing `stressEmittedForDate` dedup).

> **Restart quirk (accepted and documented).** The re-halt counter is in-memory only, so a mid-day
> restart resets it to 0: a process that already hit the cap and fell back to the full-day lock will,
> after a restart, restore the persisted halt (still locked) but begin counting re-halts afresh —
> a known **more-permissive** quirk. M23 accepts it rather than persisting the counter, because
> (1) the persisted day row is still `is_halted=true`, so a capped+restarted process resumes locked
> and must re-earn a resume through the full clean-tick + hysteresis path before it can re-halt at
> all; (2) there is no migration-free place to persist a counter (no JSON/metadata column on
> `risk_state`); (3) restarts are rare operational events, not a tape-driven exploit. Persisting
> `stress_rehalt_count` is logged as **LOW tech-debt**, to land with the `risk_state.updated_at`/
> metadata work rather than a varchar hack now. The clean-tick counter resetting to 0 on restart is
> conservative in the **other** direction — net restart story: locked stays locked, resume requires
> a fresh confirmation cycle, only the chatter-cap headroom is loosened.

**Branch placement (locked).** The resume evaluation is inserted in `firstFailingHaltCheck`
**before** the `state.today.isHalted` day-halt early return at line 459. That early return
short-circuits before `isStressed()` ever runs, so the resume branch cannot live after it. The
branch reads the persisted `halt_reason`:

- `isHalted && halt_reason starts with 'market_stress' && leg == breadth` → run `isGlobalStressed()`
  resume evaluation. On a successful resume, clear the persisted day-halt (see below) and **continue
  to the fresh `isStressed()` engage check** so a same-tick re-stress can immediately re-halt and bump
  the re-halt counter.
- `isHalted && halt_reason starts with 'market_stress' && leg != breadth` → keep the existing
  `GLOBAL_HALT` early return (non-breadth stress stays full-day locked).
- `isHalted && halt_reason is a loss-based reason` → keep the existing `GLOBAL_HALT` early return.
  Loss halts never auto-resume.

**Clearing a resumed halt for the day (locked).** On a successful breadth auto-resume the gate marks
the day **not halted** so subsequent ticks do not re-trip the day-lock early return. This reuses the
existing `upsertDay` path (the inverse of `persistHalt`): write `is_halted=false, halt_reason=null`
for the UTC day, **preserving** the PnL/exposure/trade counters (mirror `emptyDay`'s
field-preservation discipline). Idempotent on the UTC-day key, replay-safe.

**`stressEmittedForDate` dedup interaction (M1, locked).** After a successful auto-resume the gate
must **reset `stressEmittedForDate` to `null`** so a same-day re-halt after resume still fires a
fresh `RISK_HALT_TRIGGERED` event. Without this reset the dedup would suppress the re-halt alert
once `is_halted` was cleared by the resume.

**`MARKET_STRESS_AUTO_RESUME_ENABLED` boot flag (locked — code-level rollout gate).** A boolean env
config gating the entire resume branch. When `false`, `firstFailingHaltCheck` keeps the pre-M23
day-lock for **all** stress halts (M23 is inert — identical to pre-M23 behaviour); when `true`, the
breadth auto-resume branch runs. **Default is derived from `EXCHANGE_ENV`, fail-safe to off:** ON in
**paper**, OFF in **live**. Live can only enable auto-resume by an **explicit** operator override
after the live-activation gates below pass — a deliberate second action, never an accidental
inheritance from a paper deploy. The flag is read **once at boot** (constant within a run), so it
does not touch the determinism invariant: within a run it is constant, and a backtest sets it
explicitly.

**In-process tick counting, not cron (determinism note).** The clean-tick counter advances
in-process on each decision tick that reaches the gate — never a wall-clock timer or scheduler.
Given the same ordered sequence of snapshots, the resume decision is identical in live and backtest.
"Tick" means a gate evaluation; N consecutive clean **gate evaluations** in the inner band trigger
resume. **Operator-facing note:** decision cadence is ~5m-aligned to the breadth field, so
`N = 3` ≈ ~15 minutes of confirmation — but the mechanism counts **ticks, not minutes**, a
deliberate determinism choice.

**`MARKET_STRESS_RESUMED` event payload (locked).** On a successful auto-resume the gate emits a
`MARKET_STRESS_RESUMED` event (symmetric to `RISK_HALT_TRIGGERED`) carrying:
`{ clearCount, breadthAtResume, triggerLeg, dailyReHaltCount, utcDateString, nearReHaltCap }`. It
does **NOT** fire on a loss-halt clear or on operator resume — only on breadth auto-resume.

**Paper-first live-activation gates (locked).** In addition to the boot flag being explicitly
enabled, live activation requires **both**:

1. A `BacktestRunnerService` run over the soak window **with auto-resume enabled**, reporting trade
   count / win rate / profit factor / max drawdown specifically for trades **opened within 30 minutes
   of an auto-resume**. Negative expectancy in those windows → M23 does not go live (revert or raise N).
2. **14-day paper-soak** evidence of non-negative expectancy in the auto-resume windows, with a
   re-halt-cycle count that stays under the cap on most days.

The M21/M22 14-day slippage telemetry is still running; M23's gate composes with it — neither
unlocks live alone.

### 6e. Same-bar stress recalibration + auto-resume wiring (M28)

**This subsection (1) raises the `same_bar` engage threshold and moves it engine-side, and (2)
extends the §6d auto-resume mechanism to the `same_bar` leg. It does not change the breadth resume
path, the engage semantics of any other leg, or the §6d re-halt cap.** Like M21/M22/M23 it is
**code-only and migration-free** — no schema change, no shared-package change, no DB write at rest;
an engine restart picks it up.

**Why (calibration failure).** Before M28 the engage check was
`same_bar_trigger_count >= params.stress_same_bar_trigger_count` with the param seeded at **5**.
With a ~100-symbol universe, threshold=5 means a **5% co-trigger rate halts the whole UTC day** —
routine correlated behaviour in crypto, not a cascade. A 14-day soak makes the separation explicit:
routine days peak at 10–12 same-bar (Jun 6 ran 118 decisions, max 12, no harm), elevated correlated
sessions peak 26–30 (Jun 4/5), and the genuine cascade (Jun 7) peaked at **52** with avg 17.3 and
50% of bars hot. Threshold=5 cannot tell a 5% drift from a 52-symbol cascade.

**Engage threshold — move engine-side, raise to 20 (locked).** A new risk-only engine const
`STRESS_SAME_BAR_HALT_COUNT = 20` replaces the strategy-param comparison in `activeStressLegs`.

- **Decoupling (the key structural decision).** `stress_same_bar_trigger_count` is **also** read by
  `classifyFlowType` to route `MARKET_BETA` flow
  (`marketBreadth5mUpPct > stress_breadth_pct && sameBarTriggerCount >= stress_same_bar_trigger_count`).
  This is the identical coupling §6b called out for breadth and resolved by moving the halt
  threshold engine-side. **The halt reads the const; flow classification reads the param; neither
  sees the other.** The param **stays at 5** and remains consumed **only** by `classifyFlowType` —
  re-seeding it to fix the halt would silently change flow routing. Do not re-couple them.
- **Value = 20 (distribution-separated).** Above the routine ceiling (12) with an 8-count buffer;
  engages on the genuine cascade days (Jun 4/5/7 all peak > 20); ~20% co-trigger on ~100 symbols =
  a real market-wide pile-on. 15 rejected (only a 3-count buffer over Jun 6's calm max=12 — would
  mis-fire on a no-harm day). 25+ rejected (would miss the elevated Jun 4/5 sessions that *should*
  halt-then-resume). **Starting point, NOT a validated calibration** — same caveat as the breadth N;
  the 14-day post-deploy soak re-confirms or re-tunes it (tech-debt, alongside the breadth-N item).

**Auto-resume eligibility — `same_bar` joins `breadth` (locked).** §6d's
`MARKET_STRESS_RESUME_ELIGIBLE_LEG` (single `breadth`) becomes a set
`MARKET_STRESS_RESUME_ELIGIBLE_LEGS = { breadth, same_bar }`. The §6d `halt_reason` table row for
`market_stress:same_bar` flips from **full-day lock** to **resume-eligible**. Every other suffix —
`:multi`, `:invalid`, every other leg, bare legacy `market_stress`, and all loss-based reasons —
stays full-day locked (unchanged). Most-conservative-leg-wins is intact: a `same_bar`+anything
snapshot still classifies `:multi` and locks.

**Resume predicate — `isSameBarStillStressed()` (same_bar-only + multi-scalar NaN fail-closed,
locked).** A new method on `StressHaltEvaluator`, mirroring `isGlobalStressed`. It checks **only**
the `same_bar` leg at a **resume** threshold distinct from engage. **Malformed-snapshot precheck
(locked).** Before evaluating the leg count it fails closed on **any** non-finite consumed stress
scalar — not just `same_bar_trigger_count` — reusing the engage-side `hasInvalidStressInputs` scalar
set (`btc_5m_move_pct`, `eth_5m_move_pct`, `market_breadth_5m_up_pct`, `same_bar_trigger_count`,
`open_interest_change_5m_pct`, `funding_rate_annualized`, `bid_ask_spread_pct`). A snapshot with a
clean `same_bar_trigger_count` but a NaN elsewhere is treated **as stressed** (counter reset, no
resume, no event). Without this, the gate would clear a `:same_bar` halt on malformed data, emit a
spurious `triggerLeg='same_bar'` resume, advance the shared re-halt counter, then immediately
re-halt as `market_stress:invalid` — a misleading transition that also corrupts postmortem
attribution. `isGlobalStressed` already applies this multi-scalar guard; the two are now symmetric.
The predicate plays no role in the breadth resume path (and breadth's `isGlobalStressed` plays no
role in same_bar resume) — each leg's resume is judged only by its own leg signal, both behind the
shared malformed-input fail-closed gate. This keeps the M25 invariant intact: invalid inputs are
never relaxed and never counted clean.

**Hysteresis — engage ≠ resume threshold (locked).** Mirrors §6d's breadth 40→30 inner band:

- **Engage (M28):** halt when `same_bar_trigger_count >= STRESS_SAME_BAR_HALT_COUNT (20)`.
- **Resume:** require `same_bar_trigger_count < STRESS_SAME_BAR_RESUME_COUNT (12)` — back inside the
  routine band the soak showed is harmless.
- **Hysteresis buffer:** a reading in `[12, 20)` is below the engage threshold but **not** clean
  enough to count toward resume (it resets the counter). The 8-count gap is the buffer.

**Consecutive-clean-tick confirmation — N=2 for same_bar (locked, distinct from breadth's 3).**
`SAME_BAR_RESUME_CLEAR_TICKS = 2`. A same-bar pile-on is overwhelmingly a **single transient bar**
(soak: Jun 9 avg 4.1 vs max 10; Jun 6 avg 2.6 vs max 12) — the spike bar appears, the next bar
resolves. One confirming clean bar after the spike is sufficient; requiring 3 (breadth's count)
would burn two extra bars for a leg that is structurally less persistent than breadth. The clean-tick
counter is the **same** in-memory counter §6d uses; only the required count is leg-parameterised.
Same starting-point caveat as the threshold (tech-debt).

**Per-day re-halt cap — shared, unchanged (locked).** `MARKET_STRESS_MAX_DAILY_REHALT = 3` is reused
as a **combined** cascade-chatter budget across breadth + same_bar (the existing in-memory counter
already counts every `market_stress` re-halt, not a per-leg count). On the 3rd `market_stress`
re-halt in one UTC day — any mix of legs — the gate falls back to the full-day lock for the rest of
the day. M28 does **not** split the cap per leg (out of scope; a future refinement if 3/day proves
too tight). The §6d restart quirk carries forward unchanged.

**Branch placement + resume profile selection (locked).** The §6d resume branch in
`resolveDayHalt` is unchanged in shape; M28 parameterises it by the persisted leg. A small pure
helper `resumeProfileFor(leg)` returns `{ isStillStressed, requiredTicks }`:

- leg `breadth` → `isGlobalStressed`, `MARKET_STRESS_RESUME_CLEAR_TICKS (3)` — unchanged.
- leg `same_bar` → `isSameBarStillStressed`, `SAME_BAR_RESUME_CLEAR_TICKS (2)`.

The clean-tick counter advance/reset, the re-halt cap check, the `autoResumeMarketStress`
clear-day + `stressEmittedForDate` reset, and the in-memory day-row flip are **unchanged** — only
the predicate and required-tick count are leg-selected. The resume log line and the
`IMarketStressResumedEvent` payload now carry the **actual** resumed leg and the **leg-selected**
clean-tick count (`triggerLeg='same_bar'`, `clearCount=2` on a same_bar resume), not the hard-coded
`breadth`/`3`. `breadthAtResume` stays in the payload but is leg-irrelevant for a same_bar resume;
M28 does not add a same-bar-count field (that would be a shared-package change — out of scope; the
same_bar count is surfaced in the WARN log instead).

**Resume-event dedup — per-transition, not per-UTC-day (M28, locked — fixes a pre-existing bug).**
Before M28 `autoResumeMarketStress` deduped the `MARKET_STRESS_RESUMED` emit on
`autoResumeEmittedForDate === utcDateString` — **at most one resume event per UTC day**. With breadth
the only eligible leg this was tolerable; M28 makes a second same-day resume reachable (a breadth
resume then a same_bar resume, or same_bar → re-halt → same_bar before the cap), and the day-only
dedup would silently drop the second event — breaking the §6e monitoring criterion that every
same_bar resume emits a `triggerLeg='same_bar'` event. M28 replaces it with **per-transition** dedup:
each genuine HALTED→RUNNING transition emits exactly one event (the same-call `mutableDay.isHalted`
flip already guards same-tick re-entry), while a same-tick duplicate is still suppressed. Equivalent
keying `{ utcDateString, triggerLeg, dailyReHaltCount }` is acceptable; day-only dedup is not.

**Halt-flag clear must recognise the new leg (M28, locked — `RiskListeners`).** The DB resume
(`risk_state` clear) and the in-memory `HaltFlagService` clear are two paths: the gate clears the
former, `RiskListeners.onMarketStressResumed` clears the latter on the `MARKET_STRESS_RESUMED` event.
Before M28 the listener early-returned unless `triggerLeg === breadth`, so a same_bar resume would
clear the DB but leave the in-memory flag halted — `GET /v1/control/halt` would keep reporting halted.
M28 generalises the listener's leg check to `MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(triggerLeg)` so
any resume-eligible leg clears the flag. The restart-safe `isHalted()` guard before `resume()` is
unchanged.

**Config flag — reuse `MARKET_STRESS_AUTO_RESUME_ENABLED` (locked).** No new flag. The §6d master
switch (paper-default-on, live-default-off, read once at boot) gates the whole mechanism; `same_bar`
resume rides under it. When off, both breadth and same_bar keep the pre-M23 full-day lock. A second
flag is explicitly rejected — one master switch per mechanism.

**Threshold homes (locked).** `STRESS_SAME_BAR_HALT_COUNT (20)`, `STRESS_SAME_BAR_RESUME_COUNT (12)`,
and `SAME_BAR_RESUME_CLEAR_TICKS (2)` are all engine consts in `riskConsts.ts` — same home and
rationale as the breadth resume consts. Risk config lives engine-side (Conflicts #1); the shared
strategy-params schema is unchurned and the halt threshold stays off the param `classifyFlowType`
reads.

**Out of scope (M28).** Per-bar held-out validation of 20 / 12 / 2 (tech-debt, with breadth-N);
splitting the re-halt cap per leg; persisting the in-memory counters; any change to the breadth
resume path, the M25 paper-relax set (`same_bar` is never relaxed — §2 intact), the engage-side NaN
guard, or the shared schema.

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

#### 8a. Sizer → per-coin-cap clamp + `effectiveRiskUsdt` (M29)

> **Amendment (M29, 2026-06-10).** Soak evidence (11 days, 36 `exposure_cap_per_coin`
> rejects on an empty book) showed that for low-ATR names the 1%-risk-targeted notional
> exceeds `MAX_EXPOSURE_PER_COIN_USDT` *before any position exists*, so the bot never
> opens. The fix moves the per-coin ceiling into the sizer as a shrink input. See ADR
> 0042 §4 for the config-only-lock reversal that motivated this.

1. **The sizer → cap clamp.** `PositionSizer` now accepts `maxExposurePerCoinUsdt` as a
   sizing input and clamps the risk-targeted notional to
   `min(riskTargeted, leverageCeiling, maxExposurePerCoinUsdt)`. The cap is the operator
   hard ceiling; the sizer **shrinks** the 1%-risk target to fit it (shrink-never-grow),
   the same shape as the existing leverage clamp (§8.3) — it can only lower notional,
   never raise it. `RiskGateService.checkExposureCaps` remains **unchanged** as the final
   authority (defence in depth for multi-reservation scenarios where the cap binds against
   *existing* positions the sizer cannot see).

2. **`effectiveRiskUsdt` (new field on `IIntentSizing`).** `riskPerTradeUsdt` is the
   **pre-clamp** 1%-risk target (e.g. $15 = 1% of $1,500). `effectiveRiskUsdt` is the
   **post-clamp** realized dollar risk:
   `effectiveRiskUsdt = clampedNotional / entryPrice × stopDistance`. When no ceiling
   binds, `effectiveRiskUsdt === riskPerTradeUsdt`. The gap between target and effective
   is **audit signal** — `riskPerTradeUsdt` is **never overwritten** (the pre-clamp
   intent is preserved for diagnosing how often, and how hard, the cap shrinks size).

3. **R-multiple / expectancy denominator rule.** Any funnel rollup or PnL expectancy
   calculation **MUST** use `effectiveRiskUsdt` as the denominator for R-multiples on
   closed positions — it is the risk actually taken, not the pre-clamp target. Pre-M29
   rows that lack `effectiveRiskUsdt` yield a **null** R-multiple, **not** a fallback to
   `riskPerTradeUsdt` (falling back would silently overstate R when a clamp bound).

4. **Funnel observability (D3).** The `getFunnelSummary` query in `packages/analysis` is
   **observability-only**: read-only, derived from existing `decisions` rows, no new
   schema. The `sl_outside_liquidation` sub-cause split (wrong-side stop / over-levered /
   non-positive liquidation fraction) is derived from already-persisted columns
   (`trade_side`, `stop_loss`, `leverage`, `notional`, `market_snapshot`) — there is **no
   new `gate_reject_sub_reason` column**.

#### 8b. Idiosyncratic-edge soak gate + idiosyncrasy observability (M30)

> **Amendment (M30, 2026-06-11).** M29 made the first idiosyncratic paper fill possible
> and instrumented the funnel, but left the slot-C prerequisite as a prose floor ("≥20
> closed trades across ≥3 trading days"). M30 turns that floor into an **executable
> instrument** — `getIdiosyncraticEdgeReport.slotCGateOpen` — and closes the
> idiosyncrasy-funnel blind-spot. **Measurement-first, minimum-touch:** no migration, no
> shared-package change, no DB-param change, no safety floor relaxed. The only runtime
> change is a provably-tightening noise floor in a pure function (D4).

1. **`slotCGateOpen` is a sample-readiness signal, NOT an edge-positive assertion.**
   `slotCGateOpen = meetsClosedTradeFloor (n ≥ 20) AND meetsTradingDayFloor
   (distinctTradingDays ≥ 3)`. It means "there are enough closed idiosyncratic trades to
   evaluate the edge," nothing more. A measured **negative** expectancy with the gate open
   is actionable data — it means "decide" (the sample is large enough to act on), **not**
   "build." No slot-C / correlated-strategy milestone may open until this reads `true`
   (D1 lock; tech-debt MEDIUM "Differentiated correlated slot-C strategy").

2. **Fill-anchored risk reconstruction (F1 — `effectiveRiskUsdt` is never persisted).**
   `effectiveRiskUsdt` (§8a.2) lives only on the engine-internal `IIntentSizing` and is
   dropped at persistence (`StrategyService.buildGateGeometry` writes `qty/notional/leverage`
   only; no `effective_risk_usdt` column exists on `decisions` or `positions`). The edge
   report therefore **reconstructs** the per-trade R denominator from fill-anchored
   `positions` columns:
   `reconstructedEffectiveRiskUsdt = qty × |entry_price − stop_loss_price|`.
   This is the dollar risk realized **at fill** — more correct for an edge read-out than
   the pre-round intent value. **Three-column null-exclusion rule:** a closed trade where
   ANY of `qty`, `entry_price`, `stop_loss_price` is null yields a **null** R-multiple and
   is **excluded** from the expectancy aggregate — never a target-based fallback.

3. **LATERAL open-decision join (F3 — `decisions.position_id` is never stamped).** The
   column exists on `DecisionEntity` but `StrategyService.persistDecision` never writes it
   on the open path, so it is null on live soak rows. To recover the BTC-move snapshot the
   report joins each closed position to the most-recent matching open decision via a
   **LATERAL time-join** on `(strategy_version_id, symbol, action='open', gate_allowed=true,
   ts ≤ opened_at) ORDER BY ts DESC LIMIT 1` — not via the (null) `position_id` FK.

4. **`rMultipleStdError = null` at `n < 2`.** Standard error of the mean R-multiple =
   `stdDev / sqrt(n)` (decimal math). A single trade has no dispersion, so the report
   returns **null** (not `0`) for `n < 2` — returning `0` would imply false certainty;
   `null` reads honestly as "undefined at this sample size." `n = 0` also returns null.

5. **D4 noise floor (the only runtime change — tightening-only).**
   `IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05` is a new engine const. When
   `abs(coin5mMovePct) < 0.05`, `computeIdiosyncrasyScore` returns `IDIOSYNCRASY_SCORE_MIN`
   (0) — the noise-floor analogue of the existing `coinMagnitude === 0` guard. The floor is
   **16× below** the tightest tier-1 trigger (`tier1_min_abs_move_pct = 0.8%`), so it is
   **inert for every real trigger input** (asserted byte-identical by a regression test).
   Its direction is provably safe: it can only **lower** a score toward 0 — it can remove
   false idiosyncratic eligibility (a noise-inflated pass becomes a `no_eligible_slot`
   reject) but never inflate a score or open a previously-rejected trade. The idiosyncrasy
   **threshold** (`idiosyncrasy_min_score = 0.5`, per-version DB param) is **not touched**.

6. **D4b — live/backtest idiosyncrasy-formula divergence (pre-existing, NOT fixed here).**
   The live function (`computeIdiosyncrasyScore.ts`) computes `1 − abs(btc)/abs(coin)`;
   `BacktestEventBuilder.ts` has a **separate private** formula
   `abs(symbol−btc)/(abs(symbol)+abs(btc)+0.0001)`. These yield different scores for the
   same inputs, so the same strategy sees a different idiosyncrasy gate live vs in backtest.
   This predates M30 and is **explicitly not fixed** here (touching the backtest formula
   demands its own parity suite + backtest re-baseline). D4 hardens the live function only
   and makes **no parity claim** between the two. Unification is logged as MEDIUM tech-debt.

7. **D3 idiosyncrasy miss-distribution (observability-only).** `getIdiosyncrasyMissDistribution`
   is read-only, derived from existing `decisions` rows + `market_snapshot` JSONB, no schema
   change. For each `no_eligible_slot` open decision it buckets
   `missDistance = activeMinScore − idiosyncrasyScore` into five equal-width bands
   `[0,0.1) … [0.4,0.5]` per UTC day. `activeMinScore` is resolved by the caller from
   `ACTIVE_STRATEGY_VERSION_ID` (the env-selected v2 param 0.5), **not** the `status='active'`
   v0 seed row. A coin scoring exactly at the threshold passes the gate (miss = 0) and never
   appears; rows with no `idiosyncrasy_score` are counted as unknown, never as 0-score.
   M30 does **not** move the threshold — D3 gathers evidence for a separate calibration
   milestone starting from the correct 0.5 cut (not the WIP's stale 0.3).

8. **`regimeRobustnessPasses` is advisory, NOT part of `slotCGateOpen`.** The `btc_5m_*`
   sub-split partitions eligible trades by the per-bar BTC 5m move at entry vs the ±1.5%
   boundary (`up`/`down`/`flat`). These are **per-bar move labels, not regime classifiers** —
   a single 5-minute return is not a stable regime state. `regimeRobustnessPasses` is true
   when every bucket with `n ≥ REGIME_BUCKET_MIN_N = 8` has a mean R-multiple agreeing in
   sign with the aggregate; below that n a bucket does not participate. Because idiosyncratic
   triggers fire *because BTC is calm*, `btc5mFlat` will structurally dominate — that is
   expected, not a failure. The flag is reported alongside the gate for operator context but
   is **never AND'd into** `slotCGateOpen`: a real positive edge running through calm-BTC
   sessions must not be structurally blocked by a per-bar proxy biased toward the flat bucket.

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

- `docs/plans/archive/M4-risk-management.md` (milestone brief), `docs/plans/00-overview.md`
(locked decisions, data model, RiskModule paragraph)
- `docs/architecture/adr/0003-strategy-engine.md` (`ISignal`/`IProposedExit`/`nowMs` the
gate consumes), `0002-persistence-and-data-model.md` (`risk_state`/`positions`/`decisions`
schema + shared-enum placement rule), `0001-exchange-and-market-data.md`
(`IVolatilityDetectedEvent` fast-stress fields, closed-bar rule)
- `docs/best-practices/code-conventions.md` (constants placement, enums, control flow,
decimal money — authoritative)

