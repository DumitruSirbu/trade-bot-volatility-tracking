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

// --- M8 W5a statistical primitives (ADR 0018) ---

// Politis & White (2004) §3.1 — number of consecutive autocorrelation lags
// required to be below the 2/√N noise band when picking bandwidth M. K = 2 is
// the standard recommendation in the original paper.
export const BACKTEST_POLITIS_WHITE_K_CONSECUTIVE = 2;

// Floor for the selected block length. Prevents pathological tiny blocks on
// short series (a block length of 1 collapses the circular bootstrap into the
// independent bootstrap, defeating the autocorrelation correction).
export const BACKTEST_POLITIS_WHITE_MIN_BLOCK_LEN = 4;

// At least this many blocks must fit into a resample. Cap = floor(N / 5).
// Going lower trims the resample variability that the bootstrap relies on.
export const BACKTEST_POLITIS_WHITE_MIN_BLOCKS_PER_RESAMPLE = 5;

// Fixed number of resamples per pair (ADR 0018 §2.4). Pinned by the brief; NOT
// configurable. Lower weakens the CI; higher has diminishing returns.
export const BACKTEST_BOOTSTRAP_RESAMPLES = 10000;

// Two-sided 95% CI bounds — quantile indices (ADR 0018 §2.4: `floor(0.025 * n)`
// and `ceil(0.975 * n) - 1` into the sorted resampleMeans array).
export const BACKTEST_BOOTSTRAP_CI_LOW_QUANTILE = 0.025;
export const BACKTEST_BOOTSTRAP_CI_HIGH_QUANTILE = 0.975;

// Expected-shortfall threshold for tail-risk stats (ADR 0018 §2.6). Worst 5%
// of `r_t` outcomes are averaged. Floor of one element ensures a non-degenerate
// stat on small samples.
export const BACKTEST_EXPECTED_SHORTFALL_PCT = 0.05;

// --- M8 W5b bootstrap sample-size floors (ADR 0018 §2.5) -------------------
// Used by BootstrapStatsService when deciding whether to run a paired
// circular-block bootstrap for a (versionA, versionB) pair.

// At least this many OPEN trades per candidate; the bootstrap declines to run
// below this threshold. ADR 0018 §2.5.
export const BACKTEST_BOOTSTRAP_TRADES_PER_CANDIDATE_FLOOR = 200;

// Paired non-zero events floor — separate from per-candidate trades because a
// skip vs. open pairing produces a non-zero diff even when one side has fewer
// trades. ADR 0018 §2.5 sets this at 30 as the bootstrap stability floor.
export const BACKTEST_BOOTSTRAP_PAIRED_NON_ZERO_EVENTS_FLOOR = 30;

// --- M8 W7 backtest artefact path-allow-list (security gate) ---------------
// Module-resolved at import time so a single subprocess can never observe the
// env var changing mid-run. Reader (PromotionGateService.loadReportArtefact)
// and writer (CompareCommand.writeArtefact) both path-resolve against this
// root and reject if `path.relative` indicates an escape.
//
// Default: `./var/backtest-artefacts/`. Override via BACKTEST_ARTEFACT_ROOT.
// (The legacy BACKTEST_ARTEFACT_DIR env, if set, takes precedence to keep the
// writer-only smoke runbook working without an env rename — a deprecation
// notice is logged in CompareCommand.)
import { resolve as resolvePath } from 'path';

export const BACKTEST_ARTEFACT_ROOT = resolvePath(
    process.env['BACKTEST_ARTEFACT_ROOT']
        ?? process.env['BACKTEST_ARTEFACT_DIR']
        ?? './var/backtest-artefacts',
);
