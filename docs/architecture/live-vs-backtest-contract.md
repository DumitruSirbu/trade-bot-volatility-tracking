# Live ↔ Backtest contract

Status: Living document
Owners: Architecture (this file), M3 (strategy), M4 (risk), M5 (execution), M7 (backtest)

## Purpose

This document is the **single place that enumerates every clause M7 (backtest) must
satisfy to be considered a faithful replay of live**. Each clause cites the ADR that
owns it. M7 is the consumer; if a clause here is impossible to model from persisted data,
the gap is documented (not silently glossed) and surfaced to the main session.

The umbrella rule, from `docs/plans/00-overview.md`:

> **The same strategy code runs live and in backtest.** Strategies are pure and
> deterministic (market state in → signal out). All risk limits live outside the strategy
> and are enforced centrally. Nothing reaches execution without passing the risk gate.

That extends, post-M5, to: **the same execution policy code runs live and in backtest**
for everything below the strategy/risk core that affects fill outcomes.

## Clause index

| # | Area | Owning ADR / milestone | Status |
|---|---|---|---|
| C1 | Strategy purity (no wall clock, no RNG, no I/O) | ADR 0003 §1, §7 | Locked (M3) |
| C2 | Closed-bar causality (no look-ahead) | ADR 0001, ADR 0003, M7 brief | Locked (M3) |
| C3 | Risk gate determinism (ports, injected clock) | ADR 0004 §7 | Locked (M4) |
| C4 | Reservation ledger semantics in replay | ADR 0004 §3, §7 | Locked (M4) |
| C5 | Order-policy parity (matrix shared with M7) | ADR 0005 §1, §5 | **Locked (M5)** |
| C6 | Missed-fill modeling | ADR 0005 §5, M7 brief | **Locked (M5)** |
| C7 | Idempotency / clientOrderId determinism | ADR 0006 §1 | **Locked (M5)** |
| C8 | Partial-fill modeling | ADR 0007 §1, §2, §4 | **Locked (M5)** |
| C9 | Fee & slippage realism (shared cost model) | ADR 0005 §2, M7 brief | **Locked (M5)** |
| C10 | Protective-order parity (SL/TP timing) | ADR 0008 §1, §3 | **Locked (M5)** |
| C11 | Funding realism (real history, no constants) | M7 brief | Locked (M2/M7) |
| C12 | Universe point-in-time / no survivorship bias | M7 brief, ADR 0002 | Locked (M2/M7) |

C1–C4 and C11–C12 are reproduced here as references; the **M5-introduced clauses are
C5–C10** below.

---

## C5 — Order-policy parity

**Rule.** The selection matrix in `ADR 0005 §1` is the single source of truth for which
order policy applies to which `(intentAction, strategyDirection, coinTier, flowType)`.
Live's `OrderPolicyRouter` and M7's replay router import the matrix from the **same
constants module** (`executionConsts`). A diff in either direction is a must-fix.

**`flowType` propagation contract.** Both live and replay key into the matrix using
`flowType` carried on `IOrderIntent`, populated from the persisted `decisions.flow_type`
row. Live reads it off the in-memory intent (the strategy stamped it, the risk gate
passed it through unchanged); M7 reads it from `decisions.flow_type` directly. Neither
side may infer, default, or override the flow type at the execution layer — the
executor must **not** carry a `resolveFlowType` heuristic.

**M7 obligations:**

- Compute `OrderPolicyEnum` per intent from the matrix; do not branch on hardcoded
  policy.
- Compute `limitPrice` using the same formula as live (ADR 0005 §2), reading
  `entryRef = book_snapshots.mid_at_trigger` from persisted M2 data — never the
  next-bar open, never the trigger-bar close, never the intent's `entryPrice` (which
  is bar close, used for SL/TP distance math but **not** for IOC limit price).
- Live carries the same value on the intent as `midAtTrigger` (in-memory mirror of
  the persisted row); both worlds therefore evaluate the limit formula against
  identical inputs.
- Use the same `executionConsts.ORDER_TIMEOUT_MS` per policy as live.

**Pinned acceptance:** for a fixed `event_id` set across a replay, the
`(policy, limitPrice, timeoutMs)` triple produced by M7's router must equal the one
persisted alongside the live `transactions` row for the same event. Pinned in M7 tests.

---

## C6 — Missed-fill modeling

**Rule.** A live order that cancels-on-timeout with zero fill is a *missed* trade; PnL =
0; no `positions` row exists. M7 must produce the same outcome under the same intrabar
conditions.

**M7 obligations** (extends ADR 0005 §5, ADR 0007 §4):

- `MARKETABLE_LIMIT_IOC`: replay fills iff the intrabar tape (`tick_aggregates`) crosses
  `limitPrice` within `ORDER_TIMEOUT_MS`. Otherwise **missed**. Live and replay both
  rely on the exchange (or its simulator) for remainder cancel — no executor-side
  cancel call.
- `POST_ONLY_MAKER`: replay fills iff the tape trades at or through the maker price from
  the **unfavorable side** within `ORDER_TIMEOUT_MS`, **and** the trigger-time
  `book_snapshots.depth_10bps` ≥ intent notional. Otherwise **missed**. On partial,
  replay cancels the remainder at timeout and does not re-evaluate (mirrors ADR 0007
  §4's no-chase rule).
- `REDUCE_MARKET`: always fills in replay (mirrors live's worst-case fallback to the
  local monitor — ADR 0008 §3). On partial in replay, the remainder retries under
  a new `attemptN` up to `MAX_REDUCE_REMAINDER_ATTEMPTS`, matching ADR 0007 §4.
- **Zero-fill audit row in replay.** A missed `OPEN` produces a `transactions` row in
  replay with `qty=0, position_id=NULL` — the same shape live writes (ADR 0007 §3).
  M8 comparison joins on `client_order_id`; zero-fill rows participate in the join.

**Persisted fidelity floor:** when `book_snapshots` for the trigger window is missing
(M2 captures only around decisions), M7 falls back to the **tier-slippage floor** and
flags the trade as `low_fidelity=true`. M7 reports the fraction of low-fidelity fills
per run. A version whose edge depends on low-fidelity trades does not graduate to live.

**Pinned acceptance:** missed-fill rate per `(policy, tier)` reported per backtest run;
must be non-zero on `POST_ONLY_MAKER` rows except in cherry-picked windows.

---

## C7 — Idempotency / clientOrderId determinism

**Rule.** The `clientOrderId` seed in ADR 0006 §1 is computed from purely persisted
data (`eventId`, `positionSlot`, `intentAction`, `attemptN`). A replay produces
byte-identical ids.

**M7 obligations:**

- Mint `clientOrderId`s using the same scheme. M7 does not call the exchange but it does
  persist a `transactions` row, and the `client_order_id` column is the bridge to live
  comparisons in M8.
- `attemptN` in replay is always `0` for first submits and only advances under the same
  permanent-reject conditions as live (ADR 0006 §4). M7 simulates permanent rejects only
  via configured failure-injection runs (not in normal replay).

**Pinned acceptance:** M7 vs live diff on a paired event set: identical `clientOrderId`
on every approved intent.

---

## C8 — Partial-fill modeling

**Rule.** Filled qty drives position notional, SL distance, TP distance, and exposure
accounting — never intended qty (ADR 0007 §1). One `transactions` row per terminal
state (ADR 0007 §2 / ADR 0006 §5). The terminal-decision rules branch per policy
(ADR 0007 §4): IOC fetches terminal state without a cancel call; maker cancels then
classifies and does not re-evaluate the remainder; reduce-market retries the remainder
under a new `attemptN` and escalates to M6 via `ORDER_INTENT_UNKNOWN_EVENT` when the
budget exhausts.

**M7 obligations:**

- For partial-fill simulation, M7 draws `filledFraction ∈ [0, 1]` from a **deterministic,
  intrabar-path-driven** model:
  - `MARKETABLE_LIMIT_IOC`: integrate intrabar volume crossing `limitPrice` until intent
    notional consumed, cap at exchange's typical fill rate (depth-aware where available);
    remainder is auto-cancelled by IOC.
  - `POST_ONLY_MAKER`: integrate intrabar volume trading **through** the maker price
    from the unfavorable side; if total intrabar volume < intent notional, partial-fill
    that fraction; cancel the remainder at policy timeout.
  - `REDUCE_MARKET`: always full fill (with tier slippage).
- Compute `avgFillPrice` from the intrabar path's volume-weighted price across the
  filled fraction — not from `limitPrice`.
- Recompute SL/TP from `avgFillPrice` using the same ATR-multiple formula as live
  (ADR 0007 §1). Weighted-average entry on ADDs follows the same formula.
- Update the simulated reservation ledger per ADR 0007 §5 (confirm `filledNotional`,
  release `pendingNotional`).

**Pinned acceptance:** for a paired event set with known intrabar tapes, M7's
`avgFillPrice` and `filledQty` match live within a documented epsilon (≤ 1 tick on
fill price, exact on qty).

---

## C9 — Fee & slippage realism (shared cost model)

**Rule.** Fees, slippage, and funding are defined **once** and consumed by both live PnL
math (M5/M6) and backtest PnL math (M7). One source of truth = `executionConsts` +
`strategy_versions.params` + persisted `funding_rates` history.

**M7 obligations:**

- Fee rates per role (maker/taker) come from `executionConsts.FEE_TIER_*`, matching the
  account tier the live bot is operating under. A version-specific fee override lives in
  `strategy_versions.params.feeOverridePct` if a promo tier applies.
- Slippage components: `base_tier + spread_component + volatility_component +
  depth_component + market_stress_component + adverse_selection_component` per M7 brief.
  Live PnL on partial/full fills uses the *realized* spread (from `book_snapshots` at
  fill); M7 uses the same persisted `book_snapshots` rows. **No hard-coded slippage in
  the live executor.**
- The limit-price reference for IOC math is `book_snapshots.mid_at_trigger` in both
  worlds (see C5). The cost model never reads `entryPrice` (bar close) as the reference
  point for IOC slippage — that field is reserved for SL/TP distance anchoring.
- Reject-reason taxonomy (ADR 0006 §4) is shared: failure-injection runs in M7 use the
  same `RETRIABLE / TERMINAL / UNKNOWN` classifier table from `executionConsts` so
  simulated retry budgets match live exactly.
- Funding: live applies real funding events into `transactions` (M6); M7 reads
  `funding_rates` history for the replayed window and applies the same formula. No
  constant funding rate in replay.

**Pinned acceptance:** running live for a known testnet session and replaying the same
events through M7 yields **net PnL within a documented epsilon** (driven by un-modelable
microstructure differences only — quantified per run).

---

## C10 — Protective-order parity

**Rule.** Live attaches exchange-side SL/TP at mark price post-fill (ADR 0008 §1); the
local monitor is armed synchronously between `positions.insert` and the exchange-side
attach call regardless of attach outcome (ADR 0008 §2); on attach failure, the local
monitor exits through the gate at the level (ADR 0008 §3). Backtest must model both
paths.

**M7 obligations:**

- Default: simulate exchange-side `STOP_MARKET`/`TAKE_PROFIT_MARKET` triggers using
  **mark-price intrabar path** (mark-price proxy: `tick_aggregates` smoothed per the
  same formula M6 uses for `mark_vs_last_max_divergence_pct`). Trigger when mark crosses
  the SL/TP; fill at the next tape print with `REDUCE_MARKET`-tier slippage.
- For failure-injection runs, simulate the **local-monitor path**: trigger evaluated
  every `tick_aggregates` row, exit through the same risk-gate de-risking path as live.
  The latency between trigger and exit submit is the configurable `MONITOR_LATENCY_MS`
  (matching live's monitor tick frequency).
- `protective_order_type` in simulated `positions` rows reflects whichever path the
  replay took (default `exchange_side`; failure-injection runs set `local_fallback`).

**Pinned acceptance:** for a paired event set with a known stop-out, M7's exit price
matches live's exit price within tape-print resolution. A failure-injection run
demonstrates the local-monitor path produces a worse-but-bounded fill (the documented
local-fallback slippage delta).

---

## M37 Amendment (2026-06-15) — per-check gate-reconstructability table

**Milestone:** M37 (strategy-comparison infrastructure). **Status:** Accepted.
**See:** ADR 0015 M37 amendment, ADR 0004 §1 (`RejectReasonEnum`).

The backtest produced `tradeCount: 0` because the gate rejected 100% of post-signal
candidates while the same gate approves ~7% live — the depth/liquidation checks could
not reconstruct their `book_snapshots` inputs and hard-rejected everything. This table
classifies **every** risk-gate check (ADR 0004 §1 ordered pipeline) by how faithfully
it reconstructs in backtest:

- **Reconstructable** — runs **identically** live and in backtest; the input is a pure
  function of replayed OHLCV / `tick_aggregates` / `funding_rates` / `open_interest`
  or in-memory ledger state. No flag.
- **Approximated** — uses a documented **fallback** in backtest because its true input
  (live order book) is unavailable; any fill produced via the fallback is **flagged
  low-fidelity** (`lowFidelityTradeCount`, ADR 0017 §2.4 / ADR 0015 M37).
- **Not modeled** — skipped in backtest, with a stated reason.

| Gate check (ADR 0004 §1) | Class | Input source in backtest | Owning ADR |
|---|---|---|---|
| Global halt / kill-switch (`global_halt`) | Reconstructable | `BacktestRiskStateAdapter` (in-memory `risk_state`) | ADR 0004 §1, §7 |
| Market-stress halt (`market_stress`: BTC/ETH 5m, OI, funding, breadth, same-bar, spread) | Reconstructable | M1 fast-stress snapshot fields on the replayed event — all from OHLCV / funding / OI / spread | ADR 0004 §6, §6a–§6e |
| Universe floor (`below_universe_floor`) | Reconstructable | `UniverseReplayLoader` point-in-time `universe_membership` | ADR 0004 §1; ADR 0015 §4.4 |
| OI available (`oi_unavailable`) | Reconstructable | replayed `open_interest` seeded at the bar boundary | ADR 0004 §1; ADR 0015 §4.2 |
| Spread ceiling (`spread_too_wide`) | **Approximated** | `book_snapshots.bid_ask_spread_pct` where present; **fallback to tier-slippage-derived spread when missing → low-fidelity** | ADR 0004 §1; ADR 0015 §4.6, M37 |
| Per-coin depth (`coin_book_too_thin`) | **Approximated** | `book_snapshots.book_depth_10bps_usdt` where present; **conservative fallback when missing → low-fidelity** | ADR 0004 §6a; ADR 0015 §4.6, M37 |
| Cooldown (`cooldown_active`) | Reconstructable | in-memory closed-position log in `BacktestBook` | ADR 0004 §1, §5 |
| Daily / weekly / consecutive-loss limits | Reconstructable | `BacktestRiskStateAdapter` realized-PnL map + closed-position log | ADR 0004 §5; ADR 0015 §4.5 |
| Overtrading caps (per-symbol/day, per-bar universe) | Reconstructable | in-memory open/closed logs + injected `nowMs` | ADR 0004 §1, §7 |
| Slot / candidate selection (`max_positions_reached`, `btc_correlated_*`, `no_eligible_slot`) | Reconstructable | `BacktestPositionAdapter` + reservation ledger; deterministic bar-window batching | ADR 0004 §4; ADR 0015 §4.5 |
| Funding size-cut / suppress (`funding_suppressed`) | Reconstructable | replayed `funding_rates` history (no constant) | ADR 0004 §8; ADR 0015 §4.7 |
| Time-stop validity (`time_stop_missing_or_invalid`) | Reconstructable | pure check on the strategy's `IProposedExit` | ADR 0004 §1; ADR 0003 §3 |
| **SL-inside-liquidation (`sl_outside_liquidation`) — KNOWN BLOCKER** | **Approximated** | liquidation distance needs depth/book state; **documented relaxed liquidation+depth fallback when `book_snapshots` missing → low-fidelity.** This is the check that hard-rejected 100% in the 0-fill backtest | ADR 0004 §8; ADR 0015 §4.6, M37 |
| Exposure caps (per-coin, same-direction portfolio) | Reconstructable | reservation ledger + in-memory positions; notional math is decimal | ADR 0004 §1, §8a |
| Tier-3 not validated (`tier3_not_validated`) | Reconstructable | seeded `instruments` / version params | ADR 0004 §1 |
| Model-divergence halt (`model_divergence_halt`) | **Not modeled** | live-only kill switch fed by realized-slippage divergence (M9); no live order flow to diverge against in replay. Skipped — backtest measures the modeled cost, not live execution drift | ADR 0004 §1 |
| Sizing / leverage clamp (≤3×, step, min-notional) | Reconstructable | pure `PositionSizer` decimal math against seeded `instruments` row | ADR 0004 §8, §8a; ADR 0015 §4.7 |
| Live order book (any check requiring live L2 depth at fill) | **Approximated** | persisted `book_snapshots` row where present; tier-slippage floor fallback otherwise → low-fidelity (C6 fidelity floor) | C6, C9; ADR 0015 §4.6, M37 |

**Notes (locked):**

- The **only** checks that degrade to **Approximated** are those whose true input is
  the live order book (`book_snapshots`): spread ceiling, per-coin depth,
  `sl_outside_liquidation`, and any direct L2-depth-at-fill check. Every other check is
  **Reconstructable** from replayed OHLCV / `tick_aggregates` / `funding_rates` /
  `open_interest` or in-memory ledger state.
- The fallback for the Approximated checks is a **gate-INPUT approximation, not a
  different gate** — the same `RiskGateService.evaluate` code runs; only the missing
  `book_snapshots` input is substituted (ADR 0015 M37). It is **backtest-only** and
  never applied live.
- Any fill produced through an Approximated fallback is flagged **low-fidelity**, and a
  version's edge must survive with low-fidelity trades excluded (ADR 0019 criterion 12).
- The single **Not modeled** check (`model_divergence_halt`) is a live execution-drift
  kill switch with no backtest analogue; skipping it is conservative for the backtest
  (it can only *add* live rejections, never remove backtest ones).

## Updating this document

Adding a clause requires either an ADR or an explicit reference to a milestone brief.
Removing/relaxing a clause requires an ADR with explicit "Alternatives considered". M7
implementation owes a test per clause; the test names cite the clause number (`C5`, `C6`,
…) so reviewers can map failures back to the contract.
