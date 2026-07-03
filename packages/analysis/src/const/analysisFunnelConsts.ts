// Funnel-diagnostic constants for the getFunnelSummary query (M29).
//
// These mirror engine constants that @bot/analysis cannot import directly
// (ADR 0033 package-boundary: the analysis package must not depend on the
// engine). They must be kept in sync manually if the engine values change;
// both are deliberately conservative (slight over-detection of bad rows,
// never under-detection).

/** Binance USDT-M maintenance-margin rate proxy (fraction of notional).
 *  Mirrors engine `DEFAULT_MAINTENANCE_MARGIN_RATE` in riskConsts.ts.
 *  Used to reproduce the gate's non-positive-liquidation-fraction check:
 *  liquidationFraction = 1/leverage - MAINTENANCE_MARGIN_RATE. */
export const FUNNEL_MAINTENANCE_MARGIN_RATE = 0.005;

/** Paper-profile leverage ceiling.
 *  Mirrors engine `MAX_LEVERAGE` in riskConsts.ts.
 *  A decision row whose `leverage` exceeds this is classified over-levered. */
export const FUNNEL_MAX_LEVERAGE = 3;

/** Validates that a string is a UTC calendar date in 'YYYY-MM-DD' format. */
export const FUNNEL_UTC_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// M30 — Idiosyncratic-edge soak gate constants

/** ADR 0004 §8b floor: minimum closed idiosyncratic trades before the expectancy is statistically meaningful. */
export const MIN_CLOSED_TRADES_FOR_EDGE_VERDICT = 20;

/** ADR 0004 §8b floor: minimum distinct UTC trading days before the expectancy is statistically meaningful. */
export const MIN_TRADING_DAYS_FOR_EDGE_VERDICT = 3;

/** Advisory: per-bar BTC-move regime bucket minimum sample size below which sign should not be trusted. */
export const REGIME_BUCKET_MIN_N = 8;

// BTC-move partition boundary (mirrors engine const btc_correlated_move_threshold_pct = 1.5%)
export const BTC_REGIME_PARTITION_PCT = 1.5;

// Miss-distance histogram bucket edges (five equal-width [0,0.1) … [0.4,0.5])
export const MISS_DISTANCE_BUCKET_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5] as const;

// M52 D3 (ADR 0051 §6 / §6.1) — force_close ATR-unit drift histogram bucket edges for
// getRetryAttribution. 0.25-wide bands through the calibration-relevant range (straddling the
// provisional MOMENTUM_RETRY_MAX_ATR_DRIFT=1.0) so D4 can place the threshold off a fine grid. The
// histogram is only an eyeballing aid for where the stale-reference cluster ends; the final threshold
// is set from the RAW force_close_atr_units_drift column, not these bins. Final band is open-ended.
export const RETRY_DRIFT_BUCKET_EDGES = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, Number.POSITIVE_INFINITY] as const;

// M52 D3 (ADR 0051 §6) — ATR-as-fraction-of-entry-price bands for getRetryAttribution's matched-
// control cells. ATR in absolute price units is not comparable across coins; normalising by entry
// price yields a regime/coin-comparable volatility band. Final band is open-ended.
export const RETRY_ATR_PCT_BUCKET_EDGES = [0, 0.01, 0.02, 0.04, Number.POSITIVE_INFINITY] as const;

// M52 D3 (ADR 0051 §D3 / M51 carry-over) — surfaced on getRetryAttribution's report: if the paper
// fill simulator fills flat at best-quote with zero slippage, the counterfactual PnL and any
// slippage read are pipeline-validation only, not edge.
export const RETRY_FLAT_FILL_SIM_CAVEAT =
    'Counterfactual PnL and slippage reads are pipeline-validation only, not edge, if the paper fill ' +
    'simulator fills flat at best-quote with zero slippage (ADR 0051 §D3 / M51 carry-over).';
