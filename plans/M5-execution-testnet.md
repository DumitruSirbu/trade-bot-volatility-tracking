# M5 — Execution (testnet)

**Goal:** Approved order intents become real orders on Binance Futures testnet,
recorded faithfully.

**Depends on:** M4 (approved order intents), M2 (positions/transactions).

## Tasks

- **ExecutionModule** consuming approved order intents; places market/limit orders via ccxt on **testnet**.
  - *Output:* a live signal results in a real testnet order.
- **Idempotency across all actions.** Client order IDs / dedup so a restart or retry can't double-fire — applied to `open / add / reduce / close`, not just entries. On an order whose final state is **unknown** (timeout after submit), query by `clientOrderId` before any retry.
  - *Output:* replaying any of the four actions, or recovering from a timeout, places at most one order.
- **Open / reduce / close / add** order paths writing `transactions` and creating/updating `positions`.
  - *Output:* each action persists a transaction and updates position state.
- **Partial-fill handling.** Track filled qty; **recompute position notional and SL/TP from the *actual* filled qty** (not the intended qty); define the unfilled-remainder policy (cancel + re-evaluate vs. leave resting with a timeout).
  - *Output:* protective levels and exposure match the filled qty; remainder handled per policy.
- **Error handling.** Surface and log exchange errors without crashing the loop.
  - *Output:* errors logged and recovered.
- **Attach SL/TP** from the risk intent (exchange-side orders where supported). When unsupported/rejected, the M6 local monitor owns protection — never leave a position unprotected.
  - *Output:* protective orders present after entry, or the local monitor engaged.

## Definition of done

The bot opens and closes a real testnet short end-to-end from a live signal, with
transactions and position rows matching the orders placed.
