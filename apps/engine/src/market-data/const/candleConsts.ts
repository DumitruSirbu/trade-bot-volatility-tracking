// Candle timeframes. The 5-minute bar drives indicators + the trigger; the
// 1-minute bar is accumulated for M2 persistence and short-window breadth.
export const CANDLE_5M_INTERVAL_MS = 5 * 60 * 1000;
export const CANDLE_1M_INTERVAL_MS = 1 * 60 * 1000;

// Wall-clock cadence for the bar-close sweep. The forming 5-min candle graduates
// when its bucket elapses regardless of tick arrival, so a quiet symbol's bar still
// closes/emits on schedule. Sub-bar cadence keeps close latency low without churn.
export const BAR_CLOSE_SWEEP_MS = 5 * 1000;

// Bounded rolling window of CLOSED 5-min bars retained per symbol. Sized to cover
// the longest indicator lookback (ADX(14) needs ~2× period to warm up) plus the
// 20-bar VWAP/σ/volume windows, with headroom.
export const CLOSED_BAR_WINDOW_SIZE = 64;

// How long the per-symbol price tape is retained — long enough for the widest
// breadth/stress window (15m) without unbounded growth.
export const PRICE_TAPE_RETENTION_MS = 15 * 60 * 1000;

// How long OI history is retained — covers the 15m OI-change window with headroom.
export const OPEN_INTEREST_HISTORY_RETENTION_MS = 20 * 60 * 1000;

// OI-change lookback windows (M1: open_interest_change_5m_pct / _15m_pct).
export const OI_CHANGE_5M_MS = 5 * 60 * 1000;
export const OI_CHANGE_15M_MS = 15 * 60 * 1000;

// A full UTC session of 5-min bars (288). Caps sessionBars even if a reset is
// somehow missed, so the array can never grow unbounded in a 24/7 process.
export const SESSION_BAR_MAX = 288;

// Hard cap on the event-anchored VWAP window. The anchor normally re-anchors on a
// high-volume regime shift, but absent one this bounds the array (24/7 process).
export const EVENT_ANCHORED_BAR_MAX = 288;
