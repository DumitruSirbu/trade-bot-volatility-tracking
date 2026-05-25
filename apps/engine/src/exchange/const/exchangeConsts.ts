// USDT-margined linear perpetuals are the only instruments this bot trades.
// ccxt tags them with this settle currency + swap=true; the universe filter
// keys off these to drop spot, inverse, options, and dated futures.
export const PERPETUAL_SETTLE_CURRENCY = 'USDT';

// Depth requested from watchOrderBook for triggered symbols. Top-of-book plus a
// shallow ladder is enough to estimate 10bps/50bps notional without streaming a
// full book (ADR §2 tiering — never deep books for the whole universe).
export const ORDER_BOOK_DEPTH_LIMIT = 20;

// ccxt's built-in rate-limiter is DISABLED — M11a W1.4 (ADR 0030 §2). The
// in-engine RateLimitPolicyService is the sole authority; two stacked
// throttles confuse observability (a stall in one is invisible behind the
// other). See `RateLimitPolicyService` for the per-class token-bucket
// accounting and 429/418 freeze path.
export const ENABLE_RATE_LIMIT = false;

// Censor substituted for any credential-bearing token found inside a ccxt error
// string before it reaches the logs.
export const EXCHANGE_ERROR_CENSOR = '[REDACTED]';

// M11a W1.2 (ADR 0028 §2.2) — provenance string list pinned on every
// IKeyPermissionSnapshot.sourceEndpoints. Kept here (not inlined) so the
// audit row and assertion site share one source of truth.
export const KEY_PERMISSION_SOURCE_ENDPOINTS: ReadonlyArray<string> = ['sapiGetAccountApiRestrictions', 'sapiGetAccountApiRestrictionsIpRestriction'];

// M11a W1.2 (ADR 0028 §2.2) — Binance "-1" sentinel for
// `tradingAuthorityExpirationTime` ("never expires"). Mapped to `null` at the
// boundary so the allowlist predicate treats it as expired.
export const TRADING_AUTHORITY_NEVER_EXPIRES_SENTINEL = -1;

// M11a W1.1 — API key fingerprint length on each side (first 4 + last 4) for
// the boot Telegram alert. Never the full key, never the secret.
export const API_KEY_FINGERPRINT_PREFIX_LEN = 4;
export const API_KEY_FINGERPRINT_SUFFIX_LEN = 4;

// Binance signed-request query params, the header-form API key, and any long secret
// token (HMAC signature or API key) that a ccxt AuthenticationError/RequestError can
// embed verbatim in its message. We strip these at the exchange boundary before
// logging so credentials never reach disk/stdout (deepRedactLog only scrubs object
// KEYS, not strings).
//
// Patterns, in order:
//  1. Signed-request query params in `key=value` form.
//  2. The Binance API key in HEADER form (X-MBX-APIKEY) — base62, not hex, separated
//     by `=`, `:`, or `":"` (JSON-echoed headers), so patterns 1/3 miss it.
//  3. Any standalone hex token of length >= 64 (HMAC signature).
//  4. Any standalone base62 token of length >= 40 (an API key echoed without a label).
export const EXCHANGE_ERROR_SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
    /(signature|apiKey|api_key|timestamp|sign)=[^&\s"']+/gi,
    /(x-mbx-apikey)("?\s*[:=]\s*"?)([^&\s"']+)/gi,
    /\b[a-f0-9]{64,}\b/gi,
    /\b[A-Za-z0-9]{40,}\b/g,
];
