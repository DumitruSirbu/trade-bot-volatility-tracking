-- Cross-Sectional Momentum — Decile Forward-Return Study (Phase A, read-only)
--
-- Tests whether the cross-section of trailing returns predicts forward returns
-- in the perp universe. At each non-overlapping rebalance point it ranks every
-- tradable symbol by its trailing return over :lb hours, buckets into deciles,
-- and measures each symbol's forward return over the next :hd hours. The
-- top-minus-bottom decile spread is the candidate momentum edge.
--
-- This is OFFLINE ANALYSIS over existing `candles` only. It opens no positions
-- and changes no engine state. It is the cheap go/no-go gate before building
-- the Phase B position-level simulation (which would feed entries into the
-- existing HistoricalFillAdapter / simulateIntrabarStop engine).
--
-- Parameters (psql -v):
--   lb     trailing lookback, hours          (e.g. 6, 24, 72)
--   hd     holding / forward window, hours   (e.g. 6, 24); also the rebalance step
--   floor  min median 5m dollar-volume to be tradable (liquidity gate, e.g. 20000)
--   nw     number of disjoint sub-windows for robustness (e.g. 3)
--   cost   round-trip cost per leg, bps (long-short = 4 legs/period, e.g. 10)
--
-- Non-overlapping design: the rebalance step equals the holding window, so
-- forward windows never overlap. This avoids the autocorrelation that would
-- inflate the t-stat under overlapping holds. Fewer samples, honest inference.
--
-- Output: three result sets — (A) per-decile pooled means, (B) long-short
-- per-period series stats + t-stat + annualized Sharpe + net-of-cost, (C) the
-- per-sub-window long-short spread for robustness.

\set ON_ERROR_STOP on

-- Shared CTEs are recomputed per result set (psql has no cross-statement temp
-- without a transaction block); kept in a prepared view-like WITH for clarity.
-- To avoid triple duplication we materialize the ranked panel into a TEMP TABLE
-- inside a single transaction, then run the three aggregations against it.

BEGIN;

CREATE TEMP TABLE _xmom_ranked ON COMMIT DROP AS
WITH bounds AS (
    SELECT min(open_time) AS t0, max(open_time) AS t1
    FROM candles WHERE interval = '5m'
),
liquidity AS (
    SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close * volume) AS med_5m_dvol
    FROM candles WHERE interval = '5m'
    GROUP BY symbol
),
tradable AS (
    SELECT symbol FROM liquidity WHERE med_5m_dvol >= :floor
),
grid AS (
    SELECT gs AS rebal_time
    FROM bounds,
         generate_series(
             (SELECT t0 FROM bounds) + (:lb || ' hours')::interval,
             (SELECT t1 FROM bounds) - (:hd || ' hours')::interval,
             (:hd || ' hours')::interval
         ) AS gs
),
panel AS (
    SELECT
        g.rebal_time,
        c_now.symbol,
        c_now.close / c_back.close - 1 AS trailing_return,
        c_fwd.close / c_now.close - 1 AS forward_return
    FROM grid g
    JOIN tradable tr ON true
    JOIN candles c_now  ON c_now.interval  = '5m' AND c_now.symbol  = tr.symbol AND c_now.open_time  = g.rebal_time
    JOIN candles c_back ON c_back.interval = '5m' AND c_back.symbol = tr.symbol AND c_back.open_time = g.rebal_time - (:lb || ' hours')::interval
    JOIN candles c_fwd  ON c_fwd.interval  = '5m' AND c_fwd.symbol  = tr.symbol AND c_fwd.open_time  = g.rebal_time + (:hd || ' hours')::interval
    WHERE c_now.close > 0 AND c_back.close > 0 AND c_fwd.close > 0
)
SELECT
    rebal_time,
    symbol,
    trailing_return,
    forward_return,
    ntile(10) OVER (PARTITION BY rebal_time ORDER BY trailing_return) AS decile,
    ntile(:nw) OVER (ORDER BY rebal_time)                            AS subwindow
FROM panel;

\echo '=== PARAMS ==='
SELECT :lb AS lookback_h, :hd AS holding_h, :floor AS liq_floor_dvol, :nw AS n_windows, :cost AS cost_bps_per_leg;

\echo '=== COVERAGE ==='
SELECT
    count(DISTINCT rebal_time) AS rebalances,
    count(DISTINCT symbol)     AS universe_symbols,
    count(*)                   AS observations
FROM _xmom_ranked;

\echo '=== (A) PER-DECILE POOLED FORWARD RETURN ==='
SELECT
    decile,
    count(*)                            AS n,
    round((avg(trailing_return) * 100)::numeric, 3) AS avg_trailing_pct,
    round((avg(forward_return)  * 100)::numeric, 3) AS avg_forward_pct,
    round(((avg(forward_return) / NULLIF(stddev(forward_return), 0)) * sqrt(count(*)))::numeric, 2) AS forward_t
FROM _xmom_ranked
GROUP BY decile
ORDER BY decile;

\echo '=== (B) LONG-SHORT (D10 - D1) PER-PERIOD SERIES ==='
WITH ls AS (
    SELECT
        rebal_time,
        avg(forward_return) FILTER (WHERE decile = 10)
          - avg(forward_return) FILTER (WHERE decile = 1) AS ls_ret
    FROM _xmom_ranked
    GROUP BY rebal_time
)
SELECT
    count(*)                                           AS n_periods,
    round((avg(ls_ret) * 100)::numeric, 4)             AS gross_mean_pct,
    round(((avg(ls_ret) - 4 * (:cost / 10000.0)) * 100)::numeric, 4) AS net_mean_pct,
    round((stddev(ls_ret) * 100)::numeric, 4)          AS std_pct,
    round((avg(ls_ret) / NULLIF(stddev(ls_ret) / sqrt(count(*)), 0))::numeric, 2) AS t_stat,
    round(((avg(ls_ret) / NULLIF(stddev(ls_ret), 0)) * sqrt((365.0 * 24) / :hd))::numeric, 2) AS ann_sharpe_gross,
    round((count(*) FILTER (WHERE ls_ret > 0)::numeric / count(*) * 100)::numeric, 1) AS pct_periods_positive
FROM ls;

\echo '=== (C) LONG-SHORT SPREAD PER SUB-WINDOW (robustness) ==='
WITH ls AS (
    SELECT
        subwindow,
        rebal_time,
        avg(forward_return) FILTER (WHERE decile = 10)
          - avg(forward_return) FILTER (WHERE decile = 1) AS ls_ret
    FROM _xmom_ranked
    GROUP BY subwindow, rebal_time
)
SELECT
    subwindow,
    count(*)                          AS n_periods,
    round((avg(ls_ret) * 100)::numeric, 4) AS gross_mean_pct,
    min(rebal_time)::date::text || ' .. ' || max(rebal_time)::date::text AS span
FROM ls
GROUP BY subwindow
ORDER BY subwindow;

COMMIT;
