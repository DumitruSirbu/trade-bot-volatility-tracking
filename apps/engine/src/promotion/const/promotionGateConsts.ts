import { RegimeLabelEnum, StrategyDirectionEnum } from '@bot/shared';

// Operator-level promotion-gate thresholds (ADR 0019 §2.4). These are the bar a
// candidate must clear; they are NOT per-strategy params (which live in
// strategy_versions.params jsonb). A change to the bar happens via a single PR
// with full review.
//
// Percentages are plain numbers (0..100 unless otherwise noted). They are NOT
// money — they describe ratios of equity / counts and never participate in
// fee/PnL accounting.
//
// First-run placeholders: these are conservative defaults pending re-tuning
// after the first concrete comparison report (ADR 0019 §5 open questions).

// Criterion 3 — max drawdown tolerance. A candidate whose OOS max drawdown
// exceeds this percentage is rejected. 15% is conservative for a low-risk
// survival mandate (live starts at $500-1000, no daily profit target).
export const MAX_DD_TOLERANCE_PCT = 15;

// Criterion 4 — worst single-day loss tolerance, as a percentage of the daily
// equity-curve starting equity. A candidate whose worst day exceeds this is
// rejected as not survivable.
export const WORST_DAY_LOSS_TOLERANCE_PCT = 5;

// Criterion 2 — minimum profit factor on OOS folds.
export const MIN_PROFIT_FACTOR = 1.25;

// Criterion 6 — sample-sufficiency gates (mirrors ADR 0018 §2.5). The gate
// only re-checks; the bootstrap already encodes its own counters. Kept here
// so the gate can produce a structured failure independently if the bootstrap
// produced a 'conclusive' result on an undersized sample.
export const MIN_TOTAL_TRADES = 200;
export const MIN_REGIME_TRADES = 100;
export const MIN_SHADOW_DAYS = 30;

// Criterion 10 — concentration limits. No single symbol may carry more than
// MAX_SYMBOL_CONCENTRATION_PCT % of trades; no single ISO week may carry more
// than MAX_WEEK_CONCENTRATION_PCT %. Starting values per ADR 0019 §5.
export const MAX_SYMBOL_CONCENTRATION_PCT = 40;
export const MAX_WEEK_CONCENTRATION_PCT = 30;

// Criterion 8 — drop-best-5% robustness trim. Mirrors
// BACKTEST_ROBUSTNESS_TOP_TRIM_PCT in the backtest module; redeclared here
// so the gate's threshold is auditable in one file.
export const DROP_BEST_TRIM_PCT = 0.05;

// Criterion 11 — regime-target map keyed by StrategyDirectionEnum (ADR 0019 §5).
// A candidate of a given direction must beat the current active baseline in the
// regimes it is expected to specialise in. v0 baseline is exempt (it is never
// promoted to live in M8).
export const REGIME_TARGETS_BY_DIRECTION: Readonly<Record<StrategyDirectionEnum, readonly RegimeLabelEnum[]>> = {
    [StrategyDirectionEnum.MEAN_REVERSION]: [RegimeLabelEnum.RANGING, RegimeLabelEnum.TRANSITIONING],
    [StrategyDirectionEnum.MOMENTUM]: [RegimeLabelEnum.TRENDING_UP, RegimeLabelEnum.TRENDING_DOWN],
    [StrategyDirectionEnum.HYBRID]: [RegimeLabelEnum.RANGING, RegimeLabelEnum.TRENDING_UP, RegimeLabelEnum.TRENDING_DOWN, RegimeLabelEnum.TRANSITIONING],
};
