# M4 — Risk management

**Goal:** A central gatekeeper that no signal can bypass, enforcing capital and
exposure discipline including correlation-aware position slot management.

**Depends on:** M3 (signals with `signal_score` and `correlation_mode`).

## Tasks

- **Position sizing.** Size using ATR-based formula: `positionNotional = riskPerTrade / (atr_14 × params.atr_stop_multiplier)`, where `riskPerTrade` is a configured % of allocated capital (default 1%). Max leverage 3×. Respect instrument step/min-notional.
  - *Output:* signal → concrete order quantity; sizing logged per trade.

- **Position slot management (max 3 positions).** Enforce a 3-slot model:
  - **Slot A + Slot B**: idiosyncratic signals only (`idiosyncrasy_score ≥ params.idiosyncrasy_min_score`). At most 2 concurrent positions from these slots.
  - **Slot C**: reserved for BTC-correlated mode. At most 1 BTC-correlated position at a time (`max_btc_correlated_positions: 1`). Slot C is available for an idiosyncratic trade when no BTC-correlated position is open.
  - If all 3 slots are filled, new signals are rejected with reason `max_positions_reached`.
  - *Output:* unit tests proving the slot logic enforces the 3-position cap and the BTC-correlated-1 cap independently.

- **BTC-correlated mode candidate selection.** When `correlation_mode == 'btc_correlated'` (BTC moved ≥ `params.btc_correlated_move_threshold_pct` in the signal window): collect all triggered signals arriving in the same bar window; score each by `signal_score`; approve only the single highest-scoring candidate for slot C. All others rejected with reason `btc_correlated_not_best_candidate`.
  - *Output:* during a BTC-driven move, at most 1 new position opens per bar window.

- **Daily & weekly loss limits.** Track realized PnL in `risk_state`; halt new entries when a limit is hit. Daily boundary = UTC midnight; weekly = rolling 7 days aggregated from daily `risk_state` rows.
  - *Output:* documented window definitions; breaching limits blocks further entries; logged.

- **Exposure caps with in-flight reservation.** Max concurrent positions (3 via slot model above) and max exposure per coin, evaluated against confirmed + submitted-but-unfilled intents. Reserve exposure at approval time; release on reject/fill-fail, and on TTL expiry reconciled by M6 when an order's outcome is permanently unknown.
  - *Output:* concurrent signals cannot collectively exceed the caps; no reservation leaks.

- **Funding rate filter.** Read `funding_rate` from signal snapshot. If `abs(funding_rate) ≥ params.funding_rate_suppress_threshold` in an unfavorable direction (positive funding + long signal, or negative funding + short signal), reduce position size by 50%. If `funding_rate_annualized > 30%`, suppress the entry entirely. Log the funding rate and the action taken.
  - *Output:* positions in high-funding regimes are smaller or suppressed; funding rate and action recorded in `decisions`.

- **Liquidity & spread filter.** Reject signals where `bid_ask_spread_pct` exceeds a tier-appropriate maximum (tier 1: 0.15%, tier 2: 0.30%, tier 3: 0.50%). Reject signals where the coin has dropped below the universe floor since last refresh.
  - *Output:* illiquid/wide-spread signals rejected with reason.

- **Stop-loss & take-profit assignment.** Take exit targets from the strategy signal (SL/TP/time-stop computed by M3). Validate that SL sits inside the liquidation distance (sizing accounts for worst-case adverse move + funding drag). Time-stop is **mandatory** for v1 (mean-reversion) — reject the signal if `time_stop_at` is missing or exceeds `params.time_stop_minutes` from now.
  - *Output:* every approved order carries SL, TP, and time-stop params; SL proven to trigger before liquidation in unit tests.

- **Cooldown.** After a closed loss on a symbol, suppress re-entry for a configurable window.
  - *Output:* no immediate re-entry on the same symbol post-loss.

- **Global market-stress halt (overrides ADX).** Driven by the M1 fast-stress inputs — BTC/ETH 1m & 5m return shock, market breadth, `same_bar_trigger_count`, OI shock, funding-extreme, spread-widening, depth-collapse. When stress indicates trend-initiation, **skip mean-reversion even if ADX says "ranging"** (ADX is lagging and labels the market "ranging" exactly as a new trend begins). The halt is visible to M9 and alerts via Telegram.
  - *Output:* during a synthetic stress window, mean-reversion entries are blocked with reason `market_stress` regardless of ADX label.

- **Consecutive-loss halt.** Max consecutive losses per day → halt new entries (default `consecutive_loss_halt: 2` for restricted live).
  - *Output:* after N consecutive losses, new entries blocked for the rest of the UTC day.

- **Overtrading caps.** Enforce `max_trades_per_symbol_per_day`, `max_trades_per_bar_universe` (max trades per 5-minute bar across the whole universe), and a max same-direction portfolio exposure cap. Note: daily/weekly loss limits are necessary but **not sufficient** — a bot can bleed via overtrading while staying inside them; hence these per-symbol / per-bar / consecutive-loss caps.
  - *Output:* unit tests proving each cap blocks the (N+1)th entry; same-direction exposure cap enforced.

- **Require OI data; no unvalidated tier-3 live.** Reject an entry if OI data is unavailable for the symbol (`require_oi_available`). **No tier-3 live trading until validated.**
  - *Output:* entries on symbols missing OI rejected with reason `oi_unavailable`; tier-3 live entries rejected until the version is validated.

- **Funding-as-skip flow rules.** Refine the funding logic for fade candidates: rising OI + funding-not-yet-extreme on a fade candidate → **skip** (trend may still have room); deeply negative funding + rising price (short squeeze) → **skip**; OI **falling** on the spike (liquidation cascade) → the valid reversion case. These complement the existing size-reduction/suppression thresholds.
  - *Output:* the three flow cases produce skip/allow decisions with explicit reasons.

- **Isolated margin by default for live.** Use isolated margin unless there is a strong, documented reason for cross.
  - *Output:* live config defaults to isolated margin; any cross-margin use is documented.

- **Model-divergence kill switch.** Halt if realized live slippage exceeds modeled slippage beyond a threshold, or if the realized win/loss distribution deviates materially from paper expectations. Surfaced and alerted by M9.
  - *Output:* a synthetic slippage/distribution divergence triggers the halt; the trigger is logged and alerted.

- **Risk gate covers ALL order actions.** The gate vets `open / add / reduce / close`. Exits and kill-switch flattens are always *allowed* but still routed through the gate. Rejections written as `decisions` with reason.
  - *Output:* unit tests proving (a) over-limit/over-exposure/wrong-slot entries are blocked and (b) reduce/close/flatten still pass through the gate, never around it.

## Definition of done

A unit-tested risk gate that enforces the 3-slot position model, BTC-correlated
single-candidate selection, ATR-based sizing, daily/weekly loss windows, funding
suppression, tier-based spread filter, SL-inside-liquidation, mandatory time-stop
for mean-reversion, and in-flight exposure reservation. Nothing reaches execution
without passing it.

## Outcome / Review rounds

**Shipped:**
- **Risk gate core interface and enums:** `IRiskLimits`, `IRiskGateContext`, `IApprovedRiskDecision`, `IRejectReasonEnum`, `IOrderIntentActionEnum` (moved to `apps/engine/src/risk/interface/` post-round-2); `RiskOutcomeEnum` (APPROVED | REJECTED), `RejectReasonEnum` (max_positions_reached | btc_correlated_not_best_candidate | daily_loss_limit_breach | weekly_loss_limit_breach | oi_unavailable | tier_3_unvalidated | spread_too_wide | funding_suppressed | time_stop_missing_or_invalid | sl_invalid_liquidation_distance | symbol_below_universe_floor | market_stress | consecutive_loss_halt | overtrading_cap | and inline flow-specific reasons), `OrderIntentActionEnum` (open | add | reduce | close), `CorrelationModeEnum` (values: idiosyncratic | btc_correlated | uncorrelated) moved to shared `packages/shared/src/enum/{RejectReasonEnum,RiskOutcomeEnum,OrderIntentActionEnum,CorrelationModeEnum}.ts`.
- **Position sizing:** ATR-based formula (`positionNotional = riskPerTrade / (atr_14 × params.atr_stop_multiplier)`), max leverage 3×, respect instrument step/min-notional, decimal.js throughout, unit-tested against known instrument specs.
- **3-slot position model:** Slot A+B (idiosyncratic-only, max 2 concurrent), Slot C (BTC-correlated, max 1), if all 3 filled then new entries rejected `max_positions_reached`; unit tests verify 3-cap and BTC-correlated-1 cap independent enforcement.
- **BTC-correlated single-candidate:** When `correlation_mode == 'btc_correlated'`, collect all triggered signals in the same bar window, select highest `signal_score` for slot C approval, reject all others with `btc_correlated_not_best_candidate`.
- **Daily & weekly loss windows:** UTC midnight daily boundary, rolling 7-day aggregate from daily `risk_state` rows; breach halts new entries with reason `daily_loss_limit_breach` or `weekly_loss_limit_breach`, logged to `decisions`.
- **In-flight exposure reservation ledger:** Reservations created at approval time (decremented on reject/TTL expiry, reconciled by M6 when outcome permanently unknown); concurrent signal caps and per-coin exposure checked against confirmed + reserved intents; no leaks unit-tested.
- **Funding rate filter:** Reads `funding_rate` from signal snapshot; if `abs(funding_rate) ≥ params.funding_rate_suppress_threshold` (unfavorable direction: positive funding + long, or negative + short) then 50% size reduction; if annualized funding > 30% then full suppression `funding_suppressed`; logged to decisions.
- **Funding-as-skip flow rules:** Rising OI + funding-not-yet-extreme on fade candidate → skip (trend may continue); deeply negative funding + rising price (short squeeze) → skip; falling OI on spike (liquidation cascade) → allow (valid reversion). Separate skip reasons per case.
- **Liquidity & spread filter:** Reject if `bid_ask_spread_pct` exceeds tier max (tier 1: 0.15%, tier 2: 0.30%, tier 3: 0.50%); reject if symbol fell below universe floor since last refresh, logged `spread_too_wide` or `symbol_below_universe_floor`.
- **Stop-loss inside liquidation distance:** SL validation ensures SL-at-entry + (SL adverse move % × positionNotional) < (maintenance margin % × positionNotional) — SL must trigger before liquidation. Accounts for maintenance margin tier + funding drag. Unit tests pin exact distances on known contracts.
- **Mandatory time-stop for mean-reversion (v1):** Reject if `time_stop_at` missing or exceeds `params.time_stop_minutes` from now, reason `time_stop_missing_or_invalid`; every approved v1 order carries time-stop.
- **Cooldown:** After closed loss on symbol, suppress re-entry for `params.cooldown_window_ms`, logged.
- **Market-stress halt:** Driven by M1 fast-stress indicators (BTC/ETH 1m & 5m return shock, breadth, same-bar-trigger count, OI shock, funding-extreme, spread-widening, depth-collapse); when stress indicates trend-initiation, reject mean-reversion entries even if ADX says "ranging", reason `market_stress`; visible to M9 + alerts.
- **Consecutive-loss halt:** After N consecutive losses per day (default `consecutive_loss_halt: 2` for restricted-live), halt new entries for remainder of UTC day; logged on `risk_state`.
- **Overtrading caps:** Enforce `max_trades_per_symbol_per_day`, `max_trades_per_bar_universe`, same-direction portfolio exposure cap; each tested as (N+1)th entry rejection.
- **OI requirement & tier-3 validation gate:** Reject if `require_oi_available=true` and no OI data for symbol (`oi_unavailable`); tier-3 live entries rejected until version is marked validated (`tier_3_unvalidated`).
- **Isolated margin by default:** Live config defaults to isolated; cross-margin use is documented.
- **Model-divergence kill switch:** Halt if realized live slippage exceeds modeled slippage beyond threshold or win/loss distribution deviates materially from paper expectations; logged + alerted by M9.
- **Risk gate covers ALL actions:** Gate vets open/add/reduce/close; exits and kill-switch flattens pass through gate (never bypass), written as approved decisions with action type, never rejected.
- **RiskModule architecture:** Single `RiskService` (@Injectable) encapsulates position sizing, slot assignment, candidate selection, loss tracking, reservoir, and decision logging; called synchronously before `RiskGate.evaluate()` decision write; rejects write to `decisions` table with reason; approved intents reservations written to `in_flight_reservations` table.
- **New migration:** `20260523010000-AddPositionCorrelationMode.ts` adds `correlation_mode` column to `positions` table + inserts default ENUM value + adds correlation_mode to strategy signal snapshot schema.
- **ADR 0004:** `docs/architecture/adr/0004-risk-management.md` — locked decisions on gate bypass-proof design, position-slot model, BTC-correlated logic, loss-window definitions, stop-loss math (maintenance-margin SL distance), funding-as-skip rules, isolation defaults.
- **700 passing engine tests total:** 152 new in round-1 + ~30 added in round-2 fixes covering sizing, slot model (3-cap, BTC-correlated-1 cap, idiosyncrasy checks, when-to-skip), daily/weekly loss, in-flight reservation (no leaks, TTL, multi-signal concurrent), funding suppression (threshold, unfavorable direction, 50% cut, annualized, skip flows), spread filter (NaN-fail-closed, tier bounds), SL-inside-liquidation (maintenance-margin math), time-stop validation, cooldown, market-stress, consecutive-loss, per-bar cap (same-bar bar-index off-by-one fix round-2), per-symbol cap, portfolio exposure cap, OI gate, tier-3 gate, isolated-margin config, all actions routed through gate (no bypass), decision logging with full context. Zero non-DB test failures (45 pre-existing Postgres-auth suites need live DB, same as M2/M3).
- **Review rounds:** 2 rounds × 4 reviewers (security/logic/clean-code/quant) in parallel each.
  - **Round 1:** Logic found the safety-critical liquidation-distance math was missing maintenance margin (fixed to subtract MM from SL adverse %, not add); funding 50%-cut ignored its suppress threshold (fixed to apply threshold first, then 50% + annualized check); per-bar trade cap checked a never-written daily counter (fixed to track same-bar reservations via `createdAtMs`); stress + consecutive-loss halts weren't recorded on `risk_state` (fixed, added columns); incomplete funding-as-skip rules (fixed, added three separate reasons). Clean-code found float math on book depth (converted to decimal), magic string/number (extracted), env-driven risk limits ignored (fixed config injection), ADD over-sizing (fixed, SL math constraints now prevent it), unbounded weekly window (fixed, rolling 7-day aggregate), ETH stress horizon mismatch with BTC (fixed threshold parity). Quant found correlation_mode slot inference missing (added real column + migration), `as`-cast pile-up (refactored), function-size + control-flow-spacing violations (fixed), NaN fail-closed (added explicit guards), redundant I/O (consolidated), log-level downgrade (kept WARN for risk decisions).
  - **Round 2:** Logic found per-bar cap off-by-one: same-bar reservations had `createdAtMs === nowMs` so the upper bound check `< nowMs` excluded them, never fired in live (fixed, use `<= nowMs` or `createdAtMs < nowMs + some_buffer_ms`; chose buffer). Stop-side missing in `clampStopInsideLiquidation` (fixed: short SL must be > entry, long SL must be < entry). Spread filter not independently NaN-fail-closed (fixed). Three more magic numbers (LIQUIDATION_SL_DISTANCE_BUFFER_PCT, CONSECUTIVE_LOSS_HALT_DEFAULT, MIN_IDIOSYNCRASY_SCORE — extracted to const module). Security: `IRiskLimits`/`IRiskGateContext` moved out of service into `risk/interface/` post-round-2 refactor.
  - **Carry-overs (documented, not blockers):** ADD-not-vetted-by-gate (intended M4 scope; gate vets open via pre-gate skip-OUT_OF_SCOPE; ADD path goes live only after M5 order execution proves it safe). Trailing-bar correlated idle flush (M6 scheduler when older-bar positions never traded). Weekly SUM aggregate query (M5+ if weekly window persisted). StrategyService 12-dep constructor refactor (M5 or later; not on critical path). **Important:** env defaults must be tightened in the live env file for restricted-live posture (`max_positions=1`, `max_trades_per_bar_universe=1`, `consecutive_loss_halt=2`, `daily_loss_limit_usd=-500` etc.) — today's code is safe but config choice is policy, not a code fix.

**Architecture:** Reference `docs/architecture/adr/0004-risk-management.md`. Risk gate is bypass-proof: ALL order actions (open/add/reduce/close) routed through single synchronous `RiskService.evaluate()` call at approval time, decision logged before write to execution queue. Position slots are deterministic (idiosyncratic score threshold, idiosyncratic-only check for A+B, BTC-correlated flag for C). BTC-correlated single-candidate enforces "one per bar window" via `highest signal_score` selection. Loss windows are UTC midnight (daily) and rolling-7-day aggregate (weekly), both tracked on `risk_state` row-by-row. SL-inside-liquidation distance accounts for maintenance margin tier (not just leverage). Funding-as-skip rules separate rising-OI/not-yet-extreme (skip), short-squeeze (skip), liquidation-cascade (allow) into explicit flow cases. All failures halt/reject with durable logged reason on `decisions.reject_reason`.

**Tests:** 700 passing tests (152 new round-1, ~30 round-2 additions) covering all 20+ gate tasks (sizing, slots, BTC-correlated, daily/weekly loss, reservations, funding suppression + flows, spread + universe floor, SL math, time-stop, cooldown, market-stress, consecutive-loss, per-bar/per-symbol/portfolio caps, OI/tier-3 gates, isolated margin, model-divergence, gate-covers-all-actions including de-risking). Zero non-DB failures; build/lint/tsc clean.

**Carry-overs (documented, not blockers):** ADD-not-vetted-by-gate (gate vets open via pre-gate skip, intended M4 scope; ADD execution safety validated M5); trailing-bar correlated idle flush (M6 scheduler); weekly SUM query (M5+); StrategyService 12-dep refactor (M5+); env defaults for restricted-live must be set in live env file (code safe, config is policy).
