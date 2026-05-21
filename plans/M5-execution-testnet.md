# M5 — Execution (testnet)

**Goal:** Approved order intents become real orders on Binance Futures testnet,
recorded faithfully.

**Depends on:** M4 (approved order intents), M2 (positions/transactions).

## Tasks

- **ExecutionModule** consuming approved order intents; places market/limit orders via ccxt on **testnet**.
  - *Output:* a live signal results in a real testnet order.
- **Idempotency.** Client order IDs / dedup so a restart or retry can't double-fire.
  - *Output:* replaying the same intent places at most one order.
- **Open / reduce / close / add** order paths writing `transactions` and creating/updating `positions`.
  - *Output:* each action persists a transaction and updates position state.
- **Partial-fill & error handling.** Track filled qty; surface and log exchange errors without crashing the loop.
  - *Output:* partial fills reconciled; errors logged and recovered.
- **Attach SL/TP** from the risk intent (exchange-side orders where supported).
  - *Output:* protective orders present after entry.

## Definition of done

The bot opens and closes a real testnet short end-to-end from a live signal, with
transactions and position rows matching the orders placed.
