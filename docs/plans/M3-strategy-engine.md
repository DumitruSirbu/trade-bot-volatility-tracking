# M3 — Strategy engine

**Goal:** Pluggable, deterministic strategies that turn the enriched market snapshot
into signals and record every decision with its full indicator context.

**Depends on:** M1 (enriched `volatility.detected` events), M2 (decisions table, params schema).

## Tasks

- **`Strategy` interface.** Pure function of market snapshot + current open-position state for the symbol → optional signal. Signal vocabulary: `open | add | reduce | close`. No I/O, no LLM, no wall-clock dependence beyond inputs — runs identically live and in backtest. Inputs come entirely from the `volatility.detected` payload (closed-bar data only — no look-ahead into the forming candle).
  - *Output:* documented interface + signal type covering all four actions.

- **Protective exits are NOT the strategy's job.** Stop-loss, take-profit, and time-stop closes are owned by the risk/position layer (M4/M6), not the strategy. The strategy expresses thesis signals; protection is enforced centrally.
  - *Output:* clear split documented — strategy emits thesis actions, risk/position layer emits protective closes.

- **`skip` is a first-class output.** The bot is judged on **avoiding bad trades, not on trade count** — most triggers should `skip`. Every version emits `skip` (with a reason) far more often than `open`, and that is the intended, high-value behavior. The signal vocabulary therefore treats `skip` as a real decision, not the absence of one.
  - *Output:* `skip` decisions written with reasons; skip rate is reported as a primary metric, not a defect.

- **v0 — no-trade baseline.** Logs every trigger with the full `market_snapshot` + classified `flow_type` and opens **nothing**. Pure calibration/measurement — establishes the population of events and their outcomes (replayed in M7) before any direction is trusted.
  - *Output:* v0 writes a decision for every trigger; opens zero positions.

- **v1 — exhaustion-confirmed VWAP mean-reversion strategy.**
  - *Direction:* `vwap_deviation_sigma` positive → price above VWAP → **short** (fade the spike). Negative → price below VWAP → **long** (fade the dump).
  - *Exhaustion confirmation (required — do NOT enter on first close outside the ±band):* enter only after a confirmation of exhaustion, namely ANY of: close back inside the band; break of the prior candle's extreme against the spike (prior-candle high broken downward after a pump, or prior-candle low broken upward after a dump); volume **deceleration** after the spike; OR OI stops rising / starts falling. Stepping in front of a move on the first bar is the fastest path to a stop, so confirmation is mandatory.
  - *Scope:* restrict v1 to **BTC-correlated / ranging liquidity dislocations** (the setup where reversion alpha is real), not idiosyncratic high-volume decoupling.
  - *Exit targets emitted with signal:* take-profit = VWAP (configurable: VWAP ± 0.5σ for conservatism); stop-loss = **structural stop** (just beyond the deviation wick + a hard % cap, see structural-stop task) OR `entry_price ± (atr_14 × params.atr_stop_multiplier)`; time-stop = `now + params.time_stop_minutes`.
  - *Regime gate:* suppress `open` if `regime_label == 'trending_up'` and signal is short, or `regime_label == 'trending_down'` and signal is long, or if the M4 market-stress halt is active. Log as `skip` with reason `regime_suppressed` / `market_stress`.
  - *Output:* deterministic signals on the live stream (dry-run); suppressed signals written as `skip` decisions.

- **v2 — VWAP momentum strategy.**
  - *Direction:* same trigger, opposite trade. `vwap_deviation_sigma` positive → **long** (follow the spike); negative → **short** (follow the dump).
  - *Default for idiosyncratic decoupling:* momentum is the better default for **idiosyncratic high-volume decoupling**, which is often catalyst-/informed-flow — fading it is the fastest way to a stop.
  - *Exit targets:* take-profit = `entry_price ± (atr_14 × 2.0)` (wider — momentum trades run further); stop-loss = VWAP (reversion back to VWAP invalidates the momentum thesis); time-stop = `now + params.time_stop_minutes`.
  - *Regime gate:* suppress `open` if `regime_label == 'ranging'`. Momentum fails in range-bound markets. Log as `skip` with reason `regime_suppressed`.
  - *Output:* deterministic signals on the live stream (dry-run).

- **v3 — hybrid flow router (end-state target; go-live is NOT blocked on it).** Classify each event into `flow_type ∈ {forced_exhaustion, trend_initiation, market_beta, catalyst_risk, low_quality_noise}` from OI change, funding, volume acceleration/deceleration, BTC/ETH move, market breadth, spread/depth, wick structure, prior-candle continuation/failure, symbol universe age, and same-bar trigger count. Routing:
  - `forced_exhaustion` → mean-reversion (the valid fade case: OI falling on the spike / liquidation cascade after exhaustion).
  - `trend_initiation` → momentum **or** skip.
  - `market_beta` → skip, or 1 slot only.
  - `catalyst_risk` → skip.
  - `low_quality_noise` → skip.
  - *Output:* `flow_type` written on every decision; routing decision deterministic and logged.

- **Idiosyncratic-altcoin trap (correct the prior assumption).** Idiosyncratic does NOT automatically mean a good reversion candidate. **Idiosyncratic + rising OI + rising volume is SUSPICIOUS for reversion** (likely a catalyst / informed flow) → route to momentum or skip, never fade. This corrects the earlier framing that treated idiosyncratic moves as high-quality fade candidates.
  - *Output:* documented; v3 router and v1 scope reflect this rule.

- **Signal quality score.** Compute `signal_score` (0–100) from: `vwap_deviation_sigma` (normalized to tier), `volume_ratio`, `idiosyncrasy_score`, inverse funding cost. This score is passed through to M4 for BTC-correlated mode candidate selection.
  - *Output:* `signal_score` included in every signal and written to `decisions`.

- **Strategy registry + active-version selection** by config; stamp `strategy_version_id` on all outputs.
  - *Output:* switching active version changes which strategy emits, no code change.

- **Decision logging.** Write a `decisions` row for every trigger (acted or skipped) with the full `market_snapshot` payload validated against the M2 Zod schema. Include `signal_score` and suppression reason where applicable.
  - *Output:* `decisions` table fills during dry-run; every skip carries a reason.

- **Structural stop option (alongside ATR stop).** Offer a structural stop placed just beyond the deviation wick plus a hard % cap (`structural_stop_wick_buffer_pct`, `structural_stop_hard_cap_pct`), since ATR stops can trigger prematurely on a wick when stepping in front of a move. The strategy may emit either stop type; the risk layer (M4) still validates SL sits inside liquidation distance.
  - *Output:* signal can carry a structural stop; unit test pins both stop computations on a known candle.

- **Seed `strategy_versions` rows** for v0 (no-trade baseline), v1 (exhaustion-confirmed mean-reversion), v2 (momentum), and v3 (hybrid router) with the canonical `params` JSONB defined in M2.
  - *Output:* all four versions persisted with their full params.

## Definition of done

On testnet/dry-run, the active strategy emits deterministic signals, writes a
full-snapshot decision for every trigger (including skipped ones with reason), and
suppresses entries in adverse regimes. No risk checks or orders yet.
