# ADR 0012 — Funding cashflows + realized / unrealized PnL (M6)

Status: Accepted (revised 2026-05-23 post-M6 review round 1)
Date: 2026-05-23
Milestone: M6 — Position management & reconciliation

## Revision history

- **2026-05-23 (initial):** Funding rows in `transactions`, exit-reason
  enum extended, account_snapshots split. §5b said "FLATTEN intents
  tagged with `exit_reason = KILL_SWITCH` by the gate" without
  conditioning on the halt-flag state.
- **2026-05-23 (post-M6 R1):**
  - §5b mapping made halt-conditional. `FLATTEN + HaltFlagService.is
    Set() === true` → `KILL_SWITCH`. `FLATTEN + !halt` → `MANUAL`
    (operator-initiated flatten via M9 endpoint, or reconciliation
    case-(a) `flatten` policy on a foreign position; neither is a
    kill-switch event). The `IOrderIntent.originatedBy` field alone is
    not sufficient — the halt flag is the authoritative discriminator.
    (Round-1 logic high #L10.)
  - Wiring note added: `IExchangeOverfillDriftEvent` from ADR-0010 §5
    feeds the M4 model-divergence counter at clamp time. The
    transaction row records the clamped qty/cashflow (matches position
    state); the divergence event records the gap. (Round-1 quant high
    #Q2.)

## Context

Three M6 brief items consolidate into one accounting ADR because they share
the same arithmetic surface — **what counts as PnL on a perpetual-futures
position, and where each contribution lands in the schema:**

1. **Funding cashflows recorded** — perpetuals accrue funding every 8 hours
   while held; the cashflow must land in `transactions` so realized PnL
   matches the exchange account history.
2. **Unrealized PnL** — live, decimal, sign-correct per side, net of
   accrued funding-not-yet-paid.
3. **Realized PnL + exit reason** — written on close, includes funding
   already paid; exit reason enumerated and tied to the M0 halt primitive
   for kill-switch closes.

Constraints binding on this ADR:

- **Money is decimal, never float.** Every PnL computation uses
  `MoneyValue` (decimal.js); rounding only at the persistence boundary
  (`NUMERIC(38,8)` for USDT amounts).
- **Same code live and backtest.** Funding in live comes from the exchange's
  funding-payment endpoint; in backtest it comes from the `funding_rates`
  table replayed against the position's qty-time integral. Both produce a
  `transactions` row with `type=funding` — the *write site* is identical.
- **Exchange is truth.** Live funding cashflows are pulled from the
  exchange's transaction history, not computed locally from
  rate × notional × duration (locally computed values are validated against
  the exchange figure; mismatch raises a divergence alert).

## Decision

### 1. Funding rows in `transactions` — schema-fits the existing table

M2's `transactions` already has `type ∈ {open, add, reduce, close,
funding}` (`TransactionTypeEnum`). M6 puts that fifth value to work.

**Funding-row shape:**

```
transactions {
    type             = TransactionTypeEnum.FUNDING
    position_id      = the open position's id at funding payment time
    side             = position's side at payment time (long|short)         // §1a
    price            = mark price at funding settlement (informational)
    qty              = position qty at payment time (informational)
    fee              = ZERO (funding is not an exchange fee — see §1b)
    client_order_id  = `funding-${positionId}-${fundingTime}` (deterministic, dedup key)
    exchange_order_id = the exchange's funding transaction id (Binance returns one)
    created_at       = fundingTime (the 00:00/08:00/16:00 UTC tick)
}
```

A new top-level column is needed for the actual cashflow:
**`transactions.cashflow`** `NUMERIC(38, 8) NOT NULL DEFAULT 0`. For
`type ∈ {open, add}` it is zero (entries are exposure increases, not cash
movements per se — fees are tracked in `fee`); for `reduce/close` it is
the realized PnL portion attributable to that fill; for `funding` it is
the funding payment amount (positive = received, negative = paid). This
column lets the M8 "PnL by version" SQL aggregate directly over
`SUM(cashflow) - SUM(fee)` without re-deriving from prices and qtys.

The `cashflow` column is a **shared/persistence change** routed through
`bot-shared-maintainer` before engine work begins. Migration is small
and reversible (add column with default 0; reverse drops it).

#### 1a. Why `side` on the funding row

Funding payment direction depends on side and rate sign:

- LONG, positive rate → pay (negative cashflow).
- LONG, negative rate → receive (positive cashflow).
- SHORT, positive rate → receive.
- SHORT, negative rate → pay.

Recording `side` on the funding row makes the cashflow self-describing and
matches the exchange's account-history format.

#### 1b. Why `fee = 0` on funding rows

Funding is not a fee paid to the exchange — it's a peer-to-peer transfer
between longs and shorts mediated by the exchange. Co-mingling funding into
`fee` would distort the fee-vs-PnL ratio used by M8/M9 metrics. The
`cashflow` column carries the funding amount; `fee` stays for true
exchange fees only.

### 2. Live funding ingestion — exchange-history poll, not WS

**Live cadence:** reconciliation's 30-second tick (ADR 0010 §2) includes a
funding-history poll per held symbol. The poll uses
`exchange.fetchFundingHistory({ symbol })` (ccxt's normalized endpoint over
Binance's `/fapi/v1/income?incomeType=FUNDING_FEE`) since the last
recorded funding `created_at` for that position. Funding settles every 8
hours, so polling every 30s catches each event within seconds of
settlement.

**Idempotency:** the deterministic `client_order_id = funding-${positionId}-${fundingTime}`
combined with the existing `uq_transactions_client_order_id` constraint
guarantees one row per funding event per position. A reconciliation
re-poll inserts only the new rows.

**Local validation:** the engine computes an expected funding amount from
the `funding_rates` table snapshot at `fundingTime` and the position's
notional at that tick. Mismatch by more than `FUNDING_TOLERANCE_USDT =
0.01` (1 cent) raises a divergence alert (feeds the model-divergence
counter, ADR 0004 §6). The exchange figure is the persisted truth; the
local figure is a check, not an override.

### 3. Backtest funding — replay from `funding_rates`

The M7 backtest replays funding events deterministically by joining the
backtest's open-position timeline against the `funding_rates` table.
Each 8h boundary while a position is open emits a synthetic `funding`
event consumed by the same writer that records live funding:
`PositionService.recordFunding(positionId, cashflow, fundingTime,
markPrice)`. Same code path, same row shape, same `cashflow` value
computed by the same formula. Live and backtest funding rows are
indistinguishable to downstream SQL.

### 4. Unrealized PnL — formula, sign, funding-net

Unrealized PnL is computed on demand (not persisted on every tick — the
M9 read API computes it from cached state per request, and
`account_snapshots` writes it at the snapshot cadence per ADR §6).

**Formula (per position):**

```
priceTermLong  = qty * (markPrice - entryPrice)
priceTermShort = qty * (entryPrice - markPrice)

priceTerm = side === LONG  ? priceTermLong : priceTermShort
fundingPaid = SUM(transactions.cashflow WHERE position_id = id AND type = FUNDING)
accruedFunding = §4a — funding not yet settled

unrealizedPnl = priceTerm - feesPaid + fundingPaid + accruedFunding
```

- `feesPaid = SUM(transactions.fee WHERE position_id = id)` — entry-side
  fees subtracted. (M5 deferred this for realized PnL pending M7/M8; M6
  takes it on for unrealized so the dashboard equity matches reality.)
- `fundingPaid` is the actually-settled funding via §1.
- `accruedFunding` is the predicted-pro-rated next-settlement amount —
  `(remainingFundingIntervalFraction) * nextFundingRate * notional`,
  with sign per §1a. Used so equity does not jump at every 8h boundary.

**Reviewer rule:** anywhere in the engine that computes unrealized PnL,
including the dashboard projection in M9 and the M4 model-divergence
metric, uses this exact formula. A second definition is a must-fix.

#### 4a. Accrued-funding precision

The next-funding rate is not known until the moment of settlement (Binance
publishes a *predicted* rate that converges to the realized rate over the
interval). The engine uses the latest predicted rate from
`exchange.fetchFundingRate({ symbol })` cached at reconciliation cadence.
Accrued funding is therefore an estimate; it can drift from reality
between cache refreshes. For dashboard purposes (0.0001 of notional
typical magnitude) this is acceptable. For account_snapshots (§6) the
accrued component is recorded separately from the settled component so
M8 analysis can isolate the estimation noise.

### 5. Realized PnL + exit reason

Realized PnL is written **once**, at the `closing → closed` transition (ADR
0009 §4), via `PositionService.finalizeRealizedPnl(positionId)`:

```
finalizeRealizedPnl:
    fillPnl       = SUM(transactions.cashflow WHERE type IN {reduce, close})
    feesPaid      = SUM(transactions.fee   WHERE type != funding)
    fundingPaid   = SUM(transactions.cashflow WHERE type = funding)
    realizedPnl   = fillPnl - feesPaid + fundingPaid
    exitPrice     = vol-weighted-avg(transactions.price WHERE type IN {reduce, close})
    closedAt      = nowMs
    exitReason    = §5a
```

The `cashflow` per `reduce/close` row is computed at fill time as the
side-aware price delta times fill qty (the inverse of the position's
entry — see §1). The `finalize` step is therefore pure aggregation over
the existing `transactions` rows; no late arithmetic on entry/exit
prices.

#### 5a. ExitReasonEnum — extended for M6

`ExitReasonEnum` (shared) already has `take_profit | stop_loss | time_stop
| signal | manual | kill_switch`. M6 adds two values to cover the
reconciliation paths surfaced by ADR 0010:

```
enum ExitReasonEnum {
    TAKE_PROFIT          = 'take_profit',
    STOP_LOSS            = 'stop_loss',
    TIME_STOP            = 'time_stop',
    SIGNAL               = 'signal',
    MANUAL               = 'manual',
    KILL_SWITCH          = 'kill_switch',
    RECONCILED_MISSING   = 'reconciled_missing',     // NEW — ADR 0010 case (b)
    LIQUIDATED           = 'liquidated',             // NEW — exchange liquidation
}
```

`RECONCILED_MISSING` is used when reconciliation discovers a DB-open
position that no longer exists on the exchange and the close cause cannot
be determined (account-history poll inconclusive). `LIQUIDATED` is used
when the account-history poll reveals the close was an exchange
liquidation. The two are distinct because the M8 strategy-versioning
analysis treats liquidations as a quality-of-edge signal (a strategy
producing liquidations is unsafe) vs reconciled-missing (a one-off drift
event).

The exit-reason values are SHARED (already in `packages/shared/src/enum/`);
`bot-shared-maintainer` adds the two new ones.

#### 5b. `kill_switch` reads M0 halt primitive — halt-conditional mapping

The kill-switch exit path is plumbed via the M0 `HaltFlagService` (the
M9 operator endpoint or the M4 model-divergence trigger calls
`HaltFlagService.set()`), which causes the gate to emit `FLATTEN`
intents for all open positions (ADR 0004 §2).

**Locked exit-reason mapping (revised post-R1 #L10):**

| Intent action | Halt flag state at gate evaluation time | `exit_reason` |
|---|---|---|
| `FLATTEN` | `HaltFlagService.isSet() === true`  | `KILL_SWITCH` |
| `FLATTEN` | `HaltFlagService.isSet() === false` | `MANUAL`      |
| `CLOSE` driven by reconciliation case-(a) `flatten` policy | (irrelevant — not driven by halt) | `MANUAL` |
| `CLOSE` driven by reconciliation case-(b) | (irrelevant) | `RECONCILED_MISSING` |
| `CLOSE` driven by `LocalProtectiveMonitor` breach | (irrelevant) | `STOP_LOSS` or `TAKE_PROFIT` per breach kind |
| `CLOSE` driven by strategy signal | (irrelevant) | `SIGNAL` |
| `CLOSE` driven by time-stop | (irrelevant) | `TIME_STOP` |

**Why halt-conditional, not originator-conditional:** the
`IOrderIntent.originatedBy` field tracks *which subsystem emitted the
intent* (`risk-gate`, `local-monitor`, `reconciliation`, `m9-operator`),
not *why*. The same `FLATTEN` intent shape is used both by the
kill-switch path and by an operator's manual-flatten click in M9;
distinguishing them requires reading the halt primitive. M9's manual
flatten does NOT set the halt flag (operator wants the bot to continue
trading); the kill-switch path DOES set it (operator wants the bot
stopped). The halt flag is therefore the authoritative discriminator
between `KILL_SWITCH` and `MANUAL` for any `FLATTEN`.

**No new exit reason for bot-initiated foreign flatten.** Case-(a)
`flatten` policy emits a `CLOSE` (or `FLATTEN` if the foreign row is
also halt-flagged — vanishingly rare); the resulting close transaction
is tagged `exit_reason = MANUAL`. The `ReconciliationOutcomeEnum.
FLATTENED` value on the `IReconciliationResolvedEvent` carries the
"this was a bot-initiated foreign flatten" semantics; the exit reason
on the transaction row stays `MANUAL` so the M8 analysis groups it
with operator-class closes. Avoid having two enums encode the same
fact.

**Determinism:** `HaltFlagService` is an injected port (M0); backtest
replays of "engine halted mid-trade" set the flag at the replay's
controlled tick. The exit reason is identical in live and backtest.

#### 5c. Exchange overfill — clamp + emit drift event

When ExecutionService records a fill whose qty or cashflow exceeds the
expected residual (e.g., exchange filled more than the position can
absorb due to a stale-mark race), the recorded `transactions.qty` and
`transactions.cashflow` are **clamped** to the expected values so the
position-state arithmetic stays consistent. Silently clamping is a
data-integrity hazard — the audit ledger would understate exchange
behavior.

Locked behaviour (R1 #Q2):

1. Record the clamped values on the `transactions` row (matches the
   position-state qty/cashflow).
2. Emit `IExchangeOverfillDriftEvent` (ADR-0010 §5) carrying
   `(expectedQty, observedQty, clampedQtyDelta, clampedCashflowDelta)`.
3. The M4 model-divergence counter (ADR 0004 §6) consumes the event
   exactly like a `recordExposureDrift` event — recurring overfills
   raise the divergence rate and can trigger
   `MODEL_DIVERGENCE_HALT`.

This keeps the transaction row aligned with the position (no
phantom-fill arithmetic) while preserving forensic visibility through
the divergence event stream.

### 6. `account_snapshots` cadence

Account snapshots track balance/equity/unrealized-PnL over time and are
the basis for drawdown / equity-curve metrics in M8/M9.

**Cadence (locked):**

- **Write interval:** every `ACCOUNT_SNAPSHOT_INTERVAL_MS = 60 seconds`
  by the engine's scheduler (`@nestjs/schedule`, already in use). 60s is
  fast enough to catch intra-bar equity moves for drawdown tracking, slow
  enough to keep the table from bloating (~525k rows/year at 60s; trivial).
- **Trigger:** the scheduler is the primary writer. Reconciliation
  additionally **forces** a snapshot at the end of each reconciliation
  pass when **any** drift case (a/b/d/f) resolved — so the equity-curve
  record reflects the corrected state immediately after a reconciliation
  step, not 60s later.
- **On boot:** one snapshot is written immediately after the boot-time
  reconciliation pass completes (ADR 0014 §5), recording the engine's
  starting view of the account. This is the audit trail entry "engine
  restarted at T, account looked like X."

**Fields (locked, schema-fits M2 `account_snapshots`):**

```
account_snapshots {
    ts                 = nowMs at write
    balance            = exchange wallet balance (fetchBalance().total)
    equity             = balance + sum(unrealizedPnl over all open positions)
    unrealized_pnl     = sum(unrealizedPnl over all open positions)
}
```

M6 adds **two new columns** to support the funding/accrued split (§4a)
and the account-history audit:

- `unrealized_pnl_funding NUMERIC(38, 8) NOT NULL DEFAULT 0` — the
  `fundingPaid + accruedFunding` component of unrealized.
- `unrealized_pnl_price NUMERIC(38, 8) NOT NULL DEFAULT 0` — the
  `priceTerm - feesPaid` component.

Together they sum to `unrealized_pnl`. Splitting them lets M8 analyze
"was the equity curve driven by price moves or by funding harvest" per
strategy version. Shared/persistence change, routed through
`bot-shared-maintainer`.

**Interaction with restart:**

- The boot snapshot reads the exchange balance directly
  (`exchange.fetchBalance()`), not a stale DB value. The most recent
  pre-crash snapshot is informational (used for drawdown context) but
  not authoritative for the boot equity.
- A discrepancy between the latest pre-crash snapshot and the boot
  snapshot equity beyond `ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT = 1.00`
  raises an alert (operator should investigate: external transfers,
  unaccounted fills, etc.).

### 7. Reviewer rules

- All PnL math goes through `decimal.js`. A `Number` arithmetic on price
  or cashflow is a reviewer must-fix.
- Funding is recorded as `type=funding`, never as `fee`. A funding row
  with non-zero `fee` is must-fix.
- Realized PnL is computed by summing the `cashflow` column from the
  existing `transactions` rows; recomputing from entry/exit prices at
  finalize time is must-fix (would re-introduce float drift between
  reduce-fill computation and final aggregation).
- Two definitions of unrealized PnL anywhere in the codebase is must-fix.
  One formula, one helper, one caller.
- `exit_reason` is NOT NULL on a `closed` position. The close transition
  writes both atomically; a closed row with NULL reason is must-fix.

## Consequences

- `transactions` grows one new column (`cashflow`). `account_snapshots`
  grows two (`unrealized_pnl_funding`, `unrealized_pnl_price`). One small
  reversible migration, routed through bot-shared-maintainer +
  bot-engine-nestjs (entity + repository updates).
- `ExitReasonEnum` grows two values. Strict reads (switch statements with
  no default) must be updated — already enforced by the existing
  exhaustive-switch lint in the engine.
- M5's "entry-side fees subtracted from realized PnL" deferred item is
  now resolved in M6 (the §5 finalize includes `feesPaid`).
- Backtest funding fidelity becomes dependent on `funding_rates` data
  coverage. M2's `funding_rates` table is already populated; ongoing
  backfill is M7's concern.

## Alternatives considered

- **Store funding in a separate `funding_events` table.** Rejected:
  schema fragmentation. The `transactions.type=funding` value already
  exists; using it preserves one timeline per position.
- **Compute funding locally and skip the exchange-history poll.**
  Rejected: drift between the predicted and realized funding rate
  produces a discrepancy with the actual account balance. Exchange is
  truth; local is the validation.
- **Persist unrealized PnL on every tick.** Rejected: write storm with
  no analytic value (the prices are in `tick_aggregates`; the qty is in
  `positions`; the PnL is a derived value). Snapshot at 60s suffices.
- **Use `fee` column for funding to avoid a new `cashflow` column.**
  Rejected: §1b — distorts the fee/PnL ratio used by M8 metrics.
- **Skip `LIQUIDATED` exit reason and roll into `RECONCILED_MISSING`.**
  Rejected: M8 strategy-quality analysis needs to distinguish
  liquidations (strategy-quality signal) from drift cleanup
  (operational event).
- **Skip the funding/price split on `account_snapshots`.** Rejected:
  the strategy-versioning analysis (M8) demands the split to answer
  "did this version earn from price moves or just farm funding?" — a
  first-class question for the low-risk philosophy.

## See also

- `docs/plans/M6-position-management.md`
- `docs/architecture/adr/0009-position-state-machine.md` (`closing → closed` transition writes realized PnL)
- `docs/architecture/adr/0010-reconciliation-and-drift-policy.md` (RECONCILED_MISSING, LIQUIDATED exit-reason sources)
- `docs/architecture/adr/0002-persistence-and-data-model.md` (transactions / account_snapshots schema)
- `docs/architecture/adr/0004-risk-management.md` §6 (model-divergence kill switch consumes funding drift)
- M0 halt primitive — `HaltFlagService` (M0 milestone artefact)
