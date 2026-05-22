// Strategy-engine constants (ADR 0003 §2). No inline magic numbers in strategy code.

// Deterministic clock base. nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS (the
// close time of the trigger bar). Reuses the market-data 5m interval — the canonical bar
// length — rather than redefining it, so the two never drift.
export { CANDLE_5M_INTERVAL_MS as CANDLE_INTERVAL_MS } from '../../market-data/const/candleConsts';

// Config key selecting the active strategy_versions.id (read via AppConfigService). Value
// comes from env; switching the active version is a config change + restart, no code change.
export const ACTIVE_STRATEGY_VERSION_ID_ENV = 'ACTIVE_STRATEGY_VERSION_ID';

// Number of milliseconds in one minute, for the time-stop target arithmetic.
export const MS_PER_MINUTE = 60_000;

// --- v1 mean-reversion exhaustion-confirmation tolerances (ADR 0003 §4, M3 brief) ---

// Take-profit target is VWAP pulled in by this many sigma for conservatism: TP sits at
// VWAP ± TAKE_PROFIT_VWAP_SIGMA_OFFSET × the deviation band (closer than full VWAP).
export const TAKE_PROFIT_VWAP_SIGMA_OFFSET = 0.5;

// Strict Bollinger %B re-entry thresholds for the "close back inside the band" exhaustion
// confirmation. %B is (close - lowerBand) / (upperBand - lowerBand): 1.0 at the upper band,
// 0.0 at the lower band, 0.5 at the basis. A fresh, still-extended spike closes pinned at
// or beyond its band edge (%B >= 1.0 on a pump, <= 0.0 on a dump). Requiring the close to
// have retreated a full 20% of the band width back INSIDE distinguishes a rejected wick
// (exhaustion) from a bar still riding the band — so 1.0 / 0.0 would be a no-op (the whole
// band is [0,1]) and is rejected. A pump confirms only when %B < UPPER, a dump when
// %B > LOWER.
export const BAND_REENTRY_UPPER_PCT_B = 0.8;
export const BAND_REENTRY_LOWER_PCT_B = 0.2;

// Volume deceleration: current bar volume_ratio at or below this fraction of the spike
// trigger floor signals the impulse is fading (exhaustion confirmation).
export const VOLUME_DECELERATION_RATIO = 1.0;

// Open-interest "stopped rising / started falling" tolerance (pct over the 5m window).
// At or below this, OI is no longer building the move — an exhaustion confirmation.
export const OI_NOT_RISING_THRESHOLD_PCT = 0.0;

// v1 idiosyncratic-decoupling scope guard (ADR 0003 §4 trap). When idiosyncrasy is at or
// above idiosyncrasy_min_score AND OI is rising AND volume is elevated, v1 refuses to fade.
export const OI_RISING_THRESHOLD_PCT = 0.0;

// --- v2 momentum exit (M3 brief: TP = entry ± atr14 × 2.0, wider than reversion) ---
export const MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0;

// M3 is dry-run only — the orchestrator opens nothing, so the persisted snapshot's
// active_positions_count is always zero. M4 supplies the real live count.
export const ACTIVE_POSITIONS_COUNT_DRY_RUN = 0;

// Machine-readable entry-thesis reason codes stamped on an OPEN signal's reason field
// (skips use the SkipReasonEnum value instead). Queryable in M8 alongside skip reasons.
export const REASON_MEAN_REVERSION_FADE = 'mean_reversion_exhaustion_fade';
export const REASON_MOMENTUM_FOLLOW = 'momentum_follow';
