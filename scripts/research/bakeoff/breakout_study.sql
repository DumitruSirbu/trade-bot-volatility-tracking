-- EXP-015 — Donchian Breakout Trend-Following (bake-off, read-only)
--
-- Hypothesis: a close breaking above the prior :lb-hour high continues up
-- (long edge); below the prior :lb-hour low continues down (short edge).
-- Accept low hit rate for convex payoff. Edge test: forward return over the
-- next :hd hours after breakout events, vs the unconditional baseline, plus
-- hit rate.
--
-- Rolling channel via window MAX/MIN over the prior :lb hours of 5m bars
-- (12 bars/hour). Evaluated only at top-of-hour bars to limit overlap.
-- Params: :lb channel hours, :hd forward hours, :floor liquidity, :nw windows.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _brk ON COMMIT DROP AS
WITH liq AS (SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close*volume) med FROM candles WHERE interval='5m' GROUP BY symbol),
tradable AS (SELECT symbol FROM liq WHERE med >= :floor),
series AS (
  SELECT c.symbol, c.open_time, c.close::float8 AS close,
    max(c.high) OVER w AS chan_high,
    min(c.low)  OVER w AS chan_low,
    lead(c.close, (:hd*12)::int) OVER (PARTITION BY c.symbol ORDER BY c.open_time)::float8 AS fwd_close
  FROM candles c JOIN tradable tr ON tr.symbol=c.symbol
  WHERE c.interval='5m'
  WINDOW w AS (PARTITION BY c.symbol ORDER BY c.open_time ROWS BETWEEN (:lb*12)::int PRECEDING AND 1 PRECEDING)),
events AS (
  SELECT symbol, open_time, close,
    (fwd_close/close-1)::float8 AS forward_return,
    CASE WHEN close > chan_high THEN 'breakout_up'
         WHEN close < chan_low  THEN 'breakout_dn' END AS signal
  FROM series
  WHERE chan_high IS NOT NULL AND fwd_close IS NOT NULL AND close>0
    AND extract(minute FROM open_time)=0)   -- top-of-hour only
SELECT symbol, open_time, signal,
  CASE WHEN signal='breakout_up' THEN forward_return ELSE -forward_return END AS dir_return,
  forward_return,
  ntile(:nw) OVER (ORDER BY open_time) AS subwindow
FROM events WHERE signal IS NOT NULL;

\echo '=== BREAKOUT: baseline (all top-of-hour bars, unconditional fwd) ==='
WITH liq AS (SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close*volume) med FROM candles WHERE interval='5m' GROUP BY symbol),
tradable AS (SELECT symbol FROM liq WHERE med >= :floor),
base AS (
  SELECT (lead(c.close,(:hd*12)::int) OVER (PARTITION BY c.symbol ORDER BY c.open_time)/c.close-1)::float8 AS fwd
  FROM candles c JOIN tradable tr ON tr.symbol=c.symbol
  WHERE c.interval='5m' AND extract(minute FROM c.open_time)=0)
SELECT count(*) n, round((avg(fwd)*100)::numeric,4) AS avg_fwd_pct FROM base WHERE fwd IS NOT NULL;

\echo '=== BREAKOUT: directional edge per signal ==='
SELECT signal, count(*) n,
  round((avg(dir_return)*100)::numeric,4) AS avg_dir_pct,
  round(((avg(dir_return)/NULLIF(stddev(dir_return),0))*sqrt(count(*)))::numeric,2) AS t_stat,
  round((count(*) FILTER (WHERE dir_return>0)::numeric/count(*)*100)::numeric,1) AS hit_rate
FROM _brk GROUP BY signal ORDER BY signal;

\echo '=== BREAKOUT: combined (long up-breakouts + short dn-breakouts) per sub-window ==='
SELECT subwindow, count(*) n, round((avg(dir_return)*100)::numeric,4) AS avg_dir_pct
FROM _brk GROUP BY subwindow ORDER BY subwindow;
COMMIT;
