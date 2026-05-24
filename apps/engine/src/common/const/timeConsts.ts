// Cross-cutting time conversions. Single source of truth so modules and migrations
// never re-declare the same magic millisecond constants inline.
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

// Width of one primary trading candle. The project locks 5-minute bars as the
// canonical interval (`docs/plans/00-overview.md`); consumers that translate
// bar-count policies (e.g. walk-forward folds, lookback windows) into wall-clock
// ranges import this rather than re-deriving the multiplier inline.
export const FIVE_MINUTE_MS = 5 * 60 * 1000;
