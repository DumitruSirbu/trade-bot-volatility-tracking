# M49 — RECONCILED_MISSING must fetch the real closing fill before finalizing (H5)

> **What M49 is.** A LIVE-mode **data-integrity** fix. When the bot finalizes a position as
> `RECONCILED_MISSING` (the exchange shows the position gone, but the bot never recorded the
> closing fill locally), it currently writes `exit_price = null`, `realized_pnl = null`, and
> `fees = null` **permanently**. M49 fetches the actual closing trades from exchange account
> history (`fetchMyTrades`) and records them into the position's `transactions` ledger **before**
> the existing finalize runs, so the unchanged aggregate (ADR 0012 §5) produces real numbers.
>
> Every `CLAUDE.md` trading-safety invariant holds: no new order path (this is a read-only
> account-history fetch + ledger write, never an order), the risk gate is untouched, money stays
> `decimal`, strategies stay pure (this is reconciliation-loop code, never strategy code), no LLM
> in the loop. The fix is **LIVE-only** — the reconciliation tick is already a no-op under PAPER.

---

## Problem statement

When a close order returns a **non-clean / unknown result** (the executor cannot confirm the
terminal outcome), the position is driven to `RECONCILING`. On a later reconciliation tick the
exchange shows the `(symbol, side)` position **gone**, so `ReconciliationService` finalizes the row
as closed with `ExitReasonEnum.RECONCILED_MISSING`.

The finalize path (`PositionService.finalizeRealizedPnl`) aggregates realized PnL **purely from the
local `transactions` ledger** (ADR 0012 §5):

```
fillPnl     = SUM(cashflow WHERE type IN {reduce, close})
exitPrice   = vol-weighted-avg(price WHERE type IN {reduce, close})
realizedPnl = fillPnl - feesPaid + fundingPaid    (null when there are NO closing fills)
```

Because the closing fill happened on the exchange but was **never recorded locally** (that is
exactly the condition that drove the row to `RECONCILING`), the ledger contains **no `REDUCE` /
`CLOSE` rows**. So `aggregatePnl` returns `hasClosingFills = false`, and finalize writes:

- `realized_pnl = null`
- `exit_price = null`
- `fees` for the closing leg = never captured

In **LIVE**, this data is **permanently lost** — the trade is real (real money moved) but the
position row is a hollow `RECONCILED_MISSING` close with no PnL, no exit price, and no fees. These
rows then:

- pollute / silently drop out of trade-count, win-rate, and drawdown denominators (a real loss or
  win is recorded as "no result"),
- break the cooldown-after-loss derivation (`isCooldownStillActive` reads `realizedPnl`; a null
  closing P&L means a genuine loss never arms the cooldown), and
- corrupt the equity-curve / `account_snapshot` audit trail.

The data **is recoverable** — Binance USDT-M Futures exposes the user's own fills via account
history (`fetchMyTrades`). The bot simply never fetches them before finalizing.

---

## Root-cause analysis (the exact code path)

### How a row reaches the null-PnL finalize

1. A close order returns a non-clean result → executor emits `ORDER_INTENT_UNKNOWN_EVENT`.
2. `ReconciliationService.onOrderIntentUnknown` (`ReconciliationService.ts:247`) transitions the row
   `→ RECONCILING` (eventClass `intent.unknown`).
3. On a later tick the exchange snapshot no longer carries the `(symbol, side)` pair, so the row is
   routed into one of **two LIVE finalize sites**, both of which finalize with `RECONCILED_MISSING`
   **without fetching the real fill**:

   - **Case (b) — `handleDbOpenNotOnExchange`** (`ReconciliationService.ts:1099`). DB row with no
     exchange match. Walks the legal source-state arrows to `CLOSING`/`RECONCILING`, then calls
     `finalizeRealizedPnl(position.id, RECONCILED_MISSING, …)` (`:1172`). The inline comment at
     `:1096-1098` and `:1120-1123` explicitly acknowledges "exit_price / realized_pnl stay null
     (not recoverable without account-history; M9 backfills)" — M49 is that recovery.

   - **Case (f) closed-branch — `transitionOutOfReconciling`** (`ReconciliationService.ts:1460`).
     A `RECONCILING` row whose original intent reached a **terminal** exchange status and whose
     exchange-side qty is `0`/absent. Finalizes via `finalizeRealizedPnl(position.id,
     RECONCILED_MISSING, …)` (`:1488`). Same null-PnL outcome (comment at `:1441-1444`).

4. `finalizeRealizedPnl` (`PositionService.ts:316`) aggregates from the empty closing-fill set →
   `realizedPnl: null`, `exitPrice: null` (`:319-324`). The CLOSED transition is atomic and has no
   out-edge, so the hollow values are permanent.

### Where the fill fetch is missing

There is **no call to any account-history trade fetch** anywhere on this path. The exchange layer
today exposes `fetchOrderByClientId` (single order, used by case-f to read terminal status) and
`fetchFundingHistory` (account history, used by funding ingestion via the `IAccountStateSource`
port) — but **no `fetchMyTrades`** facade exists at all (confirmed: `CcxtBinanceExchangeClient`
has `fetchFundingHistory`, `fetchOpenOrders`, `fetchOrderByClientId`, but no user-trade fetch). The
H5 note's `fetchOrdersByClientId` / `fetchMyTrades` are aspirational — **neither is implemented**.

### Scope nuance — `StuckPositionSweeper.sweepReconcilingParked` is NOT a LIVE H5 site

The H5 location list names `StuckPositionSweeper.ts:sweepReconcilingParked`. On inspection that
specific path **cannot lose LIVE fill data**:

- `sweepIfStuck` (`StuckPositionSweeper.ts:82-96`) gates the `RECONCILING` branch on
  `appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER` (`:93`). So `sweepReconcilingParked` is
  **PAPER-only** — in LIVE the real `ReconciliationService` owns `RECONCILING` rows and the sweeper
  must not race it. Under PAPER there is no real exchange to fetch from; the simulator already holds
  the projected fill, and no real money moved. **No LIVE data loss occurs via `sweepReconcilingParked`.**

> **(M1 — reviewer narrowing.)** This claim is narrowed to `sweepReconcilingParked` **only**.
> `sweepOrphanedPendingOpen` (`:106-116`) **does run in LIVE** and finalizes `RECONCILED_MISSING`
> with null PnL. For an orphaned `pending_open` that genuinely **never filled**, null realized PnL is
> the **correct** value (no closing fill exists; the row is excluded from trade denominators by the
> M40 sweeper contract). The *theoretical* edge — a `pending_open` whose **open** fill landed on the
> exchange but was never recorded locally, then swept — is a **separate tech-debt gap outside H5's
> scope** (H5 is specifically the close-side reconciled-missing path). M49 does **not** address the
> sweeper's `pending_open` open-fill recovery; it is logged as a follow-up, not bundled.

Therefore the LIVE H5 fix lands entirely in `ReconciliationService` (case-b + case-f-closed). The
sweeper is documented as a **scope boundary** below, not changed.

---

## Deliverables / tasks (≤ 5 items, ≤ 5 files)

> Per `docs/best-practices/dev-qa-cycle.md` §1: touch the minimum surface; each item ships a paired
> test that fails before / passes after; if any item would re-interpret a contract, STOP and surface
> to the architect (the ADR amendments in this plan pre-bless the contract touches).

### D1 — `fetchMyTrades` account-history facade (exchange + port)

Add a read-only user-trade fetch to the account-state read surface, mirroring the existing
`fetchFundingHistory` shape (which is the precedent: account history consumed by reconciliation
through the `IAccountStateSource` port).

- New boundary snapshot type **`IMyTradeSnapshot`** in
  `apps/engine/src/exchange/interface/IExchangeSnapshots.ts` — decimal-as-string fields, **never
  float**: `tradeId`, `orderId` (the Binance order id; one closing order = N partial-fill trades that
  share this), `clientOrderId` (nullable), `symbol`, `side` (`'buy'|'sell'`), `price`, `amount`,
  `cost`, `fee`, `feeCurrency` (nullable), **`realizedPnl`** (decimal-as-string — the per-trade
  realized PnL Binance returns on `userTrades`; `0` on entry fills, non-zero on reducing fills), and
  `timestampMs`.

> **(H1 — `reduceOnly` is a phantom field, removed.)** Binance `/fapi/v1/userTrades` rows do **not**
> carry `reduceOnly`; ccxt cannot populate it from this endpoint, so it would always be null and the
> "primary close-leg filter" would never fire. `IMyTradeSnapshot` therefore does **not** include
> `reduceOnly`. The closing-fill discriminator is **`realizedPnl != 0`** (Binance reports a non-zero
> per-trade `realizedPnl` only on reducing fills; entry fills report `0`), with **opposite-side**
> (`side` opposite the position side) as a cross-check. **The exact ccxt field name for per-trade
> realized PnL (`info.realizedPnl` on the raw Binance row vs. any ccxt-unified key) MUST be confirmed
> via `context7-mcp` before D1 implementation** — the mapper reads it from the ccxt trade's `info`
> bag and re-stringifies to decimal.

- New facade **`fetchMyTrades(symbol, sinceMs)`** on `CcxtBinanceExchangeClient` — routes through
  `callExchange(...)` (rate-limit boundary, `/fapi REQUEST_WEIGHT_1M` bucket — ccxt
  `fetchMyTrades` → `GET /fapi/v1/userTrades`; **no new rate-limit bucket**, ADR 0030 unchanged)
  and `assertActiveLiveAccountStateCapability('fetchMyTrades')` (D14 guard), exactly like
  `fetchFundingHistory` (`CcxtBinanceExchangeClient.ts:220`). Maps each ccxt trade → `IMyTradeSnapshot`.
- Add `fetchMyTrades(symbol, sinceMs): Promise<readonly IMyTradeSnapshot[]>` to the
  **`IAccountStateSource`** port. LIVE (`ExchangeAccountStateSource`) delegates to the facade; PAPER
  (`PaperAccountStateSource`) returns the simulator's projected reduce trades (or `[]` if none) —
  PAPER never reaches the LIVE finalize path, so `[]` is acceptable and keeps PAPER engine-local.

**Files:** `exchange/interface/IExchangeSnapshots.ts`, `exchange/service/CcxtBinanceExchangeClient.ts`,
the `IAccountStateSource` interface + its two implementations (LIVE + PAPER). *(Mechanical port
fan-out — the interface + the two adapters are one logical change per the file-cap pragmatism note.)*

### D2 — Record reconciled closing fills into the ledger (`PositionService`) — **Option A: per-order aggregation**

> **Chosen approach (B1 + B2 + H4 resolution): aggregate all partial fills per `orderId` into ONE
> ledger row before insert.** `TransactionEntity` carries two unique constraints —
> `uq_transactions_exchange_order_id` (`exchangeOrderId`) and `uq_transactions_client_order_id`
> (`clientOrderId`) — and `clientOrderId` is **NOT nullable**
> (`TransactionEntity.ts:11-12, 49`). Binance `/fapi/v1/userTrades` returns **one row per partial
> fill**, and all partials of one closing order share the same `orderId`/`clientOrderId`. A naive
> "one tx row per trade" insert would therefore have the 2nd–Nth partials collide on the unique
> constraint and be **silently dropped** by `TransactionRepository.recordTerminal`'s idempotent
> no-op path (`TransactionRepository.ts:61-78`) — undercounting `fees`/`fillPnl` and corrupting the
> `exit_price` VWAP. **Option A** sidesteps this entirely and needs **no migration** (it reuses the
> existing `exchangeOrderId`/`clientOrderId` unique columns — satisfies **H4**).

New method **`PositionService.recordReconciledClosingFills(positionId, fills)`** that **groups the
fetched closing trades by `orderId`** and inserts **one** `REDUCE` `transactions` row per closing
order (type `CLOSE` for the order that drains the position to zero) **before** finalize aggregates
them. Per aggregated row:

- `qty` = SUM of the order's partial-fill `amount`s.
- `price` = **volume-weighted average** fill price across the order's partials
  (`SUM(price·amount) / SUM(amount)`) — this is what feeds `computeVolumeWeightedExitPrice` in
  finalize, so `exit_price` is correct at order granularity (resolves **B1**).
- `fee` = SUM of the partials' fees **subject to the currency guard below (H2)**.
- `cashflow` = realized-PnL contribution computed against the row's `entryPrice` with the correct
  side sign (`(exit − entry)·qty` for LONG, `(entry − exit)·qty` for SHORT, using the VWAP `price`)
  — the same convention the normal reduce path uses, so the existing `aggregatePnl` formula
  (ADR 0012 §5) is reused **unchanged**.
- `exchangeOrderId` = the Binance `orderId`. `clientOrderId` = a **synthetic key**
  **`reconciled-{positionId}-{orderId}`**, modelled on the existing `funding-{positionId}-{fundingTimeMs}`
  synthetic-key precedent (`PositionService.recordFunding`). The synthetic `clientOrderId` avoids
  colliding with the executor's own `clientOrderId` on the same order while keeping the row uniquely
  addressable for re-fetch.

**Dedup (B2 — concrete column, no phantom `tradeId`):** there is **no `tradeId` column** and no
`(positionId, tradeId)` index in the schema — the stated idempotency key in the prior draft did not
exist. Before inserting each aggregated row, the method **excludes orders already in the ledger by
exchange order id**: `TransactionRepository.findByExchangeOrderId(orderId)` (`:24-26`). This is the
authoritative dedup and it correctly catches a partial `REDUCE` that `ExecutionService` may have
**already recorded** for the same order under its real `exchangeOrderId = orderId` (which a
timestamp-based "after last recorded fill" filter would miss — different clocks: exchange trade time
vs local `created_at`). The pre-check on `exchange_order_id` is the primary guard; `recordTerminal`'s
unique-violation catch is the second backstop. **No timestamp-vs-local-clock comparison is used for
dedup.**

**Fee-currency guard (H2 — BNB fees must not corrupt USDT PnL):** `aggregatePnl` sums `tx.fee` into
USDT `realized_pnl` with **no currency check** (`PositionService.ts:365`), and `TransactionEntity`
has no fee-currency column. If "Pay fees with BNB" is enabled, a fee paid in BNB would be subtracted
from a USDT PnL — a unit mismatch. Therefore: when aggregating an order's fees, **only include
partials whose `feeCurrency === 'USDT'`**; for any partial with a non-USDT (or null) `feeCurrency`,
treat its fee as `0` for PnL purposes and emit a **`WARN`** naming the position, order, and the
unconverted fee currency/amount. **Stated constraint: M49 assumes USDT-denominated fees; non-USDT
fees are recorded as zero-for-PnL and flagged, not converted.** (BNB→USDT fee normalization remains a
pre-existing cross-milestone gap, not opened here.)

**Realized-PnL cross-check (M2 — cheap reconciliation signal, no formula change):** Binance returns
per-trade `realizedPnl` on `userTrades`. After aggregation, log `SUM(trade.realizedPnl)` alongside the
locally computed `fillPnl` and emit a **`WARN`** on material divergence (`> 1%` relative **or**
`> $0.10` absolute). This does **not** change the stored value (the ledger-derived `fillPnl` remains
authoritative per ADR 0012 §5) — it is a free integrity probe against the exchange's own number.

**Files:** `position/service/PositionService.ts` (+ reuse `TransactionRepository.recordTerminal` /
`findByExchangeOrderId`; no new repository method or migration).

### D3 — Backfill-before-finalize wiring in `ReconciliationService` (both LIVE sites)

New private helper **`backfillClosingFillsFromExchange(position, nowMs)`** called **immediately
before** `finalizeRealizedPnl` in:

- `handleDbOpenNotOnExchange` (case-b, `:1172`), and
- `transitionOutOfReconciling` closed-branch (case-f, `:1488`).

The helper:

1. `sinceMs = position.openedAt.getTime()` (deterministic; `nowMs` is plumbed, never `Date.now()`
   inside the classifier — consistent with the funding-ingestion `computeFundingSinceMs` pattern).
2. `trades = await accountState.fetchMyTrades(position.symbol, sinceMs)` (wrapped safe — see Risk
   notes; a fetch failure must NOT leave the slot stuck).
3. Filter to the **closing** leg only via the **`realizedPnl != 0`** discriminator (H1 — `reduceOnly`
   is a phantom field on `userTrades`), with **opposite-side** as a cross-check (`side` opposite the
   position side). Entry fills report `realizedPnl = 0` and are excluded by construction — so there is
   **no fragile cross-clock "after last recorded fill" timestamp filter**; entry-vs-exit separation is
   the `realizedPnl` flag, and duplicate-suppression against any already-recorded fill is the
   `exchange_order_id` dedup in D2 (B2). For case-b the position is fully gone, so every matched
   reducing trade belongs to this close.
4. `await positionService.recordReconciledClosingFills(position.id, matched)` — D2 groups by `orderId`,
   applies the fee-currency guard, and dedups on `exchange_order_id`.
5. Then the **existing** `finalizeRealizedPnl(…, RECONCILED_MISSING, …)` runs unchanged and now
   aggregates the just-recorded rows into real `realized_pnl` / `exit_price` / `fees`.

If no closing trades are found (or the fetch fails), finalize proceeds exactly as today (null PnL) so
the row **always** leaves `RECONCILING` — the close must never be blocked by a history read
(ADR 0010 §6: reconciliation outage must not cascade), and the D3.1 alert below fires.

**Files:** `position/service/ReconciliationService.ts`.

### D3.1 — Structured operator alert on the null-PnL fallback (H3)

The graceful-degradation path (empty/throwing `fetchMyTrades` → continue with null PnL) is correct
per ADR 0010 §6, but a **real-money** close finalizing with null PnL must not be log-grep-only. The
`MANUAL_ADOPTED` vanish path already emits a structured `IPositionAdoptionVanishedEvent` for operator
follow-up (`ReconciliationService.ts:1142-1148`); mirror that.

On the fallback (no closing trades recovered, **or** the fetch threw), emit a structured
**`RECONCILED_MISSING_UNRECOVERABLE`** event (payload: `positionId`, `symbol`, `side`, `dbQty`,
`reason ∈ {'no_fills_found','fetch_failed'}`, `detectedAtMs`) so the alert module notifies the
operator and the row is flagged for deferred manual backfill. This does **not** block the close — it
is emitted alongside the existing `finalizeRealizedPnl` call. The successful-backfill path does **not**
emit it.

> **Contract touch — route through `bot-shared-maintainer`.** If the event payload interface lives in
> `packages/shared/` (alongside `IPositionAdoptionVanishedEvent`), adding it is a shared-contract
> change and must go through `bot-shared-maintainer` **before** the engine wiring (per
> `docs/best-practices/dev-qa-cycle.md` §1.3). The architect pre-blesses the payload shape here; the
> engineer must STOP and surface if the shape needs to change during implementation.

**Files:** `position/service/ReconciliationService.ts` (emit) + the event-payload type (shared, if
co-located with the other reconciliation event payloads) + alert-module subscription. *(Counts within
D3's surface — one emit call + one payload type; the alert subscription is a mechanical registration.)*

### D4 — Documentation-only (no engine code) — sweeper boundary + stale-comment cleanup

1. **Sweeper boundary.** Document (in the ADR 0010 amendment + this plan) that
   `sweepReconcilingParked` is PAPER-only, so it is not a LIVE H5 site. Per the **M1** narrowing,
   `sweepOrphanedPendingOpen` **does** run in LIVE but finalizes a genuinely never-filled row where
   null PnL is correct; its *open-fill-recovery* edge is a separate tech-debt follow-up, not H5.
   **No sweeper code change.**
2. **Stale-comment cleanup (M5).** Update the `PositionService.finalizeRealizedPnl` /
   `aggregatePnl` doc comments (`PositionService.ts:294-315, 340-376`) and the ADR 0012 §5 note so
   they no longer imply null PnL is the *normal* `RECONCILED_MISSING` outcome — post-M49 it is the
   fetch-unavailable fallback only. Comment-only; no logic change.

(Listed as a deliverable so the reviewer explicitly verifies the sweeper was considered and correctly
excluded, and the now-stale "null is expected" comments are corrected, rather than silently skipped.)

---

## What NOT to change (scope boundaries)

- **`finalizeRealizedPnl` / `aggregatePnl` stay byte-for-byte unchanged.** The fix records ledger
  rows *before* finalize; the aggregate logic (ADR 0012 §5) is reused, never modified. The
  null-when-no-closing-fills branch remains the correct fallback for genuinely fill-less rows.
- **No `StuckPositionSweeper` code change** (D4 — PAPER-only / fill-less, not a LIVE H5 site).
- **No new order path, no risk-gate change, no execution change.** `fetchMyTrades` is a read-only
  account-history call; `reconcileClose` / monitor disarm sequencing is untouched.
- **No change to the `RECONCILED_MISSING` exit reason or the state graph.** The arrows
  (`OPEN→CLOSING→CLOSED`, `RECONCILING→CLOSED`) are unchanged; only the ledger is richer at finalize.
- **No PAPER behavior change.** The reconciliation tick stays a PAPER no-op; PAPER `fetchMyTrades`
  returns simulator trades / `[]`.
- **No backfill of historical hollow rows in this milestone.** M49 fixes the **forward** path. A
  one-shot repair of pre-M49 `RECONCILED_MISSING` rows with null PnL is a separate, optional
  operator script (note it in tech-debt as a follow-up, do not bundle).
- **No new rate-limit bucket** (ADR 0030 unchanged — `fetchMyTrades` is a `/fapi` weighted read on
  the existing `REQUEST_WEIGHT_1M` bucket).
- **No DB migration (H4).** Option A reuses the existing `exchange_order_id` / `client_order_id`
  unique columns and the existing `recordTerminal` / `findByExchangeOrderId` repository surface. No
  new column, no new index, no new unique constraint — so the CLAUDE.md rule-9 `pg_dump` + confirm
  flow is **not** triggered. **If implementation discovers a migration is unavoidable, the engineer
  MUST STOP and surface it as an explicit named deliverable** (it would require the rule-9 dump +
  user confirmation and is out of the current ≤5-file budget).
- **No BNB→USDT fee conversion.** Non-USDT fees are recorded as zero-for-PnL and `WARN`-flagged
  (D2/H2); fee-currency normalization stays a pre-existing cross-milestone gap, not opened here.
- **No liquidation detection / audit marker (M3).** Force-liquidated closes will appear in
  `fetchMyTrades` and their PnL recompute is directionally correct, but M49 does not add a liquidation
  audit marker — see Risk notes (a `WARN` on suspected liquidation is the only in-scope touch).

---

## ADR impact

- **ADR 0010 (Reconciliation & drift policy) — AMEND (primary).** §1b currently states exit_price /
  realized_pnl "stay null (not recoverable without account-history; M9 backfills)." Amend §1b **and**
  the §1f closed-branch to specify the new **fetch-closing-fills-before-finalize** step: on a
  `RECONCILED_MISSING` finalize, the reconciler MUST attempt `fetchMyTrades(symbol, sinceMs=openedAt)`,
  record the matched reduce/close trades to the ledger, then finalize — falling back to null PnL only
  when the fetch returns nothing or fails (the close must never be blocked).
- **ADR 0001 (Exchange & market-data boundary) — additive note.** Records the new read-only
  `fetchMyTrades` facade + `IMyTradeSnapshot` boundary type on the account-state read surface
  (decimal-as-string), routed through `callExchange` + the D14 live-account-state capability guard.
- **ADR 0012 (Funding & PnL) — NO formula change; one clarifying sentence (M5).** The §5 aggregate
  formula is reused unchanged. But ADR 0012 §5 and the `PositionService.finalizeRealizedPnl` /
  `aggregatePnl` comments currently document `null exit_price` / `null realized_pnl` as **the**
  expected `RECONCILED_MISSING` outcome — that becomes stale once M49 populates them. Add a clarifying
  sentence (to the ADR 0010 amendment and as an additive note where ADR 0012 §5 / the
  `PositionService.ts:294-315` comment describe the reconciliation-close case): **post-M49, null PnL
  is expected ONLY when the closing-fill fetch is unavailable (empty result or fetch failure), not as
  the normal `RECONCILED_MISSING` outcome.**
- **No new ADR required.** The architect signs off on the ADR 0010 §1b/§1f amendment (a contract
  touch on the reconciliation finalize sequence), the ADR 0001 additive note, the ADR 0012 §5
  clarifying sentence, and the new `RECONCILED_MISSING_UNRECOVERABLE` event payload (D3.1, routed
  through `bot-shared-maintainer` if shared) before the engineer wires D3.

---

## QA requirements (paired tests; happy path + adversarial)

Per `docs/best-practices/dev-qa-cycle.md` §2/§4 — each deliverable ships a test that fails before /
passes after; adversarial coverage is the bar for done; adversarial failures route to the architect.

**Happy path (regression backbone):**

1. **Case-b backfill (D3).** Position in `OPEN`, exchange shows it gone, `fetchMyTrades` returns one
   closing trade (`realizedPnl != 0`) → after the tick the row is `CLOSED` with `realized_pnl`,
   `exit_price`, and `fees` **non-null** and equal to the values derived from the fetched trade.
   (Fails today: both null.)
2. **Case-f closed-branch backfill (D3).** `RECONCILING` row, terminal order status, exchange qty 0,
   `fetchMyTrades` returns the closing trade → finalized `RECONCILED_MISSING` with non-null PnL.
3. **Facade + port (D1).** `fetchMyTrades` maps a ccxt trade to `IMyTradeSnapshot` with all money
   fields (including `realizedPnl`) as decimal-as-string; routes through `callExchange` + the
   capability assertion; `IMyTradeSnapshot` carries **no `reduceOnly`** field.
4. **Ledger recording (D2).** `recordReconciledClosingFills` inserts one `REDUCE`/`CLOSE` row **per
   `orderId`** with correct side-signed `cashflow` vs `entryPrice`, and `aggregatePnl` then yields the
   expected realized PnL + vol-weighted exit price.

**Adversarial (the bar for done):**

5. **Fill not found.** `fetchMyTrades` returns `[]` → row STILL finalizes `CLOSED` with null PnL
   (graceful degradation), a `WARN` is logged, **the `RECONCILED_MISSING_UNRECOVERABLE` event fires
   with `reason='no_fills_found'`** (D3.1), and the slot is released — the row must not stay stuck in
   `RECONCILING`.
6. **Fetch throws / exchange outage.** `fetchMyTrades` rejects → caught, finalize proceeds with null
   PnL, error logged, **`RECONCILED_MISSING_UNRECOVERABLE` fires with `reason='fetch_failed'`**, tick
   does not cascade (ADR 0010 §6).
7. **Multi-partial-fill single close (B1 — the truncation guard).** ONE closing `orderId` with
   **N partial fills** at different prices → aggregated into ONE row: `qty` = Σ amounts, `price` =
   volume-weighted across partials, `fee` = Σ fees, `realized_pnl` correct. **Assert no partial is
   silently dropped** by the unique constraint (the exact failure Option A prevents).
8. **Multi-order close.** Several distinct closing `orderId`s → one row each; `exit_price` =
   volume-weighted across the per-order rows; `fees`/`realized_pnl` summed.
9. **Entry fill excluded (H1).** A trade with `realizedPnl = 0` (entry fill) in the fetch window is
   **not** recorded as a closing fill; only `realizedPnl != 0` opposite-side trades are.
10. **Dedup vs prior executor REDUCE (B2).** A `REDUCE` already recorded by `ExecutionService` under
    `exchange_order_id = orderId` is **not** double-counted — `findByExchangeOrderId` excludes it
    before insert (no reliance on cross-clock timestamps).
11. **Idempotency / re-fetch.** Running the backfill twice (overlapping/re-tick) inserts each order
    **once** (dedup on `exchange_order_id` + the synthetic `client_order_id`
    `reconciled-{positionId}-{orderId}`); finalize is idempotent via the CLOSED out-edge absence.
12. **BNB fee currency (H2).** A closing fill with `feeCurrency='BNB'` → its fee is recorded as `0`
    for PnL, a `WARN` is emitted, and USDT `realized_pnl` is **not** corrupted by the BNB amount.
13. **Realized-PnL divergence probe (M2).** When `SUM(trade.realizedPnl)` diverges from the computed
    `fillPnl` by `> 1%` or `> $0.10`, a `WARN` fires; the stored value stays the ledger-derived one.
14. **Side sign.** SHORT close cashflow sign is correct (`(entry − exit)·qty`), not LONG's.
15. **PAPER inert (anti-coverage).** Under PAPER the reconciliation tick is a no-op and
    `fetchMyTrades` is **never called** on the LIVE finalize path (assert not-called); the
    StuckPositionSweeper `RECONCILING`/`pending_open` PAPER paths still finalize with null PnL
    (unchanged — no regression).
16. **Determinism.** `sinceMs` derives from `position.openedAt`, `nowMs` is plumbed; no `Date.now()`
    inside the reconciliation classifier (replay-safe).

---

## Risk notes

- **The close must never be blocked by a history read.** A `fetchMyTrades` failure or empty result
  MUST fall through to the existing null-PnL finalize so the row always leaves `RECONCILING`
  (ADR 0010 §6 — reconciliation outage must not cascade to the trade loop). The fix is
  **best-effort enrichment**, not a precondition.
- **Concurrent reconciliation.** The tick `running` guard prevents overlapping passes; the CLOSED
  state has no out-edge (finalize is idempotent); and `recordReconciledClosingFills` dedups on
  `exchange_order_id` (+ the synthetic `client_order_id`). Three independent backstops against
  double-finalize / double-insert — none of them relies on cross-clock timestamp comparison.
- **Entry-vs-exit trade disambiguation (H1).** Closing fills are selected by `realizedPnl != 0` (which
  Binance reports only on reducing fills — entry fills are `0`), cross-checked by opposite side.
  `reduceOnly` is **not** used (it is a phantom field on `userTrades`). The entry fill is therefore
  excluded by construction, not by a fragile timestamp filter.
- **Multi-partial-fill aggregation (B1).** Binance returns one `userTrades` row per partial fill;
  all partials of one order share `orderId`/`clientOrderId`. D2 aggregates per `orderId` into a
  single ledger row (VWAP price, summed qty/fee) so the unique constraints never silently drop the
  2nd–Nth partial. Without this, `exit_price` and `fees` would be undercounted.
- **Partial fills (close completeness).** Case-b only fires once the exchange shows the position
  **fully gone**, so the full closing quantity has settled; aggregating all `realizedPnl != 0`
  opposite-side trades captures the complete exit. A residual qty would route to case-c
  (`QTY_MISMATCH`), not here.
- **Timestamp window.** `sinceMs = openedAt` is a conservative lower bound (the close is always after
  the open). Binance caps `fetchMyTrades` history windows; `openedAt` for an open position is well
  inside the allowed window. If a very old adopted row ever hit this path, an empty result degrades
  gracefully (risk note 1).
- **PAPER / shadow inert.** The reconciliation tick is a PAPER no-op (`runTickNow` short-circuit);
  `CcxtExecutionClient` / live account-state reads are PAPER-guarded; the shadow path never touches
  reconciliation. No live trade behavior changes — this is purely close-side bookkeeping fidelity.
- **BNB / non-USDT fees (H2).** `aggregatePnl` sums fees into USDT PnL with no currency check and the
  schema has no fee-currency column. M49 records non-USDT fees as `0`-for-PnL and `WARN`-flags them
  (D2). Stated constraint: PnL is correct for USDT-fee closes; a BNB-fee close under-reports the fee
  (PnL slightly optimistic by the unconverted fee) but is **never corrupted by a unit mismatch**. Full
  BNB→USDT normalization is a pre-existing cross-milestone gap, not opened here.
- **Liquidation fills (M3 — out of scope, WARN only).** A force-liquidated position's fills appear in
  `fetchMyTrades`; the PnL recompute is directionally correct, but the row finalizes as
  `RECONCILED_MISSING` with no liquidation audit marker. Liquidation detection/labelling is **out of
  scope for M49** and noted as a follow-up; the only in-scope touch is a `WARN` on a suspected
  liquidation fill **if** ccxt surfaces a usable signal (e.g. an ADL/liquidation marker in the trade
  `info`). Do not build liquidation classification here.
- **Funding completeness not guaranteed (M4).** A position whose close was never recorded locally may
  **also** have missed late funding settlements; M49 recovers the closing **fills** but does not
  guarantee the funding ledger is complete for such a row. Therefore `realized_pnl` may remain
  funding-incomplete after M49. This is **expected and acceptable** — M49's scope is the closing-fill
  gap (exit_price / fill PnL / fees), not funding backfill, which the periodic funding ingestion sweep
  owns separately (ADR 0012 §2).
- **Money is decimal end-to-end.** `IMyTradeSnapshot` carries decimal-as-string; the only float
  touch is the ccxt boundary parse (same documented exception as every other snapshot mapper),
  immediately re-stringified before any math.
- **Historical hollow rows remain null.** M49 does not retro-repair pre-M49 `RECONCILED_MISSING`
  rows; an optional one-shot operator backfill is logged as a tech-debt follow-up, not bundled here.
