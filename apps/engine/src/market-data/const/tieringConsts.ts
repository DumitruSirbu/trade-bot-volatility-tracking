// Tiered subscription policy (ADR §2 "practical compromise"). "Approaching trigger"
// is computed from already-streamed ticker data only — it must not require the deep
// data it is gating. A symbol escalates when it reaches this fraction of the σ or
// volume-ratio trigger thresholds.
export const APPROACHING_TRIGGER_FRACTION = 0.7;

// Open-Interest REST poll cadences (no all-symbol OI socket exists).
export const OI_BASELINE_POLL_MS = 5 * 60 * 1000;
export const OI_ESCALATED_POLL_MS = 30 * 1000;

// Funding-rate REST poll cadence (crowding/trailing signal, not price-leading).
export const FUNDING_POLL_MS = 5 * 60 * 1000;

// Hours in a year for funding annualization (funding accrues per interval).
export const HOURS_PER_YEAR = 24 * 365;

// Default funding interval (Binance USDT-M settles every 8h) when the exchange
// does not report one, used to annualize the periodic rate.
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

// Order-book depth notional bands (basis points from mid). 10bps ≈ tight, 50bps ≈
// wider liquidity. Captured for triggered symbols only.
export const DEPTH_BAND_10_BPS = 0.001;
export const DEPTH_BAND_50_BPS = 0.005;

// Aggressor-imbalance rolling window for near-trigger symbols (trade timestamps
// older than this are dropped from the buy/sell ratio).
export const AGGRESSOR_WINDOW_MS = 5 * 60 * 1000;

// Fast market-stress thresholds (independent of lagging ADX; feed M4's halt).
export const BTC_1M_SHOCK_PCT = 1.5;
export const BTC_5M_SHOCK_PCT = 3;
export const ETH_5M_SHOCK_PCT = 4;
export const OI_SHOCK_5M_PCT = 5;
export const FUNDING_EXTREME_ANNUALIZED_PCT = 50;
export const SPREAD_WIDENING_PCT = 0.5;
