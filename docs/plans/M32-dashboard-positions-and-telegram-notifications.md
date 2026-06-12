# M32 — Dashboard closed-positions history + Telegram position notifications

**Status:** PLAN — not yet dispatched

---

## 0. Pre-flight discovery (read before estimating scope)

The architect inspected the live codebase before writing this plan. **Both workstreams are
much smaller than the brief assumes** because the contract and infrastructure already exist:

- **Workstream A (dashboard closed positions).** The shared contract is already complete.
  `IClosedPositionView` (`packages/shared/src/interface/IClosedPositionView.ts`) already
  carries every requested field — `symbol, side, entryPrice, exitPrice, qty, leverage,
  realizedPnlUsd, openedAt, closedAt, exitReason, strategyVersionId`. The engine endpoint
  `GET /v1/positions/closed` exists and is cursor-paginated (`PositionsController.listClosed`,
  `mapClosedPosition`). The dashboard query hook `usePositionsClosed(cursor)` **already exists**
  in `apps/dashboard/src/api/queries.ts` and is wired to `READ_API_PATHS.positionsClosed`.
  **The only gap is the UI** — no view renders the hook, and the Positions tab has no
  open/closed toggle. **There are no shared-contract changes for Workstream A.**

- **Workstream B (Telegram notifications).** The Telegram pipeline is **already built** (M9,
  ADR 0024). `apps/engine/src/alert/` contains `TelegramAlertSink` (outbound-only `sendMessage`
  via built-in `fetch`, opt-in boot guard: degrades to log-only when the token is unset in
  non-prod, throws in prod), `AlertRateLimiter`, `AlertRedactor`, and `RiskListeners` which
  **already subscribes to `POSITION_OPENED_EVENT` and `POSITION_CLOSED_EVENT`** and pushes an
  `IAlertPayload` to the sink. Config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) and
  `.env.example` entries already exist. The module is wired via `BootstrapModule`.
  **The gap is payload content.** Today the open alert body is only
  `positionId=<id> symbol=<sym>` and the close alert omits entry/exit price, hold duration,
  leverage, side label and strategy version. **There is no new module to build** — M32 enriches
  existing listeners and the event payloads they consume.

This reframes M32 as a **two small enrichment workstreams**, not greenfield construction. The
plan below reflects the real surface.

---

## 1. Goal

Make closed-position history visible in the dashboard and make Telegram position-lifecycle
notifications operator-useful. Workstream A adds a Closed sub-view to the Positions tab that
renders the already-existing `usePositionsClosed` cursor-paginated hook with closed-specific
columns and reuses the existing detail page. Workstream B enriches the already-wired
`POSITION_OPENED` / `POSITION_CLOSED` Telegram alerts so the messages carry side, leverage,
entry/exit price, notional, realized PnL (fee+funding net), hold duration, and strategy
version — observability only, never touching the order/risk path.

## 2. Non-goals

- **No editing or closing positions from the dashboard.** Read-only stays read-only
  (ADR 0022 §2.7). The kill-switch button is the only control surface and it is unchanged.
- **No inbound Telegram command handling.** Send-only is a hard invariant (ADR 0024 §2.1):
  no `getUpdates`, no webhook, no command parsing. M32 does not relax this.
- **No new Telegram alert types beyond the two position-lifecycle events.** Halt/resume,
  daily PnL summary, order-reject, model-divergence alerts already exist and are untouched.
  M32 does **not** add halt-event push notifications (already covered by ADR 0024 §2.2).
- **No WS push for closed positions.** Closed positions are immutable after close; cursor
  pagination + the existing 60s stale-time poll is sufficient. No `IClosedPositionView`
  WS room is added (ADR 0023 untouched).
- **No new persisted columns and no migration.** Both workstreams read existing entity
  columns and existing event payloads. (One in-memory event payload widening — see §5 —
  is a code change, not a schema change.)
- **No realized-PnL recompute.** `positions.realized_pnl` is already fee-and-funding-net
  per ADR 0012 (`realizedPnl = fillPnl − feesPaid + fundingPaid`); M32 surfaces the stored
  value, it does not recompute fees or funding.

---

## 3. Workstream A — Dashboard: closed-positions history

### 3.1 Design decisions

- **Sub-tab inside the Positions panel, not a new top-level tab.** The existing tab strip in
  `apps/dashboard/src/shell/Shell.tsx` has three tabs (`positions`, `decisions`,
  `performance`). M32 keeps the top-level `Positions` tab and adds an **Open / Closed toggle**
  *inside* the positions panel. Rationale: an operator thinks "show me positions, open or
  closed" — same domain, one tab, a segmented control. This avoids a four-tab strip and keeps
  the open-position live view (with its 1s age ticker and WS-driven refresh) as the default
  landing surface.

- **New container component `PositionsPanel`** owns the toggle state and renders either the
  existing `PositionsTable` (open) or a new `ClosedPositionsTable` (closed). `Shell` renders
  `PositionsPanel` instead of `PositionsTable` directly. `PositionsTable` stays unchanged
  (open positions only — keep its live mark/age behaviour intact).

- **Status filter = the Open/Closed segmented toggle itself.** The brief asks for a status
  filter of at minimum open/closed; the toggle IS that filter. Symbol/Side filters on the
  closed view are MVP-deferred (see §9 tech-debt) to keep this wave small — the closed table
  ships with the toggle + symbol-substring client filter on the loaded page only if trivial,
  otherwise no filter in v1. Decision: **no Symbol/Side filter on closed in v1** (load-more
  + the detail drawer is enough; matches the conservative small-iteration rule).

### 3.2 Contract gaps

**None.** `IClosedPositionView` already exposes `symbol, side, entryPrice, exitPrice, qty,
leverage, realizedPnlUsd, openedAt, closedAt, exitReason, strategyVersionId`. `IPaginated<T>`
and the cursor protocol already exist. `usePositionsClosed(cursor)` already exists and returns
`IPaginated<IClosedPositionView>`. No `bot-shared-maintainer` work is required for Workstream A.

### 3.3 Query hook

- **Reuse `usePositionsClosed`** as-is for page 1. For load-more/pagination, the cleanest path
  is to convert it to a cursor-stack pattern (the exact pattern `DecisionsFeed` uses today:
  a `cursorStack` state array, Previous/Next buttons keyed off `data.nextCursor`). The
  dashboard agent should mirror `DecisionsFeed`'s Previous/Next paging rather than infinite
  scroll — it is the established, tested pattern in this codebase and keeps UX consistent.
- No new query function is needed. No WS hook is needed (closed rows are immutable). The
  existing `STALE_TIME_CLOSED_MS = 60_000` is correct.

### 3.4 Columns (closed view)

Order, left to right, all read directly from `IClosedPositionView`:

| Column | Source field | Rendering note |
|---|---|---|
| Symbol | `symbol` | plain |
| Side | `side` | Badge: `success` for long, `destructive` for short (reuse `sideVariant`) |
| Leverage | `leverage` | `{leverage}x` |
| Entry | `entryPrice` | `formatMoneyString(_, 4)` |
| Exit | `exitPrice` | `formatMoneyString(_, 4)`; render `—` when `null` (M9 nullability rule) |
| Realized PnL | `realizedPnlUsd` | `formatMoneyString(_)`; render `—` when `null`; tint by sign |
| Exit reason | `exitReason` | Badge mapping `stop_loss`/`take_profit`/`signal`/`time_stop`/`manual`/`kill_switch`/`unknown` |
| Hold duration | `closedAt − openedAt` | new helper `formatDurationMs(openedAtIso, closedAtIso)` in `lib/utils` |
| Strategy version | `strategyVersionId` | `font-mono text-xs` |

- **Money stays string end-to-end.** Sign-tinting reads the leading `-` of the decimal string
  or compares via `decimal.js` (already a dashboard dep) — never `parseFloat`.
- Each row is clickable → navigates to `/positions/:id` (same `onOpen` pattern as
  `PositionsTable`), opening the existing detail page.

### 3.5 Position detail page — sufficiency check

`PositionDetail.tsx` renders `IPositionDetailView`, which is **open-shaped** (it has
`currentPrice`, `unrealizedPnlPriceUsd`, no `exitPrice`/`realizedPnl`/`closedAt`/`exitReason`).
For a closed position the engine's `mapPositionDetail` returns the open shape regardless of
state, so a closed row's detail page currently shows "unrealized PnL" and "mark/current" which
are meaningless post-close.

**Decision for M32 (kept small):** the detail page is *adequate but imperfect* for closed
positions. The MVP ships the closed **table** with the full closed columns (which is where the
operator reads exit price / realized PnL / exit reason / hold). The detail page is **not**
extended to add closed-specific fields in M32 — that would require widening
`IPositionDetailView` (a shared-contract change) and `mapPositionDetail` to surface
`exitPrice`/`realizedPnl`/`closedAt`/`exitReason`. That is logged as a **MEDIUM tech-debt
item** (§9) rather than pulled into this wave. The dashboard agent must, however, ensure the
detail page does not *mislead*: when `state` is a terminal/closed state, the "Time in trade"
and "Mark / current" / unrealized-PnL cards should label clearly (e.g. show `state` prominently)
so an operator is not confused by a live-looking mark on a closed row. This is a labelling-only
change within the existing view, no contract change.

### 3.6 Component changes (Workstream A)

- **New:** `apps/dashboard/src/views/PositionsPanel.tsx` — owns Open/Closed segmented toggle,
  renders `PositionsTable` or `ClosedPositionsTable`.
- **New:** `apps/dashboard/src/views/ClosedPositionsTable.tsx` — closed columns + cursor-stack
  Previous/Next paging (mirror `DecisionsFeed`), row → detail navigation.
- **New helper:** `formatDurationMs` in `apps/dashboard/src/lib/utils.ts`.
- **Edit:** `apps/dashboard/src/shell/Shell.tsx` — `positions` tab renders `<PositionsPanel />`.
- **Edit (labelling only):** `apps/dashboard/src/views/PositionDetail.tsx` — surface `state`
  prominently so a closed row's live-looking fields are not misleading.
- **Specs:** `PositionsPanel.spec.tsx`, `ClosedPositionsTable.spec.tsx` (paging, null exit
  price/PnL rendering, hold-duration formatting, row click → navigate).

---

## 4. Workstream B — Telegram position notifications (enrich existing pipeline)

### 4.1 What already exists (do not rebuild)

- `apps/engine/src/alert/sink/AlertSinkModule.ts` — sink port `IAlertSink` + `ALERT_SINK` token
  + Noop/Telegram factory.
- `apps/engine/src/alert/TelegramAlertSink.ts` — outbound-only `sendMessage` via `fetch`,
  5s timeout via `AbortController`, 429 `retry_after` honour, network failures log+drop,
  opt-in boot guard (log-only in non-prod when token absent; throws in prod).
- `apps/engine/src/alert/AlertRateLimiter.ts`, `AlertRedactor.ts` — global ceiling + secret
  redaction (every payload passes through `redactPayload` before the wire).
- `apps/engine/src/alert/listeners/RiskListeners.ts` — **already** `@OnEvent(POSITION_OPENED_EVENT)`
  and `@OnEvent(POSITION_CLOSED_EVENT)`, builds `IAlertPayload`, calls `alerts.publish`.
- Config + `.env.example` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) already present.

**M32 changes the message *content*, not the transport, the rate-limiter, the redactor, or the
opt-in boot guard.** All the brief's safety requirements (opt-in, never crash the engine,
fire-and-forget, no order-path involvement, send-only) are already satisfied by the existing
pipeline — M32 must preserve them, not re-implement them.

### 4.2 The real gap: thin event payloads

`POSITION_OPENED_EVENT` is emitted by `ExecutionService` with only
`{ positionId, symbol }` — it lacks side, leverage, entry price, notional, strategy version.
`POSITION_CLOSED_EVENT` (`IPositionClosedEvent`) carries
`{ positionId, symbol, side, exitReason, realizedPnl, closedAt }` — it lacks entry price,
exit price, leverage, strategy version, and `openedAt` (so hold duration cannot be computed by
the listener).

To produce the required messages, the **event payloads must be widened** so the listener has
the fields without reaching back into the DB (the listener must stay a pure consumer — no new
repository call in the alert path, per ADR 0024's "alerts never touch the trade loop / never
add I/O hops" spirit).

### 4.3 Decision: widen the open event payload + the closed event interface

The execution service already holds the fully-populated `positionRow` (open) and `finalized`
position (close) at emit time. Widen the payloads from data already in hand — zero extra I/O.

**`POSITION_OPENED_EVENT` payload** — introduce a typed `IPositionOpenedEvent`
(`apps/engine/src/common/interface/`, mirroring `IPositionClosedEvent`):

```
IPositionOpenedEvent {
  positionId: number
  symbol: string
  side: PositionSideEnum
  leverage: DecimalValue            // PositionEntity.leverage is DecimalValue, not MoneyValue
  entryPrice: MoneyValue
  entryNotional: MoneyValue        // entry_notional column, already on the row
  strategyVersionId: number
}
```

**`IPositionClosedEvent`** (shared-package interface? — see §6) — add the fields needed for the
close message that are not already present:

```
+ entryPrice: MoneyValue
+ exitPrice: MoneyValue | null
+ leverage: DecimalValue           // DecimalValue — it is a multiplier, not money
+ strategyVersionId: number
+ openedAt: Date                   // to compute hold duration in the listener
```

> **`leverage` type note:** `PositionEntity.leverage` is typed `DecimalValue` (not `MoneyValue`)
> at `PositionEntity.ts:55`. It must be typed `DecimalValue` in both event interfaces and
> rendered as `{leverage}x` in the formatter — never passed through the `$X.XX` money
> formatter.

> **Contract-location note (resolve in Wave 1):** `IPositionClosedEvent` currently lives in
> the **engine** (`apps/engine/src/common/interface/IPositionClosedEvent.ts`), not in
> `packages/shared/`, and uses the engine-local `MoneyValue` type. It is an **in-process bus
> payload**, not a wire DTO — it never crosses the read-API boundary. Therefore widening it is
> an **engine-internal** change, NOT a `packages/shared` change. The new `IPositionOpenedEvent`
> follows the same pattern (engine-local interface, `MoneyValue` fields). `bot-shared-maintainer`
> is **not** required for Workstream B unless the architect later decides these payloads should
> be shared (they should not — they carry `MoneyValue`, an engine type). See §6.

### 4.4 Message formatting — pure functions, money as decimal strings

Add a pure formatting module `apps/engine/src/alert/format/positionAlertText.ts` with two
exported pure functions (no I/O, no `Date.now()`, clock injected by the caller):

- `formatPositionOpenedBody(event: IPositionOpenedEvent): string`
- `formatPositionClosedBody(event: IPositionClosedEvent): string`

Money is rendered from `MoneyValue` via the existing money helper (`formatMoney` / `toFixed`)
to a decimal string — **never `Number()`, never float**. ADR 0024 §2.3 already mandates
human-friendly `$1,234.56` two-decimal display in the *rendered* Telegram text (the structured
`data` map keeps full precision); the new formatters follow that convention **for USD-denominated
fields only** (notional, realized PnL). **Entry and exit prices use adaptive precision** — not
fixed 2dp — to avoid rendering micro-priced coins (e.g. SHIB at `$0.00001823`) as `$0.00`. The
formatter must choose precision based on the price magnitude: use 2dp for prices ≥ $1, 4dp for
prices ≥ $0.01, 8dp otherwise. This mirrors the dashboard's `formatMoneyString(_, 4)` rule for
price columns. A `positionAlertText.spec.ts` case must assert a sub-cent entry price is not
flattened to `$0.00`.

Hold duration is computed from `closedAt − openedAt` as a pure `formatDuration(ms)` helper.
The helper must guard against zero or negative values (same-millisecond close or minor clock
skew) and render `0s` rather than a negative string. Duration renders `n/a` when `closedAt` is
null (reconciliation edge case — `IPositionClosedEvent.closedAt` is `Date | null`).

The listener (`RiskListeners.onPositionOpened` / `onPositionClosed`) is updated to consume the
widened payloads and call the new formatters for `body`, and to populate the structured `data`
map with full-precision string fields (`side`, `leverage`, `entryPrice`, `exitPrice`,
`entryNotional`, `realizedPnl`, `strategyVersionId`, `holdMs`). `title` stays the existing
`Position opened — <symbol>` / `Position closed — <symbol>`.

### 4.5 Example messages (rendered Telegram text)

**Opened:**

```
[INFO] Position opened — BTC/USDT:USDT
SHORT 3x @ $64,250.00  ·  notional $750.00  ·  strat v3
```

**Closed (win):**

```
[INFO] Position closed — BTC/USDT:USDT
SHORT 3x  ·  entry $64,250.00 → exit $63,900.00
realized +$12.18 (net)  ·  held 1h 42m  ·  exit: take_profit  ·  strat v3
```

**Closed (loss, missing exit price):**

```
[INFO] Position closed — ETH/USDT:USDT
LONG 2x  ·  entry $3,420.00 → exit n/a
realized −$8.40 (net)  ·  held 23m  ·  exit: stop_loss  ·  strat v2
```

> **(net)** = fee-and-funding-net. The stored `positions.realized_pnl` already deducts both
> trading fees and funding payments (`fillPnl − feesPaid + fundingPaid`). The label `(net)` is
> used rather than `(fee-net)` to avoid an operator reconciliation surprise on funding-bearing
> holds where the number would not equal `fillPnl − fees`.

- `realized` shows `n/a` when `realizedPnl` is null (never fabricate `0` — ADR 0022 §2.3.1
  nullability rule applies to the message too).
- `exit price` shows `n/a` when `exitPrice` is null.
- PnL sign prefix (`+`/`−`) derived from the decimal string sign, not float comparison.

### 4.6 Error handling / opt-in / safety (preserved, not changed)

- **Opt-in boot guard:** unchanged — `TelegramAlertSink` already degrades to log-only when
  the token is unset in non-prod and throws in prod (ADR 0024 §2.7). Engine boots cleanly with
  `TELEGRAM_BOT_TOKEN` unset. M32 must not regress this.
- **Never crashes / never blocks:** unchanged — `publishSafe` already swallows publish errors
  and logs; `TelegramAlertSink.sendSafely` already times out, drops on network failure, and
  honours 429. The new formatters are pure and synchronous; a formatter throwing would be
  caught by `publishSafe`'s try/catch, but the formatters must be written total (no throw on
  null fields — they branch to `n/a`).
- **No order-path involvement:** the listener reads event payloads only; it calls no execution
  or risk service. Unchanged.
- **Redaction:** every payload still passes `redactPayload`. The new `data` fields are money
  strings and enum values — no secret shapes — but they still go through the redactor and the
  three-field render whitelist (`severity`/`title`/`body`) in `TelegramAlertSink`, so only the
  formatted body reaches the wire.

### 4.7 Engine component changes (Workstream B)

- **New:** `apps/engine/src/common/interface/IPositionOpenedEvent.ts` (engine-local; uses
  `MoneyValue` for price/notional fields and `DecimalValue` for `leverage`).
- **Edit:** `apps/engine/src/common/interface/IPositionClosedEvent.ts` — add the five fields
  (§4.3); `leverage` typed `DecimalValue`.
- **Edit:** `apps/engine/src/execution/service/ExecutionService.ts` — populate the widened open
  payload at the `POSITION_OPENED_EVENT` emit (line ~951) and the closed payload at the
  `closedEvent` construction (line ~439). Data already in hand (`positionRow` / `finalized`).
- **New:** `apps/engine/src/alert/format/positionAlertText.ts` — pure formatters + duration helper.
- **Edit:** `apps/engine/src/alert/listeners/RiskListeners.ts` — `onPositionOpened` /
  `onPositionClosed` consume widened payloads, call formatters, populate full-precision `data`.
- **Retype (no logic change) — all four `POSITION_OPENED_EVENT` consumers:** the event is also
  consumed by `PositionInstrumentor.onPositionOpenedEvent` (reads `{positionId, symbol}`),
  `RiskStateLifecycleListener.onPositionOpened` (ignores payload), and
  `LiveGateway.onPositionOpened` (reads `{positionId, symbol}`). All three are structurally
  safe (they read a subset). The engine agent **must retype** all three handler signatures from
  inline `{ positionId: number; symbol: string }` literals to the new `IPositionOpenedEvent`
  so they don't drift from the interface. This is a type-annotation change only — no logic
  change in those three files.
- **Specs:** `positionAlertText.spec.ts` (pure formatting: win/loss, null exit price, null PnL,
  zero PnL, sub-cent price not flattened to `$0.00`, duration boundaries — 0s/sub-minute/hours/
  days, negative/zero duration guard, `(net)` label); update `RiskListeners` `__tests__` for
  the new payload shapes; an integration-style listener test with a mocked `IAlertSink`
  asserting the published `body`/`data` (no real HTTP).

---

## 5. In-memory payload widening (not a schema change)

To be explicit for the reviewers: §4.3 widens **in-process event-bus payloads**, which are
plain TypeScript interfaces consumed by `@OnEvent` listeners. This is **not** a database
migration, **not** a wire/read-API DTO, and **not** a `packages/shared` change. No column is
added; the execution service projects fields it already holds onto the event. The
trading-safety invariants are untouched — the events are emitted *after* the fill/close
completes (post-lifecycle observability), exactly as today.

---

## 6. Shared-contract changes

**Workstream A:** none. `IClosedPositionView`, `IPaginated`, `READ_API_PATHS.positionsClosed`,
and `usePositionsClosed` all already exist.

**Workstream B:** none in `packages/shared`. The widened payloads (`IPositionOpenedEvent`,
`IPositionClosedEvent`) are engine-local bus interfaces carrying `MoneyValue` (an engine type),
not wire DTOs — they must **not** move into `packages/shared` (shared types are float-free
string-money wire contracts; pushing a `MoneyValue`-typed bus payload into shared would leak an
engine concern across the boundary). `AlertTypeEnum.POSITION_OPENED` / `POSITION_CLOSED` already
exist in shared; no enum change.

**Net: `bot-shared-maintainer` has no required work in M32.** Wave 1 runs only to confirm
"no shared change needed" and to adjudicate the §4.3 contract-location note (keep both event
interfaces engine-local). If the adjudication unexpectedly concludes a shared change is needed,
Wave 1 absorbs it before Wave 2.

---

## 7. ADRs to create or amend

- **Amend ADR 0024 (Telegram alerts)** — add §2.2a "Position-lifecycle alert payload enrichment
  (M32)". Document: the open/close alert *bodies* now carry side, leverage, entry/exit price,
  notional, realized PnL (fee-net), hold duration, strategy version; the message renders money
  as `$X.XX` two-decimal display per §2.3 while the structured `data` map keeps full
  decimal-string precision; null exit-price / null realized-PnL render as `n/a` (never `0` —
  inherits ADR 0022 §2.3.1 nullability rule); the event payloads were widened in-process (no
  migration, no shared DTO); send-only / opt-in / fire-and-forget / no-order-path invariants
  are explicitly **unchanged**. Rationale: the alert taxonomy and transport are already
  ADR 0024's; M32 only enriches existing rows, so an amendment is correct, not a new ADR.

- **Amend ADR 0022 (read-API surface)** — light touch, optional. Add a one-line note under
  §2.2 confirming the dashboard now *consumes* `GET /v1/positions/closed` (the endpoint and
  `IClosedPositionView` are unchanged; this is a consumer note, not a contract change). Only
  add if the scribe judges it useful; not load-bearing.

- **No new ADR.** Workstream A introduces no new architectural decision (it consumes an existing
  contract via an existing hook). Workstream B is an amendment to an existing accepted ADR.

---

## 8. Dispatch waves

Per `CLAUDE.md` wave pattern and `docs/best-practices/dev-qa-cycle.md` (≤5 files/items per
dispatch, reviewer continuity, architect on contract touches).

- **Wave 1 (serial) — `bot-shared-maintainer`:** Confirm **no** shared-package change is needed
  for either workstream (adjudicate §4.3 / §6 — keep `IPositionOpenedEvent` and
  `IPositionClosedEvent` engine-local). Output: a one-line confirmation, or, if the
  adjudication flips, the minimal shared addition. Expected: no-op.

- **Wave 2 (parallel):**
  - **`bot-engine-nestjs`** — Workstream B: new `IPositionOpenedEvent`, widen
    `IPositionClosedEvent`, populate both payloads in `ExecutionService`, new pure
    `positionAlertText.ts` formatters, update `RiskListeners` consumers. (5 files + specs.)
  - **`bot-dashboard-react`** — Workstream A: new `PositionsPanel` + `ClosedPositionsTable`,
    `formatDurationMs` helper, wire into `Shell`, labelling fix in `PositionDetail`. (5 files
    + specs.)

- **Wave 3 (serial) — `bot-qa-engineer`:** Adversarial tests. Engine side: null exit price,
  null realized PnL, zero PnL (sign rendering), hold-duration boundaries (0s, sub-minute,
  multi-day), formatter totality (never throws), listener wiring with a mocked `IAlertSink`
  (asserts body + full-precision `data`, no real HTTP), opt-in guard still degrades to log-only
  when token unset. Dashboard side: empty closed list, single page, `nextCursor` paging
  forward/back, `—` rendering for null exit/PnL, row click → `/positions/:id` navigation,
  toggle preserves open-view live behaviour.

- **Wave 4 (parallel) — all four reviewers:** `bot-review-security` (confirm send-only / no
  inbound surface / no secret in new `data` fields / redactor still runs / no order-path call
  added), `bot-review-logic` (event-payload widening correctness; listener consumes the right
  fields; null handling), `bot-review-clean-code` (pure formatters ≤20 lines, no flag args,
  named constants, no float), `bot-review-quant` (money is decimal-string throughout the
  message and `data`; fee-net realized PnL surfaced unmodified; hold-duration math; no
  fabricated sentinels).

- **Wave 5 (serial) — `bot-scribe`:** Amend ADR 0024 (§2.2a) and optionally ADR 0022; update
  `docs/milestone-log.md`, `docs/work-log.md`, the CLAUDE.md status line, `00-overview.md`
  NotificationModule line, and the tech-debt entries (§9). Confirm `.env.example` already
  documents the Telegram vars (it does — no change needed).

Cycle Wave 3↔4 fixes until zero blockers, zero highs, majority of mediums resolved
(`CLAUDE.md` rule 6). Reviewer continuity across rounds.

---

## 9. Tech-debt items to create

- **[MEDIUM] Closed-position detail page surfaces open-shaped fields.** `IPositionDetailView`
  is open-shaped (`currentPrice`, `unrealizedPnlPriceUsd`); a closed row's detail page shows a
  live-looking mark and "unrealized PnL" instead of exit price / realized PnL / exit reason /
  hold duration. M32 ships the closed *table* with full columns and only adds a labelling
  guard on the detail page. Fix: widen `IPositionDetailView` + `mapPositionDetail` with
  nullable closed fields (`exitPrice`, `realizedPnlUsd`, `closedAt`, `exitReason`), gated on
  `state`. **Shared-contract change** — route through `bot-shared-maintainer`. Origin: M32.

- **[MEDIUM] Closed-positions Symbol/Side filter (deferred from M32).** The closed view ships
  with cursor paging only; no Symbol/Side filter (kept the wave small). Add a server-side
  symbol filter on `GET /v1/positions/closed` (mirrors the deferred multi-value `IN (...)`
  decisions-filter debt) plus dashboard filter controls. Origin: M32.

- **[LOW] Open-position alert lacks SL/TP in the message.** The opened message carries entry /
  notional / leverage / strat but not the protective stop/target prices (they are attached
  asynchronously after `POSITION_OPENED_EVENT`). Surfacing them would need either a second
  alert post-attach or reading the attach result. Deferred; not operator-blocking. Origin: M32.

---

## 10. Post-deploy checklist

**Type:** code-only — no migration, no shared-package change, no DB write at rest. Engine
restart (Workstream B) + dashboard redeploy (Workstream A).

**Env vars to set (engine, for Telegram to actually send):**
- `TELEGRAM_BOT_TOKEN=<bot token from @BotFather>` — write-only credential, never committed.
- `TELEGRAM_CHAT_ID=<operator chat id>` — required when the token is set.
- Both already documented in `.env.example`. With the token **unset** the engine still boots
  (log-only in paper/dev). Verify boot is clean both with and without the token before deploy.

**Pre-deploy (DB-safety, per CLAUDE.md rules 8/9):**
1. `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`
   then prune to the 2 most recent. (No migration, but the rule requires a dump before any
   restart that touches the postgres-adjacent stack — restart only the engine container, not
   postgres.)

**Smoke (10-minute live run):**
2. Boot engine **without** `TELEGRAM_BOT_TOKEN` first → confirm clean boot, log line
   `TelegramAlertSink: missing token/chatId in non-production — degrading to log-only`.
3. Set the token + chat id → reboot → confirm no boot error (prod path throws on missing; the
   degrade path is non-prod only).
4. Confirm `AlertModule` boots via `BootstrapModule` with `RiskListeners` resolved (no DI
   cycle, no missing-provider error).

**Verify Telegram messages arrive:**
5. On the first paper open after deploy: a Telegram message lands with the enriched open body
   (side, leverage `Nx`, entry `$X.XX`, notional `$X.XX`, `strat vN`). Cross-check against the
   `POSITION_OPENED` log line and the new row in `/v1/positions/open`.
6. On the first close: a Telegram message with entry→exit, realized `±$X.XX (fee-net)`, hold
   duration, exit reason, `strat vN`. Cross-check realized PnL against the closed row's
   `realizedPnlUsd` (must match the stored fee-net value exactly — no recompute).
7. Confirm null-safety: if a close arrives with null `exitPrice`/`realizedPnl`, the message
   shows `n/a`, never `$0.00`.
8. Confirm `AlertRedactor` still runs over the enriched payload: `TelegramAlertSink.ts`
   calls `redactPayload` unconditionally before `renderAlertText` (the 3-field whitelist of
   `severity`/`title`/`body` means the enriched `data` fields never reach the wire). Verify
   the enriched body contains only money strings and enum values — no secret-shaped strings.

**Verify closed positions appear (dashboard):**
9. Open the dashboard → Positions tab → toggle **Closed** → confirm the closed table renders
   the existing `usePositionsClosed` data with all nine columns.
10. Confirm Previous/Next paging walks `nextCursor` forward and back; the empty state renders
    when there are no closed positions yet.
11. Click a closed row → detail page opens at `/positions/:id`; confirm the `state` label makes
    clear it is closed (the open-shaped mark/unrealized fields are present but labelled, per
    the M32 labelling guard — full closed-field detail is the deferred MEDIUM in §9).
12. Confirm the **Open** toggle still shows live open positions with the 1s age ticker and
    WS-driven refresh unchanged.

**Rollback:** Workstream B is additive payload enrichment behind the existing opt-in sink —
unsetting `TELEGRAM_BOT_TOKEN` disables sends without code change. Workstream A is a pure
front-end addition — reverting the dashboard build removes the Closed toggle with no engine
impact. No data is written by either workstream; no migration to revert.
