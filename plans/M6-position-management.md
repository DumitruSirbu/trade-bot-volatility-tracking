# M6 — Position management & reconciliation

**Goal:** Authoritative, crash-safe position state that always matches the exchange.

**Depends on:** M5 (execution).

## Tasks

- **Authoritative position state** in memory + DB; single source the rest of the system reads.
  - *Output:* open positions queryable with current state.
- **Reconciliation loop.** Periodically compare local state vs. exchange; exchange is truth; correct drift and alert on mismatch.
  - *Output:* injected drift is detected and corrected.
- **Unrealized PnL** computed from current price vs. entry.
  - *Output:* live unrealized PnL per open position.
- **Realized PnL & exit reason** recorded on close (`take_profit | stop_loss | signal | manual | kill_switch`).
  - *Output:* closed positions carry final PnL + reason.
- **Crash recovery.** On restart, rebuild state from exchange + DB.
  - *Output:* positions survive a process restart and match the exchange.
- **`account_snapshots`** written on a schedule (balance/equity/unrealized).
  - *Output:* equity history accumulating.

## Definition of done

Positions survive a restart and reconcile exactly against the exchange; realized
and unrealized PnL are correct; equity history is recorded.
