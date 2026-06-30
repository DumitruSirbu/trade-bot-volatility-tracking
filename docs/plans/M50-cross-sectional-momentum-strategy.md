# M50 — Cross-Sectional Momentum Strategy (parallel addition)

Status lives in [`README.md`](README.md), not here.

## Milestone summary

Add **cross-sectional momentum** as a *new, parallel* strategy alongside the existing
VWAP-deviation family (v0–v3). The signal: rank the tradable universe by trailing 24h
return, hold the top-ranked winner(s) for 24h, re-rank on a 24h cadence. Evidence:
EXP-011 (gross +6.0%/period long-short, t=2.45, positive in all 3 sub-windows) and
EXP-012 (survives real tier-floor fills at +4.46% long-short). **M50 deploys the long-only
single-slot proxy, whose post-cost significance is t=1.49** — NOT the long-short t=1.83, which
is the wrong statistic for the deployed mode. Both are below the registry's decision bar.

**This milestone delivers the infrastructure + a paper/shadow validation path. It does
NOT take live capital.** EXP-011/012 are explicitly INCONCLUSIVE ("do NOT promote to a
strategy build on this evidence … soak + monthly re-run, not a strategy build"). The
correct conservative action is to wire the strategy so it runs in PAPER (and shadow),
accumulate a multi-regime soak, and gate any live promotion on post-cost significance
holding across a *down* regime. Building the engine path now is justified only because it
is a prerequisite for that soak — not because the signal has cleared the bar.

### Delivers
- A new pure **portfolio-strategy contract** (`IPortfolioStrategy`) — distinct from the
  single-symbol `IStrategy` — and a pure `crossSectionalMomentumCore` ranking function.
- A scheduled **rebalance trigger** + a **momentum orchestrator** that builds the
  cross-sectional snapshot, runs the pure core, and routes each selected leg through the
  **existing risk gate and execution path, unchanged**.
- **Single-slot long-only proxy** (`top_n = 1`) as the first operating mode — the
  lowest-architecture path EXP-012 endorses. Fits the current 1-position / 3-slot model
  with no cap change.
- PAPER-mode wiring so the strategy runs in the local soak as a **version-partitioned PAPER soak**
  (real `decisions` + `positions` under `strategy_version_id=xmom`; analysis partitions by version —
  no new shadow orchestrator; see Phase 2c recording seam).
- A `strategy_versions` row (`name='xmom'`, `direction='momentum'`) and a *separate*
  active-selection env, so VWAP and momentum run concurrently on disjoint orchestrators. They
  **share** the global A/B/C slot pool in M50 (a separate namespace is the M50b feature, D4/D5).

### Does NOT deliver
- **No live capital.** PAPER + shadow only this milestone; live promotion is a gated
  follow-on (see Open questions).
- **No multi-position basket, no short leg, no dollar-neutral book.** The N-long / N-short
  basket needs the slot-model relaxation (per-strategy cap + total-notional cap); that is
  designed here but deferred to M50b. Single-slot long-only first.
- **No new market data.** Reads existing `candles` / `instruments` / `universe_membership`.
- **No change to the VWAP path** (v0–v3, `StrategyService`, `IStrategy`, `evaluateTrigger`,
  `VOLATILITY_DETECTED_EVENT`). Strictly additive.
- **No in-engine portfolio backtest harness.** Offline validation reuses the existing
  `scripts/research/cross-sectional-momentum/` + `packages/analysis/research/phaseB_fill_sim.mjs`.
  An in-engine `BacktestRunner` portfolio path is deferred.

## Pre-reading (before touching code)

| File | Why |
|------|-----|
| `docs/analysis/20260630-cross-sectional-momentum-exp011.md` | Operating point (24h/24h), liquidity floor ($20k median 5m $vol), tail-only edge, rules-out list |
| `docs/analysis/20260630-cross-sectional-momentum-phaseB-exp012.md` | Real-fill cost (~75–79 bps/leg round trip), upper-bound caveats, single-slot long-only proxy as the live path |
| `docs/brainstorm/20260630-1038-alternative-strategies-alpha-forge.md` §1 + recommendation | Integration modes (a) single-slot proxy / (b) basket; multi-position is the binding constraint on the high-Sharpe variant |
| `docs/analysis/README.md` | EXP-014 short-cover overlay, EXP-013 funding-fade rejection, methodology bar (≥30 obs, multi-window, decision-grade) |
| `docs/plans/00-overview.md` | Locked decisions: max 3 positions, decimal money, deterministic strategies, central risk gate, no LLM in loop |
| `apps/engine/src/strategy/interface/IStrategy.ts` + `IStrategyInput.ts` | The single-symbol contract that does NOT fit; basis for the parallel `IPortfolioStrategy` |
| `apps/engine/src/strategy/service/StrategyService.ts` | The per-event orchestrator pattern to mirror (gate → persist decision → emit `ORDER_INTENT_APPROVED_EVENT`) |
| `apps/engine/src/strategy/registry/StrategyRegistry.ts` | Registration + params-resolution pattern to mirror for the portfolio registry |
| `apps/engine/src/risk/service/RiskGateService.ts` (`evaluate`, `evaluateEntry`) + `SlotManager.ts` | The unchanged gate path each leg must traverse; slot assignment |
| `apps/engine/src/risk/const/riskConsts.ts` | `MAX_OPEN_POSITIONS=3`, exposure caps, sizing; all risk lives here, never in strategy params |
| `apps/engine/src/position/service/ReconciliationService.ts` | Already per-`(symbol, side)`; confirm multi-position needs no change |
| `apps/engine/src/market-data/repository/CandleRepository.ts` + `UniverseMembershipRepository.ts` | Snapshot data sources for the ranking job |
| `packages/shared/src/schema/strategyParamsSchema.ts` | `.strict()` + VWAP-required — confirms why momentum needs a *separate* `momentumParamsSchema`, not bolt-on keys |
| `docs/best-practices/code-conventions.md` + `dev-qa-cycle.md` | Authoritative; overrides generic Clean Code |

## Architecture decisions (new locked choices)

> The architect must author/extend ADRs for D1–D8 before engine work begins.

**D1 — New `IPortfolioStrategy` contract; `IStrategy` untouched (OCP).**
The cross-sectional signal is portfolio-shaped (whole-universe snapshot → ranked selection),
which the single-symbol `IStrategy.evaluate(input): ISignal` cannot express. Add a *parallel*
pure contract:

```
IPortfolioStrategy {
  name, version, direction
  selectPortfolio(input: IPortfolioInput): IPortfolioSelection   // pure, deterministic
}
```

`IPortfolioInput` carries the ranked snapshot (per-symbol trailing-return + tier + liquidity),
the set of currently-held momentum positions, validated params, and `nowMs` (injected, never
wall-clock). `IPortfolioSelection` is the target book: symbols to OPEN and symbols to CLOSE this
rebalance — never an order, never I/O. The same purity/determinism invariant as `IStrategy`
applies (no `Date.now()`/`Math.random()`/DB/exchange). New ADR **0047** owns this contract.

**D2 — Scheduled rebalance trigger, deterministic clock.**
Rebalancing is time-driven (24h), not event-driven. A new `RebalanceSchedulerService` fires on
a fixed UTC cadence (`@Cron` / `@Interval`) and emits `UNIVERSE_REBALANCE_DUE_EVENT` carrying
`nowMs` (the scheduler is the one allowed `Date.now()` boundary, mirroring `UniverseService` /
`ReconciliationService.scheduledTick`). All downstream code receives `nowMs` injected so
backtest/replay reproduce identical selections. The ranking I/O (candle reads) happens in the
*orchestrator*, never inside the pure core.

**D3 — Each leg traverses the existing risk gate unchanged; single-slot proxy first.**
The momentum orchestrator builds one `IOrderIntent` per selected symbol and calls the existing
`RiskGateService.evaluate(intent, context)` — the same `PositionSizer`, exposure caps, slot
model, and halt logic. No new order path. With `top_n = 1` (long-only proxy) the single leg
consumes one idiosyncratic slot (A) within the existing `MAX_OPEN_POSITIONS = 3` model — **no
cap change required**. Exit = flatten-and-re-rank each rebalance + a `hold_hours` time-stop
backstop (24h). New ADR **0048** documents the orchestrator + leg-routing.

**D7 — Momentum hold-window exit geometry (the gate cannot open without it).**
`RiskGateService.evaluate` requires a full `IOrderIntent.proposedExit` (`takeProfitPrice`,
`stopLossPrice`, `stopType`, `timeStopAtMs`, `tpRebaseEligible`, `atrDistance`) and `PositionSizer`
derives notional from the stop distance — flatten-on-rebalance alone is not sufficient. The pure
core (or a sibling `buildMomentumHoldExit` helper) must emit, for each OPEN leg, anchored to the
rebalance reference price:
- **Time stop:** `timeStopAtMs = nowMs + momentum_hold_hours × MS_PER_HOUR` (the 24h hold; NOT the
  VWAP `time_stop_minutes`). **BLOCKER (logic review):** `RiskGateService.checkTimeStop`
  (RiskGateService.ts:1296-1310) rejects `TIME_STOP_MISSING_OR_INVALID` when
  `timeStopAtMs > nowMs + context.params.time_stop_minutes × MS_PER_MINUTE` — the gate ceiling IS
  `time_stop_minutes`. A 24h `timeStopAtMs` against a VWAP-sized `time_stop_minutes` rejects every
  momentum OPEN. ADR 0048 MUST either set `time_stop_minutes ≥ momentum_hold_hours × 60` (≥1440) in
  the momentum gate-context params, or branch `checkTimeStop` by `direction='momentum'`. **Pin in
  Phase 0 before engine work.**
- **Disaster stop:** an ATR-multiple stop (`momentum_stop_atr_multiplier`) wide enough not to fire
  on normal 24h noise yet inside the liquidation clamp. **Quant constraint:** EXP-011/012 validated
  pure close-to-close 24h holds with NO intrabar stop — a stop that fires mid-hold changes the return
  distribution away from what was validated. The disaster stop must therefore sit *beyond* the
  empirical 24h MAE distribution of D10 winners (a true safety backstop, NOT part of the edge); if it
  fires materially in soak, the live strategy is no longer the one the experiments measured. Calibrate
  from the offline panel before seeding `momentum_stop_atr_multiplier`. **ADR 0048 must state, numerically:**
  (a) the calibrated 24h-MAE percentile the stop clears for D10 winners (which can draw 15–25%
  intra-hold, so a cosmetically-tight stop would fire constantly and destroy the validated
  distribution); and (b) confirmation the stop sits *inside* the liquidation clamp so it is a real
  backstop, not a no-op.
- **Take profit:** the rebalance is the intended exit, so either a very wide ATR-multiple TP
  (`tpRebaseEligible=false` — momentum holds are not single-bar rebased) or an explicit "no-TP"
  policy; if no-TP, the ADR must state how the gate's `isWrongSideTakeProfit` / `isRewardRiskTooLow`
  (M47 R:R floor) behave for `direction='momentum'` portfolio holds. **Locked default:** an explicit
  no-TP policy with a documented `min_rr` exception for `direction='momentum'` (preferred over a
  sentinel-wide TP, which silently couples the R:R floor to an arbitrary distance). ADR 0048 owns the
  exception.
- **`flowType`:** a new `FlowTypeEnum.CROSS_SECTIONAL_MOMENTUM` with an `orderPolicyMatrix` row
  (taker open `MARKETABLE_LIMIT_IOC`, exits `REDUCE_MARKET`).
- **`signalScore` / `idiosyncrasyScore` / `correlationMode`:** the orchestrator must source these
  for slot assignment — top-ranked winners are often high-beta, so slot C vs A/B matters. Define the
  derivation (e.g. correlation from the symbol's BTC-correlation snapshot; a fixed/derived signal
  score). Locked in ADR 0048; without it Phase 2c is not implementable.
- **Per-leg `IMarketSnapshot` + full `IStrategyParams` source (logic review, BLOCKER).** Momentum
  OPENs traverse the full `evaluateEntry`, which reads `bid_ask_spread_pct`, `book_depth_10bps_usdt`,
  `estimated_slippage_pct`, `open_interest`, `vwap_deviation_pct`, `funding_rate` (RiskGateService.ts:
  804-826, 1046-1059, 1166-1178) — all fail-closed on missing/NaN. `IRankedSymbol` only carries
  `{symbol, trailingReturn, coinTier, dvol}`, and `StrategyService.buildGateContext` (line 341-367)
  derives its snapshot from a `VOLATILITY_DETECTED_EVENT` momentum does not have. ADR 0048 MUST define
  the per-leg snapshot source: a **fresh book / OI / slippage read per selected symbol at rebalance**.
  ADR 0048 must also enumerate the **complete `IStrategyParams` risk-key set** the gate reads beyond
  the strategy params — `require_oi_available`, `funding_rate_suppress_threshold`, `oi_rising_skip`,
  `max_trades_per_symbol_per_day`, `max_trades_per_bar_universe`, `time_stop_minutes` (RiskGateService.ts:
  856, 1019, 1023, 1048, 1083) — and how the orchestrator constructs them for the momentum gate context.
  **Pin in Phase 0.**
- **VWAP-specific gate predicates on stubbed fields.** `checkFundingFlowSkip` / `isFadeEntry` read
  `vwap_deviation_pct`; a momentum LONG below VWAP could be classified a "fade" and skipped. ADR 0048
  must state the stubbing decision explicitly (e.g. `vwap_deviation_pct=0` to make fade classification
  inert for `direction='momentum'`), not leave it to chance.

**D8 — Sizing basis: fixed-fractional notional, NOT ATR-stop risk-sizing (quant review).**
`PositionSizer.size` derives qty from `risk_per_trade ÷ stopDistance` — tuned for the VWAP path's
*tight* ATR stops. The D7 momentum disaster stop is deliberately *wide*, and `risk = qty × stopDistance`
means a wide stop yields a *tiny* qty → frequently below `min_notional` → the leg is skipped. Worse,
this diverges from the validated panel: **EXP-012 sized every leg at a flat $1,000 equal-weight
notional**, not ATR-risk-sized. Decision: momentum legs size by **fixed-fractional notional** (a
configured % of allocated capital, matching the equal-weight panel), routed through the gate so all
exposure caps (`MAX_EXPOSURE_PER_COIN_USDT`, same-direction, per-strategy in M50b) still bind. This
needs a momentum sizing path in the risk module (a `PositionSizer` mode or sibling), NOT a reuse of
the ATR-risk sizer. Money stays `decimal`. ADR 0048 locks the sizing formula; flag the risk-module
touch for the engine wave (this is the one place M50 extends, not just consumes, the risk module).
**Soak-fidelity cap:** the configured fixed-fractional notional MUST cap each leg at the validated
panel's flat **$1,000/leg** equal-weight basis (EXP-012) so soak PnL is comparable to the study; a
larger leg changes the cost/slippage ratio away from what was measured.

**D4 — Multi-position basket model (designed, deferred to M50b).**
The N-long basket needs concurrency the 3-slot VWAP correlation budget was not designed for.
Locked model for when it lands: a **per-strategy position cap** (`momentum_max_positions`,
risk-only config, NOT strategy params) AND a **per-strategy total-notional cap**
(`momentum_notional_cap_usdt`), layered *on top of* — never replacing — the existing slot model
and per-coin / same-direction exposure caps. Momentum legs occupy a *separate* slot namespace so
they never starve or collide with VWAP slots A/B/C. `MAX_OPEN_POSITIONS = 3` stays the VWAP
architectural max (ADR 0004 §4); the momentum cap is an independent budget. This is an ADR-0004
amendment + new ADR section, authored in M50b, not this milestone. **Defended invariant:** even
with a basket, no leg bypasses the gate, and the gate enforces all D-rules per leg.

**D5 — Separate active-version selection; shared slot pool in M50 (NOT disjoint).**
A new env `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` (nullable; null/absent = momentum disabled,
the default) selects the active momentum version, independent of `ACTIVE_STRATEGY_VERSION_ID`
(VWAP). Both run concurrently on *disjoint orchestrators and a disjoint event stream*.

**They do NOT have disjoint slot namespaces in M50.** The separate namespace is the M50b feature
(D4); in this milestone a `top_n = 1` momentum leg competes for the *same* global slots A/B/C and
the *same* `MAX_OPEN_POSITIONS = 3` / per-coin / same-direction exposure caps as VWAP. Expected and
acceptable behaviour:

| Mode | Slot behaviour |
|------|----------------|
| **M50 (`top_n = 1`)** | Momentum and VWAP **share** A/B/C. A rebalance can be `MAX_POSITIONS_REACHED` when VWAP already holds 3 slots; the orchestrator records the gate reject and opens nothing — it never bypasses the gate. |
| **M50b** | Separate momentum slot namespace + per-strategy caps (D4). |

For clean PAPER soak attribution, run momentum PAPER during low-VWAP-occupancy windows or with VWAP
triggers relaxed — or accept slot competition as part of the experiment and partition results by
`strategy_version_id`.

**Cross-strategy `(symbol, side)` collision under exchange netting (logic review, BLOCKER).**
`ReconciliationService.runPass` (ReconciliationService.ts:475-476) keys its map by `(symbol, side)`
only — no `strategy_version_id` in the key. Binance USDT-M one-way mode holds ONE net position per
symbol, so a momentum BTC-long concurrent with a VWAP BTC-long collapses to a single netted exchange
row but two DB rows sharing one map key → `QTY_MISMATCH` mis-fires or one DB row becomes invisible.
The earlier claim that "N independent rows per `(symbol, side)`" is sufficient is WRONG under netting.
**M50 decision (simplest):** forbid cross-strategy same-`(symbol, side)` concurrency at the gate — a
momentum OPEN on a symbol+side already held by VWAP (or vice versa) is gate-rejected, opens nothing,
and is recorded. ADR 0048 must lock this rule (or, if cross-strategy same-symbol concurrency is later
wanted, address netting reconciliation by keying on `strategy_version_id`). **Pin in Phase 0.**

**Global halt / consecutive-loss coupling between VWAP and momentum (logic review, HIGH).**
`isConsecutiveLossHalt` (RiskGateService.ts:991-996) counts ALL closed losses on the UTC day
regardless of `strategy_version_id`. Momentum losses can trip the day-halt that suppresses VWAP
entries, and vice versa — the two strategies share one loss-halt budget in M50. This is stated, not
fixed: per-strategy halt budgets are deferred to M50b. Soak analysis must attribute halt-driven flat
periods to the correct strategy.

**D6 — Ranking statistics are not money.**
Prices feeding the trailing-return ratio are `decimal` (read from `candles`). The trailing-return
*rank statistic* is a derived ordering value (never PnL, never persisted as money) and may be a
`number`. Every notional / qty / price that reaches sizing, the gate, or the ledger stays
`decimal` end-to-end via `PositionSizer` (unchanged). This is called out so a reviewer does not
flag the rank float as a money-as-float violation.

## Phase breakdown (dispatch waves)

Per `CLAUDE.md` waves and `dev-qa-cycle.md` (≤5 files/items per dispatch, architect on contract
touches, paired tests per fix, orchestrator verifies every diff).

### Phase 0 — Architect (this doc + ADRs) — must close before any engine work
- Author ADR **0047** (`IPortfolioStrategy` contract + determinism rule + the separate
  `momentumParamsSchema` and strategy-vs-risk param split).
- Author ADR **0048** (rebalance scheduler + UTC anchor + boot recovery (D2/OQ8); momentum
  orchestrator + leg routing (D3); **hold-window exit geometry (D7)**; flatten-then-open ordering;
  recording seam (D5 option A); batch candle read).
- Add an ADR-0004 *deferred note* pointing at D4 (momentum cap model + separate slot namespace, M50b)
  — do not implement.
- Update `docs/architecture/adr/README.md` topic map.
- **Do NOT dispatch engine work until ALL of the following are pinned in the ADRs:** exit geometry
  (D7); the **24h time-stop vs `time_stop_minutes` gate-ceiling resolution** (D7 BLOCKER —
  `time_stop_minutes ≥ 1440` in momentum context or branch `checkTimeStop`); the **per-leg
  `IMarketSnapshot` source** (fresh book/OI/slippage read per selected symbol at rebalance, D7
  BLOCKER); the **full gate-context `IStrategyParams` key set** `evaluateEntry` reads (D7/Phase 1
  HIGH); the **cross-strategy same-`(symbol, side)` netting rule** (D5 BLOCKER — forbid at gate); the
  **canonical dvol computation** (static vs rolling, Phase 2b HIGH); `xmom` params validation
  (Amendment 2); shared-slot competition policy (D5); and the recording seam (D5 option A).

### Phase 1 — Serial: `bot-shared-maintainer` (contracts first)
Shared package only. Engine/dashboard waves depend on these landing.

| File | Change | Why |
|------|--------|-----|
| `packages/shared/src/schema/momentumParamsSchema.ts` (new) | A **separate** Zod schema for the `xmom` row: `momentum_lookback_hours` (24), `momentum_hold_hours` (24), `momentum_top_n` (1), `momentum_universe_dvol_floor_usdt` (20000), `momentum_rebalance_cadence_hours` (24), `momentum_stop_atr_multiplier` (disaster-stop, D7), plus the shared keys the gate still needs (`idiosyncrasy_min_score`, `atr_period`). **Do NOT** bolt momentum keys onto the VWAP `strategyParamsSchema` — it is `.strict()` with the full VWAP key set *required*, so an `xmom`-only row cannot validate against it and seeding a dummy VWAP param set is wasteful/confusing. `PortfolioStrategyRegistry` validates against this schema; `StrategyRegistry` + the VWAP schema stay untouched | Params shape for the `xmom` `strategy_versions` row; mirrors EXP-011 operating point. ADR 0047 documents which keys are strategy vs risk-only. **Note (logic review, HIGH):** `idiosyncrasy_min_score` + `atr_period` are NOT the full set the gate reads — `evaluateEntry` also reads `require_oi_available`, `funding_rate_suppress_threshold`, `oi_rising_skip`, `max_trades_per_symbol_per_day`, `max_trades_per_bar_universe`, `time_stop_minutes`. The orchestrator must construct a complete `IStrategyParams` for the gate context (these are risk-only, not validated strategy params); ADR 0047/0048 enumerates the full set (see D7 per-leg snapshot bullet) |
| `packages/shared/src/enum/SignalTypeEnum.ts` / `SkipReasonEnum.ts` | Add `CROSS_SECTIONAL_MOMENTUM` signal type; momentum-specific skip reasons (`NOT_TOP_RANKED`, `BELOW_DVOL_FLOOR`) | Decision-row vocabulary for momentum |
| `packages/shared/src/interface/` (new) | `IRankedSymbol` (symbol, trailingReturn, coinTier, dvol — decimal-as-string for money fields), `IPortfolioSelection` DTO if it must cross the package boundary for shadow recording | Cross-package decision/snapshot shape |
| `packages/shared/src/index.ts` barrel | Export the new symbols | — |

Note for maintainer: `IPortfolioStrategy` / `IPortfolioInput` are **engine-internal** (live in
`apps/engine/src/strategy/interface/`), NOT shared — only the persisted DTOs that cross to
analysis/dashboard are shared. Decide per-field whether it crosses; default to engine-internal.

### Phase 2 — Parallel: `bot-engine-nestjs` (+ `bot-dashboard-react` if a momentum view is in scope)

Engine work, split into reviewable sub-tasks (each ≤5 files):

**2a — Pure core + contracts (no I/O):**
| File | Change |
|------|--------|
| `apps/engine/src/strategy/interface/IPortfolioStrategy.ts` (new) | The D1 contract |
| `apps/engine/src/strategy/interface/IPortfolioInput.ts` + `IPortfolioSelection.ts` (new) | Pure input/output DTOs |
| `apps/engine/src/strategy/strategies/crossSectionalMomentumCore.ts` (new) | Pure ranking + selection: rank by trailing return desc, drop below dvol floor, take `top_n`, diff against held book → {open, close}. No `Date.now`/`Math.random`/I/O |
| `apps/engine/src/strategy/strategies/CrossSectionalMomentumStrategy.ts` (new) | `IPortfolioStrategy` impl delegating to the core (mirrors `V2MomentumStrategy` → `momentumCore` pattern) |
| `apps/engine/src/strategy/registry/PortfolioStrategyRegistry.ts` (new) | Parallel registry resolving `xmom:version` → impl + validated params (mirrors `StrategyRegistry`) |

**2b — Snapshot builder + scheduler (I/O lives here):**
| File | Change |
|------|--------|
| `apps/engine/src/strategy/service/RebalanceSchedulerService.ts` (new) | `@Cron`/`@Interval` on the configured cadence; emits `UNIVERSE_REBALANCE_DUE_EVENT{nowMs}`. Boot-race guarded like `ReconciliationService.scheduledTick` |
| `apps/engine/src/strategy/service/UniverseRankingService.ts` (new) | Reads `candles` (trailing 24h close-to-close per universe symbol via `CandleRepository`), filters to `universe_membership` (point-in-time) + dvol floor + `instruments.coin_tier`; builds `IRankedSymbol[]`. **dvol floor = static per-symbol `percentile_cont(0.5)` of 5m dollar-volume (`median(close × volume)`)** over a **fixed multi-day window** (NOT a trailing-24h rolling median). **Correction (quant review, HIGH):** the offline `xmom_decile_study.sql` `liquidity` CTE computes the median over the **entire history per symbol** (a *static* admit/drop gate, lines 43-49) — a trailing-24h rolling median is a *different statistic* that admits/drops different symbols each rebalance, making the live universe ≠ the validated universe. ADR 0048 must pin which computation is canonical: either (a) a static per-symbol median over a window matching the study's semantics, or (b) re-run EXP-011/012 with a rolling-24h floor in the offline script and adopt that. Default to (a) for soak comparability. **Survivorship note:** the live path additionally applies point-in-time `universe_membership` + `coin_tier` filters the study did not, so the live universe will differ from the EXP-011/012 panel — a PnL delta vs the study is *expected* and is not a regression. Symbols with `< N` bars of coverage are excluded (ties to the QA "missing candle history" case). **Reads only fully-closed bars** (`openTime ≤ nowMs − CANDLE_INTERVAL_MS`) so live and backtest select identically (OQ12). Prices decimal; rank statistic number (D6) |
| `apps/engine/src/strategy/const/momentumConsts.ts` (new) | `UNIVERSE_REBALANCE_DUE_EVENT`, cadence default, event-id prefix, min-bar-coverage threshold |
| `apps/engine/src/market-data/repository/CandleRepository.ts` | Add a **batch** trailing-window read across many symbols (one query or a bounded parallel batch — NOT N sequential `findRange` calls; specify for soak latency in ADR 0048) |

**2c — Orchestrator (routes legs through the existing gate):**
| File | Change |
|------|--------|
| `apps/engine/src/strategy/service/MomentumOrchestratorService.ts` (new) | `@OnEvent(UNIVERSE_REBALANCE_DUE_EVENT)`: load held momentum book → build `IPortfolioInput` → `core.selectPortfolio` → **if the new winner == current holding, hold through (no churn); otherwise close the incumbent** (OQ10 — the close→fill→slot-release seam is async, so a same-tick open of a different challenger will gate-reject `MAX_POSITIONS_REACHED`; for `top_n=1` accept a 1-rebalance re-entry gap rather than a 2-slot transient). Orchestrator is **idempotent per rebalance boundary** (key on the UTC boundary ts) so a mid-rebalance restart cannot double-open (OQ12). **The gate's in-memory reservation id `${eventId}:${slot}` (RiskGateService.ts:1314) does NOT survive a restart** — a re-fired event for the same boundary would re-open. ADR 0048 must specify a **DB-level unique constraint** on the rebalance boundary / momentum `eventId` (e.g. on a decision or reservation row) so idempotency is durable, not memory-only; for each CLOSE emit a flatten through the gate (reuse `ReconciliationService.buildCloseIntent` / de-risk pattern); for each OPEN build `IOrderIntent` (with D7 exit geometry) + `riskGate.evaluate` + persist decision + emit `ORDER_INTENT_APPROVED_EVENT` (reuse `StrategyService.gateAndPersist` shape). **Recording seam (D-decision, ADR 0048):** option **(A)** — PAPER execution writes real `decisions` + `positions` rows under `strategy_version_id=xmom`, partitioned by version for analysis; **no** new shadow orchestrator (the existing `ShadowStrategyOrchestratorService` is `IStrategy`/volatility-event only and does not fit). Recommended. Rename the "shadow-decision recording" deliverable to "version-partitioned PAPER soak." `midAtTrigger` source for IOC limit math = the rebalance reference close/mark (ADR 0005 §2); momentum `eventId` uses a dedicated prefix in `momentumConsts` distinct from the VWAP eventId space for idempotency |
| `apps/engine/src/strategy/StrategyModule.ts` | Register the new providers; do not touch existing wiring |
| `apps/engine/src/config/service/AppConfigService.ts` | Add `activePortfolioStrategyVersionId` (nullable) + cadence read |
| `apps/engine/src/paper-mode/...` | Verify momentum legs flow through `StreamingFillAdapter` taker path (M24); momentum opens are `MARKETABLE_LIMIT_IOC`, closes `REDUCE_MARKET` — already supported. Add wiring only if a gap surfaces. **Confirm + document** the executor tolerates an absent `geometryParams` / `entrySnapshot` on a momentum intent with `tpRebaseEligible=false` (momentum holds are not single-bar TP-rebased); ADR 0048 records the confirmation |

**2d — Seed row + migration boundary (engine agent writes the SQL seed/migration, not the architect):**
- New `strategy_versions` row: `name='xmom'`, `version=1`, `direction='momentum'`,
  `status='draft'`, params = EXP-011 operating point (`top_n=1`, lookback/hold 24h, $20k floor).
- No schema migration expected (reuses `positions`/`decisions`/`transactions`); confirm
  `positions.strategy_version_id` partitions momentum trades cleanly for analysis.

### Phase 3 — Serial: `bot-qa-engineer`
Adversarial + boundary tests (paired per fix item):
- Core purity: identical input → identical selection; no wall-clock leak.
- Ranking boundaries: empty universe, single symbol, all-below-dvol-floor, ties (deterministic
  tiebreak by symbol), missing candle history (symbol excluded, not crash).
- Orchestrator: gate REJECT on a selected leg is recorded + skipped (no order); flatten-and-
  re-rank holds the right book across two rebalances; halt flag suppresses opens but permits
  closes (ADR 0046).
- Exit geometry (D7): every OPEN intent carries a valid `proposedExit` (time stop at
  `nowMs + hold_hours`, ATR disaster stop, TP policy) that passes the gate's R:R / liquidation /
  wrong-side checks.
- Hold-through (OQ10): when the new top-ranked winner equals the current holding, the orchestrator
  opens/closes nothing; a different winner closes the incumbent and re-enters per the gap policy.
- Halt behaviour: a rebalance during halt closes incumbents (de-risk, permitted) but opens nothing,
  so the momentum book goes flat and stays flat until halt clears + next rebalance (expected,
  conservative).
- Rebalance idempotency (OQ12): a replayed `UNIVERSE_REBALANCE_DUE_EVENT` for the same boundary opens
  no duplicate position.
- Fixed-fractional sizing (D8): qty/notional comes from the momentum sizing path, not the ATR-risk
  sizer; a wide disaster stop does not shrink the position below min-notional.
- Slot competition (D5): with VWAP already holding A/B/C, a momentum rebalance gate-rejects
  `MAX_POSITIONS_REACHED`, opens nothing, and does NOT violate `assertSlotAccountingInvariant`.
- Flatten-then-open ordering (Amendment 7): when the top-ranked symbol changes, the incumbent
  closes before the challenger opens — never transient 2-slot momentum occupancy at `top_n=1`.
- Partial / failed flatten (Amendment 7): a CLOSE that fills partially or is lost does not leave a
  stale momentum slot or a phantom DB row; the next reconciliation/rebalance reconverges the book.
- Cross-strategy netting collision (D5): a momentum OPEN on a `(symbol, side)` already held by VWAP
  is gate-rejected and opens nothing (no netted-row `QTY_MISMATCH` mis-fire).
- Determinism: same `nowMs` + same candle fixture → same intents.
- PAPER soak smoke: rebalance fires, a leg opens, reconciliation tracks it, 24h time-stop /
  next-rebalance flatten closes it with non-null PnL.

### Phase 4 — Parallel reviewers
`bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`.
Quant reviewer specifically checks: no live-capital path enabled; cost assumptions match EXP-012
(≥75 bps round-trip/leg, not the 10 bps stub); single-regime caveat documented; selection matches
the EXP-011 24h/24h operating point; the long-only proxy is benchmarked against an unconditional
forward baseline so beta is not mistaken for momentum edge (OQ11); the disaster stop is wide enough
not to alter the validated close-to-close distribution (D7); momentum sizing is fixed-fractional, not
ATR-risk (D8). Security reviewer greps for any path that promotes `xmom` to
`active` / enables `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` execution on LIVE `EXCHANGE_ENV` — there
must be none until the M50c promotion gate (down-regime + post-cost significance). Cycle until zero
blockers, zero highs, majority of mediums.

### Phase 5 — Serial: `bot-scribe`
Close-out: `STATUS.md`, `milestone-log.md`, work-log, hypothesis-registry cross-link (EXP-011/012
→ M50), `tech-debt.md` for deferred items. Single writer.

## Risk-gate compliance checklist

- [ ] Every momentum leg (open AND close) routes through `RiskGateService.evaluate` — no direct
      `CcxtExecutionClient` / order-API call anywhere in the momentum path.
- [ ] Momentum sizing is **fixed-fractional notional** (D8, decimal), routed through the gate so all
      exposure caps still bind; it does NOT reuse the ATR-stop risk-sizer (a wide D7 stop would
      under-size / breach min-notional). Ranking floats never reach sizing.
- [ ] Per-coin (`MAX_EXPOSURE_PER_COIN_USDT`) and same-direction (`MAX_SAME_DIRECTION_EXPOSURE_USDT`)
      caps apply per leg via the gate context, unchanged.
- [ ] Single-slot proxy stays within `MAX_OPEN_POSITIONS = 3`; the slot-accounting invariant
      (`ReconciliationService.assertSlotAccountingInvariant`) still holds with a momentum leg open.
- [ ] All money (`entryPrice`, `notional`, `qty`, PnL) is `decimal`; trailing-return rank is the
      only `number` and is never persisted as money (D6).
- [ ] Strategy core is pure/deterministic: no `Date.now()`, no `Math.random()`, no I/O — `nowMs`
      injected from the scheduler boundary.
- [ ] No LLM anywhere in the rebalance loop.
- [ ] Halt flag (`HaltFlagService`) suppresses momentum opens; risk-reducing flattens still permitted
      (ADR 0046). **Mechanism (ADR 0048):** the orchestrator **pre-checks `HaltFlagService` before
      building OPEN intents** (preferred over relying on executor TTL expiry), so a halted rebalance
      closes incumbents and opens nothing. Note the day-halt budget is shared with VWAP (D5).
- [ ] PAPER/shadow only — no env path enables LIVE momentum capital this milestone.

## Reconciliation & paper-mode compatibility

- **Reconciliation needs no change for multi-position.** `ReconciliationService.runPass` already
  iterates `dbPositions` × `exchangePositions` per `(symbol, side)` key and classifies each
  independently (cases a–f). N concurrent momentum positions are N independent rows; the slot
  invariant and per-row finalize already handle them. Confirm only: momentum rows carry a distinct
  `strategy_version_id` and (deferred) slot namespace so the M34 invariant counts them correctly.
- **PAPER mode** runs the rebalance against live market data with simulated fills
  (`StreamingFillAdapter`, M24 taker path) and simulated account state (`PaperAccountStateSource`).
  Live-exchange reconciliation is a no-op under PAPER today (`R2d PaperReconciliationAdapter`
  deferred) — momentum positions are tracked via the DB rows + the simulator projection, which is
  sufficient for the soak. **Funding is a required soak component, NOT deferrable tech-debt (quant
  review, HIGH).** Hot trailing winners (+22.6%) routinely carry elevated positive funding and longs
  pay; ~3 funding intervals per 24h hold at 0.05–0.15%/8h = 15–45 bps/period — the same order of
  magnitude as slippage. A funding-blind soak PnL CANNOT resolve OQ3 and would promote on the same
  overstated edge EXP-012 warned about. Either the paper simulator models funding on the 24h hold, or
  the soak PnL is explicitly flagged **funding-blind** and MUST be funding-adjusted before any
  promotion read (OQ1 condition (d)).

## Open questions / deferred items

1. **Live promotion gate (BLOCKER on any live capital).** EXP-012 post-cost t=1.83 (long-short) /
   1.49 (long-only single-slot) on one 31-day up-regime is below the registry's decision bar.
   This milestone deliberately stops at PAPER/shadow. Owner: future analysis + M50c. **All FOUR
   conditions are HARD gates (every one must pass), stated numerically:**
   - **(a) Sample size:** ≥30 non-overlapping observation periods (current sample is 26, below grade).
   - **(b) Significance on the deployed series:** t≥2 on the **long-only single-slot** series — the
     mode M50 actually deploys (current t=1.49). The long-short t=1.83 is the WRONG statistic and does
     NOT count toward this gate.
   - **(c) Beta-baseline pass (OQ11, promoted from analysis note to hard gate):** the long-only proxy
     must out-return an unconditional baseline (random-long / equal-weight-universe forward return over
     identical windows). D10 gross +4.11%/24h vs soak beta drift ~+2.15%/24h means beta could erase the
     momentum alpha; if the proxy does not beat the baseline, there is no edge, only beta, and promotion
     fails regardless of t-stat.
   - **(d) Funding-inclusive PnL:** significance must hold on PnL that *models the 24h-hold funding
     cost* (OQ3), not the funding-blind soak number.
   plus all four holding across ≥1 *down* regime + multi-window confirmation.
2. **M50b — multi-position basket.** Per-strategy cap + total-notional cap + separate slot
   namespace (D4). Dollar-neutral N-long/N-short, short-leg borrow/availability cost (EXP-012:
   D1 short is the highest-friction leg, ~79 bps + un-modeled borrow). Deferred until the single-slot
   proxy confirms the signal survives in paper.
3. **Funding overlay (EXP-011 §3 optional) + funding cost modeling (HIGH).** Avoid longing a coin you
   pay to hold; funding on the 24h hold is a real cost not modeled in EXP-012's upper bound. The
   *overlay* (an entry filter) is an optional offline-testable deferral, but *modeling* funding in the
   soak PnL is NOT optional — it is a required soak component / hard promotion-gate input (see the
   Reconciliation section and OQ1 condition (d)).
4. **Short-cover OI overlay (EXP-014).** "Don't long a rally on falling OI" — the most
   statistically robust bake-off signal (price↑ on OI↓ → −0.21%/1h, t=−10.3), too small to trade
   standalone but a sound *gate* on a momentum long. Candidate filter, deferred.
5. **Market-internal attention proxy (brainstorm wild card).** OI-acceleration + funding surge +
   volume spike as a deterministic momentum *accelerant* tilt (the social-feed version violates the
   determinism invariant and is out of scope). Offline-testable on existing data; deferred.
6. **Fast-mover slippage / IOC missed fills.** EXP-012's +4.46% is an UPPER bound — tier-floor
   slippage understates fills on +22% trailing winners, and IOC misses are un-modeled. Paper soak
   will surface the real drag; do not assume the upper bound is realizable.
7. **In-engine portfolio backtest harness.** Deferred; offline scripts
   (`scripts/research/cross-sectional-momentum/`, `phaseB_fill_sim.mjs`) remain the validation
   tooling for monthly re-runs.
8. **Rebalance UTC anchor + missed-tick recovery — must be LOCKED in ADR 0048 before code, not left
   open through implementation.** Recommended default: a fixed UTC hour (e.g. 00:00 UTC daily) aligned
   with EXP-011's non-overlapping 24h windows; on boot mid-hold, **wait for the next boundary** (do not
   immediate re-rank) to avoid drift-driven churn — but test both the wait and the re-rank-once paths.
   Boot-race guard mirrors `ReconciliationService.scheduledTick`.
9. **Momentum-crash drawdown management.** Fat-left-tail risk on a violent regime reversal
   (brainstorm §1.5). Needs a portfolio-level drawdown rule before live capital — design in M50b.
10. **Atomic-rebalance fidelity gap (logic review, HIGH).** EXP-011/012 assume an *atomic* rebalance
    — close the old holding and open the new winner at the same boundary price. The engine cannot:
    a close emits → executor → fill → `CLOSED` → slot release is async, so a same-tick "close incumbent
    then open challenger" will see the slot still occupied and gate-reject the open
    (`MAX_POSITIONS_REACHED`). For `top_n=1` on the shared slot pool this means either (a) the
    challenger opens a tick late (24h flat gap = half the time out of market, material drag), or (b) a
    dedicated momentum slot reservation is held across the close→open seam. Recommended for M50: if the
    new winner == current holding, **hold through** (no churn); only when it differs do you close — and
    accept the validated panel slightly overstates realizable edge by the rebalance-latency drag. Lock
    the policy in ADR 0048; this is a real fidelity caveat for soak interpretation, not just an impl
    detail.
11. **Long-only proxy conflates momentum edge with market beta (quant review, HIGH).** EXP-015 warns
    the soak month drifted +2.15%/24h; EXP-011's long-SHORT spread cancels that beta, but the M50
    long-only single-slot proxy does NOT — a chunk of its +3.42% is just "being long in an up-month,"
    not momentum edge. The PAPER soak MUST benchmark the proxy against an unconditional baseline
    (random-long / equal-weight-universe forward return over the same windows); if the top-ranked-long
    does not out-return the baseline, there is no momentum edge, only beta. **This benchmark is now a
    HARD promotion-gate condition (OQ1 (c)), not just a soak-analysis line item** — D10 gross
    +4.11%/24h vs ~+2.15%/24h beta drift means beta could erase the alpha before costs.
12. **Deterministic snapshot cutoff + rebalance idempotency (logic review).** The ranking must read
    only fully-closed bars with `openTime ≤ nowMs − CANDLE_INTERVAL_MS` (no partial/un-ingested bar)
    so backtest and live select identically. The orchestrator must be idempotent per rebalance
    boundary (key actions on the UTC boundary timestamp) so a process restart mid-rebalance cannot
    double-open. Specify both in ADR 0048.
13. **Post-loss cooldown soak-fidelity caveat (logic review).** `isCooldownActive` rejects same-symbol
    re-entry within `cooldownAfterLossMs` of a losing close. For the 24h cadence this is usually inert,
    but EXP-011/012 applied no cooldown — so a cooldown-blocked re-entry is a divergence from the
    validated path. Flag in soak interpretation; do not silently absorb a skipped re-entry as "no
    signal."

## Acceptance criteria

- [ ] ADRs 0047 + 0048 merged; ADR-0004 deferred note for D4 added; ADR README updated.
- [ ] VWAP path (v0–v3) unchanged — `IStrategy`, `StrategyService`, `evaluateTrigger`, and the
      `VOLATILITY_DETECTED_EVENT` flow have zero behavioral diff (verified by existing tests still
      green with no edits).
- [ ] `xmom:1` `strategy_versions` row seeded (`status='draft'`, params at the EXP-011 operating
      point); `PortfolioStrategyRegistry` resolves it.
- [ ] With `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` set in PAPER: the scheduler fires a rebalance, the
      core selects the top-ranked winner, the gate approves one leg, a position opens, reconciliation
      tracks it, and the next rebalance (or 24h time-stop) flattens it with a non-null realized PnL.
- [ ] With the env unset (default): momentum is fully inert — no scheduler, no decisions, no orders.
- [ ] Concurrent VWAP PAPER + momentum PAPER does not violate `assertSlotAccountingInvariant`; slot
      competition gate-rejects are observable and counted (D5).
- [ ] No code path promotes `xmom` to `active` or enables LIVE momentum execution
      (`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` on LIVE `EXCHANGE_ENV`) — security-reviewer confirmed.
- [ ] All risk-gate compliance checkboxes satisfied; reviewer-confirmed no live-capital path.
- [ ] Core is pure/deterministic (test: identical fixture → identical selection across runs).
- [ ] Tests: core boundaries + orchestrator gate-reject/halt/flatten + determinism + PAPER soak smoke.
- [ ] Zero blockers, zero highs, majority of mediums resolved across review rounds.
- [ ] 10-minute live-app PAPER smoke run clean (per the milestone live-app-smoke rule) before scribe.
