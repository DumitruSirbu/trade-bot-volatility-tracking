# ADR 0030 — In-engine rate-limit token-bucket policy (M11a W1.4)

**Status:** Accepted (M11a W1 design wave); amended M46 (2026-06-24, §2.7 — dual-host ledger split)
**Date:** 2026-05-25
**Milestone:** M11a — Local soak hardening
**Depends on:** ADR 0001 (Exchange & market data), ADR 0010 (Reconciliation & drift policy), ADR 0012 (Funding & PnL), ADR 0024 (Telegram alerts), ADR 0028 (Key-permission assertion port).
**Consumed by:** M11a W1.4 implementation in `apps/engine/src/exchange/service/CcxtBinanceExchangeClient.ts`, reconciliation poller (`apps/engine/src/position/service/ReconciliationService.ts`), funding poller (M6 W5), market-data REST fallbacks.

## 1. Context

ccxt 4.5.x ships a single global `enableRateLimit` throttle: a process-wide
minimum gap between any two REST calls, derived from the slowest published rate
class. That single-throttle model does not match Binance Futures' limiter,
which enforces **multiple independent weight classes** over **different
windows**:

- `REQUEST_WEIGHT` — per **IP**, per **1-minute** rolling window. Every REST
  endpoint declares an integer weight. Order placement weighs 1;
  `fetchPositions`, `fetchOpenOrders` (no symbol), `fetchBalance`, and
  `fetchFundingHistory` carry higher per-call weights.
- `ORDERS` — per **UID**, two windows (**10 s** and **1 min**). Counts only
  order placement and cancel; capacity is set by the UID's trading tier.
- `RAW_REQUESTS` — per **IP**, per **5-minute** rolling window. Counts every
  HTTP request regardless of weight.
- Per-symbol order limits exist on some Binance endpoints but are not a
  separate published class for USDT-M Futures at this ADR's time. Treated as
  a defensive sub-bucket per §2.4.

A 429 or 418 from Binance Futures is not recoverable by ccxt's default
backoff. 418 imposes a 2-minute-to-several-hour IP ban during which every
call from the host fails — including reconciliation polls, kill-switch
confirmation, and protective-order arming. For a multi-week soak on a
single host that is an unrecoverable trading-safety event masquerading as
a transient network error.

ccxt's `enableRateLimit` throttles to one window (the slowest), does not
account for per-call weight, does not read Binance's `X-MBX-USED-WEIGHT-*`
and `X-MBX-ORDER-COUNT-*` response headers, and applies one rule per
process (a future second instance would silently double the rate).

**Numeric limits below are the values published by Binance at this ADR's
time.** Implementation MUST re-verify against live Binance Futures
documentation and pin the source values in a single constants file the
bucket configuration reads. The header feedback loop in §2.5 is the
runtime safety net for divergence between the constants and the venue.

## 2. Decision

The engine ships an in-process **multi-class token-bucket limiter** owned by
the exchange module. Every call into `CcxtBinanceExchangeClient` passes
through it; ccxt's `enableRateLimit` is **disabled** because two stacked
throttles confuse the observability (a stall in one is invisible behind the
other).

### 2.1 Weight classes and safety margin

The engine respects four classes, each with its own bucket. **Effective
capacity = floor(Binance published limit × 0.80)** — the 20% safety margin
absorbs clock skew between the engine and Binance, header-feedback lag, and
short bursts the local accounting did not yet observe.

| Class | Scope | Window | Binance published limit (verify at impl) | Effective bucket capacity (80%) | Counts |
|---|---|---|---|---|---|
| `REQUEST_WEIGHT_1M` | per IP, **`/fapi` host** | 1 minute rolling | 2400 weight-units | 1920 | Every `/fapi` REST call, weighted per endpoint. Reconciled from the `/fapi` `X-MBX-USED-WEIGHT-1M` header only (M46 amendment §2.7). |
| `ORDERS_10S` | per UID | 10 seconds rolling | 300 orders | 240 | `createOrder`, `cancelOrder`, `cancelAllOrders` |
| `ORDERS_1M` | per UID | 1 minute rolling | 1200 orders | 960 | same as `ORDERS_10S` |
| `RAW_REQUESTS_5M` | per IP | 5 minutes rolling | 61000 requests | 48800 | Every HTTP request, weight ignored. **Local-only — no readable header.** |
| `SAPI_REQUEST_WEIGHT_1M` (M46) | per IP, **`/sapi` host** | 1 minute rolling | 2400 weight-units | 1920 | Every `/sapi` REST call (boot-time `sapiGetAccountApiRestrictions*`). **Local-only — the `/sapi` host exposes an `X-MBX-USED-WEIGHT-1M` header, but it is a *different* per-IP ledger on a different host that the engine cannot reliably distinguish from the `/fapi` header; treat as un-reconcilable like `RAW_REQUESTS_5M`** (M46 amendment §2.7). |

Per-symbol bursts are handled as a defensive sub-bucket (§2.4), not as a
distinct Binance class.

WebSocket subscriptions (market-data WS, user-data WS) are **out of scope**
for this limiter — they consume Binance's WebSocket connection limits, which
are independently bounded by the M1 `MarketDataModule` connection budget and
are not part of the REST limiter ledger.

### 2.2 Bucket parameters and class assignment

Each bucket is a classic token bucket: `capacity` = the effective number from
the table above; `refillRate` = `capacity / windowSeconds` tokens per second
(continuous refill, not window-edge step); `currentTokens` initialised to
`capacity` at boot. Token cost of a call is the call's declared weight (for
`REQUEST_WEIGHT_1M`) or `1` (for the other three).

A single shared interface owns the contract:

```ts
interface IRateLimitPolicy {
  // Reserve tokens for one call across all classes the call counts against.
  // Returns immediately when capacity is available; the wait/reject behaviour
  // when capacity is exhausted is determined by `mode` (§2.3).
  acquire(call: IRateLimitedCall): Promise<void>;

  // Apply authoritative state from Binance response headers (§2.5).
  // Always called after every REST response, including failures that carry
  // headers (e.g. 4xx with rate-limit headers attached).
  reconcileFromHeaders(headers: Readonly<Record<string, string>>): void;

  // Snapshot for /v1/health and read-API exposure (§5).
  snapshot(): IRateLimitSnapshot;
}

interface IRateLimitedCall {
  // Stable name of the ccxt method (e.g. 'fetchPositions', 'createOrder').
  readonly operation: string;
  // The endpoint's declared REQUEST_WEIGHT — looked up from a per-operation
  // table, never inferred at the call site.
  readonly requestWeight: number;
  // True iff the call places, modifies, or cancels an order — counts against
  // ORDERS_10S and ORDERS_1M.
  readonly isOrderOp: boolean;
  // Symbol if scoped to one; `null` for account-wide calls. Drives §2.4.
  readonly symbol: string | null;
  // The acquisition mode the caller wants (§2.3).
  readonly mode: 'fail-fast' | 'await';
  // Max time the caller will wait in 'await' mode. Required when mode='await'.
  readonly maxWaitMs: number | null;
}
```

**Per-operation weight table** lives in a single module-private const map
seeded from Binance's published per-endpoint weights. New operations cannot
be called through the client without an entry — the type system enforces
that the call-site supplies `IRateLimitedCall`, and the helper that builds
it throws on an unknown operation. Adding a new ccxt method is a two-file
edit (interface + weight table) reviewed in one diff.

**Bucket targeting (M46 amendment).** Each operation in the weight table is
explicitly assigned to the bucket(s) it counts against — the target bucket is
declared in the table, never inferred at the call site (same rule as the
weight value). The `sapiGetAccountApiRestrictions*` operations target
`SAPI_REQUEST_WEIGHT_1M` (the `/sapi` host ledger) instead of
`REQUEST_WEIGHT_1M`; every other weighted operation targets the `/fapi`
`REQUEST_WEIGHT_1M`. All weighted operations continue to count against
`RAW_REQUESTS_5M`. See §2.7 for why the split is host-aligned, not
endpoint-type-aligned.

The implementation is colocated with the exchange module
(`apps/engine/src/exchange/service/`). The buckets are **in-process**;
M11a explicitly excludes multi-instance (that is M11b), so a shared
limiter (e.g. Redis-backed) is intentionally not in scope. M11b ADR will
revisit the topology.

### 2.3 Wait vs reject — per call class

Acquisition mode is declared by the caller, not inferred. Two modes:

- **`fail-fast`** — if any class is below the call's cost, `acquire()`
  immediately throws `ExchangeRateLimitExhaustedException` carrying the
  failing class name + remaining tokens. The call is **never made** to
  Binance. Caller decides what to do.
- **`await`** — `acquire()` resolves after enough tokens have refilled
  across **all** required classes, or rejects with the same exception if
  `maxWaitMs` elapses first. Refill timing uses an injectable monotonic
  clock so backtests stay deterministic per the project's purity rule.

Per-call-site mode assignment:

| Call class | Mode | `maxWaitMs` | Rationale |
|---|---|---|---|
| Order placement / cancel (`createOrder`, `cancelOrderByClientId`) | **fail-fast** | N/A | An order silently delayed by 30 s is worse than an order rejected. The strategy / execution layer decides whether to retry, abort, or escalate. Slippage from a delayed entry is unbounded; a fast failure routes the decision back to the risk gate, which records the miss and continues. |
| Reconciliation poll (`fetchPositions`, `fetchOpenOrders`) | **await** | poll-interval (currently 30 s, read from config) | Reconciliation polls are idempotent and cadence-driven. A 30 s wait is acceptable; missing a poll cycle is also acceptable (the next cycle catches up via the M6 W4a state machine). `maxWaitMs = pollIntervalMs` so a waiting poll never overlaps the next scheduled one. |
| Funding poll (`fetchFundingHistory`) | **await** | poll-interval | Same shape as reconciliation; funding polls are 60-s cadence per M6 W5. |
| Market-data REST fallback (`fetchOpenInterest`, `fetchFundingRate`, `fetchTickers`) | **await** | min(call-budget, 5 s) | These are gate-evaluation reads with a hard upstream deadline. 5 s ceiling because the risk gate's market-stress check has a budget. |
| `loadMarkets` / boot-time `fetchBalance` | **await** | 30 s | Boot calls; a slow boot is acceptable, a failed boot under transient rate pressure is not (it would loop under Docker compose `restart: on-failure` and amplify the issue). |
| Account snapshot writer (M6 W7) | **await** | snapshot-interval | Same shape as reconciliation. |

The mode is part of `IRateLimitedCall` so the call-site declares it
explicitly; there is no default. A reviewer can grep for `mode: 'fail-fast'`
and confirm that order placement is the only call site that fails fast.

### 2.4 Per-symbol bursts

Binance USDT-M Futures does not publish a per-symbol REQUEST_WEIGHT or
ORDERS class as of this ADR. Two real risks remain that justify a defensive
sub-bucket:

1. **One volatile symbol monopolising ORDERS_*.** A symbol whose strategy
   triggers repeated cancel/replace can starve order capacity for the rest
   of the portfolio in the same minute window.
2. **Future Binance addition of a per-symbol class.** Building the sub-bucket
   now means the day Binance ships a per-symbol ORDERS-2 class, the engine
   already accounts for it and the constants file is the only edit.

**Sub-bucket shape:** an additional bucket per `(class, symbol)` for the
`ORDERS_10S` and `ORDERS_1M` classes only — REQUEST_WEIGHT bursts are
already capped account-wide and a per-symbol weight sub-bucket would
double-charge the same headroom. Sub-bucket capacity = `floor(class
capacity × 0.30)` so any single symbol can use at most 30% of the order
budget in either window before the per-symbol bucket throttles further
order placements on that symbol while leaving 70% headroom for the rest of
the portfolio. The 30% number is intentional headroom for a 3-slot M4
position model — one slot can fully utilise its share without starving the
other two.

Sub-bucket exhaustion in `fail-fast` mode raises a distinct exception
subclass `SymbolRateLimitExhaustedException` so the strategy logs the cause
correctly ("this symbol is throttled" vs "the whole UID is throttled").

### 2.5 Header feedback loop

Binance returns rate-limit headers on **every** REST response, including
errors:

| Header | Class it informs |
|---|---|
| `X-MBX-USED-WEIGHT-1M` | `REQUEST_WEIGHT_1M` |
| `X-MBX-ORDER-COUNT-10S` | `ORDERS_10S` |
| `X-MBX-ORDER-COUNT-1M` | `ORDERS_1M` |
| `Retry-After` | Sent on 429/418; the backoff window in seconds |

The implementation:

1. **Where parsing lives.** ccxt parks raw response headers under the
   `last_response_headers` property on the client (and on the exception's
   `httpHeaders` for failures). A small helper in
   `apps/engine/src/exchange/utils/` extracts the rate-limit fields by name
   and returns a typed `IRateLimitHeaders`. The helper is the single source
   of truth for header parsing; `CcxtBinanceExchangeClient.callExchange()`
   invokes it after every call (success and failure) and passes the typed
   result into `policy.reconcileFromHeaders()`.
2. **Authoritative override.** For each class with a fresh header value,
   `reconcileFromHeaders` sets `currentTokens = capacity - usedFromHeader`
   when the header value is **higher** than the local-accounting used
   count (server has counted more than we have). When the header is lower
   (server has expired some window already), the local accounting is **not
   relaxed** — we keep the conservative local value until the next window
   tick. Rationale: the header is a point-in-time snapshot; trusting it to
   release headroom we have not yet refilled would race with another
   in-flight call.
3. **Drift detection (M18 amendment).** The local token bucket runs
   intentionally conservative (continuously refilling, peaking transiently
   above Binance's near-empty rolling window during bursty market-data
   polls, then draining via refill). This means `localUsed > headerUsed` is
   the expected **safe** direction and must stay silent. Only when Binance
   has counted **more** than we have (`headerUsed > localUsed` by ≥ 10% of
   class capacity) does a drift detection fire — this is the genuine
   "stale weight table / approaching a 429 we cannot see" canary. When
   true, a `RATE_LIMIT_DRIFT` event is emitted (logged WARN, recorded once
   per 5 minutes to avoid alert spam; Telegram alert only on the first
   occurrence per boot). M11b will use this signal to validate any
   shared-state limiter design.

### 2.7 Dual-host ledger separation (M46 amendment)

> Section number kept after §2.6 for traceability of the M46 amendment;
> it extends §2.2 (bucket targeting) and §2.5 (header reconciliation).

**Date:** 2026-06-24 · **Milestone:** M46 — Rate-limit ledger audit ·
**Trigger:** M46 Wave 1 investigation, Verdict A (separate-ledger confirmed).

**Finding.** Binance Futures REST traffic crosses **two distinct host
processes**, each maintaining its **own independent per-IP
`REQUEST_WEIGHT` ledger**:

- **`/fapi/*`** (USDT-M Futures host). Public market-data endpoints
  (`fetchOpenInterest`, `fetchFundingRate`, `fetchTickers`, `loadMarkets`)
  and authenticated account endpoints (`fetchPositions`, `fetchBalance`,
  `fetchOpenOrders`, order ops) **share one ledger** on this host and
  expose **one** `X-MBX-USED-WEIGHT-1M` header. There is no second
  readable header for a market-data sub-ledger on `/fapi`.
- **`/sapi/*`** (spot host, used only by boot-time
  `sapiGetAccountApiRestrictions*` per ADR 0028). Runs its **own separate
  per-IP `REQUEST_WEIGHT` ledger** with its own `X-MBX-USED-WEIGHT-1M`
  header instance. The two headers **share a name** but report **different
  ledgers on different hosts** — they are not interchangeable.

**Defect this corrects.** Pre-M46, `CcxtBinanceExchangeClient` held a single
per-client `last_response_headers` slot. Only the most recent response —
from whatever host was last called — lands there. After a `/sapi` boot call,
`reconcileFromHeaders()` wrote the `/sapi` header's value into the `/fapi`
`REQUEST_WEIGHT_1M` bucket, conflating two unrelated ledgers. The
observed symptom was a persistently near-zero (`≈1–6`) `/fapi`
`X-MBX-USED-WEIGHT-1M` header even during a ~240-weight market-data burst:
the slot was carrying the idle `/sapi` ledger's count, not the `/fapi` one.

**Why not a stale weight table (Scenario C).** The local `localUsed ≈ 240–280`
is arithmetically correct (100 OI × 1 + 100 funding × 1 + 1 ticker × 40 = 240
gross, minus continuous-refill drain); every `/fapi` weight-table entry
matches its Binance-documented per-call weight. C requires the header to climb
meaningfully during a burst; a near-zero **persistent** header is structural
(wrong host's ledger), not a stale weight.

**Decision — Option A1 (split `/sapi` to its own bucket).** Add a distinct
local-only `SAPI_REQUEST_WEIGHT_1M` bucket and route
`sapiGetAccountApiRestrictions*` to it (§2.2 targeting). The existing
`REQUEST_WEIGHT_1M` bucket then carries **only** `/fapi` weight, so its
`reconcileFromHeaders()` is now fed **only** from `/fapi` responses and is
correct. Because the `/sapi` ledger's header cannot be reliably distinguished
from the `/fapi` one (same header name, different host, single shared
`last_response_headers` slot), `SAPI_REQUEST_WEIGHT_1M` is **local-only** —
it is never reconciled from a header, exactly like `RAW_REQUESTS_5M`. This is
acceptable: `sapi*` is a low-volume boot-only path (a handful of weight-1
calls), so running it purely on conservative local accounting carries no
realistic ban risk.

**`allBuckets` membership (hard constraint).** `SAPI_REQUEST_WEIGHT_1M` MUST
be a member of the `allBuckets` getter. `engageFreeze()` (§2.6) zeroes every
bucket in `allBuckets` and suspends its refill for the backoff window. A 418
IP ban applies to the **IP**, which covers both the `/fapi` and `/sapi`
hosts; a `sapi` key-permission check firing at boot during an active ban
would hit the same banned IP. A bucket left outside `allBuckets` would keep
refilling through the freeze and could issue a call into a 418 ban — the
exact retry-storm escalation §2.6 exists to prevent.

**Why not Option A2 (split `/fapi` market-data vs account).** Rejected as
incorrect by construction. The `/fapi` `X-MBX-USED-WEIGHT-1M` header reports
the **combined** market-data + account weight for the single `/fapi`
ledger — there is no per-type header. If `REQUEST_WEIGHT_1M` were narrowed to
account-only weight (market-data moved to a separate `MARKET_DATA_WEIGHT_1M`
bucket), the account bucket's `reconcileFromHeaders()` would receive a header
value inflated by market-data weight it no longer tracks. Per §2.5's
authoritative-override rule, `headerUsed > localUsed` would then read as
genuine server-side over-count: the account bucket would be reconciled too
conservatively and the §2.5 `RATE_LIMIT_DRIFT` canary would fire spuriously
every time a market-data poll runs. A2 trades one real bug (host conflation)
for a worse one (a header that structurally over-reports what its bucket
tracks). The split must follow the **host/ledger boundary** (A1), not the
endpoint-type boundary (A2), because the host boundary is the line Binance
actually draws between ledgers.

**Safe-direction note.** On `/fapi` alone the pre-existing failure mode was
already safe: the engine over-counts locally and throttles itself early
versus the real ledger (no silent under-count). The genuine correctness gap
A1 closes is the `/sapi`→`/fapi` conflation; A1 removes the cross-host write
without touching the safe `/fapi` over-count behaviour.

### 2.6 Failure mode — 429 and 418

When Binance returns 429 (rate exceeded) or 418 (IP banned):

1. **Every bucket in `allBuckets` is immediately drained to zero** (the four
   M11a buckets plus the M46 `SAPI_REQUEST_WEIGHT_1M` — see §2.7 for why the
   `/sapi` bucket MUST be a member). Header parsing
   extracts `Retry-After`; the buckets are then frozen (refill suspended)
   for `Retry-After` seconds. If `Retry-After` is missing (rare), the
   default freeze is 60 s for 429 and 120 s for 418 — both intentionally
   longer than Binance's typical minimum so the engine never under-waits.
2. **A halt is issued via the M9 kill-switch contract (ADR 0021)** with
   `reason='RATE_LIMIT_BAN'` and a structured payload carrying the response
   code, the failing class (from the most recent
   `acquire()` call), and the backoff seconds. Halt is `partial:
   'block-new-orders'` — existing positions retain their protective orders
   and reconciliation polls continue (now subject to the bucket freeze,
   which makes them wait, not retry-storm). The halt **auto-clears** at the
   end of the backoff window if no further 429/418 occurred in the interim;
   the existing kill-switch contract handles the audit row + Telegram
   resume alert for an operator-issued resume, but the auto-clear path
   writes its own `control_audit` row with
   `action='RATE_LIMIT_HALT_AUTO_CLEARED'`.
3. **One Telegram CRITICAL alert** fires via the same boot-alert path as
   ADR 0028, with body:

   ```
   BINANCE RATE LIMIT TRIGGERED — new orders halted for <N> seconds.
   Code: 429|418
   Failing class: REQUEST_WEIGHT_1M|ORDERS_10S|ORDERS_1M|RAW_REQUESTS_5M|SAPI_REQUEST_WEIGHT_1M
   Local-used at trip: <N>/<capacity>
   Header-used at trip: <N>/<capacity>
   Drift: <signed pct>
   Retry-After: <N seconds>
   ```

   No values are echoed beyond the class identity and the numeric counts.
   The same channel ADR 0024 documents is reused — no new sink.
4. **The engine does NOT retry the failed call.** The caller of the
   limited operation receives the same `ExchangeRateLimitExhaustedException`
   shape it would have received from a fail-fast bucket exhaustion. ccxt's
   own retry-on-network-error path is disabled for this exception class so
   a 429 cannot loop. A retry storm against a 418-banned IP is the failure
   mode that turns a 2-minute soft ban into a multi-hour escalated ban —
   the policy is **always backoff, never retry**.
5. **A second 429/418 within the freeze window** doubles the freeze duration
   (capped at 1 hour) and re-fires the Telegram alert with the new
   backoff. The doubling lives in the limiter, not the kill-switch — the
   halt is simply extended via a new kill-switch event.

Repeated 429/418 (≥3 in any 24-hour window) is a soak-abort condition. The
abort threshold is recorded in `docs/plans/archive/M11a-local-soak.md` §"Soak
abort thresholds" as a follow-up addition — this ADR documents the runtime
behaviour, not the soak-management policy.

## 3. Consequences

- **ccxt's `enableRateLimit` is disabled** (`ENABLE_RATE_LIMIT` flips to
  `false`); the in-engine limiter is the sole authority. Pacing tests
  rewrite against the new policy.
- **Boot now reads a per-operation weight table.** A new ccxt method
  added without a weight-table entry fails fast at the call site rather
  than silently passing through. Adding a method is a two-file edit; this
  is a deliberate friction trade for limiter correctness.
- **Order placement under bucket exhaustion fails fast.** The execution
  layer must treat `ExchangeRateLimitExhaustedException` as a first-class
  "miss" outcome — not a transient error to retry. The risk gate records
  the miss in `decisions` with a new `failure_reason='RATE_LIMIT'`.
- **Reconciliation and funding polls may wait up to one poll interval.**
  This is the expected cost; the alternative (polls failing under burst)
  is strictly worse. Soak observability includes a P95 wait-time chart
  per bucket so an operator can see headroom over time.
- **A 429/418 halts new orders, never retries.** This is more conservative
  than ccxt's default and more conservative than most ccxt-using bots; it
  is the right posture for a long-running unattended soak on a single IP.
- **Per-symbol sub-bucket prevents one symbol from monopolising orders.**
  The 30% per-symbol share is configurable but the default is locked in
  this ADR.
- **Drift detection runs continuously.** If local accounting diverges from
  headers by more than 10% of class capacity, the engine surfaces the
  drift before it becomes a 429. This is the canary for "the weight table
  is stale because Binance changed an endpoint's published weight."
- **M11b implication.** A second instance sharing the same IP cannot use
  this in-process limiter as-is. M11b ADR will replace the in-process
  buckets with a Redis-backed shared limiter (Lua-scripted atomic
  acquire) reusing the same `IRateLimitPolicy` interface so call sites do
  not change.
- **Cross-cutting with ADR 0021 (kill-switch).** The rate-limit halt is
  emitted through the existing kill-switch event channel; no parallel
  halt mechanism is introduced. The kill-switch reason enum gains
  `RATE_LIMIT_BAN` (shared package change tracked in M11a W0).

## 4. Alternatives considered

- **Keep ccxt's `enableRateLimit` and tighten it manually.** Rejected:
  cannot account for per-endpoint weight, cannot read response headers,
  and tuning to the slowest class under-utilises easier classes by
  10–20×, blocking legitimate fetches during a market-stress sweep.
- **Wrap only order placement; let ccxt pace the rest.** Rejected:
  REQUEST_WEIGHT and RAW_REQUESTS bans are the failure modes most likely
  to bite a non-trading market-data sweep during a soak. A partial cover
  is a false sense of safety.
- **Redis-backed shared limiter now.** Rejected for M11a (single-instance
  by design); `IRateLimitPolicy` is shaped so M11b swaps the impl.
- **Trust Binance headers exclusively, drop local accounting.** Rejected:
  headers arrive only after the call completes; a burst of in-flight
  calls cannot consult headers from calls that have not returned.
  Headers are the **reconciliation** authority, not the runtime gate.
- **Token-per-second cap, no bucket.** Rejected: wastes the 10 s burst.
- **Per-endpoint sub-buckets for every endpoint.** Rejected as
  configuration surface explosion; most endpoints share REQUEST_WEIGHT_1M
  headroom without needing isolation. Per-symbol on `ORDERS_*` is the
  minimum-viable defence.
- **50% safety margin instead of 80%.** Rejected as too conservative for
  the soak profile. **90% margin** rejected as too aggressive (clock skew
  alone can consume 2–3% of the 10 s window). 80% absorbs realistic skew
  + header-feedback lag.
- **`fail-fast` for reconciliation polls too.** Rejected: a poll that
  failed fast is a poll that did not happen, and reconciliation drives
  M6 state-machine correctness. `await` capped at one poll interval is
  the right trade.
- **(M46) Split `/fapi` market-data off into its own bucket (Option A2).**
  Rejected as incorrect by construction — the single `/fapi`
  `X-MBX-USED-WEIGHT-1M` header reports combined market-data + account
  weight, so an account-only bucket would be reconciled from a header that
  over-reports what it tracks and fire spurious `RATE_LIMIT_DRIFT`. The
  ledger boundary Binance enforces is the **host** (`/fapi` vs `/sapi`), so
  the split follows the host boundary (Option A1, §2.7), not endpoint type.
- **(M46) Reconcile `SAPI_REQUEST_WEIGHT_1M` from the `/sapi`
  `X-MBX-USED-WEIGHT-1M` header.** Rejected — the `/fapi` and `/sapi`
  headers share a name but report different per-IP ledgers, and only the
  last-called host's response lands in the single `last_response_headers`
  slot, so the engine cannot reliably attribute a header to the `/sapi`
  ledger. The `/sapi` bucket is local-only like `RAW_REQUESTS_5M`; its
  boot-only, weight-1 traffic carries no realistic ban risk under pure
  conservative local accounting (§2.7).
- **Inline the limiter inside `CcxtBinanceExchangeClient`.** Rejected: a
  separate `IRateLimitPolicy` is testable in isolation (deterministic
  clock injection), makes the M11b swap one-file, and matches the
  port/adapter pattern ADR 0028 just established.
