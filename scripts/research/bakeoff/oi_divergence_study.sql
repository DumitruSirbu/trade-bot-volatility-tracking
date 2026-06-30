-- EXP-014 — OI-Divergence Quadrant (bake-off, read-only)
--
-- Hypothesis: price direction × OI direction classifies move quality.
--   price↑ & OI↑ = new longs  → continuation up (follow long)
--   price↓ & OI↑ = new shorts → continuation down (follow short)
--   price↑ & OI↓ = short cover → fade/flat
--   price↓ & OI↓ = long liq   → bounce/flat
-- Edge test: forward return per quadrant, and a "follow fresh money" rule
-- (long price↑OI↑, short price↓OI↑) vs the two "closing" quadrants.
--
-- Price/OI change measured over the last :win hours; forward return over the
-- next :hd hours. Hourly grid. OI resolved to last value per symbol per hour.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _oi ON COMMIT DROP AS
WITH bounds AS (SELECT min(open_time) t0, max(open_time) t1 FROM candles WHERE interval='5m'),
liq AS (SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close*volume) med FROM candles WHERE interval='5m' GROUP BY symbol),
tradable AS (SELECT symbol FROM liq WHERE med >= :floor),
oi_hourly AS (
  SELECT DISTINCT ON (symbol, date_trunc('hour', ts)) symbol,
         date_trunc('hour', ts) AS hour_ts, value::float8 AS oi
  FROM open_interest
  ORDER BY symbol, date_trunc('hour', ts), ts DESC),
grid AS (
  SELECT gs AS t FROM bounds,
  generate_series(date_trunc('hour',(SELECT t0 FROM bounds))+interval '24 hours',
                  (SELECT t1 FROM bounds)-(:hd||' hours')::interval,
                  interval '1 hour') gs),
panel AS (
  SELECT g.t, tr.symbol,
    (c0.close/cb.close-1)::float8 AS price_chg,
    (oi0.oi/oib.oi-1)::float8 AS oi_chg,
    (cf.close/c0.close-1)::float8 AS forward_return
  FROM grid g JOIN tradable tr ON true
  JOIN candles c0 ON c0.interval='5m' AND c0.symbol=tr.symbol AND c0.open_time=g.t
  JOIN candles cb ON cb.interval='5m' AND cb.symbol=tr.symbol AND cb.open_time=g.t-(:win||' hours')::interval
  JOIN candles cf ON cf.interval='5m' AND cf.symbol=tr.symbol AND cf.open_time=g.t+(:hd||' hours')::interval
  JOIN oi_hourly oi0 ON oi0.symbol=tr.symbol AND oi0.hour_ts=g.t
  JOIN oi_hourly oib ON oib.symbol=tr.symbol AND oib.hour_ts=g.t-(:win||' hours')::interval
  WHERE c0.close>0 AND cb.close>0 AND cf.close>0 AND oib.oi>0)
SELECT t, symbol, price_chg, oi_chg, forward_return,
  CASE WHEN price_chg>=0 AND oi_chg>=0 THEN 'up_oiUp_newLong'
       WHEN price_chg<0  AND oi_chg>=0 THEN 'dn_oiUp_newShort'
       WHEN price_chg>=0 AND oi_chg<0  THEN 'up_oiDn_shortCover'
       ELSE 'dn_oiDn_longLiq' END AS quadrant,
  ntile(:nw) OVER (ORDER BY t) AS subwindow
FROM panel;

\echo '=== OI-DIV: coverage ==='
SELECT count(DISTINCT t) hours, count(DISTINCT symbol) symbols, count(*) obs FROM _oi;

\echo '=== OI-DIV: forward return per quadrant ==='
SELECT quadrant, count(*) n,
  round((avg(forward_return)*100)::numeric,3) AS avg_forward_pct,
  round(((avg(forward_return)/NULLIF(stddev(forward_return),0))*sqrt(count(*)))::numeric,2) AS fwd_t
FROM _oi GROUP BY quadrant ORDER BY avg_forward_pct DESC;

\echo '=== OI-DIV: follow-fresh-money directional edge ==='
-- long price-up/OI-up: capture +fwd ; short price-down/OI-up: capture -fwd
WITH dir AS (
  SELECT t, quadrant, forward_return,
    CASE WHEN quadrant='up_oiUp_newLong' THEN forward_return
         WHEN quadrant='dn_oiUp_newShort' THEN -forward_return END AS strat_ret
  FROM _oi WHERE quadrant IN ('up_oiUp_newLong','dn_oiUp_newShort'))
SELECT count(*) n_events,
  round((avg(strat_ret)*100)::numeric,4) AS avg_strat_pct,
  round(((avg(strat_ret)/NULLIF(stddev(strat_ret),0))*sqrt(count(*)))::numeric,2) AS t_stat,
  round((count(*) FILTER (WHERE strat_ret>0)::numeric/count(*)*100)::numeric,1) AS pct_pos
FROM dir;

\echo '=== OI-DIV: follow-fresh-money per sub-window ==='
WITH dir AS (
  SELECT subwindow,
    CASE WHEN quadrant='up_oiUp_newLong' THEN forward_return
         WHEN quadrant='dn_oiUp_newShort' THEN -forward_return END AS strat_ret
  FROM _oi WHERE quadrant IN ('up_oiUp_newLong','dn_oiUp_newShort'))
SELECT subwindow, count(*) n, round((avg(strat_ret)*100)::numeric,4) AS avg_strat_pct
FROM dir GROUP BY subwindow ORDER BY subwindow;
COMMIT;
