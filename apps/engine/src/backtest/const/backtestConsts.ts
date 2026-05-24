// Minimum warm-up bars needed before a replay symbol can produce its first valid snapshot.
// Equals the longest indicator lookback (ATR_PERIOD = 14). Below this, IndicatorStateBuilder
// returns null and the replay skips the bar.
export const BACKTEST_MIN_WARMUP_BARS = 14; // matches ATR_PERIOD in market-data/const

// Number of warm-up bars to load BEFORE the replay window opens. Loading exactly
// CLOSED_BAR_WINDOW_SIZE (200) pre-window bars gives every indicator a full warm window
// at the first bar. Fewer bars still work but indicators will warm up during the replay.
export const BACKTEST_WARMUP_BAR_COUNT = 200; // matches CLOSED_BAR_WINDOW_SIZE

// When the `stress_period` flag is set on the config, the replay uses this worst-case
// tier-1 slippage multiplier instead of the strategy_versions.params value.
export const BACKTEST_STRESS_SLIPPAGE_MULTIPLIER = 2.0;

// Fraction of best trades to remove for robustness gate (remove top 5%).
export const BACKTEST_ROBUSTNESS_TOP_TRIM_PCT = 0.05;
