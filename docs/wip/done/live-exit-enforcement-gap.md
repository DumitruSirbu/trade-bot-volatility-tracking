# Live exit enforcement gap — stuck open positions (2026-06-12)

**Date:** 2026-06-12  
**Status:** WIP — defect analysis; no fix landed  
**Related milestones:** M31 (zombie lifecycle — **different bug**, DONE). Candidate fix: new milestone (live time-stop + paper protective simulation + entry `cashflow`).

---

## Executive summary

On 2026-06-12 the dashboard correctly showed **two open positions** (PYTH #4, OPN #5). They are **not** M31-style zombies (`qty=0` rows mislabeled as open). They are **genuinely open** (`qty > 0`, `state=open`) and **stuck** because the live/paper engine never fires SL, TP, or time-stop closes after `exchange_side` protection disarms the local monitor.

This is a **pre-existing implementation gap**, not a regression from M31.

---

## Observed state (2026-06-12 ~08:43 UTC)

| `positions_id` | Symbol | Side | `qty` | `time_stop_at` (UTC) | Minutes past time stop |
|----------------|--------|------|-------|----------------------|-------------------------|
| 4 | PYTH/USDT:USDT | short | 13,478 | 06:30 | ~151 |
| 5 | OPN/USDT:USDT | long | 5,372 | 08:25 | ~36 |

Additional facts:

- **Zero** non-terminal rows with `qty = 0` (M31 zombie pattern absent).
- `risk_state.open_exposure` ≈ **$995** — consistent with two live rows, not phantom flat residue.
- `GET /v1/positions/open` (M31 `findLiveRisk()`) matches DB — dashboard is accurate.
- **No `transactions` rows** for positions 4 or 5 (entry audit persist failed — see §4).
- `stop_loss_price` / `take_profit_price` **null** on row; `protective_order_type = exchange_side`.
- Engine logs: `protected EXCHANGE_SIDE (SL+TP at mark price); local monitor disarmed` for both.

---

## M31 vs this defect

| | M31 (DONE) | This defect |
|--|------------|-------------|
| **Symptom** | Dashboard shows open positions that are **flat** | Dashboard shows open positions that **are** open |
| **`qty`** | 0 | > 0 |
| **`state`** | Should be `closed`, stuck non-terminal | Correctly `open` |
| **Root cause** | Close path / lifecycle / `risk_state` not updating on close | **No close intent ever emitted** after open |
| **API filter** | `findLiveRisk()` hides flat zombies | Filter working; rows are real live risk |
| **Source doc** | [first-three-paper-fills-and-zombie-positions.md](done/first-three-paper-fills-and-zombie-positions.md) | This doc |

M31 fixed: `PENDING_OPEN → OPEN` before close writes, lifecycle `risk_state` recompute, boot hardening for `qty=0` residue, read API using `findLiveRisk()`.

M31 did **not** address: live enforcement of time-stop, or paper simulation of exchange-side SL/TP fills.

---

## Design intent (what *should* happen)

Every approved open carries three proposed exits (ADR 0003 §3, M3/M4):

1. **Stop loss** — thesis invalidated by price  
2. **Take profit** — target reached  
3. **Time stop** — thesis timed out  

Strategy params seed `time_stop_minutes: **15**` for all versions (`20260522020000-SeedStrategyVersions.ts`). At open:

```text
time_stop_at = trigger_bar_close + 15 minutes
```

The position should close at the **first** of SL, TP, or time stop — not necessarily exactly at 15 minutes.

**Why 15 minutes:** short-horizon VWAP deviation trades (mean reversion / momentum on 5m bars). If the edge has not played out quickly, holding longer is unwanted exposure ("bag holding"). The strategy **proposes** the deadline; the risk gate **validates** it on open; the execution/position layer **should enforce** it (M4/M6 scope).

---

## What is implemented today

| Layer | Time stop | SL / TP (live) |
|-------|-----------|----------------|
| Strategy | Sets `timeStopAtMs` on open | Proposes SL/TP prices |
| Risk gate | Validates on **open** approval only | Validates liquidation distance |
| DB | Persists `time_stop_at` | Often **null** on row when `exchange_side` (not dual-written) |
| Backtest | **Enforced** (`BacktestRunnerService.checkPositionExit`) | Intrabar + time stop |
| Live / paper | **Not enforced** | `LocalProtectiveMonitor` **disarmed** when `exchange_side` succeeds; paper does not simulate exchange stop fills |

ADR 0011: local monitor handles SL/TP breach via `price.update` — but only while **armed**. ADR 0008: successful exchange attach **disarms** the monitor. In paper mode, protective orders are submitted but nothing watches price to trigger closes the way backtest does.

**Conclusion:** Live/paper can open positions and stamp `time_stop_at`, but nothing closes them when the deadline passes. Positions with `exchange_side` protection are especially exposed because both exchange simulation and local fallback are inactive.

---

## Contributing bugs (same soak, separate fixes)

### 1. Missing live time-stop enforcer (primary)

No scheduler, reconciliation tick, or monitor compares `now` to `positions.time_stop_at` and emits a gated `CLOSE` with `exitReason: time_stop`.

Backtest reference: `BacktestRunnerService.shouldHitTimeStop` + `closePosition(..., 'time_stop', ...)`.

### 2. Paper + `exchange_side` exit vacuum (primary)

After attach success, `ExecutionService` disarms `LocalProtectiveMonitor`. Paper `PaperExecutionClient` does not replay protective order triggers against the live tape. SL/TP never fire even if price crosses levels.

### 3. Entry transaction `cashflow` null (secondary — audit, not root cause of stuck state)

Both opens logged:

```text
entry transaction persist failed ... null value in column "cashflow" of relation "transactions"
```

`recordEntryTransaction` omits `cashflow`; reduce path sets `new Money(0)` for non-close types (`ExecutionService.ts`). Positions still transitioned to `open`; escalation to `RECONCILING` resolved without blocking the stuck-open outcome.

Positions 4 and 5 have **zero** transaction rows. Soak PnL / audit queries that depend on `open` txs are incomplete for these fills.

---

## Operator impact

- Two slots (A/B) occupied indefinitely.  
- `open_exposure` and position caps reflect stuck notional.  
- New entries may be rejected for exposure / slot limits while "dead" trades linger.  
- Telegram / dashboard open alerts are **technically correct** but economically stale.

**Clearing stuck rows today (without code fix):** operator flatten / kill-switch close path, or one-off repair — not recommended as the long-term fix.

---

## Recommended fix direction (for a future milestone)

1. **Live time-stop watcher** — periodic or event-driven (e.g. on `price.update` or reconciliation tick): for each `findLiveRisk()` row where `now >= time_stop_at`, synthesize `CLOSE` through `RiskGateService` with `ExitReasonEnum.TIME_STOP` (same pattern as `LocalProtectiveMonitor.handleBreach`). Idempotent per `positionId`.  
2. **Paper protective simulation** — when `EXCHANGE_ENV=paper` and `protective_order_type=exchange_side`, either keep local monitor armed with persisted SL/TP, or simulate exchange stop triggers from mark price (parity with backtest `IntrabarStopSimulator`).  
3. **Entry `cashflow` fix** — pass `cashflow: new Money(0)` in `recordEntryTransaction` (one-line parity with reduce path).  
4. **Optional:** persist `stop_loss_price` / `take_profit_price` on position row at attach time for boot re-arm and dashboard SL/TP columns.

**Non-goals for that milestone:** changing `time_stop_minutes` param, dashboard-only workarounds, manual SQL as the permanent close mechanism.

---

## Evidence commands (replay)

```sql
-- Live-risk rows (what API/dashboard show)
SELECT positions_id, symbol, side, state, qty, time_stop_at, protective_order_type
FROM positions
WHERE state != 'closed' AND qty::numeric > 0;

-- Zombie check (should be empty post-M31)
SELECT positions_id, symbol, state, qty
FROM positions
WHERE state != 'closed' AND qty::numeric = 0;

-- Missing entry audit
SELECT position_id, type, created_at FROM transactions WHERE position_id IN (4, 5);
```

---

## Cross-references

- M31 plan + outcome: `docs/plans/archive/M31-zombie-positions-and-broken-lifecycle.md`, `docs/milestone-log.md`  
- Zombie defect (resolved): [done/first-three-paper-fills-and-zombie-positions.md](done/first-three-paper-fills-and-zombie-positions.md)  
- Slot / correlated leg (still open): [slot-model-and-correlated-leg-gaps.md](slot-model-and-correlated-leg-gaps.md)  
- ADR 0003 §3 (strategy proposes, M4/M6 enforces)  
- ADR 0011 (local SL/TP monitor)  
- ADR 0008 (exchange-side attach disarms local monitor)  
- ADR 0015 §4.6 (backtest time-stop)
