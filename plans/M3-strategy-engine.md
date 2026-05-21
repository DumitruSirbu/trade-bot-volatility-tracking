# M3 — Strategy engine

**Goal:** Pluggable, deterministic strategies that turn the enriched market snapshot
into signals and record every decision with its full indicator context.

**Depends on:** M1 (enriched `volatility.detected` events), M2 (decisions table, params schema).

## Tasks

- **`Strategy` interface.** Pure function of market snapshot + current open-position state for the symbol → optional signal. Signal vocabulary: `open | add | reduce | close`. No I/O, no LLM, no wall-clock dependence beyond inputs — runs identically live and in backtest. Inputs come entirely from the `volatility.detected` payload (closed-bar data only — no look-ahead into the forming candle).
  - *Output:* documented interface + signal type covering all four actions.

- **Protective exits are NOT the strategy's job.** Stop-loss, take-profit, and time-stop closes are owned by the risk/position layer (M4/M6), not the strategy. The strategy expresses thesis signals; protection is enforced centrally.
  - *Output:* clear split documented — strategy emits thesis actions, risk/position layer emits protective closes.

- **v1 — VWAP mean-reversion strategy.**
  - *Direction:* `vwap_deviation_sigma` positive → price above VWAP → **short** (fade the spike). Negative → price below VWAP → **long** (fade the dump).
  - *Entry conditions (already confirmed by M1 trigger formula):* σ threshold, volume ratio, tier absolute bounds.
  - *Exit targets emitted with signal:* take-profit = VWAP (configurable: VWAP ± 0.5σ for conservatism); stop-loss = `entry_price ± (atr_14 × params.atr_stop_multiplier)`; time-stop = `now + params.time_stop_minutes`.
  - *Regime gate:* suppress `open` if `regime_label == 'trending_up'` and signal is short, or `regime_label == 'trending_down'` and signal is long. Mean-reversion fails in the direction of the trend. Log as `skip` with reason `regime_suppressed`.
  - *Output:* deterministic signals on the live stream (dry-run); suppressed signals written as `skip` decisions.

- **v2 — VWAP momentum strategy.**
  - *Direction:* same trigger, opposite trade. `vwap_deviation_sigma` positive → **long** (follow the spike); negative → **short** (follow the dump).
  - *Exit targets:* take-profit = `entry_price ± (atr_14 × 2.0)` (wider — momentum trades run further); stop-loss = VWAP (reversion back to VWAP invalidates the momentum thesis); time-stop = `now + params.time_stop_minutes`.
  - *Regime gate:* suppress `open` if `regime_label == 'ranging'`. Momentum fails in range-bound markets. Log as `skip` with reason `regime_suppressed`.
  - *Output:* deterministic signals on the live stream (dry-run).

- **Signal quality score.** Compute `signal_score` (0–100) from: `vwap_deviation_sigma` (normalized to tier), `volume_ratio`, `idiosyncrasy_score`, inverse funding cost. This score is passed through to M4 for BTC-correlated mode candidate selection.
  - *Output:* `signal_score` included in every signal and written to `decisions`.

- **Strategy registry + active-version selection** by config; stamp `strategy_version_id` on all outputs.
  - *Output:* switching active version changes which strategy emits, no code change.

- **Decision logging.** Write a `decisions` row for every trigger (acted or skipped) with the full `market_snapshot` payload validated against the M2 Zod schema. Include `signal_score` and suppression reason where applicable.
  - *Output:* `decisions` table fills during dry-run; every skip carries a reason.

- **Seed `strategy_versions` rows** for v1 (mean-reversion) and v2 (momentum) with the canonical `params` JSONB defined in M2.
  - *Output:* both versions persisted with their full params.

## Definition of done

On testnet/dry-run, the active strategy emits deterministic signals, writes a
full-snapshot decision for every trigger (including skipped ones with reason), and
suppresses entries in adverse regimes. No risk checks or orders yet.
