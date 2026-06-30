-- EXP-013 — Funding-Rate Carry / Squeeze (bake-off, read-only)
--
-- Hypothesis: extreme funding marks crowding. High positive funding = crowded
-- longs = fragile → fade (short). The tradable spread is long-low-funding /
-- short-high-funding; positive spread = fade edge.
--
-- Method: at each non-overlapping rebalance (every :hd hours) rank tradable
-- symbols by their funding rate at t, bucket into deciles (D10 = highest
-- funding = most crowded longs), measure forward return over :hd hours. The
-- "fade spread" = avg_fwd(D1 low funding) − avg_fwd(D10 high funding).
--
-- Params: :hd holding/rebalance hours, :floor liquidity, :nw sub-windows.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _fund ON COMMIT DROP AS
WITH bounds AS (SELECT min(open_time) t0, max(open_time) t1 FROM candles WHERE interval='5m'),
liq AS (SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close*volume) med FROM candles WHERE interval='5m' GROUP BY symbol),
tradable AS (SELECT symbol FROM liq WHERE med >= :floor),
grid AS (
  SELECT gs AS t FROM bounds,
  generate_series((SELECT t0 FROM bounds)+interval '24 hours',
                  (SELECT t1 FROM bounds)-(:hd||' hours')::interval,
                  (:hd||' hours')::interval) gs),
-- funding observed at-or-before t (nearest prior hourly row)
fund_at AS (
  SELECT g.t, tr.symbol,
    (SELECT fr.rate FROM funding_rates fr WHERE fr.symbol=tr.symbol AND fr.funding_time <= g.t ORDER BY fr.funding_time DESC LIMIT 1) AS rate
  FROM grid g JOIN tradable tr ON true),
panel AS (
  SELECT f.t, f.symbol, f.rate::float8 AS funding_rate,
         (cf.close/c0.close-1)::float8 AS forward_return
  FROM fund_at f
  JOIN candles c0 ON c0.interval='5m' AND c0.symbol=f.symbol AND c0.open_time=f.t
  JOIN candles cf ON cf.interval='5m' AND cf.symbol=f.symbol AND cf.open_time=f.t+(:hd||' hours')::interval
  WHERE f.rate IS NOT NULL AND c0.close>0 AND cf.close>0)
SELECT t, symbol, funding_rate, forward_return,
  ntile(10) OVER (PARTITION BY t ORDER BY funding_rate) AS decile,
  ntile(:nw) OVER (ORDER BY t) AS subwindow
FROM panel;

\echo '=== FUNDING: coverage ==='
SELECT count(DISTINCT t) rebalances, count(DISTINCT symbol) symbols, count(*) obs FROM _fund;

\echo '=== FUNDING: per-decile (D10 = highest funding = most crowded longs) ==='
SELECT decile, count(*) n,
  round((avg(funding_rate)*100)::numeric,4) AS avg_funding_pct,
  round((avg(forward_return)*100)::numeric,3) AS avg_forward_pct
FROM _fund GROUP BY decile ORDER BY decile;

\echo '=== FUNDING: fade spread (long D1 low-funding / short D10 high-funding) per period ==='
WITH s AS (
  SELECT t, avg(forward_return) FILTER (WHERE decile=1) - avg(forward_return) FILTER (WHERE decile=10) AS fade
  FROM _fund GROUP BY t)
SELECT count(*) n_periods,
  round((avg(fade)*100)::numeric,4) AS gross_mean_pct,
  round((avg(fade)/NULLIF(stddev(fade)/sqrt(count(*)),0))::numeric,2) AS t_stat,
  round((count(*) FILTER (WHERE fade>0)::numeric/count(*)*100)::numeric,1) AS pct_pos
FROM s;

\echo '=== FUNDING: fade spread per sub-window ==='
WITH s AS (
  SELECT subwindow, t, avg(forward_return) FILTER (WHERE decile=1) - avg(forward_return) FILTER (WHERE decile=10) AS fade
  FROM _fund GROUP BY subwindow, t)
SELECT subwindow, count(*) n, round((avg(fade)*100)::numeric,4) AS gross_mean_pct
FROM s GROUP BY subwindow ORDER BY subwindow;
COMMIT;
