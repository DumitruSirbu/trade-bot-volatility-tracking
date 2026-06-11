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
