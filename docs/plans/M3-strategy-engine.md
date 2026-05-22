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

## Outcome / Review rounds

**Shipped:**
- **Engine-internal strategy contracts** (`apps/engine/src/strategy/interface/`): `IStrategy` (pure synchronous `evaluate(input): ISignal`), `IStrategyInput` (event + persisted snapshot + frozen open-position state + typed params + bar-derived `nowMs`), `ISignal`, `IProposedExit`, `IOpenPositionState` (readonly position snapshot carrying only what a strategy may read: `side`, `entryPrice`, `qty`, `entryNotional`, `strategyVersionId`, `positionSlot`, `openedAtMs`, `timeStopAtMs`).
- **Four versioned strategies** (`apps/engine/src/strategy/`), each a pure NestJS provider: **v0** (baseline_no_trade — always SKIP, opens nothing); **v1** (exhaustion-confirmed VWAP mean-reversion — fade: +σ→short, −σ→long; mandatory exhaustion confirmation via close-back-inside-band [strict %B re-entry <0.8 pump / >0.2 dump], volume deceleration, or OI-not-rising; idiosyncratic-trap skip; regime gate; TP=VWAP±0.5σ, structural-or-ATR SL, time-stop); **v2** (momentum — follow: +σ→long, −σ→short; ranging-regime skip; TP=entry±atr×2, SL=VWAP); **v3** (hybrid router — routes on the already-stamped `flow_type`: forced_exhaustion→reversion, trend_initiation→momentum, market_beta/catalyst_risk/low_quality_noise→skip; reuses v1/v2 cores).
- **StrategyRegistry** (`strategy/registry/StrategyRegistry.ts`): maps a `strategy_versions` row→impl, validates `params` via the shared Zod schema at load.
- **StrategyService orchestrator** (`strategy/service/StrategyService.ts`): `@OnEvent(volatility.detected)`, classifies `flow_type` + computes `signal_score` ONCE via shared pure utils and stamps both on the persisted `market_snapshot` so every version shares them, derives deterministic `nowMs` from the bar, reads open position and freezes it, runs the active strategy, writes exactly one decision via `DecisionRepository.record`. Dry-run only — emits nothing to risk/execution.
- **Active-version selection by config** (`ACTIVE_STRATEGY_VERSION_ID` env, default 1 = v0 baseline; added to `.env.example`); deterministic stable `event_id = ${symbol}:${entryCandleOpenTime}` stamped by MarketData.
- **Stop computations** (ATR + structural, side-aware, hard-cap clamp, decimal.js).
- **Shared enums** (`packages/shared/src/enum/`): `FlowTypeEnum` redefined to the 5-class taxonomy (forced_exhaustion | trend_initiation | market_beta | catalyst_risk | low_quality_noise); new `SignalActionEnum`, `SkipReasonEnum`, `SignalTypeEnum`, `StopTypeEnum`, `CorrelationModeEnum`.
- **Shared utilities** (`packages/shared/src/util/`): pure `classifyFlowType` (with the idiosyncratic-altcoin-trap guard) and flow-aware `computeSignalScore` (momentum-favourable flows raise idiosyncrasy term, reversion lowers it; funding cost side-agnostic per-event score).
- **Shared params schema** (`packages/shared/src/schema/strategyParamsSchema.ts`): typed `IStrategyParams`, `.strict()`, tier-band `.refine` guard.
- **Market snapshot hardening**: `marketSnapshotSchema` now `.strict()`.
- **Shared event change**: `eventId` added to `IVolatilityDetectedEvent`; MarketData stamps it.
- **decimal.js added** to `packages/shared` deps (for shared utils and engine comparisons).

**Architecture:** Reference ADR 0003 — locked decisions on all these points. Strategy interface is engine-internal (only persisted enums go shared); `skip` is a real action with a reason; protective exits are M4/M6 (strategy only proposes targets); `flow_type` + `signal_score` stamped once by the orchestrator (M8 same-event comparability); `event_id` produced by MarketData; params typed + validated at load.

**Tests:** 202 tests across the strategy + market-snapshot suites green (v0–v3 behavior, determinism, exhaustion confirmation, regime gates, v3 routing, classifyFlowType branches incl. trap, flow-aware signal_score, ATR+structural stops, orchestrator single-stamp + event_id, registry param validation). All gates pass: shared build, engine build, engine lint (0 errors), tsc.

**Review rounds (two, per conventions):**
- *Round 1* (security/logic/clean-code/quant): security clean (no order path; strategies pure; logging redaction-safe) + flagged `.env.example` drift and non-strict params schema. Logic BLOCKER — `classifyFlowType` idiosyncratic-trap guard was dead code (§4 altcoin-trap rule unenforced on the classifier side); HIGHs — magic numbers/dead constants not params-driven, `parseFloat` on decimal-string money fields; MEDIUM — v1 "close-back-inside-band" confirmation near-always-true (would open on most triggers, contradicting skip-first), correlation_mode raw strings. Quant HIGHs — `computeSignalScore` idiosyncrasy term flow-blind/inverted vs ADR §5, funding-cost unit/scale bug (degenerate near-binary), tier-band div-by-zero. Clean-code must-fixes — inline magic numbers, control-flow spacing, consts placement, missing `registry/` barrel.
- *Round 1 fixes*: trap promoted to explicit top guard (CATALYST_RISK); thresholds params-driven; decimal.js comparison; signal_score made flow-aware (momentum-favourable flows raise on idiosyncrasy, reversion lowers) with corrected per-period funding term; tier-band guarded by schema `.refine`; v1 confirmation tightened to strict %B re-entry (still-extended spike now correctly SKIPs `no_exhaustion_confirmation`); CorrelationModeEnum; consts/barrel/spacing fixed; `.env.example` updated; params schema `.strict()`.
- *Round 2*: logic, security, quant all clear to close; clean-code found 6 residual must-fixes (comment/`if`-and-`return` blank-line spacing in the shared utils, redundant runtime tier-band throw removed in favour of the load-time `.refine`, named the neutral idiosyncrasy constant, `marketSnapshotSchema` tabs→4-space + `.strict()`) — all fixed. End state: zero blockers/highs.

**Carry-overs (document, not blockers):** prior-candle-extreme-break exhaustion confirmation omitted (no field on the event wire — candidate event-contract addition later); v1 `market_stress` skip deferred to M4 (stress params are risk-layer, strategies must not read them); `signal_score` funding term is side-agnostic (a single per-event score can't know trade side — M4 applies true directional carry); orchestrator snapshot placeholders (`active_positions_count=0`, `position_slot=A`) until M4 owns slot assignment.
