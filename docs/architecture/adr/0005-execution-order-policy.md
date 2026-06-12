# ADR 0005 — Execution order policy (M5)

Status: Accepted
Date: 2026-05-23
Milestone: M5 — Execution (testnet)

## Context

M4 ends at an approved `IOrderIntent` carrying `tradeSide`, `sizing` (decimal qty +
notional), `proposedExit` (SL/TP/time-stop), `coinTier`, `flowType`, `midAtTrigger`, and
the active `strategyVersionId`. The orchestrator emits `order.intent.approved`; the
ExecutionModule consumes it. **No other producer is allowed.** Strategies, controllers, the dashboard, and
M6 reconciliation never call `exchange.createOrder` directly — the only exchange-order
caller is `ExecutionService` (reviewer must-fix invariant, mirroring the risk-gate
invariant from ADR 0004 §2).

The brief (`docs/plans/archive/M5-execution-testnet.md`) calls for **marketable-limit-with-max-
slippage** or **post-only maker entry after confirmation** with **no chasing**, cancel-on-
timeout, and tier/regime-varying policy. M7 must mirror the same policy so live and
backtest agree on fill quality. A plain market order at the moment a 5m VWAP-deviation
event triggers is exactly when spread is widest and depth thinnest — using one would
silently destroy the mean-reversion edge measured in backtest.

Constraints inherited from `00-overview.md`, `code-conventions.md`, ADR 0003/0004:

- **Live starts restricted:** 1 position max, tier-1 only, isolated margin, $500–$1,000.
  The order policy must be safe and well-tested under this restricted profile **first**;
  tier-2/3 entries arrive only after a live-edge demonstration.
- **Deterministic, replayable.** Every choice the executor makes from the same intent +
  market state must be reproducible in M7 from persisted data.
- **Decimal money.** Slippage caps, limit prices, and qty are `decimal.js`; no float.
- **Skip-first culture.** A missed fill is an acceptable outcome. Chasing is forbidden.

## Decision

### 1. Three concrete policies, selected by `(coinTier, strategyVersion, flowType)`

**Contract: `flowType` is carried on the intent itself.** The strategy classifies the
trigger (`flow_type ∈ {liquidation_cascade, new_money, catalyst, rotation, mixed, …}`)
and stamps it on `decisions.flow_type`; the orchestrator reads that same value when
assembling `IOrderIntent` so `flowType: FlowTypeEnum` is a first-class field on the
intent and on the `order.intent.approved` event payload. The **risk gate passes it
through unchanged** — the gate may consult `flowType` for funding-suppression and flow
rules (ADR 0004) but never overwrites it. The **executor consumes it** as a direct row
key into the matrix below; it does **not** infer or default a flow type (no
`resolveFlowType` heuristic — that path is the must-fix Round-1 reviewers caught).

This is the parity hinge for M7: backtest reads `decisions.flow_type` from the same
persisted row and feeds the identical value into the matrix. Live and replay therefore
key into the same row of the table for every event.


`OrderPolicyEnum` (engine-internal, kept off the wire because it is implementation detail
of execution, not vocabulary the dashboard needs):

```
enum OrderPolicyEnum {
    MARKETABLE_LIMIT_IOC = 'marketable_limit_ioc',  // crosses the book, capped slippage, immediate-or-cancel
    POST_ONLY_MAKER     = 'post_only_maker',        // rests at limit, never takes, cancels if unfilled
    REDUCE_MARKET       = 'reduce_market',          // de-risking only: reduce/close/flatten — market IOC
}
```

**Selection matrix (locked):** the executor picks the policy by a pure function of
`intent.intentAction × intent.coinTier × strategyVersion.direction × intent.flowType`.
No wall-clock dependency, no random branch — backtest plays the same matrix.

| Intent action | Strategy direction (active version) | Tier | Flow type | Policy |
|---|---|---|---|---|
| `OPEN` / `ADD` | mean_reversion (v1) | 1 | liquidation_cascade | `MARKETABLE_LIMIT_IOC` |
| `OPEN` / `ADD` | mean_reversion (v1) | 1 | other | `POST_ONLY_MAKER` |
| `OPEN` / `ADD` | mean_reversion (v1) | 2/3 | any | `POST_ONLY_MAKER` |
| `OPEN` / `ADD` | momentum (v2) | 1 | new_money / catalyst | `MARKETABLE_LIMIT_IOC` |
| `OPEN` / `ADD` | momentum (v2) | 2/3 | any | `MARKETABLE_LIMIT_IOC` (tighter cap, see §2) |
| `OPEN` / `ADD` | hybrid (v3) | any | router-resolved leg | inherits the leg above |
| `OPEN` / `ADD` | no_trade (v0) | any | any | n/a — v0 never produces an intent |
| `REDUCE` / `CLOSE` / `FLATTEN` | any | any | any | `REDUCE_MARKET` |

Rationale per row:

- **Mean-reversion in a liquidation cascade is the one place we *cross* the book on entry.**
  The whole edge is "be the maker faded into a forced seller." Resting post-only loses the
  fill because the cascade trades away in seconds. We pay a bounded taker fee but capture
  the move; the IOC cap protects against a spike that vanishes mid-fill.
- **Mean-reversion in any other flow context posts maker** — we are early/contrarian, we
  can afford to wait one bar, and the maker rebate plus zero adverse selection is exactly
  the slippage profile mean-reversion needs to survive.
- **Momentum *must* take liquidity** — by definition we are joining a move and a maker
  order is adverse-selected (only fills when the move stops). Marketable-limit-IOC bounds
  the slippage we are willing to pay to join.
- **De-risking is always market.** A reduce/close/flatten that fails to fill is worse than
  any slippage; the only error here is *not exiting*. This matches ADR 0004 §2
  ("reduce/close always pass through the gate") at the execution layer.

### 2. Max-slippage bounds — derived from tier and SL distance, not a single constant

Slippage cap is `min(tierCap, slDistanceFraction × atrSlMultiplier × params.maxSlippageOfSlPct)`
where:

- `tierCap` (`MAX_SLIPPAGE_TIER_PCT` in `executionConsts`): tier-1 `0.15%`, tier-2 `0.40%`,
  tier-3 `0.80%`. These are the **upper ceiling**; tier-3 is restricted from live entirely
  during M5/M11, so the live-relevant cap during M5 is the tier-1 number.
- `slDistanceFraction` = `abs(entryPrice - proposedExit.stopLossPrice) / entryPrice`. The
  cap **never exceeds a fraction of the stop distance** — if we are willing to lose
  `slDistance` on a stop hit, we cannot reasonably pay a quarter of it just to enter.
- `params.maxSlippageOfSlPct` defaults to `25%` (i.e. entry slippage ≤ ¼ of SL distance).
  Lives in `strategy_versions.params` so versions can tune it; backtest reads the same key.

The executor computes the limit price as:

- **Long marketable-limit-IOC:** `limitPrice = entryRef * (1 + slippageCapPct)`
- **Short marketable-limit-IOC:** `limitPrice = entryRef * (1 - slippageCapPct)`
- **Long post-only:** `limitPrice = bestBid` (Binance's `timeInForce=GTX` rejects crossing).
- **Short post-only:** `limitPrice = bestAsk` (same).

`entryRef` is the **trigger-time mid carried on the intent as `midAtTrigger`** —
populated by the strategy from the persisted `book_snapshots.mid_at_trigger` row stamped
at the trigger event, **not** the bar close and **not** the latest tick at execution
time. `IOrderIntent.entryPrice` (bar close) is preserved as the analytical reference for
strategy-internal math (e.g. SL distance anchoring) and is **not** what the IOC limit
formula reads — that is `midAtTrigger`. Two reasons for the split rather than
repurposing `entryPrice`:

- `entryPrice = barClose` already flows through SL/TP distance computation in M3/M4
  (ADR 0003 §3, ADR 0004 §8). Repurposing it would silently rewrite SL math.
- The IOC limit formula is a fill-quality / microstructure concern, distinct from the
  analytical reference price the strategy reasons about.

Both live and backtest compute IOC limit math against the same persisted
`book_snapshots.mid_at_trigger`. The intent's `midAtTrigger` field is the in-memory
carrier of that value between strategy → gate → executor; the persisted source of truth
remains the `book_snapshots` row keyed on `event_id`. M7 reads it from there; live
reads it from the intent (which was populated from there). Reviewer must-fix: any
executor code path that derives IOC limit price from `entryPrice`, from the current
ticker, or from any tick later than `mid_at_trigger`.

All slippage arithmetic is `decimal.js`. Float here would compound across thousands of
fills.

### 3. Cancel-on-timeout — fixed, short, per-policy; no extensions

`executionConsts.ORDER_TIMEOUT_MS`:

- `MARKETABLE_LIMIT_IOC`: **2,000 ms**. IOC means the exchange itself cancels the unfilled
  remainder; the executor's timer is a defensive backstop against a hung submit.
- `POST_ONLY_MAKER`: **45,000 ms** (≈ ¼ of a 5-minute bar). Long enough for normal book
  oscillation to bring the maker price to us, short enough that the trigger condition has
  not yet decayed. Hard-cancel via `exchange.cancelOrder(clientOrderId)`.
- `REDUCE_MARKET`: **5,000 ms** with **retry under a new attempt number** (ADR 0006). A
  reduce that does not confirm must escalate, not be abandoned.

At timeout for `OPEN`/`ADD`: the executor cancels and **does not re-submit**. See §4.

### 4. "No chasing" — programmatic definition

**No-chase invariant (reviewer must-fix):** after a cancel-on-timeout for an `OPEN` or
`ADD`, the executor:

1. Persists the timeout outcome to `transactions` with `type=open/add`, `qty=filled_qty`,
   `client_order_id` populated (idempotency key for any subsequent reconciliation), and
   either zero filled qty (missed) or partial filled qty (handled per ADR 0007).
2. Emits `order.intent.expired` with `eventId` and `reservationId` so the risk gate
   releases the reservation (ADR 0004 §3).
3. **Does not create a follow-up intent.** The next opportunity must come from a *new*
   strategy signal on a *new* event. The orchestrator does not re-submit the same intent
   with a wider price or longer timeout.
4. Does not subscribe to "price came back to the limit" callbacks. Replacing the order at
   a worse price, extending the timeout, or hopping to the other policy are all forbidden
   — each is "chasing" by definition.

Why this is strict: the strategy's edge is conditional on the market state *at the
trigger*. Five seconds later the conditions are different, and a fill at a chased price
is no longer the trade the strategy proposed. Letting the executor heuristically retry
silently breaks the live-vs-backtest contract because the backtest has no equivalent
chase loop.

### 5. M7 mirror — same matrix, deterministic missed-fill model

ADR-level contract for M7 (binding, not aspirational):

- M7's `OrderPolicyRouter` reads the **same matrix in §1 from the same constants module**
  (`executionConsts`). One source of truth, imported by both ExecutionModule and
  BacktestModule. A change to the matrix changes both.
- For `MARKETABLE_LIMIT_IOC`: the backtest fills if the **intrabar path from
  `tick_aggregates`** (M7 §"intrabar simulation") touches `limitPrice` within
  `ORDER_TIMEOUT_MS` of the bar open; fill price = `limitPrice` (worst-case adverse). If
  the path never reaches `limitPrice` within the window → **missed**, no PnL.
- For `POST_ONLY_MAKER`: the backtest fills only if the intrabar path **touches the maker
  price from the unfavorable side** (e.g. for a long maker at bid, the trade tape must
  print at or below the bid within `ORDER_TIMEOUT_MS` and there must be sufficient
  passive size — approximated by checking `book_snapshots.depth_10bps` ≥ intent notional).
  Otherwise **missed**.
- For `REDUCE_MARKET`: fills at next-tick mid + tier slippage adverse, always succeeds in
  backtest (mirrors "de-risking always works" in live — at the worst case the local
  monitor in M6 handles it).

Missed-fill rate per policy per tier is a first-class metric in M7's report. A version
whose backtested edge collapses when realistic missed fills are modeled does **not**
graduate to live.

## Consequences

- ExecutionModule has a `OrderPolicyRouter` service that takes an `IOrderIntent` and
  returns `IOrderPlan { policy, limitPrice, timeoutMs, slippageCapPct, reduceOnly }`.
  This `IOrderPlan` is what gets persisted alongside the transaction so reconciliation
  (M6) and M7 replay can both inspect what the live executor would have done.
- The matrix is a pure table — easy to test, easy to audit, easy to extend when v2/v3
  graduate.
- Live restricted profile in M5 (tier-1, mean-reversion v1) exercises exactly two rows of
  the matrix; momentum/hybrid rows are dormant code paths but tested via unit pinning.
- Versions can adjust `maxSlippageOfSlPct` in `strategy_versions.params` without touching
  execution code. Tier caps are operator-level config (mirrors ADR 0004's "risk params
  vs strategy params" split), defined in `executionConsts`.

## Alternatives considered

- **Single policy (always marketable-limit-IOC).** Rejected: kills the mean-reversion edge
  outside cascades — we would pay taker fees + adverse selection on every entry where the
  whole point is *waiting* for the unfavorable counterparty.
- **Single policy (always post-only).** Rejected: misses the cascade-fade entirely (the
  exact trade the system is built to capture) and is impossible for momentum.
- **Chase missed entries by re-pricing.** Rejected: changes the trade the strategy
  proposed, breaks the live-vs-backtest contract, and contradicts the skip-first culture
  in `00-overview.md` ("skip is a first-class output").
- **Per-symbol learned policy.** Rejected for M5: introduces a learned component into the
  live trade loop, which violates "no LLM/ML in the live loop" (overview locked decision).
  May become an M8 comparison artifact, not an M5 mechanism.
- **Let the executor pick `entryRef` from "current mid at submit time".** Rejected:
  destroys backtest parity. The persisted trigger-time `book_snapshots` mid is the only
  reference both worlds can agree on.
- **Trigger-side OCO entry-with-bracket in one shot.** Rejected for the entry submit:
  Binance USDT-M Futures' OCO behaviour around partial fills is fragile and the SL/TP
  attach must wait for actual filled qty (ADR 0007 + ADR 0008). Bracket is attached as a
  **second submit** after fill confirmation.

## See also

- `docs/plans/archive/M5-execution-testnet.md` (milestone brief)
- `docs/architecture/adr/0006-idempotency-contract.md` (clientOrderId, retries)
- `docs/architecture/adr/0007-partial-fill-semantics.md` (filled-qty drives state)
- `docs/architecture/adr/0008-sl-tp-attach.md` (protective-order attach + fallback)
- `docs/architecture/live-vs-backtest-contract.md` (M5 clauses)
- `docs/architecture/adr/0004-risk-management.md` §2 (no path bypasses the gate)
- `docs/best-practices/code-conventions.md` (constants placement, decimal money)
