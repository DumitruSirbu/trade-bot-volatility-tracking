-- One-off repair: stuck open positions 4, 5, 6 (2026-06-12)
-- Backfills open+close transactions (ADR 0012 §5) and closes rows with computed PnL.
-- Exit marks: latest tick_aggregates.close per symbol at repair time.
-- Run ONLY with engine stopped. Requires prior pg_dump.

BEGIN;

-- Guard: abort if any target row is not open with qty > 0
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT COUNT(*) INTO bad FROM positions
  WHERE positions_id IN (4, 5, 6)
    AND NOT (state = 'open' AND qty::numeric > 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'expected 3 open rows with qty>0, found % mismatched', bad;
  END IF;
END $$;

-- Guard: no existing transactions for these positions
DO $$
DECLARE
  n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM transactions WHERE position_id IN (4, 5, 6);
  IF n > 0 THEN
    RAISE EXCEPTION 'transactions already exist for positions 4/5/6 (count=%)', n;
  END IF;
END $$;

-- Latest mark per symbol (repair-time exit proxy)
CREATE TEMP TABLE repair_marks AS
SELECT DISTINCT ON (symbol)
  symbol,
  close::numeric AS exit_price,
  ts AS mark_ts
FROM tick_aggregates
WHERE symbol IN ('PYTH/USDT:USDT', 'OPN/USDT:USDT', 'AMD/USDT:USDT')
ORDER BY symbol, ts DESC;

-- Position facts + marks
CREATE TEMP TABLE repair_plan AS
SELECT
  p.positions_id,
  p.symbol,
  p.side AS pos_side,
  p.entry_price::numeric AS entry_price,
  p.qty::numeric AS qty,
  p.entry_notional::numeric AS entry_notional,
  p.opened_at,
  m.exit_price,
  m.mark_ts,
  CASE p.positions_id
    WHEN 4 THEN 'tbvt-ec69977ab70900cc64a9'
    WHEN 5 THEN 'tbvt-3962356b1f64512332da'
    WHEN 6 THEN 'tbvt-0ad466d20db5d8bd69c6'
  END AS open_client_order_id,
  CASE p.positions_id
    WHEN 4 THEN 'tbvt-728d3b2766547438a9f4'
    WHEN 5 THEN 'tbvt-d435fc4ae83780b02ca1'
    WHEN 6 THEN 'tbvt-a37f6b26e7502bc3108f'
  END AS close_client_order_id,
  CASE p.positions_id
    WHEN 4 THEN 'long'
    WHEN 5 THEN 'short'
    WHEN 6 THEN 'short'
  END AS close_tx_side
FROM positions p
JOIN repair_marks m ON m.symbol = p.symbol
WHERE p.positions_id IN (4, 5, 6);

-- Derived fees + cashflow (4 bps taker; matches fillSimulatorCore FEE_TAKER_BPS)
CREATE TEMP TABLE repair_ledger AS
SELECT
  *,
  ROUND(entry_notional * 0.0004, 8) AS open_fee,
  ROUND(exit_price * qty * 0.0004, 8) AS close_fee,
  CASE pos_side
    WHEN 'long'  THEN ROUND((exit_price - entry_price) * qty, 8)
    WHEN 'short' THEN ROUND((entry_price - exit_price) * qty, 8)
  END AS close_cashflow
FROM repair_plan;

-- Open transactions
INSERT INTO transactions (
  position_id, type, side, price, qty, fee, cashflow,
  client_order_id, exchange_order_id, created_at
)
SELECT
  positions_id,
  'open',
  pos_side,
  entry_price,
  qty,
  open_fee,
  0,
  open_client_order_id,
  'paper-repair-open-' || positions_id::text,
  opened_at
FROM repair_ledger;

-- Close transactions (repair timestamp = now UTC)
INSERT INTO transactions (
  position_id, type, side, price, qty, fee, cashflow,
  client_order_id, exchange_order_id, created_at
)
SELECT
  positions_id,
  'close',
  close_tx_side,
  exit_price,
  qty,
  close_fee,
  close_cashflow,
  close_client_order_id,
  'paper-repair-close-' || positions_id::text,
  NOW() AT TIME ZONE 'UTC'
FROM repair_ledger;

-- Close positions with finalizeRealizedPnl-equivalent aggregate
UPDATE positions p SET
  state = 'closed',
  qty = 0,
  exit_price = r.exit_price,
  exit_reason = 'manual',
  closed_at = NOW() AT TIME ZONE 'UTC',
  realized_pnl = agg.realized_pnl
FROM repair_ledger r
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(CASE WHEN t.type IN ('reduce', 'close') THEN t.cashflow ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN t.type <> 'funding' THEN t.fee ELSE 0 END), 0)
    + COALESCE(SUM(CASE WHEN t.type = 'funding' THEN t.cashflow ELSE 0 END), 0) AS realized_pnl
  FROM transactions t
  WHERE t.position_id = r.positions_id
) agg
WHERE p.positions_id = r.positions_id
  AND p.state = 'open';

-- Link decisions to positions (optional analysis hygiene)
UPDATE decisions d SET position_id = v.positions_id
FROM (VALUES
  ('PYTH/USDT:USDT:1781244600000', 4),
  ('OPN/USDT:USDT:1781251500000', 5),
  ('AMD/USDT:USDT:1781254800000', 6)
) AS v(event_id, positions_id)
WHERE d.event_id = v.event_id AND d.action = 'open' AND d.gate_allowed = true;

-- Rebuild today's risk_state accounting (Option R recompute)
DO $$
DECLARE
  affected integer;
  utc_day_start timestamptz := DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC');
BEGIN
  UPDATE risk_state SET
    open_exposure = (
      SELECT COALESCE(SUM(qty * entry_price), 0)
      FROM positions
      WHERE state <> 'closed' AND qty::numeric > 0
    ),
    realized_pnl_day = (
      SELECT COALESCE(SUM(realized_pnl), 0)
      FROM positions
      WHERE state = 'closed'
        AND closed_at >= utc_day_start
        AND closed_at < utc_day_start + INTERVAL '1 day'
    ),
    trades_count = (
      SELECT COUNT(*)
      FROM positions
      WHERE state = 'closed'
        AND closed_at >= utc_day_start
        AND closed_at < utc_day_start + INTERVAL '1 day'
    )
  WHERE date = (utc_day_start)::date;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'risk_state update touched % rows (expected 1)', affected;
  END IF;
END $$;

-- Post-checks inside txn
DO $$
DECLARE
  open_live integer;
  zombies integer;
  exposure numeric;
BEGIN
  SELECT COUNT(*) INTO open_live FROM positions WHERE state <> 'closed' AND qty::numeric > 0;
  SELECT COUNT(*) INTO zombies FROM positions WHERE state <> 'closed' AND qty::numeric = 0;
  SELECT open_exposure::numeric INTO exposure FROM risk_state WHERE date = (NOW() AT TIME ZONE 'UTC')::date;
  IF open_live <> 0 THEN
    RAISE EXCEPTION 'post-check failed: % live-risk rows remain', open_live;
  END IF;
  IF zombies <> 0 THEN
    RAISE EXCEPTION 'post-check failed: % zombie rows', zombies;
  END IF;
  IF exposure <> 0 THEN
    RAISE EXCEPTION 'post-check failed: open_exposure=% (expected 0)', exposure;
  END IF;
END $$;

-- Summary for operator log
SELECT
  r.positions_id,
  r.symbol,
  r.pos_side,
  r.entry_price,
  r.exit_price,
  r.mark_ts,
  r.close_cashflow,
  r.open_fee + r.close_fee AS total_fees,
  r.close_cashflow - r.open_fee - r.close_fee AS realized_pnl_net,
  p.realized_pnl,
  p.closed_at
FROM repair_ledger r
JOIN positions p ON p.positions_id = r.positions_id;

COMMIT;
