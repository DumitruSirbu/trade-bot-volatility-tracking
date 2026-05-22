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
