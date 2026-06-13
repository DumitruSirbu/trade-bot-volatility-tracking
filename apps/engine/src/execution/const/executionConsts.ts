import { CoinTierEnum, OrderPolicyEnum } from '@bot/shared';

// Execution-layer constants (ADR 0005/0006/0007/0008). All numbers/strings used by the
// executor live here — no inline magic numbers in services (conventions §Constants Placement).
// Both ExecutionModule (live) and M7 BacktestModule import THIS module so live and replay
// stay byte-equivalent on policy choice, timeouts, and slippage caps (ADR 0005 §5 / C5).

// --- order-policy timeouts (ADR 0005 §3) ---
//
// Per-policy cancel-on-timeout. IOC's exchange-side IOC handles the real cancel; our timer
// is a defensive backstop. Maker timeout is ≈ ¼ of a 5m bar — long enough for normal book
// oscillation, short enough that the trigger has not decayed. Reduce-market retries on
// timeout (ADR 0006 §4) because not-exiting is worse than slippage.
export const ORDER_TIMEOUT_MS: Record<OrderPolicyEnum, number> = {
    [OrderPolicyEnum.MARKETABLE_LIMIT_IOC]: 2_000,
    [OrderPolicyEnum.POST_ONLY_MAKER]: 45_000,
    [OrderPolicyEnum.REDUCE_MARKET]: 5_000,
};

// --- slippage caps (ADR 0005 §2) ---
//
// Hard ceiling by tier. Tier-3 is restricted from live entirely during M5/M11; the live-
// relevant cap is the tier-1 number. The effective cap is min(tierCap, slDistance × maxSlOfSl)
// so a stop-tight entry cannot bleed a quarter of its risk budget paying entry slippage.
export const MAX_SLIPPAGE_TIER_PCT: Record<CoinTierEnum, number> = {
    [CoinTierEnum.TIER_1]: 0.15,
    [CoinTierEnum.TIER_2]: 0.4,
    [CoinTierEnum.TIER_3]: 0.8,
};

// Default fraction of the SL distance the executor is willing to pay as entry slippage. Lives
// here so backtest can read the same default when strategy_versions.params.maxSlippageOfSlPct
// is absent.
export const DEFAULT_MAX_SLIPPAGE_OF_SL_PCT = 25;

// --- idempotency / state machine (ADR 0006) ---

// Client-order-id prefix used by reconciliation (M6) to tell bot orders from manual / external.
export const CLIENT_ORDER_ID_PREFIX = 'tbvt-';

// Length of the hex slice after the prefix. 5 + 20 = 25 chars total — comfortably inside the
// 36-char Binance limit and leaves room for a `-sl` / `-tp` suffix on protective orders.
export const CLIENT_ORDER_ID_HASH_LENGTH = 20;

// Distinct from the policy-level cancel timeout. Bounds how long createOrder may wait for an
// ack before the executor enters the UNKNOWN-recovery protocol (ADR 0006 §3).
export const SUBMIT_NETWORK_TIMEOUT_MS = 3_000;

// Wait between an UNKNOWN classification and the fetchOrder recovery probe (ADR 0006 §3 step 1)
// so the exchange has time to apply a create that did arrive but ack'd late.
export const RECOVERY_BACKOFF_MS = 1_000;

// Max recovery cycles before the executor escalates to M6 reconciliation (ADR 0006 §3).
export const MAX_UNKNOWN_RECOVERY_ATTEMPTS = 3;

// Max attemptN before the executor stops retrying a permanent reject (ADR 0006 §4).
// attemptN ∈ {0, 1, 2}.
export const MAX_PERMANENT_RETRY_ATTEMPTS = 2;

// REDUCE_MARKET-specific remainder-retry ceiling (ADR 0007 §4). Separate from the
// permanent-reject budget so a pathological partial-fill loop on a reduce cannot
// exhaust the budget other paths need. Each retry advances attemptN (fresh
// clientOrderId), submitted for the remainder qty only, with the policy's own
// ORDER_TIMEOUT_MS.
export const MAX_REDUCE_REMAINDER_ATTEMPTS = 3;

// Internal marker the submit-side network-timeout path raises; the failure
// classifier matches this marker (NOT a substring of the wrapper message) when
// deciding "this is an UNKNOWN ack-loss, not a classified reject". Lives here so
// the wire string is a single source of truth across submitter + tests.
export const SUBMIT_TIMEOUT_ERROR_MARKER = 'submit_network_timeout';

// Placeholder amount used when Binance USDT-M Futures protective orders are submitted
// with `closePosition=true` (ADR 0008 §1 step 3): the exchange ignores the amount
// because closePosition auto-tracks the live position qty. Kept as a const so the
// "why is amount='0'" magic disappears from ProtectiveOrderAttacher.
export const BINANCE_CLOSE_POSITION_PLACEHOLDER_AMOUNT = '0';

// --- close-producer eventId prefixes (ADR 0011 §9 shared close registry) ---
//
// Each close producer stamps its emitted CLOSE intent with a deterministic eventId built from
// its own prefix + positionId. The matching `ORDER_INTENT_EXPIRED_EVENT` listener parses the
// prefix back so a producer releases ONLY its own held slot — a monitor expiry must never
// release a time-stop or flatten slot. Kept here as a single source of truth across the three
// producers (enforcer / monitor / reconciliation) and their tests.
export const TIME_STOP_ENFORCER_EVENT_ID_PREFIX = 'time-stop-enforcer-';
export const LOCAL_MONITOR_BREACH_EVENT_ID_PREFIX = 'local-monitor-breach-';
export const RECONCILIATION_FLATTEN_EVENT_ID_PREFIX = 'reconciliation-flatten-';

// `reason` values carried on ORDER_INTENT_EXPIRED_EVENT that leave no live order resting, so the
// owning producer releases its close slot and the next tick re-fires (Fix 1b release table).
export const ORDER_INTENT_EXPIRED_REASON_HALTED = 'halted';
export const ORDER_INTENT_EXPIRED_REASON_DRY_RUN = 'dry_run';

// --- M31 escalation reasons + event classes (zombie-position lifecycle) ---
//
// `reason` values carried on ORDER_INTENT_UNKNOWN_EVENT when a reduce/close path aborts and
// hands the residual to M6 reconciliation. Kept as named constants so the wire strings are a
// single source of truth across ExecutionService + tests (no inline magic strings).
export const REDUCE_ON_FLAT_POSITION_REASON = 'reduce_on_flat_position';
export const PENDING_PROMOTE_FAILED_REASON = 'pending_promote_failed';
export const ENTRY_AUDIT_PERSIST_FAILED_REASON = 'entry_audit_persist_failed';

// eventClass stamped on the PENDING_OPEN -> OPEN promote transition that precedes a closing
// fill (ADR 0009 §6.3 two-step promote through `open`).
export const PENDING_OPEN_PROMOTE_EVENT_CLASS = 'execution.reduce.fill.terminal.pending_promote';

// --- reject-classification taxonomy (ADR 0006 §4) ---
//
// Pure table from Binance USDT-M Futures numeric error codes → reject class. The
// classifier is a pure function so backtest failure-injection runs and live use the
// same mapping. RETRIABLE → attemptN++; TERMINAL → ABORTED + release; codes not in
// the table default to TERMINAL (safety) but the submitter logs WARN with the code so
// the table can be extended.
export const BINANCE_REJECT_CLASSIFICATION: Record<string, 'RETRIABLE' | 'TERMINAL'> = {
    // Retriable (server-side transient / clock drift / rate-limit family)
    '-1000': 'RETRIABLE',
    '-1001': 'RETRIABLE',
    '-1003': 'RETRIABLE',
    '-1007': 'RETRIABLE',
    '-1015': 'RETRIABLE',
    '-1021': 'RETRIABLE',

    // Terminal (intent invalid; resubmit fails identically)
    '-2010': 'TERMINAL',
    '-2011': 'TERMINAL',
    '-2013': 'TERMINAL',
    '-2018': 'TERMINAL',
    '-2019': 'TERMINAL',
    '-2020': 'TERMINAL',
    '-2021': 'TERMINAL',
    '-2022': 'TERMINAL',
    '-2027': 'TERMINAL',
    '-4045': 'TERMINAL', // Insufficient liquidity for IOC — resubmitting at the same price fails identically.
    '-4060': 'TERMINAL', // Margin mode reject (isolated/cross mismatch) — account-level reconfigure required.
    '-4061': 'TERMINAL', // Position-side reject (one-way vs hedge mismatch) — account-level reconfigure required.
    '-4131': 'TERMINAL',
    '-4164': 'TERMINAL',
    '-4400': 'TERMINAL', // PRICE_FILTER violation — limit price outside allowed band; same intent fails identically.
};

// Names of the retriable ccxt error subclasses (cross-checked via ccxt 4.5.x docs).
// Constructor-name match is safer than message substring because the localized text
// varies by ccxt release.
export const CCXT_RETRIABLE_ERROR_NAMES = ['ExchangeNotAvailable', 'NetworkError', 'RequestTimeout', 'DDoSProtection'] as const;

// Names of the terminal ccxt error subclasses — intent invalid, retry will fail.
export const CCXT_TERMINAL_ERROR_NAMES = ['InsufficientFunds', 'OrderImmediatelyFillable', 'OrderNotFillable', 'InvalidOrder', 'BadSymbol'] as const;

// --- SL/TP attach (ADR 0008) ---

// One-shot retry interval for the exchange-side protective attach after a failure (ADR 0008
// §3). If the retry succeeds, protective_order_type flips back to EXCHANGE_SIDE; if not, the
// position stays on LOCAL_FALLBACK for its life and the alert escalates.
export const RETRY_PROTECTIVE_MS = 5_000;

// Suffixes appended to the protective orders' clientOrderId hash slice so SL/TP and the
// underlying close-action id stay distinct yet reproducible (ADR 0008 §1 step 3).
export const PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX = '-sl';
export const PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX = '-tp';

// --- ccxt order types / params (binding to Binance USDT-M Futures) ---
//
// Lower-case ccxt-unified strings; the Binance USDT-M Futures adapter translates them to the
// exchange's STOP_MARKET / TAKE_PROFIT_MARKET / LIMIT / MARKET equivalents.
export const CCXT_ORDER_TYPE_MARKET = 'market';
export const CCXT_ORDER_TYPE_LIMIT = 'limit';
export const CCXT_ORDER_TYPE_STOP_MARKET = 'stop_market';
export const CCXT_ORDER_TYPE_TAKE_PROFIT_MARKET = 'take_profit_market';

export const CCXT_ORDER_SIDE_BUY = 'buy';
export const CCXT_ORDER_SIDE_SELL = 'sell';

// Binance USDT-M Futures time-in-force values, exposed via ccxt params.
export const CCXT_TIME_IN_FORCE_IOC = 'IOC';
export const CCXT_TIME_IN_FORCE_GTX = 'GTX'; // post-only on binanceusdm
export const CCXT_TIME_IN_FORCE_GTC = 'GTC';

// Trigger price source for SL/TP — MARK_PRICE avoids wick-driven liquidations from a
// last-price tape outlier (ADR 0008 §1).
export const CCXT_WORKING_TYPE_MARK_PRICE = 'MARK_PRICE';

// --- ccxt order status (mapping into SubmitStateEnum) ---

export const CCXT_ORDER_STATUS_OPEN = 'open';
export const CCXT_ORDER_STATUS_CLOSED = 'closed';
export const CCXT_ORDER_STATUS_CANCELED = 'canceled';
export const CCXT_ORDER_STATUS_EXPIRED = 'expired';
export const CCXT_ORDER_STATUS_REJECTED = 'rejected';
