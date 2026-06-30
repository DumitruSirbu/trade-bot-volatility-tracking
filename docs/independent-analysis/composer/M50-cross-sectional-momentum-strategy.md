# Independent Review — M50 Cross-Sectional Momentum Strategy

**Plan reviewed:** `docs/plans/M50-cross-sectional-momentum-strategy.md`  
**Codebase snapshot:** 2026-06-30 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M50 is **well-framed for a conservative, evidence-honest milestone**: it treats EXP-011/012 as **INCONCLUSIVE**, limits delivery to **PAPER + shadow infrastructure**, and correctly positions the engine work as a **soak prerequisite** rather than a live promotion. The parallel `IPortfolioStrategy` contract, scheduled rebalance boundary, and leg-routing through the existing risk gate are architecturally sound and consistent with locked invariants (central gate, deterministic cores, decimal money, no LLM in loop).

The plan is **not yet implementation-ready**. Several gaps would block a clean engine wave without ADR amendments: **exit geometry for momentum opens is unspecified** (the gate requires `proposedExit` with SL/TP/time-stop and M47 R:R checks), **`strategyParamsSchema` cannot validate an `xmom` row** without either a separate schema or dummy VWAP keys, and **D5 contradicts D4** on disjoint slot namespaces while M50 still claims concurrent VWAP + momentum without collision.

**Assessment:** **Approve with amendments** — proceed to Phase 0 (ADRs) after resolving six items below. Quant reviewer should lead (cost/significance bar, single-regime caveat); architect must own D1–D4 + exit-geometry before `bot-shared-maintainer` lands.

| Area | Grade | Assessment |
|------|-------|------------|
| Evidence humility / scope honesty | A+ | INCONCLUSIVE status, no live capital, EXP-012 upper-bound caveats called out. |
| `IPortfolioStrategy` parallel contract (D1) | A | Correct OCP split from `IStrategy`; purity/determinism mirrors ADR 0003. |
| Rebalance scheduler boundary (D2) | A- | Pattern matches `ReconciliationService.scheduledTick`; **UTC anchor + boot recovery (OQ 8) must be locked in ADR 0048 before code**. |
| Risk-gate leg routing (D3) | B+ | Correct intent; **exit geometry + `IOrderIntent` assembly unspecified**. |
| Slot / concurrency model (D4/D5) | C+ | **Internal contradiction** — D5 claims disjoint namespaces; D4 defers that to M50b. |
| Params / schema (Phase 1) | C | Optional momentum keys on VWAP `baseSchema` do not solve `xmom` row validation. |
| Shadow / counterfactual recording | B- | Deliverable stated; **no seam specified** (existing shadow path is `IStrategy` + volatility-event only). |
| Reconciliation / PAPER compatibility | A- | Per-`(symbol, side)` reconciliation confirmed; funding-boundary gap noted. |
| Phase breakdown / dispatch | A- | Waves align with `CLAUDE.md` + `dev-qa-cycle.md`; engine sub-tasks are sensibly ≤5 files. |
| Test matrix (Phase 3) | A- | Strong adversarial bar; add exit-geometry + slot-competition cases. |
| Open questions / deferred items | A | Live promotion gate, IOC misses, funding overlay, crash drawdown — appropriately deferred. |

**Bottom line:** **Yes, pursue M50** — but only after pinning exit geometry, params schema, slot-competition policy, and shadow seam in ADRs 0047/0048. Do not dispatch engine work until those are written; the evidence does not justify live capital and the plan correctly says so.

---

## Verified Current State

### Single-symbol `IStrategy` cannot express portfolio ranking (confirmed)

```10:15:apps/engine/src/strategy/interface/IStrategy.ts
export interface IStrategy {
    readonly name: string; // matches strategy_versions.name
    readonly version: number; // matches strategy_versions.version
    readonly direction: StrategyDirectionEnum;
    evaluate(input: IStrategyInput): ISignal;
}
```

The plan’s D1 rationale is correct: cross-sectional momentum is snapshot-shaped (universe → ranked selection), not event-per-symbol shaped.

### Risk gate requires full `IOrderIntent` including `proposedExit` (gap in plan)

```36:38:apps/engine/src/risk/interface/IOrderIntent.ts
    readonly proposedExit: IProposedExit; // strategy SL/TP/time-stop (ADR 0003 §3)
    readonly openPosition: IOpenPositionState | null; // for add/reduce/close; null for open
    readonly sizing: IIntentSizing; // §8 concrete decimal sizing
```

`IProposedExit` mandates `takeProfitPrice`, `stopLossPrice`, `timeStopAtMs`, `stopType`, `tpRebaseEligible`, and `atrDistance`. `PositionSizer.size` uses `stopLossPrice` for notional. Post-M47, `RiskGateService.isRewardRiskTooLow` enforces a minimum R:R against `referencePrice`.

The plan specifies `momentum_hold_hours` (24h) and flatten-on-rebalance but **does not define SL/TP geometry** for the hold window. This is not a minor omission — `MomentumOrchestratorService` cannot call `riskGate.evaluate` without it.

### `strategyParamsSchema` is VWAP-complete and `.strict()` (xmom row blocker)

```13:71:packages/shared/src/schema/strategyParamsSchema.ts
const baseSchema = z
    .object({
        // Base params (shared by all versions)
        vwap_window_bars: z.number().min(1),
        vwap_sigma_trigger: z.number().positive(),
        // ... all VWAP/risk keys required ...
    })
    .strict();
```

`StrategyRegistry` validates every row against this schema (`StrategyRegistry.ts:48`). Adding optional `momentum_*` keys lets v0–v3 rows still parse, but an `xmom` row with **only** momentum params will **fail** validation unless it also carries the full VWAP param set (wasteful, confusing) or `PortfolioStrategyRegistry` uses a **separate** `portfolioStrategyParamsSchema` / `momentumParamsSchema`.

### Slot model is global A/B/C — no per-strategy namespace today (D5 overclaim)

```14:16:apps/engine/src/risk/service/SlotManager.ts
// Deterministic 3-slot assignment (ADR 0004 §4). A/B are idiosyncratic-only (max 2); C holds
// at most one BTC-correlated position but is available to an idiosyncratic trade when no
// correlated position is open. Pure: it reads the occupied-slot set the gate passes in.
```

```63:67:apps/engine/src/risk/const/riskConsts.ts
// Architectural max concurrent open positions = the 3 slots A/B/C (ADR 0004 §4, locked). NOT a
// tunable knob — widening it is a correlation-budget redesign (new ADR), not a parameter change
export const MAX_OPEN_POSITIONS = 3;
```

D4 correctly defers **separate momentum slot namespace** to M50b. D5 states “No collision because they occupy disjoint slot namespaces” — **false for M50**. With `top_n = 1`, momentum and VWAP **share** the same three slots and the same `MAX_OPEN_POSITIONS` / same-direction exposure caps. Concurrent PAPER soak is possible but **not collision-free**; momentum rebalances can be gate-rejected when VWAP fills A/B/C.

### Existing shadow path is volatility-event / `IStrategy` only

`ShadowStrategyOrchestratorService` resolves `IStrategy` implementations and evaluates `IVolatilityDetectedEvent` triggers into `shadow_decisions` with a virtual ledger. There is **no** portfolio-rebalance shadow seam today. The plan’s “shadow-decision recording for counterfactual comparison” in `MomentumOrchestratorService` needs an explicit design: write to `decisions` (PAPER execution path) vs `shadow_decisions` (counterfactual) vs both.

### `CandleRepository` lacks multi-symbol trailing-window read (acknowledged in plan)

```24:28:apps/engine/src/market-data/repository/CandleRepository.ts
    async findRange(symbol: string, interval: string, fromOpenTime: Date, toOpenTime: Date): Promise<CandleEntity[]> {
        return this.repository.find({
            where: { symbol, interval, openTime: Between(fromOpenTime, toOpenTime) },
            order: { openTime: 'ASC' },
        });
    }
```

Phase 2b correctly calls for a batch read method. Ranking 100+ symbols per rebalance should use a single query (or bounded parallel batch), not N sequential `findRange` calls — specify in ADR 0048 for soak latency.

### Reconciliation is per-`(symbol, side)` — plan claim holds

`ReconciliationService.assertSlotAccountingInvariant` counts **distinct slots** across all open DB rows + reservations (`MAX_OPEN_POSITIONS = 3`). Momentum rows with distinct `strategy_version_id` still participate in the **global** slot pool — another reason D5’s “disjoint namespaces” language must be corrected for M50.

---

## Strengths

1. **Evidence discipline.** The milestone summary explicitly cites EXP-011/012 as INCONCLUSIVE, documents post-cost t=1.83 / 1.49, single up-regime sample, and IOC/slippage upper-bound risk. This matches `docs/analysis/README.md` methodology and prevents premature live promotion.

2. **Correct conservative action.** Building PAPER/shadow infrastructure to accumulate multi-regime soak while **blocking live capital** is the right sequencing given the registry bar (≥30 obs, multi-window, decision-grade).

3. **OCP / additive architecture.** Parallel `IPortfolioStrategy`, separate `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID`, untouched VWAP path (`IStrategy`, `StrategyService`, `VOLATILITY_DETECTED_EVENT`) — minimizes regression risk to the production VWAP soak.

4. **Determinism boundary.** Scheduler as the sole `Date.now()` seam, `nowMs` injected downstream, ranking I/O in orchestrator not core — mirrors established patterns (`ReconciliationService`, `StuckPositionSweeper`).

5. **Single-slot long-only proxy first.** Aligns with EXP-012’s endorsed live path (+3.42%/period frictionless-adjusted, t=1.49) and avoids M50b basket/slot-redesign scope creep.

6. **D6 (rank float ≠ money).** Proactive reviewer guidance — trailing-return rank as `number`, notional/qty as `decimal` — prevents false positives on money-as-float audits.

7. **Risk-gate compliance checklist.** Comprehensive and maps to real code paths; halt-on-open / close-permitted (ADR 0046) included.

8. **Phase breakdown.** Shared-first wave, engine sub-tasks ≤5 files, paired adversarial QA, quant-led review — consistent with `dev-qa-cycle.md`.

9. **Open questions register.** Live promotion gate, funding overlay (EXP-011 §3), short-cover OI gate (EXP-014), fast-mover IOC misses, portfolio drawdown rule — all appropriately deferred with owners.

10. **Reconciliation / PAPER notes.** Honest about `PaperReconciliationAdapter` deferral and funding-boundary modeling gap.

---

## Risks & Amendments

### Amendment 1 — Define momentum exit geometry before engine work (BLOCKER)

Cross-sectional momentum holds for 24h with flatten-on-rebalance, but the engine **cannot open** without `proposedExit` and cannot size without a stop distance. The plan must specify in ADR 0048 (and `crossSectionalMomentumCore` or a sibling `buildMomentumHoldExit`):

- **Time stop:** `timeStopAtMs = nowMs + momentum_hold_hours × MS_PER_HOUR` (maps to `momentum_hold_hours`, not `time_stop_minutes` unless aliased).
- **Disaster stop:** e.g. ATR-multiple or fixed-% stop from entry — wide enough not to fire on normal 24h noise, tight enough for liquidation clamp to pass. Must satisfy M47 `min_rr` at signal reference or document an ADR exception for `direction='momentum'` portfolio holds.
- **Take profit:** very wide TP, rebalance-driven exit only, or explicit “no TP” policy — if “no TP,” gate `isWrongSideTakeProfit` / `isRewardRiskTooLow` behavior must be specified.
- **`flowType`:** new `FlowTypeEnum` value (e.g. `CROSS_SECTIONAL_MOMENTUM`) or mapped existing value for `orderPolicyMatrix` — momentum entries are taker (`MARKETABLE_LIMIT_IOC` per plan); matrix row must exist.
- **`signalScore` / `idiosyncrasyScore` / `correlationMode`:** orchestrator must source these for slot assignment (winners are often high-beta; slot C vs A/B matters).

Without this, Phase 2c is not implementable.

### Amendment 2 — Separate params schema for `xmom` (BLOCKER)

Do **not** seed `xmom:1` with a full copy of VWAP params. Recommended:

- Add `momentumParamsSchema` (or `portfolioStrategyParamsSchema`) in `packages/shared` with only momentum keys + shared keys the gate still needs (e.g. `idiosyncrasy_min_score` if referenced).
- `PortfolioStrategyRegistry` validates against the portfolio schema; `StrategyRegistry` keeps the VWAP schema unchanged.
- Document in ADR 0047 which params are strategy vs risk-only (`momentum_max_positions` correctly placed in D4 as risk config, not strategy params).

### Amendment 3 — Correct D5 slot-collision language (HIGH)

Replace “disjoint slot namespaces” for M50 with explicit policy:

| Mode | Slot behavior |
|------|----------------|
| **M50 (`top_n = 1`)** | Momentum and VWAP **share** A/B/C. Expected: momentum may be `MAX_POSITIONS_REACHED` when VWAP holds 3 slots; orchestrator records skip/reject, does not bypass gate. |
| **M50b** | Separate momentum namespace per D4. |

Add acceptance criterion: concurrent VWAP PAPER + momentum PAPER does not violate `assertSlotAccountingInvariant`; gate rejects are observable and counted.

Consider soak config guidance: run momentum PAPER with VWAP triggers relaxed or during low-VWAP-occupancy windows if clean attribution matters — or accept slot competition as part of the experiment.

### Amendment 4 — Shadow seam specification (MEDIUM)

Clarify what “shadow-decision recording” means:

- **(A — recommended for M50):** PAPER execution writes real `decisions` + `positions` with `strategy_version_id = xmom`; analysis partitions by version. No new shadow orchestrator.
- **(B):** Extend `ShadowStrategyOrchestratorService` with a portfolio hook — larger scope.
- **(C):** `MomentumOrchestratorService` writes `shadow_decisions` rows without execution — counterfactual only.

Pick one in ADR 0048. If (A), remove “shadow” from deliverables or rename to “version-partitioned PAPER soak.” If (C), specify `shadow_decisions` schema extensions for portfolio selection (rank snapshot JSON?).

### Amendment 5 — Lock rebalance UTC anchor + boot recovery in ADR 0048 (MEDIUM)

Open question 8 must not remain open through implementation. Specify:

- Fixed UTC hour (e.g. 00:00 UTC daily) aligned with EXP-011 non-overlapping 24h windows.
- On boot mid-hold: **do not** immediate re-rank (wait for next boundary) vs **do** re-rank once (recover drift) — pick one; test both paths.
- Boot-race guard mirroring `ReconciliationService.scheduledTick` (plan mentions this — good).

### Amendment 6 — `UniverseRankingService` dvol computation (MEDIUM)

EXP-011 uses **median 5m dollar-volume** over the lookback window, not a point-in-time snapshot. Plan names `momentum_universe_dvol_floor_usdt` ($20k) but Phase 2b should specify:

- Query pattern (aggregate over trailing 24h of 5m candles: `median(close × volume)` or equivalent).
- Minimum candle coverage (symbols with &lt; N bars excluded — ties to QA “missing candle history”).
- Alignment with offline script (`xmom_decile_study.sql`) so soak results are comparable to EXP-011/012.

### Amendment 7 — Flatten-then-open ordering on rebalance (LOW)

When the top-ranked symbol changes, orchestrator must **close the incumbent before opening the challenger** (or close-only this tick, open next) to avoid transient 2-slot momentum occupancy with `top_n = 1` and same-direction exposure cap breaches. Specify in ADR 0048 and add orchestrator test.

### Amendment 8 — `strategy_versions.status = 'draft'` + promotion path (LOW)

Seed row as `draft` is correct. Add runbook line: `PromotionGateService` / `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` must not enable LIVE execution without the M50c promotion gate (down-regime + post-cost significance). Security reviewer should grep for any path that promotes `xmom` to `active` on LIVE `EXCHANGE_ENV`.

---

## Minor Notes (no blockers)

- **`midAtTrigger` for momentum opens:** VWAP uses book mid at trigger; rebalance may use last close or live mark — specify source for IOC limit math (ADR 0005 §2).
- **`eventId` prefix:** Plan mentions event-id prefix in `momentumConsts` — ensure uniqueness vs VWAP `eventId` space for idempotency (`PaperFillSimulator`, execution dedup).
- **Dashboard scope:** Phase 2 lists dashboard “if in scope” — default **out of scope** for M50 unless a read-api partition by `strategy_version_id` already surfaces momentum decisions.
- **EXP-012 cost assumption in soak analysis:** When comparing paper results to EXP-012, use **≥75 bps round-trip/leg** (plan checklist) — not the 10 bps EXP-011 stub.
- **In-engine backtest deferral:** Correct; offline `phaseB_fill_sim.mjs` remains authoritative for monthly re-runs.

---

## Dispatch Recommendation

| Wave | Contents |
|------|----------|
| 0 (serial) | Architect: ADR **0047** (contract + params schema split), ADR **0048** (scheduler, exit geometry, orchestrator, shadow seam, UTC anchor, flatten ordering). ADR-0004 deferred note for D4. **Resolve Amendments 1, 2, 3, 4, 5 before any code.** |
| 1 (serial) | `bot-shared-maintainer`: momentum params schema, enums, cross-package DTOs (`IRankedSymbol`, etc.). |
| 2a (serial) | Engine pure core + `IPortfolioStrategy` (≤5 files). |
| 2b (serial) | `UniverseRankingService` + `RebalanceSchedulerService` + `CandleRepository` batch read. |
| 2c (serial) | `MomentumOrchestratorService` + config + module wiring + seed migration. |
| 3 (serial) | `bot-qa-engineer`: purity, ranking boundaries, gate-reject/halt, slot competition, flatten ordering, PAPER smoke. |
| 4 (parallel) | Reviewers — **quant lead** (no live path; cost bar; single-regime caveat). |
| 5 (serial) | `bot-scribe`: STATUS, milestone-log, hypothesis-registry cross-link, tech-debt for M50b/M50c. |

**Do not enable LIVE momentum capital.** `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` in PAPER only for soak.

---

## Summary

M50 is the **right milestone at the right conservatism level**: infrastructure + PAPER soak for a promising but **not decision-grade** signal. The parallel portfolio contract, scheduled rebalance, and unchanged risk gate are sound.

**Block dispatch of engine work** until ADRs pin **exit geometry**, **`xmom` params validation**, **shared-slot competition policy** (D5 language fix), and **shadow/PAPER recording seam**. With those amendments, the plan is implementable and aligns with EXP-011/012 evidence without over-committing live capital.
