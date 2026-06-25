# ADR 0003 — Strategy engine (M3)

Status: Accepted
Date: 2026-05-22
Milestone: M3 — Strategy engine

## Context

M3 turns the enriched `volatility.detected` event (M1) into a recorded decision per
strategy version (M2 `decisions` table), with zero orders and zero risk checks. It locks
the cross-cutting contracts every later milestone reads or writes: the `IStrategy`
interface, the signal/skip vocabulary, the `flow_type` taxonomy, the `signal_score`
formula, the stable `event_id`, the strategy registry, and the typed params. No
application code is written by this ADR — it prescribes exactly what
`bot-shared-maintainer` adds to `packages/shared` and what `bot-engine-nestjs` builds in
`apps/engine`.

Constraints that shape every decision below (all non-negotiable):

- **Same code live and in backtest.** Strategies are pure, deterministic functions: no
  `Date.now()`, no `Math.random()`, no I/O. All inputs arrive as data. (code-conventions
  "Trading-domain rules"; overview "Core principle".)
- **Closed-bar only / no look-ahead.** Inputs come entirely from the `volatility.detected`
  payload, which is built on closed 5m bars (ADR 0001). No peek into the forming candle.
- **The strategy never reaches execution directly.** It emits a thesis signal; the risk
  gate (M4) and execution (M5) are downstream. Protective-exit *enforcement* is M4/M6.
- **Money is `decimal`, never float.** Price-bearing signal fields cross the
  shared-package boundary as decimal **strings** (ADR 0001/0002 wire convention); inside
  the engine they are `MoneyValue` (decimal.js).
- **`skip` is a first-class output**, not the absence of one. Most triggers should `skip`.
- The M2 schema is fixed: `decisions.action varchar (open|add|reduce|close|skip)`,
  `decisions.signal_type varchar`, `decisions.event_id varchar`, `decisions.reason varchar
  nullable`, `decisions.market_snapshot jsonb` (Zod `safeParse` at write,
  `DecisionRepository.record`), `strategy_versions.params jsonb`,
  `strategy_versions.direction varchar` (`StrategyDirectionEnum`).

## Decision

### 1. `IStrategy` — a pure, deterministic, synchronous function (engine-internal)

`IStrategy` lives at **`apps/engine/src/strategy/interface/IStrategy.ts`** (barrel
`interface/index.ts`). It is **NOT** added to `packages/shared`: the dashboard never
consumes it, only the engine and its backtest do, and it references engine-internal money
types (`MoneyValue`). Keeping it engine-side avoids leaking decimal.js / I/O-free
contracts across the wire.

Shape (one strategy = one `evaluate` method; the input groups its arguments per the
"≤2 args → group into a DTO" rule):

```
interface IStrategy {
    readonly name: string;            // matches strategy_versions.name
    readonly version: number;         // matches strategy_versions.version
    readonly direction: StrategyDirectionEnum;
    evaluate(input: IStrategyInput): ISignal;   // ALWAYS returns a signal (skip is a signal)
}
```

`IStrategyInput` (readonly; engine-internal, `strategy/interface/`):

```
interface IStrategyInput {
    event: IVolatilityDetectedEvent;      // the enriched closed-bar payload (with flow_type already classified — see §4)
    snapshot: IMarketSnapshot;            // the exact JSONB that will be persisted (string-money form)
    openPosition: IOpenPositionState | null;  // the symbol's current open position, or null
    params: IStrategyParams;              // typed, validated params for the active version (§8)
    nowMs: number;                        // deterministic clock — see below
}
```

**Determinism rules baked into the type:**

- **`evaluate` is synchronous and returns a value** (Command-Query Separation: it only
  computes a signal, it performs no writes, no logging, no exchange calls).
- **`nowMs` is the deterministic clock.** It is **derived from the bar**, not the wall
  clock: `nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS` (the close time of the
  trigger bar). The orchestrator computes it once and passes it in. Strategies use `nowMs`
  for the only time arithmetic they do — emitting a proposed time-stop target
  (`timeStopAtMs = nowMs + params.timeStopMinutes * 60_000`). A strategy that calls
  `Date.now()` is a must-fix. Backtest passes the historical bar-close time, so live and
  replay produce byte-identical signals.
- **Open-position state is a plain readonly snapshot, never the entity/repo.** The entity
  and `PositionRepository.findOpenBySymbol` are impure (DB I/O), so the **orchestrator**
  reads them and maps the open row to a frozen `IOpenPositionState`
  (`strategy/interface/`) carrying only what a strategy may legitimately read: `side`,
  `entryPrice: MoneyValue`, `qty: MoneyValue`, `entryNotional: MoneyValue`,
  `strategyVersionId`, `positionSlot`, `openedAtMs`, `timeStopAtMs`. The strategy never
  touches TypeORM. (Backtest builds the same struct from its simulated book.)

### 2. `ISignal` + `SignalActionEnum` + `SkipReasonEnum` — `skip` is a real action (shared)

`decisions.action` and `decisions.signal_type` are **persisted varchars** that M8 and the
M10 dashboard read, so their enums live in **`packages/shared/src/enum/`**. The `ISignal`
*shape* is the strategy↔orchestrator contract and is **engine-internal**
(`strategy/interface/ISignal.ts`) because it carries `MoneyValue` and is never sent to the
dashboard — the dashboard reads the persisted `decisions` row, not the in-memory signal.

**`skip` is in the SAME action enum.** `evaluate` ALWAYS returns an `ISignal`; a no-trade
outcome is `action = SKIP` with a populated `skipReason`. This matches the brief ("the
signal vocabulary treats `skip` as a real decision, not the absence of one") and the M2
column (`action ∈ open|add|reduce|close|skip`). No nullable signal, no "no signal" path.

```
// shared: SignalActionEnum.ts  (drives decisions.action — values match the M2 varchar)
enum SignalActionEnum { OPEN='open', ADD='add', REDUCE='reduce', CLOSE='close', SKIP='skip' }

// shared: SkipReasonEnum.ts  (drives decisions.reason for skips — stable, queryable taxonomy)
enum SkipReasonEnum {
    BASELINE_NO_TRADE='baseline_no_trade',          // v0 always
    REGIME_SUPPRESSED='regime_suppressed',
    MARKET_STRESS='market_stress',
    NO_EXHAUSTION_CONFIRMATION='no_exhaustion_confirmation',
    OUT_OF_SCOPE='out_of_scope',                     // v1 idiosyncratic decoupling, not BTC-correlated/ranging
    IDIOSYNCRATIC_TRAP='idiosyncratic_trap',         // idiosyncratic + rising OI + rising volume (§4 rule)
    FLOW_ROUTED_SKIP='flow_routed_skip',             // v3 routes catalyst_risk/low_quality_noise/market_beta to skip
    LOW_SIGNAL_SCORE='low_signal_score',
    FUNDING_COST_TOO_HIGH='funding_cost_too_high',
    MOVE_OUT_OF_BAND='move_out_of_band',             // abs move below tier floor or above tier ceiling
    OI_UNAVAILABLE='oi_unavailable',                 // require_oi_available && OI missing
}
```

**`signal_type`** (the M2 `signal_type` varchar, distinct from `action`) records *what the
detector classified*, not the act taken. Lock it as a stable shared enum
**`SignalTypeEnum`** keyed off the deviation/flow context so M8 can group "what kind of
event was this" independently of "what did we do": `VWAP_DEVIATION_LONG_BIAS`,
`VWAP_DEVIATION_SHORT_BIAS` (derived from `DeviationSideEnum`). This keeps `action` =
*decision* and `signal_type` = *event class*, both queryable.

**`ISignal` (engine-internal, `strategy/interface/`):**

```
interface ISignal {
    action: SignalActionEnum;             // open|add|reduce|close|skip
    signalType: SignalTypeEnum;
    skipReason: SkipReasonEnum | null;    // non-null IFF action === SKIP
    tradeSide: PositionSideEnum | null;   // long|short — DECIDED BY THE STRATEGY; null on skip
    signalScore: number;                  // 0–100 (§5); stamped on every decision incl. skip
    flowType: FlowTypeEnum;               // classified value carried through (§4)
    reason: string;                       // machine-readable code (mirrors skipReason or an entry-thesis code)
    proposedExit: IProposedExit | null;   // null on skip / reduce-by-signal; see §3
}

interface IProposedExit {                 // PROPOSED only — enforcement is M4/M6 (§3)
    takeProfitPrice: MoneyValue;
    stopLossPrice: MoneyValue;
    stopType: StopTypeEnum;               // atr | structural  (shared enum, persisted in M4 positions)
    timeStopAtMs: number;                 // = nowMs + params.timeStopMinutes*60_000 (deterministic)
}
```

`tradeSide` is the locked place where v1 and v2 diverge: same `event.side`, **opposite**
`tradeSide`. v1 (mean-reversion) fades — short on positive deviation, long on negative. v2
(momentum) follows — long on positive, short on negative. The strategy owns this; the
risk gate never flips a side.

`StopTypeEnum` (`atr | structural`) is **shared** because M4 persists the chosen stop type
and the dashboard surfaces it.

### 3. Protective-exit ownership — strategy PROPOSES, risk/position ENFORCES (M4/M6)

Unambiguous split (reviewers enforce):

- The strategy **emits proposed targets only** inside `ISignal.proposedExit`
  (`takeProfitPrice`, `stopLossPrice`, `stopType`, `timeStopAtMs`). These are *intent*,
  computed deterministically from the snapshot + params.
- The strategy **never closes a position to protect it.** It does not watch price, does
  not fire stop-loss / take-profit / time-stop closes, and does not enforce its own
  proposed targets. Those exits are owned by **M4 (risk validates SL sits inside
  liquidation distance, may tighten/clamp)** and **M6 (position layer places protective
  orders and triggers the actual closes)**.
- A `CLOSE` or `REDUCE` action from a strategy is a **thesis reversal** (the original
  edge is gone), not a protective stop. Protective closes are emitted by the
  risk/position layer with an `ExitReasonEnum` of `stop_loss|take_profit|time_stop`; a
  strategy-driven close carries `signal`.
- **Reviewer rule:** any strategy code that reads live price after the trigger bar, calls
  the exchange, or schedules a timer to close is a must-fix. The strategy's only output is
  one `ISignal` per `evaluate`.

### 4. `flow_type` — 5-class taxonomy, classified by the ORCHESTRATOR, stamped on every decision

**Redefine `FlowTypeEnum`** (shared) to the locked taxonomy, replacing the M1 placeholder:

```
enum FlowTypeEnum {
    FORCED_EXHAUSTION='forced_exhaustion',   // OI falling on the spike / liquidation cascade after exhaustion → fade-able
    TREND_INITIATION='trend_initiation',     // momentum or skip
    MARKET_BETA='market_beta',               // broad move; skip, or 1 slot only
    CATALYST_RISK='catalyst_risk',           // informed/catalyst flow; skip
    LOW_QUALITY_NOISE='low_quality_noise',   // skip
}
```

**Placement: the classifier is a SHARED PURE UTIL, run by the ORCHESTRATOR (recommended).**

- A shared pure function `classifyFlowType(snapshot|event) → FlowTypeEnum` lives in
  **`packages/shared/src/util/classifyFlowType.ts`** (new `util/` folder + barrel).
  Rationale: it is deterministic, side-effect-free, and **the M7 backtest and M8
  comparison must classify identically to live** — same source-of-truth requirement that
  put the Zod schema in shared (ADR 0002 §5). It reads only fields already on
  `IVolatilityDetectedEvent` (OI change, funding, volume accel/decel via `volume_ratio`,
  `btc_5m_move_pct`/`eth_5m_move_pct`, `market_breadth_5m_up_pct`, spread/depth, bollinger
  wick structure, `symbol_universe_age_hours`, `same_bar_trigger_count`,
  `idiosyncrasy_score`).
- **The orchestrator (StrategyService) calls it once per trigger and stamps the result on
  the snapshot before any version runs**, so **every** decision (v0/v1/v2/v3) carries the
  same classified `flow_type` for that event — required for M8 to compare versions on the
  same classification. Classifying *inside each strategy* is rejected: it would let two
  versions disagree on the flow of one event and break apples-to-apples comparison, and it
  would duplicate the logic four ways.
- **v3 ROUTES on `flow_type`; v0/v1/v2 only RECORD it.** v3 reads the already-stamped
  value from its input; it does not re-classify.
- **Idiosyncratic-altcoin trap (locked rule, enforced in both `classifyFlowType` and v1
  scope):** *idiosyncratic + rising OI + rising volume = SUSPICIOUS for reversion.* Such
  an event classifies as `catalyst_risk` (or `trend_initiation`), **never** a fade
  candidate. Concretely: when `idiosyncrasy_score ≥ params.idiosyncrasyMinScore` AND
  `open_interest_change_5m_pct > 0` AND `volume_ratio ≥ params.volumeRatioMin`, the
  classifier must NOT return `forced_exhaustion`. v1 (mean-reversion) additionally scopes
  itself to BTC-correlated / ranging dislocations and emits `SKIP` with
  `IDIOSYNCRATIC_TRAP` (or `OUT_OF_SCOPE`) on such events — it never fades them.

This corrects the earlier framing that treated idiosyncratic moves as high-quality fade
candidates. v0/v1/v2 keep their own (possibly simpler) entry logic but all see the same
stamped `flow_type`.

### 5. `signal_score` (0–100) — pure formula, computed by the ORCHESTRATOR

`signal_score` is written to **every** decision (incl. skip) and passed to M4 for
BTC-correlated candidate selection, so it must be one canonical value per event shared by
all versions → **computed by the orchestrator** via a shared pure util
**`packages/shared/src/util/computeSignalScore.ts`**, stamped on the snapshot alongside
`flow_type`. (Same single-source-of-truth + M8-comparability argument as §4. A strategy
may *read* it but does not compute its own.)

Inputs (all already on the event/snapshot; deterministic, no float-money — these are
ratios/scores, `number` is correct here, not `MoneyValue`):

- `vwap_deviation_sigma` **normalized to tier** — divide by the tier's expected band so a
  3σ tier-1 move and a 3σ tier-3 move are comparable (uses `coin_tier` + the tier
  min/max abs-move params).
- `volume_ratio` — higher confirmation → higher score.
- `idiosyncrasy_score` — its contribution is **regime/flow-aware**: it *raises* score for
  a momentum-favourable flow and *lowers* it for a reversion thesis on a suspicious
  idiosyncratic event (consistent with §4).
- **inverse funding cost** — `funding_rate_annualized` against the trade direction reduces
  the score (carry cost erodes edge).

Lock: the exact weights are `const/` values in the engine
(`strategy/const/strategyConsts.ts`) passed into the shared util, OR baked as named
constants in shared — either way **no inline magic numbers**, and the function is a pure
`(snapshot) → number` clamped to `[0,100]`. Determinism: identical inputs → identical
score, live and backtest.

### 6. `event_id` — derived deterministically, MarketData stamps it (shared change)

One stable `event_id` per VWAP trigger, **shared by all versions** writing a decision for
that event (M8 joins on it). It must be reproducible in live and backtest from the event
alone.

**Decision: MarketData stamps `eventId` onto `IVolatilityDetectedEvent` (a shared change),
the orchestrator copies it onto each decision.** Rationale: MarketData is the single
producer of the trigger; deriving in the orchestrator would force every consumer
(strategy now, risk/backtest later) to re-derive identically and risk drift. One producer,
one id.

Derivation (deterministic, collision-safe, human-debuggable):

```
eventId = `${symbol}:${entryCandleOpenTime}`
```

`symbol` + closed-bar open-time is unique per trigger (one trigger per symbol per closed
5m bar — the detector fires on bar close). It is identical live and on replay because both
read the same `entryCandleOpenTime`. No hash needed; the readable form aids debugging and
matches the `decisions.event_id varchar` column and its index. If a future change permits
multiple triggers per symbol per bar, append `:${sameBarTriggerCount}` — out of scope for
M3.

Shared change: add `eventId: string` to `IVolatilityDetectedEvent`; MarketData's
`toVolatilityDetectedEvent` mapper sets it.

### 7. Strategy registry + active-version selection by config

- **Registry** (`strategy/registry/StrategyRegistry.ts`, engine): maps a
  `strategy_versions` row (`name`, `version`, `direction`, `params`) to one `IStrategy`
  implementation. Each impl (`V0BaselineStrategy`, `V1MeanReversionStrategy`,
  `V2MomentumStrategy`, `V3HybridRouterStrategy`) is a NestJS provider implementing
  `IStrategy`; the registry indexes them by `${name}:${version}` (or by `direction` +
  `version`). The registry resolves an `IStrategyParams` for the active row by validating
  its `params` JSONB (§8).
- **Active-version selection by config**: an env/config key
  (`ACTIVE_STRATEGY_VERSION_ID`, read via the existing config layer, surfaced as a
  `strategy/const/` key name — value comes from env) selects the active
  `strategy_versions.id`. The orchestrator loads that row at startup, resolves its impl
  via the registry, validates params, and runs only that strategy on each trigger.
  **Switching the active version is a config/env change + restart — no code change**, per
  the brief.
- **`strategy_version_id` is stamped on every decision** the orchestrator writes (it owns
  the active row's id). The strategy impl does not know its own DB id; the orchestrator
  supplies it. This keeps the strategy pure (no DB identity inside the function).
- M3 runs **dry-run only**: the orchestrator writes the decision via
  `DecisionRepository.record` and emits nothing to execution (no risk gate yet).

### 8. Params typing — typed `IStrategyParams` + Zod schema in shared (recommended)

`strategy_versions.params` is untyped `jsonb` today. **Add a typed `IStrategyParams` + Zod
schema to `packages/shared`** (`src/schema/strategyParamsSchema.ts`, inferred
`IStrategyParams`), validated **at load** by the registry. Rationale: strategies read
params on the hot path; an untyped `Record<string, unknown>` invites silent typos
(`time_stop_minutes` vs `timeStopMinutes`) that would diverge live/backtest. Shared because
M7/M8 load the same params.

Reconcile with M2 seed defaults (the canonical base + per-version block in
`docs/plans/archive/M2-persistence.md` lines 62–104). The schema mirrors those keys exactly,
**in their persisted snake_case form** (the JSONB stores snake_case), with the engine
mapping to camelCase at the boundary. Base keys: `vwap_window_bars`,
`vwap_sigma_trigger`, `volume_ratio_min`, `atr_period`, `atr_stop_multiplier`,
`time_stop_minutes`, `idiosyncrasy_min_score`, `btc_correlated_move_threshold_pct`,
`max_open_positions`, `max_btc_correlated_positions`, the six tier min/max abs-move keys,
`funding_rate_suppress_threshold`, `candle_interval`, the three slippage keys,
`require_oi_available`, `oi_rising_skip`, `consecutive_loss_halt`,
`max_trades_per_symbol_per_day`, `max_trades_per_bar_universe`, the four stress keys,
`structural_stop_wick_buffer_pct`, `structural_stop_hard_cap_pct`. Per-version optional
keys: `trade_enabled` (v0), `direction` (v1/v2/v3), `require_exhaustion_confirmation` (v1).

**Two conflicts flagged (see "Conflicts" below):** (a) `direction` appears both as a
top-level `strategy_versions.direction` column AND inside `params` — the column is
authoritative; `params.direction` is redundant. (b) several base params
(`max_open_positions`, loss-halt, stress thresholds) are **risk-layer** concerns that the
strategy must NOT enforce — they are validated by the schema for completeness but consumed
in M4, not M3. The schema marks risk-only keys so reviewers do not let a strategy read
them.

### 9. Determinism & no-look-ahead — enforceable reviewer rules

Restated as must-fix checks for `bot-review-logic` / `bot-review-quant` / `bot-review-clean-code`:

1. **Closed-bar inputs only.** `IStrategyInput` carries only `IVolatilityDetectedEvent` /
   `IMarketSnapshot` (both built on closed bars per ADR 0001) + open-position snapshot +
   params + `nowMs`. A strategy that fetches any other live data is a must-fix.
2. **No wall clock / RNG.** No `Date.now()`, `new Date()`, `Math.random()`, `process.hrtime`
   inside any `IStrategy`, the flow classifier, or the score util. Time is `nowMs`
   (bar-close-derived).
3. **Side-effect free.** `evaluate` returns an `ISignal` and does nothing else — no logging,
   no DB, no events, no mutation of its inputs (inputs are `readonly`). Persistence/logging
   is the orchestrator's job (Command-Query Separation).
4. **No float money.** Price-bearing signal fields are `MoneyValue` in the engine and
   decimal-`string` across the wire; ratio/score/pct fields are `number`. A NUMERIC-derived
   value typed `number` is a must-fix.
5. **The strategy never reaches execution.** No exchange calls, no order intent — it stops
   at `ISignal`. The risk gate (M4) is the only path to execution.

## M3 contract handoff

### `bot-shared-maintainer` adds to `packages/shared` (serial, first)

1. **Redefine `FlowTypeEnum`** to the 5-class taxonomy (§4), replacing the placeholder
   values. Update the drift-guard / decision tests that referenced `UNCLASSIFIED` etc.
2. New enums under `src/enum/` (barreled): `SignalActionEnum` (§2),
   `SkipReasonEnum` (§2), `SignalTypeEnum` (§2), `StopTypeEnum` (§2).
3. Add `eventId: string` to `IVolatilityDetectedEvent` (§6).
4. New `src/util/` folder (+ barrel): `classifyFlowType.ts` (pure, §4) and
   `computeSignalScore.ts` (pure, §5), barreled from `src/index.ts`.
5. New `src/schema/strategyParamsSchema.ts` (+ `IStrategyParams` inferred type), §8,
   mirroring the M2 seed params keys; barrel from `src/index.ts`.
6. `marketSnapshotSchema` unchanged structurally; its `flow_type: z.nativeEnum(FlowTypeEnum)`
   now validates the new taxonomy automatically. Confirm the snapshot test fixtures use a
   valid new value.

### `bot-engine-nestjs` builds in `apps/engine`

1. `strategy/interface/`: `IStrategy.ts`, `IStrategyInput.ts`, `ISignal.ts`,
   `IProposedExit.ts`, `IOpenPositionState.ts` (+ barrel). Engine-internal; `MoneyValue`
   typed (§1, §2).
2. `strategy/const/strategyConsts.ts` (+ barrel): score weights, `CANDLE_INTERVAL_MS`,
   `ACTIVE_STRATEGY_VERSION_ID` config key name — no inline magic numbers.
3. `strategy/registry/StrategyRegistry.ts` (§7) + the four impls (`V0BaselineStrategy`,
   `V1MeanReversionStrategy`, `V2MomentumStrategy`, `V3HybridRouterStrategy`), each a
   provider implementing `IStrategy` and validating its params via the shared schema.
4. `strategy/service/StrategyService.ts` — the orchestrator: `@OnEvent(VOLATILITY_DETECTED_EVENT)`,
   compute `nowMs`, classify `flow_type` + `signal_score` (shared utils), stamp them on the
   snapshot, read open position via `PositionRepository.findOpenBySymbol` and map to
   `IOpenPositionState`, run the active strategy, then write the decision via
   `DecisionRepository.record` with `event_id`, `action`, `signal_type`, `reason`,
   `signal_score`, `strategy_version_id`. Dry-run only (no risk/execution emit).
5. MarketData mapper change: set `eventId = `${symbol}:${entryCandleOpenTime}`` and
   **stop hard-coding `FlowTypeEnum.UNCLASSIFIED`** — MarketData no longer sets a flow
   placeholder; the orchestrator stamps the classified value. (Decide: either drop the
   field from the M1 emit and let the orchestrator add it to the snapshot, or have
   MarketData emit a sentinel the orchestrator overwrites. Recommended: orchestrator owns
   `flow_type` on the snapshot; the event's `flowType` becomes the classified value the
   orchestrator computes — keep the field, change who fills it.)
6. v0–v3 seed rows already exist (M2). M3 reconciles `params` with the typed schema; if any
   seed key drifts, fix the seed (a migration) — flag, do not silently edit.
7. QA: pin v1/v2 direction on a known candle; pin both stop computations (ATR + structural)
   on a known candle; pin `classifyFlowType` and `computeSignalScore` on fixtures; assert a
   skip always carries a `skipReason`; assert determinism (same input → same signal twice);
   assert `event_id` stable across versions for one trigger.

### Architecture overview note (StrategyModule sub-structure)

`docs/architecture/overview.md` does not exist as a separate file — the canonical overview
is `docs/plans/00-overview.md`, whose StrategyModule paragraph already names the interface,
versions, registry, active-version selection, `decisions`, and stable `event_id`. M3 adds
the **flow classifier + signal-score utils in `packages/shared/src/util/`** and the
engine's `strategy/{interface,registry,service,const}` folders. This is a structural
addition the scribe should fold into that paragraph (no separate file is created by this
ADR, per the project's "no unsolicited docs" rule).

## M47 Amendment — SL/TP coupling at signal time (2026-06-25)

Status: Accepted (re-blessed before the M47 implementation wave).
Milestone: M47 — Risk:Reward geometry fix. See `docs/plans/m47-rr-geometry-fix.md`.

This amends §3 (protective-exit ownership) and §8 (params typing). It is an addition, not a
contradiction: the strategy still only *proposes* exit geometry; M47 constrains the *shape*
of that proposal so no core can emit a structurally-losing trade.

### A1. New invariant — TP and SL are coupled at signal time

`momentumCore` and `meanReversionCore` historically computed `takeProfitPrice` and
`stopLossPrice` from **independent** price references, so the realized SL distance routinely
exceeded the TP distance (inverted R:R). M47 makes this a hard contract:

> **No strategy core may emit a signal whose signal-time R:R (`tp_dist / sl_dist`) is below
> `min_rr`** (the versioned param, provisionally 1.5). The TP and SL are coupled at the moment
> the signal is built — a core that cannot reach `min_rr` without degenerate geometry **skips
> the signal**, it never emits a sub-target or degenerate one.

The coupling direction is asymmetric per strategy and is itself part of the contract:

- **Momentum: only the TP is ever widened** to satisfy the ratio. The VWAP-session stop is the
  thesis-invalidation level (a reversion to VWAP kills the momentum thesis) and **is never
  tightened**. The fix adds an `rrFloor = slDist × min_rr` leg to the existing TP `max()`,
  **capped** at `max_tp_dist_factor × atr14` (so an extreme spike cannot place the TP at a
  negative or unreachable price).
- **Mean-reversion: only the structural stop is tightened (capped)** to satisfy the ratio. The
  half-retrace TP is intentionally conservative and inherently reachable and **is never
  widened**. The fix caps the structural stop at `slCap = tpDist / min_rr`, bounded below by an
  ATR-relative noise floor (see A3).

### A2. Degenerate geometry is a skip, never a degenerate signal

When coupling cannot produce a geometry that meets `min_rr` above the relevant floor/cap, the
core **skips the signal** (a first-class `SKIP` outcome per §2), it does not emit it:

- **Momentum (cap-bound):** if the `rrFloor` cap binds and the resulting `tpDist / slDist <
  min_rr`, or the capped TP price is itself degenerate (`≤ 0` for a SHORT, absurd multiple of
  entry for a LONG), the core skips via an `isDegenerateMomentumGeometry` check. It does **not**
  rely on the loose risk gate to catch a cap-bound sub-`min_rr` trade — Invariant 1 (no
  sub-`min_rr` signal) is enforced in the core.
- **Mean-reversion (SL-floor):** if `slCap = tpDist / min_rr` falls below the noise floor
  `slFloor`, the core skips via `isDegenerateReversionGeometry` rather than ship a hair-trigger
  stop that normal volatility trips immediately.

This keeps the core as the *binding* constraint that shapes geometry; the gate backstop
(ADR 0004 M47 amendment) is a loose, defense-in-depth net, never the primary enforcement of
Invariant 1.

### A3. New versioned params added to `baseSchema` (§8)

Four new **base (non-optional)** params join `strategyParamsSchema` (`packages/shared`,
persisted snake_case, versioned and replayable so live and backtest read the identical value):

| Param | Purpose | Default | Unit |
|-------|---------|---------|------|
| `min_rr` | Core R:R target — the coupling floor both cores shape toward | 1.5 | plain multiplier |
| `atr_floor_multiplier` | Mean-reversion SL noise floor, ATR-relative (binding) | 0.3 | plain multiplier |
| `entry_pct_floor` | Mean-reversion SL noise floor, %-of-entry sanity bound (zero-ATR edge) | 0.3 | **percent-number** (0.3 = 0.3%), divided by 100 before use, matching `structural_stop_hard_cap_pct` |
| `max_tp_dist_factor` | Caps the momentum `rrFloor` TP distance at `max_tp_dist_factor × atr14` | 5.0 | plain multiplier |

Where `slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor / 100) × entry)`.

- **Unit convention:** do not mix the fraction form (`0.003`) and the percent-number form
  (`0.3`); percent-of-entry quantities use the percent-number form throughout, exactly as the
  existing `structural_stop_hard_cap_pct` (`2.0` = 2%).
- The fixed `min_sl_floor` from earlier drafts is **removed and must not be reintroduced** — the
  ATR-relative pair replaces it.
- `min_rr` is the *core target*; the gate's loose floor `MIN_RR_GATE_FLOOR` is a separate
  **engine constant** (ADR 0004), deliberately not a version param, so the binding constraint
  stays in version params and the safety net stays a code-level value.
- `min_rr = 1.5` ships **provisional**. It is not validated within M47 (pre-M47 closed positions
  carried inverted geometry, so their backfilled excursion data describes badly-shaped trades);
  it is confirmed or re-tuned in a post-deploy review and re-tuned, if needed, via a targeted
  JSON-merge param-row UPDATE on the new version rows + restart (no code deploy).

### A4. New geometry-coupled version rows — v1.1 / v2.1 / v3.1

The coupling is a behavioral change to v1/v2/v3, so M47 introduces **new strategy version rows**
(v1 → v1.1, v2 → v2.1, v3 → v3.1, or the project's equivalent next-version numbering) carrying
the four new params. The migration activates the new rows and clears the active flag from the
old rows.

- **Old version rows stay immutable and read-only** for historical replay of pre-M47
  inverted-geometry trades. The JSON-merge backfill still adds the four keys to the old rows so
  they continue to load under the `.strict()` schema, but they are not traded under after deploy.
- The version bump is the clean partition key for pre/post-M47 success metrics and the
  `position_segment_stats` view (ADR 0002 / data-model) — correct by construction, no deploy-date
  arithmetic.
- **Non-rolling deploy** is mandatory: stop engine → run the param migration (JSON-merge backfill
  + new rows + activation) → start the new engine. The `.strict()` schema makes a partial deploy
  unsafe (an un-migrated row crashes strategy resolution).
- **The seeder is dev/CI-bootstrap only post-M47** — `SeedStrategyVersions.ts` does a full-blob
  `params` overwrite that would clobber production-tuned values; never re-run it against the live
  DB.

### A5. Relationship to the existing exit-ownership split (§3)

Unchanged: the strategy still only *proposes* `proposedExit`; M4 (risk) may still clamp the SL
inside liquidation; M6 enforces the actual closes. M47 narrows what the proposal may contain
(R:R ≥ `min_rr` or skip) and does not move the enforcement boundary. The momentum-rebase
interaction (the proposal must survive the fill unchanged) is settled in ADR 0045's M47
amendment (Option B / `tpRebaseEligible: false`).

## Conflicts surfaced (for the main session)

1. **`direction` duplicated.** `strategy_versions.direction` (column,
   `StrategyDirectionEnum`) AND `params.direction` (M2 seed, v1/v2/v3) both encode
   direction. **Resolution: the column is authoritative; `params.direction` is redundant
   and the strategy/registry read the column.** The schema accepts `direction` in params
   for backward-compat with the existing seed but the engine ignores it. Flagged so the
   scribe can decide whether to remove it from the seed in a later migration.
2. **Risk-layer params in the strategy params block.** The M2 base params include
   `max_open_positions`, `max_btc_correlated_positions`, `consecutive_loss_halt`,
   `max_trades_per_symbol_per_day`, `max_trades_per_bar_universe`, and the four `stress_*`
   keys. These are **risk-gate (M4)** concerns. A strategy must NOT enforce them (that would
   smuggle risk into the strategy and break "all risk lives outside the strategy"). They
   are validated by the shared schema for completeness and consumed in M4. Reviewers flag
   any M3 strategy that reads them.
3. **M2 seed omits structural-stop selection.** The brief lets the strategy emit either
   `atr` or `structural` stops, but no seed param selects which. **Resolution:** v1's exit
   logic chooses per the brief (structural beyond the wick + hard cap, OR ATR×multiplier);
   the choice is encoded in `StopTypeEnum` on the emitted signal, driven by the existing
   `structural_stop_*` and `atr_stop_multiplier` params — no new param needed. Both
   computations are unit-pinned.

## Alternatives considered

- **`skip` as the "no signal" / `null` return.** Rejected: the brief makes `skip` a
  first-class decision with a reason, the M2 `action` enum lists `skip`, and skip rate is a
  primary metric — a nullable signal would lose the reason and the row. `evaluate` always
  returns a signal.
- **Put `IStrategy`/`ISignal` in `packages/shared`.** Rejected: the dashboard reads the
  persisted `decisions` row, not the in-memory signal; the signal carries engine-only
  `MoneyValue`. Only the persisted *enums* (`SignalActionEnum`, `SkipReasonEnum`,
  `SignalTypeEnum`, `StopTypeEnum`) go shared.
- **Classify `flow_type` / compute `signal_score` inside each strategy.** Rejected: four
  versions could disagree on the flow of one event, breaking M8's same-event comparison,
  and it duplicates logic. The orchestrator stamps one value per event via a shared pure
  util.
- **Make the classifier/score an engine service (not a shared util).** Rejected: M7
  backtest and M8 comparison must classify/score identically to live — the same
  single-source-of-truth argument that put the Zod schema and the trigger in shared
  (ADR 0001/0002). Pure functions in shared guarantee parity.
- **`event_id` as a hash of the full snapshot.** Rejected: brittle (any field nudge changes
  the id, breaking version comparison across a redeploy) and unreadable. `symbol:openTime`
  is stable, reproducible, and debuggable.
- **Orchestrator derives `event_id` instead of MarketData stamping it.** Rejected: multiple
  consumers (strategy, later risk/backtest) would each re-derive and could drift; one
  producer (MarketData) stamps it once.
- **Keep `strategy_versions.params` untyped `jsonb`.** Rejected: strategies read params on
  the hot path; a typo silently diverges live/backtest. A shared Zod schema validated at
  load is cheap insurance.
- **`nowMs` from the system clock.** Rejected outright — destroys determinism; backtest and
  live would diverge on every time-stop. `nowMs` is bar-close-derived.
- **Strategy enforces its own stops/time-stop.** Rejected: violates the
  protective-exit-ownership invariant; enforcement is M4/M6. The strategy only proposes.

## See also

- `docs/plans/archive/M3-strategy-engine.md` (the milestone brief), `docs/plans/00-overview.md`
  (locked decisions + StrategyModule paragraph + data model)
- `docs/architecture/adr/0001-exchange-and-market-data.md` (`IVolatilityDetectedEvent`,
  closed-bar rule), `docs/architecture/adr/0002-persistence-and-data-model.md`
  (`decisions`/`strategy_versions` schema, `market_snapshot` Zod schema, shared enums,
  entity ownership)
- `docs/best-practices/code-conventions.md` (naming, enums, interfaces, control flow,
  constants placement — authoritative)
