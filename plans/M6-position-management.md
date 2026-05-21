# M6 — Position management & reconciliation

**Goal:** Authoritative, crash-safe position state that always matches the exchange.

**Depends on:** M5 (execution).

## Tasks

- **Authoritative position state** in memory + DB; single source the rest of the system reads.
  - *Output:* open positions queryable with current state.
- **Reconciliation with an explicit match key + drift policy.** Match exchange orders/positions to DB rows via **`client_order_id` ↔ `transactions.client_order_id`** (the bot-controlled key, usable even on a post-timeout query; `exchange_order_id` is only the post-fill unique record). Enumerate every drift case and its action: (a) exchange position not in DB → adopt as `manual` **but require human ack before the bot manages it** (alert), or flatten per config; (b) DB-open not on exchange → mark closed/reconciled; (c) qty mismatch → trust exchange, log. Exchange is truth.
  - *Output:* each drift case is detected and handled per the stated policy; injected drift resolves correctly.
- **Release leaked exposure reservations.** When an order's final state is permanently unknown (M5 post-timeout), reconciliation releases its in-flight risk reservation (reservation has a TTL; reconciliation is the authoritative release path).
  - *Output:* a timed-out intent's reservation is freed at reconciliation, not leaked.
- **Local SL/TP monitor (fallback).** When an exchange-side protective order is unavailable or fails/expires, a price-driven monitor closes the position **through the risk gate** at the SL/TP level. (Reviewer blocker: otherwise positions are unprotected.)
  - *Output:* with exchange-side SL/TP disabled, the local monitor still closes at the level.
- **Held symbols stay subscribed.** A coin leaving the top-300 universe must keep its price subscription + SL/TP monitoring until its position closes. (Reviewer blocker: universe churn must not drop tracking.)
  - *Output:* dropping a held coin from the universe does not lose its price/PnL/SL tracking.
- **Funding cashflows recorded.** Periodic funding payments/charges on open positions written as `transactions` so realized PnL (and M8 comparisons) are accurate.
  - *Output:* funding events appear in `transactions` and flow into realized PnL.
- **Unrealized PnL** from current price vs. entry (decimal, correct sign per side), net of accrued funding.
  - *Output:* live unrealized PnL per open position.
- **Realized PnL & exit reason** recorded on close (`take_profit | stop_loss | signal | manual | kill_switch`). The `kill_switch` flag reads the M0 halt primitive.
  - *Output:* closed positions carry final PnL + reason.
- **Crash recovery with re-association.** On restart, rebuild state from exchange + DB, re-associating each exchange position with its DB row (strategy_version, SL/TP, cooldown) via the match key; orphans handled per the drift policy.
  - *Output:* positions survive a restart, match the exchange, and keep their strategy/risk context.
- **`account_snapshots`** written on a schedule (balance/equity/unrealized).
  - *Output:* equity history accumulating.

## Definition of done

Positions survive a restart with full strategy/risk context, reconcile against the
exchange under an explicit drift policy, stay protected and tracked even after
leaving the universe, and account for funding in realized PnL.
