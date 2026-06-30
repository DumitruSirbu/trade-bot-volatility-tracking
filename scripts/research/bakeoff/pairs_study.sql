-- EXP-016 — Stat-Arb Pairs (z-score reversion, bake-off, read-only)
--
-- Hypothesis: economically linked pairs mean-revert their log-price ratio.
-- Entry when |z| >= :thr (ratio stretched vs its rolling mean); the spread
-- reverts toward the mean over the next :hd hours. Strategy return =
-- -sign(z) * (ratio_forward - ratio_now): positive = reversion captured.
--
-- Market-neutral by construction (long one leg / short the other). First-read
-- on a handful of liquid pairs. Rolling stats over prior :win hours, hourly.
-- Params: :win z-window hours, :hd forward hours, :thr z entry threshold, :nw.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _pairs ON COMMIT DROP AS
WITH pairs(a, b) AS (VALUES
  ('BTC/USDT:USDT','ETH/USDT:USDT'),
  ('BTC/USDT:USDT','SOL/USDT:USDT'),
  ('ETH/USDT:USDT','SOL/USDT:USDT'),
  ('ETH/USDT:USDT','BNB/USDT:USDT'),
  ('BTC/USDT:USDT','BNB/USDT:USDT'),
  ('SOL/USDT:USDT','BNB/USDT:USDT')),
hourly AS (
  SELECT symbol, open_time AS h, close::float8 AS px
  FROM candles WHERE interval='5m' AND extract(minute FROM open_time)=0),
spread AS (
  SELECT p.a, p.b, ha.h,
    ln(ha.px / hb.px) AS ratio
  FROM pairs p
  JOIN hourly ha ON ha.symbol=p.a
  JOIN hourly hb ON hb.symbol=p.b AND hb.h=ha.h
  WHERE ha.px>0 AND hb.px>0),
z AS (
  SELECT a, b, h, ratio,
    avg(ratio) OVER w AS rmean,
    stddev(ratio) OVER w AS rstd,
    lead(ratio, :hd) OVER (PARTITION BY a,b ORDER BY h) AS ratio_fwd
  FROM spread
  WINDOW w AS (PARTITION BY a,b ORDER BY h ROWS BETWEEN :win PRECEDING AND 1 PRECEDING))
SELECT a, b, h, ratio,
  (ratio - rmean)/NULLIF(rstd,0) AS zscore,
  ratio_fwd - ratio AS fwd_change,
  ntile(:nw) OVER (ORDER BY h) AS subwindow
FROM z
WHERE rstd IS NOT NULL AND rstd>0 AND ratio_fwd IS NOT NULL;

\echo '=== PAIRS: coverage ==='
SELECT count(DISTINCT (a||b)) pairs, count(*) obs,
  count(*) FILTER (WHERE abs(zscore)>=:thr) AS entry_events FROM _pairs;

\echo '=== PAIRS: reversion edge at |z|>=thr (strat = -sign(z)*fwd_change) ==='
WITH e AS (
  SELECT (-sign(zscore) * fwd_change) AS strat_ret, subwindow
  FROM _pairs WHERE abs(zscore) >= :thr)
SELECT count(*) n_events,
  round((avg(strat_ret)*100)::numeric,4) AS avg_strat_pct,
  round(((avg(strat_ret)/NULLIF(stddev(strat_ret),0))*sqrt(count(*)))::numeric,2) AS t_stat,
  round((count(*) FILTER (WHERE strat_ret>0)::numeric/count(*)*100)::numeric,1) AS pct_pos
FROM e;

\echo '=== PAIRS: per-pair reversion edge ==='
WITH e AS (
  SELECT a, b, (-sign(zscore)*fwd_change) AS strat_ret
  FROM _pairs WHERE abs(zscore) >= :thr)
SELECT a||' / '||b AS pair, count(*) n, round((avg(strat_ret)*100)::numeric,4) AS avg_strat_pct
FROM e GROUP BY a,b ORDER BY avg_strat_pct DESC;

\echo '=== PAIRS: reversion edge per sub-window ==='
WITH e AS (
  SELECT subwindow, (-sign(zscore)*fwd_change) AS strat_ret
  FROM _pairs WHERE abs(zscore) >= :thr)
SELECT subwindow, count(*) n, round((avg(strat_ret)*100)::numeric,4) AS avg_strat_pct
FROM e GROUP BY subwindow ORDER BY subwindow;
COMMIT;
