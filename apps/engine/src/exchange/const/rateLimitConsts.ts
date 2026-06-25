// M11a W1.4 (ADR 0030). Binance USDT-M Futures rate-limit constants.
//
// SOURCE-OF-TRUTH for the per-class published limits and safety margin. ADR
// 0030 §1 mandates pinning the values in a single file so re-verification
// against Binance is one diff. Re-verify the integers below against the
// current Binance Futures API documentation any time the rate-limit ban
// surface shifts:
//
//   https://binance-docs.github.io/apidocs/futures/en/#limits
//
// (Values pinned 2026-05-25; ADR 0030 §2.1 table.)
//
// Effective bucket capacity = floor(publishedLimit * SAFETY_MARGIN). The 80%
// margin absorbs clock skew, header-feedback lag, and short bursts the local
// accounting did not yet observe. ADR 0030 §2.1 rejects 50% (over-conservative)
// and 90% (skew alone can consume 2–3% of the 10s window).

export const RATE_LIMIT_SAFETY_MARGIN = 0.8;

// Per-class published Binance Futures limits (re-verify before each release).
export const REQUEST_WEIGHT_1M_PUBLISHED_LIMIT = 2400;
export const ORDERS_10S_PUBLISHED_LIMIT = 300;
export const ORDERS_1M_PUBLISHED_LIMIT = 1200;
export const RAW_REQUESTS_5M_PUBLISHED_LIMIT = 61_000;

// M46 (ADR 0030 §2.7). `/sapi` host carries its OWN IP request-weight budget,
// distinct from the `/fapi` REQUEST_WEIGHT_1M class above. The split follows the
// HOST boundary (`/fapi` vs `/sapi`), not endpoint type — Binance accounts the
// two hosts' weight independently, so a saturated `/fapi` budget must not block
// a `/sapi` call and vice versa. Published `/sapi` IP weight limit is 1200/min
// (the wallet/account REST cluster's per-IP minute budget).
export const SAPI_REQUEST_WEIGHT_1M_PUBLISHED_LIMIT = 1200;

export const REQUEST_WEIGHT_1M_WINDOW_MS = 60_000;
export const ORDERS_10S_WINDOW_MS = 10_000;
export const ORDERS_1M_WINDOW_MS = 60_000;
export const RAW_REQUESTS_5M_WINDOW_MS = 300_000;
export const SAPI_REQUEST_WEIGHT_1M_WINDOW_MS = 60_000;

// Per-symbol sub-bucket share (ADR 0030 §2.4). 30% of ORDERS_* per symbol so
// a single symbol cannot starve the other 2 slots of the M4 3-slot model.
export const PER_SYMBOL_ORDERS_SHARE = 0.3;

// Drift detection (ADR 0030 §2.5): when the SIGNED under-count
// (header-used − local-used) / capacity exceeds this fraction — i.e. Binance
// has counted more than we have and we may be approaching a 429 we cannot see —
// emit a WARN. The opposite direction (local-used > header-used) is the safe,
// conservative case and is intentionally silent (no absolute-difference check).
export const RATE_LIMIT_DRIFT_THRESHOLD_FRACTION = 0.1;

// 429/418 fallback freeze when Retry-After header is missing (ADR 0030 §2.6).
export const RATE_LIMIT_429_DEFAULT_FREEZE_MS = 60_000;
export const RATE_LIMIT_418_DEFAULT_FREEZE_MS = 120_000;

// Max freeze cap (ADR 0030 §2.6) — repeated breaches double the freeze, capped.
export const RATE_LIMIT_FREEZE_CAP_MS = 60 * 60_000;

// Freeze-escalation decay (ADR 0030 §2.6.5). A second 429/418 within this
// window of the previous freeze EXPIRY keeps the escalation chain alive
// (doubles again, capped at RATE_LIMIT_FREEZE_CAP_MS). Beyond this window
// the escalation resets to the base duration — the burst has decayed and
// the next 429/418 is treated as a fresh incident. 5×baseMs of the most
// recent baseline keeps the escalation responsive to genuine repeat bursts
// while not punishing a single transient 429 that recurs hours later.
export const RATE_LIMIT_FREEZE_DECAY_FACTOR = 5;

// Drift-alert coalescing — on a drift event emit one Telegram WARN, then
// suppress further alerts within this window and re-arm after it elapses
// (ADR 0030 §2.5).
export const RATE_LIMIT_DRIFT_LOG_COALESCE_MS = 5 * 60_000;

// Binance header names (case-insensitive at the HTTP layer; the helper
// normalises to lowercase before lookup).
export const HEADER_USED_WEIGHT_1M = 'x-mbx-used-weight-1m';
// M46 (ADR 0030 §2.7). The `/sapi` host returns the SAME header NAME
// (`x-mbx-used-weight-1m`) as `/fapi`; only the HOST differs. The bucket
// distinction therefore lives in the router (operation -> bucket map), NOT in
// the header string. We intentionally do NOT reconcile `sapiRequestWeight1m`
// from this header — a `/fapi` response's `x-mbx-used-weight-1m` reflects the
// `/fapi` budget, so cross-applying it to the `/sapi` bucket would corrupt it.
// The `/sapi` bucket is local-only, like RAW_REQUESTS_5M (§2.7).
export const HEADER_ORDER_COUNT_10S = 'x-mbx-order-count-10s';
export const HEADER_ORDER_COUNT_1M = 'x-mbx-order-count-1m';
export const HEADER_RETRY_AFTER = 'retry-after';

// Per-operation REQUEST_WEIGHT table (ADR 0030 §2.2, §2.7). Adding a new ccxt
// method requires an entry in the host-appropriate map below; calling an unknown
// operation throws so the call-site cannot drift past the limiter. Weights
// re-verified against Binance Futures 2026-05-25 — same caveat as the limit
// constants above.
//
// M46 (ADR 0030 §2.7): the table is split by HOST so the router can debit the
// correct request-weight bucket. `/fapi` operations debit REQUEST_WEIGHT_1M;
// `/sapi` operations debit the independent SAPI_REQUEST_WEIGHT_1M bucket.
export const FAPI_OPERATION_WEIGHTS: Readonly<Record<string, number>> = {
    loadMarkets: 1,
    fetchBalance: 5,
    fetchOpenInterest: 1,
    fetchFundingRate: 1,
    fetchTickers: 40,
    fetchPositions: 5,
    fetchOpenOrders: 40,
    fetchFundingHistory: 30,
    fetchOrder: 1,
    fetchOrderByClientId: 1,
    createOrder: 1,
    cancelOrder: 1,
    cancelOrderByClientId: 1,
    cancelAllOrders: 1,
    // WS calls do not consume REST weight but the helper still routes through
    // the limiter for RAW_REQUESTS observability; weight=0 means they do not
    // count toward REQUEST_WEIGHT_1M.
    watchTickers: 0,
    watchOrderBook: 0,
    watchTrades: 0,
};

// `/sapi`-host operations. These debit SAPI_REQUEST_WEIGHT_1M (per-IP `/sapi`
// budget) + RAW_REQUESTS_5M, never the `/fapi` REQUEST_WEIGHT_1M bucket.
export const SAPI_OPERATION_WEIGHTS: Readonly<Record<string, number>> = {
    sapiGetAccountApiRestrictions: 1,
    sapiGetAccountApiRestrictionsIpRestriction: 1,
};

// Union of FAPI_OPERATION_WEIGHTS and SAPI_OPERATION_WEIGHTS. Still consumed by
// `buildRateLimitedCall` as its own operation-known guard: the per-host maps
// (FAPI_OPERATION_WEIGHTS, SAPI_OPERATION_WEIGHTS) are the *routing* authority
// (which bucket to charge), while this union is the *existence* authority (is
// this op registered at all). Not a removable alias — dropping it breaks the
// guard.
export const OPERATION_REQUEST_WEIGHTS: Readonly<Record<string, number>> = {
    ...FAPI_OPERATION_WEIGHTS,
    ...SAPI_OPERATION_WEIGHTS,
};
