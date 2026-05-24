// CLI-level defaults for `strategy compare` (CompareCommand). Kept here rather
// than in strategy/const/strategyConsts.ts because they describe the CLI shell's
// defaults (walk-forward bar counts, latency, allocated capital), not the
// strategy engine itself — the engine treats every config as authoritative.

// One UTC trading day expressed in 5-minute bars.
export const FIVE_MIN_BARS_PER_DAY = 288;

// Default walk-forward split (60d train / 14d validation / 14d OOS / 14d step).
export const DEFAULT_TRAIN_BARS = 60 * FIVE_MIN_BARS_PER_DAY;
export const DEFAULT_VALIDATION_BARS = 14 * FIVE_MIN_BARS_PER_DAY;
export const DEFAULT_OOS_BARS = 14 * FIVE_MIN_BARS_PER_DAY;
export const DEFAULT_STEP_BARS = 14 * FIVE_MIN_BARS_PER_DAY;

// Default allocated capital matches the M7 RunBacktestCommand default so a
// compare run without --allocated-capital agrees with a single-version baseline.
export const DEFAULT_ALLOCATED_CAPITAL_USDT = '10000';

// Default fill-latency assumption in milliseconds; mirrors the production
// exchange-fill envelope observed during M5 testnet smoke runs.
export const DEFAULT_LATENCY_MS = 100;
