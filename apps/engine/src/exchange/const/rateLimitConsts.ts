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

export const REQUEST_WEIGHT_1M_WINDOW_MS = 60_000;
export const ORDERS_10S_WINDOW_MS = 10_000;
export const ORDERS_1M_WINDOW_MS = 60_000;
export const RAW_REQUESTS_5M_WINDOW_MS = 300_000;

// Per-symbol sub-bucket share (ADR 0030 §2.4). 30% of ORDERS_* per symbol so
// a single symbol cannot starve the other 2 slots of the M4 3-slot model.
export const PER_SYMBOL_ORDERS_SHARE = 0.3;

// Drift detection (ADR 0030 §2.5): when |local-used - header-used| exceeds
// this fraction of class capacity, emit RATE_LIMIT_DRIFT.
export const RATE_LIMIT_DRIFT_THRESHOLD_FRACTION = 0.1;

// 429/418 fallback freeze when Retry-After header is missing (ADR 0030 §2.6).
export const RATE_LIMIT_429_DEFAULT_FREEZE_MS = 60_000;
export const RATE_LIMIT_418_DEFAULT_FREEZE_MS = 120_000;

// Max freeze cap (ADR 0030 §2.6) — repeated breaches double the freeze, capped.
export const RATE_LIMIT_FREEZE_CAP_MS = 60 * 60_000;

// Drift-alert coalescing — emit Telegram WARN once per process boot on the
// first drift event, then suppress further alerts for this window (ADR 0030
// §2.5).
export const RATE_LIMIT_DRIFT_LOG_COALESCE_MS = 5 * 60_000;

// Binance header names (case-insensitive at the HTTP layer; the helper
// normalises to lowercase before lookup).
export const HEADER_USED_WEIGHT_1M = 'x-mbx-used-weight-1m';
export const HEADER_ORDER_COUNT_10S = 'x-mbx-order-count-10s';
export const HEADER_ORDER_COUNT_1M = 'x-mbx-order-count-1m';
export const HEADER_RETRY_AFTER = 'retry-after';

// Per-operation REQUEST_WEIGHT table (ADR 0030 §2.2). Adding a new ccxt method
// requires an entry here; calling an unknown operation throws so the call-site
// cannot drift past the limiter. Weights re-verified against Binance Futures
// 2026-05-25 — same caveat as the limit constants above.
export const OPERATION_REQUEST_WEIGHTS: Readonly<Record<string, number>> = {
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
    sapiGetAccountApiRestrictions: 1,
    sapiGetAccountApiRestrictionsIpRestriction: 1,
    // WS calls do not consume REST weight but the helper still routes through
    // the limiter for RAW_REQUESTS observability; weight=0 means they do not
    // count toward REQUEST_WEIGHT_1M.
    watchTickers: 0,
    watchOrderBook: 0,
    watchTrades: 0,
};
