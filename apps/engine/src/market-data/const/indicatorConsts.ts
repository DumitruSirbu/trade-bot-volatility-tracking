// Indicator lookback periods (in closed 5-min bars).
export const VWAP_ROLLING_BARS = 20;
export const VWAP_ROLLING_24H_BARS = 288; // 24h / 5m
export const SIGMA_DEVIATION_BARS = 20;
export const VOLUME_AVG_BARS = 20;
export const ATR_PERIOD = 14;
export const ADX_PERIOD = 14;
export const RSI_PERIOD = 14;
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STDDEV_MULTIPLIER = 2;

// Regime thresholds from ADX(14): < 20 ranging, > 25 trending (direction by ±DI),
// 20–25 transitioning (M1 task + ADR).
export const ADX_RANGING_MAX = 20;
export const ADX_TRENDING_MIN = 25;

// Idiosyncrasy score clamp bounds: 1 − abs(btc move)/abs(coin move), clamped.
export const IDIOSYNCRASY_SCORE_MIN = 0;
export const IDIOSYNCRASY_SCORE_MAX = 1;

// Minimum coin 5m move magnitude (%) below which the idiosyncrasy score is
// treated as pure microstructure noise and floored to IDIOSYNCRASY_SCORE_MIN.
// 16× below the tightest tier-1 trigger floor (tier1_min_abs_move_pct = 0.8%),
// so it is inert for every real trigger input and only ever removes false
// idiosyncratic eligibility on sub-noise denominators (tightening-only, M30 D4).
export const IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05;

// Multi-anchor VWAP event-shift detector: a closed bar whose volume ratio exceeds
// this re-anchors the event-anchored VWAP (high-volume regime shift, M1 task).
export const EVENT_ANCHOR_VOLUME_RATIO = 4;

// Calibration ring-buffer cap per symbol. One sample per closed 5-min bar; this
// retains ~25 days of bars, enough for robust percentiles without unbounded growth
// in a 24/7 process. Oldest samples are dropped once the cap is reached.
export const CALIBRATION_SAMPLE_CAP = 7200;

// Minimum samples before calibration percentiles are statistically trustworthy.
// Below this, stats are still returned but flagged via sampleCount so M7 can gate.
export const CALIBRATION_MIN_SAMPLES = 200;
