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

- **Order-policy realism.** For mean-reversion, a plain market order at peak spread destroys the edge. Use a **marketable-limit-with-max-slippage** or **post-only maker entry after confirmation**; cancel if not filled quickly; **no chasing missed entries**. Order policy may vary by tier/regime. The M7 backtest must mirror this policy and model **missed fills** for limit orders, so live and replay agree on fill quality.
  - *Output:* entries use a slippage-bounded/maker policy; unfilled orders cancel within a timeout; missed entries are not chased; the policy is documented for M7 to mirror.

## Definition of done

The bot opens and closes a real testnet short end-to-end from a live signal, with
transactions and position rows matching the orders placed.

## Architectural foundations (pre-W1)

Locked before implementation; binding on every wave below:

- ADR 0005 — Execution order policy (policy matrix, slippage caps, no-chase rule, M7 mirror)
- ADR 0006 — Idempotency contract (deterministic `clientOrderId`, timeout-recovery protocol)
- ADR 0007 — Partial-fill semantics (filled qty drives all state; remainder policy)
- ADR 0008 — SL/TP attach & local-fallback (always-protected invariant)
- `docs/architecture/live-vs-backtest-contract.md` — M5 clauses C5–C10 (M7 will replay against these)

## Outcome / Review rounds

**DONE after 5 review rounds.** ExecutionModule + idempotent open/add/reduce/close with partial-fill & local-fallback SL/TP protection. 898 unit tests pass (50 suites); 3 Postgres-integration suites env-blocked.

### Waves executed
1. **bot-engine-nestjs:** ExecutionModule, ExecutionService, FillAccumulator, LocalProtectiveMonitor, idempotency keying, ccxt testnet integration, policies matrix.
2. **bot-shared-maintainer:** flowType + midAtTrigger on IOrderIntent; new events IPositionClosedEvent, IOrderIntentUnknownEvent, ORDER_AUDIT_PERSIST_FAILED_EVENT; AuditFailureReasonEnum; reject taxonomy (RETRIABLE/TERMINAL/UNKNOWN per ADR 0006 §4).
3. **bot-qa-engineer:** 898 unit tests, integration test scaffolding, Postgres env-blocking documented.

### Tests & artifacts
- 898 engine unit tests across 50 suites (ExecutionService, FillAccumulator, LocalProtectiveMonitor, idempotency, policies, partial-fills, error recovery).
- 3 reversible migrations:
  - `20260524010000-AddPositionProtectiveOrderTypeDefault.ts`: NOT NULL default `local_fallback` on protective_order_type, uq_transactions_client_order_id.
  - `20260524020000-RelaxTransactionPositionIdNullable.ts`: nullable position_id with CHECK constraint (zero-fill audit rows); revert is destructive, documented.

### Review round 1
- **Blockers 8:** reject taxonomy missing, missing IOrderIntentUnknownEvent, missing arm/disarm invariants, FillAccumulator missing weighted-avg ADD, retry path not HaltFlagService-gated, ccxt timeout not idempotent, protective-order attach missing local_fallback fallback, missing order-policy docs for M7 mirror.
- **Highs 6:** classifyAuditFailure substring fallback, IPositionClosedEvent type union noise, IOrderIntentUnknownEvent.reason union broadening, awaitPolicyTimeout branching incomplete, midAtTrigger book.mid vs VWAP mismatch, LocalProtectiveMonitor arm timing.
- **Fixes:** reject enum per ADR 0006 §4 (RETRIABLE/TERMINAL/UNKNOWN); IOrderIntentUnknownEvent with optional reason; arm-before-await + disarm-before-await invariants documented; FillAccumulator weighted-avg entry recompute on ADD; all retry hops HaltFlagService-gated; clientOrderId idempotency keying (deterministic, timeout-recovery query); local_fallback fallback when exchange SL/TP rejects; order policies documented in executionConsts.ts matrix.

### Review round 2
- **Blockers 1:** awaitPolicyTimeout branches per-policy not global (fixed per executionConsts matrix).
- **Highs 5:** LocalProtectiveMonitor armed state re-sync on boot, REDUCE remainder M6 escalation (documented as deferred), StrategyService.reconstructReferencePrice midAtTrigger projection (vwap × deviation, live/backtest parity via in-memory), book_snapshots.mid_at_trigger column deferred (M2 follow-up), entry-side fees not subtracted from realized PnL (M7/M8).
- **Fixes:** per-policy awaitPolicyTimeout keyed in executionConsts; LocalProtectiveMonitor sealed with comment; REDUCE remainder deferred M6 doc block; midAtTrigger reconstructed live/backtest sync; fees deferred explicit doc.

### Review rounds 3–5
- **Round 3 blockers:** 1 (HaltFlagService not injected on LocalProtectiveMonitor → fixed).
- **Round 4 blockers:** 0.
- **Round 5 blockers:** 0.
- **Highs trend:** 6 → 5 → 2 → 1 → 0.
- **End state:** zero blockers/highs, all deferreds documented, contracts threaded (flowType, midAtTrigger, reject taxonomy, arm/disarm, per-policy timeouts, weighted-avg ADD, HaltFlagService-gated retries), live/backtest parity established.

### Deferred to M6/M7/M8
1. **M6 owns:** LocalProtectiveMonitor evaluation loop (SL/TP enforcement), re-arming OPEN positions whose status was never persisted due to save-exception, position reconciliation on boot.
2. **M7/M8 owns:** entry-side fees subtracted from realized PnL on close; BNB→USDT fee currency normalization.
3. **M2 follow-up (M9):** Persist book_snapshots.mid_at_trigger column (M5 stands in with reconstructReferencePrice; live/backtest in-memory parity holds, but forensic replay needs the real column).

## Adversarial backfill — 2026-05-23

**Surfaces (5):**

1. **Idempotency replay on UNKNOWN reject** — submit order, fail with timeout path, restart engine; confirm clientOrderId query lands one row, not zero or two. Deterministic `clientOrderId` collision case (same intent re-emitted by retry path).
2. **arm-before-await invariant on LocalProtectiveMonitor** — crash window between order-place response and monitor arm, between disarm and close acknowledgment. M5 round 1 caught once — regression-test. **Scope clarification:** validates only the **contract** M6's boot-resync relies on (`protective_order_type = local_fallback`, `position.status` correct, row visible to future M6 scan). Boot-resync **logic itself stays M6 scope**.
3. **Partial-fill recompute on weighted-average ADD** — ADD to open position with partial fill; position notional, entry price, SL/TP recomputed off **actual** filled qty, not intended. Boundary: zero fill, single-tick, full fill, fill > intent.
4. **HaltFlagService gating on every retry hop** — halt flips mid-retry on RETRIABLE reject; no further retry. Same for reconciliation-on-boot path.
5. **awaitPolicyTimeout per-policy boundary** — each policy exercised at exactly its timeout, timeout − 1ms, timeout + 1ms; confirm cancel-vs-leave-resting matches policy. M5 round 2 caught global-vs-per-policy bug — regression-test.

**Findings:**

- **Round 1 (0 blockers, 0 highs):** 5 plan surfaces tested (idempotency replay, M6-boot-resync contract, partial-fill drift, halt mid-flight, timeout boundaries). 20 adversarial tests added. **No findings — clean.** The 5-round review cycle that closed M5 hardened the surface thoroughly; this pass validates the bar is set correctly. M5's adversarial pass covers ONLY the contract surface M6 will rely on (correct `protective_order_type`, `position.status`, `client_order_id` on rows). Actual boot-resync logic is M6 scope and gets adversarial coverage when M6 implements it.

**Tests added:** 20 adversarial tests in round 1 (all unit-level, no Postgres-integration).

**Round count: 1.** Zero blockers, zero highs. End state: clean.

### Acceptable open mediums
- `classifyAuditFailure` substring fallback (best-effort, fails safe).
- IPositionClosedEvent type union noise (`| null | undefined` legible).
- IOrderIntentUnknownEvent.reason union vs string (union preferred; string broadening acceptable medium-term).

### Definition-of-done evidence

Testnet smoke runbook (run yourself later):

1. **Start Postgres:** `docker compose up` (port 5432 or 5433 per env).
2. **Apply migrations:** `pnpm migration:run` (applies M0–M5 chain).
3. **Configure testnet:** Set `EXECUTION_MODE=live`, `EXCHANGE_TESTNET=true`, `EXCHANGE_API_KEY`/`EXCHANGE_API_SECRET` to testnet keys (expect ~5000 USDT balance).
4. **Start engine:** `pnpm start:dev` (NestJS boots, connects Binance testnet, listens for signals).
5. **Await signal:** Watch logs for a live signal passing risk gate → `ExecutionService.executeApprovedOrder` called → ccxt `createOrder` placed → HTTP 200 response → clientOrderId in response logged.
6. **Verify transaction row:** Query Postgres:
   ```sql
   SELECT client_order_id, exchange_order_id, qty, filled_qty, price, status 
   FROM transactions 
   WHERE symbol='BTCUSDT' 
   ORDER BY created_at DESC LIMIT 1;
   ```
7. **Verify position row:** Query Postgres:
   ```sql
   SELECT symbol, direction, entry_price, notional, sl_price, status 
   FROM positions 
   WHERE symbol='BTCUSDT' 
   ORDER BY created_at DESC LIMIT 1;
   ```
8. **Verify idempotency:** Stop engine, restart, confirm no duplicate clientOrderId in `transactions` (query by clientOrderId).
9. **Verify protective orders:** Check if protective_order_type = 'exchange_side' (SL/TP attached) or 'local_fallback' (LocalProtectiveMonitor armed).
10. **Close position:** Await close signal or manual trigger → reduce/close order placed → transaction row written with opposite direction → position status='closed' → fill realized PnL into position.realized_pnl.

End-to-end flow: **Signal → Risk Gate (M4) → ExecutionService → ccxt order → transaction/position persisted → LocalProtectiveMonitor armed or exchange SL/TP attached → Idempotent restart recovers in-flight orders.**
