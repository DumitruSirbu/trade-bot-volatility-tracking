# Independent Review — M26 Shadow Counterfactual Fill Wiring

**Plan reviewed:** `docs/plans/M26-shadow-counterfactual-fill-wiring.md`  
**Codebase snapshot:** 2026-06-08 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M26 correctly diagnoses why **100% of shadow fills are missed** and the virtual ledger stays empty: `simulateShadowFill` passes `ticks: []` and collapses `barHigh`/`barLow` to `entryPrice`, while the shared `missedFillDetector` returns **miss on empty ticks** for `MARKETABLE_LIMIT_IOC`. The stale comment claiming a “bar-extreme fallback” is **wrong** (same class of bug as M24’s stale “limit-vs-mark fallback” comment). The plan’s rejection of “only fix bar high/low” is **code-verified** — the detector inspects `ticks`, not bar geometry.

**Design A (DB load in orchestrator)** is the right default: mirror M7’s `tick_aggregates` window query, no `packages/shared/` change, parallel with M24/M25. Amend implementation to **avoid injecting `CandleLoader` from `BacktestModule`** (circular import with `StrategyModule`), **load ticks once per live event** (not once per shadow version), and **resolve missing-tick tagging** — `ISimulatedFill` has no `missedReason` field today. Reframe plan item 2 / QA “bar geometry touch test”: for **opens**, bar extremes do not drive `isMissedFill`; derive them from ticks for snapshot consistency only.

**Assessment:** **Approve with amendments** — ship as migration-free, engine-only, read-only against `tick_aggregates`. Lock injection via `TickAggregateRepository` (or a thin `loadTicksForBar` on `MarketDataModule`). Quant should scope “same-tape parity” to **tick source identity**, not identical fill price vs M7 (shadow entry uses `reconstructReferencePrice` at signal bar; backtest may differ on timing). Note **forward-only ledger population** — historical `shadow_decisions` rows stay `missed: true` until an explicit backfill/replay (out of scope but affects M11b on full soak window).

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A+ | Empty ticks + IOC policy + `tryOpen` gated on `!missed` verified; WIP “minimal high/low fix” correctly rejected. |
| Design A vs B | A | DB load mirrors M7; avoids shared event shape change. |
| Scope / boundaries | A | No shared core change; `lowFidelity` preserved; independent of M24/M25. |
| Loader / DI plan | B- | “Reuse M7 loader” conflicts with `BacktestModule` ↔ `StrategyModule` cycle; use `MarketDataModule` repo. |
| Plan item 2 (bar extremes) | C+ | Misleading for open miss-detector; ticks-only for `isMissedFill`; bar fields cosmetic until intrabar stop enabled. |
| Missing-tick tagging (item 5) | C | Required by plan but no schema field; needs architect decision before QA can assert “tagged”. |
| Performance | B+ | Acceptable one SELECT/event; must cache ticks across shadow versions in `runShadows`. |
| Historical ledger / M11b | B- | `rebuildLedger` replays persisted `simulated_fill`; pre-M26 rows won’t populate virtual ledger on restart. |
| Test plan | B+ | Strong themes; amend parity test scope; add multi-shadow single-load test. |
| DB safety | A | Read-only SELECT; pg_dump ritual appropriate. |

**Bottom line:** **Yes, load `tick_aggregates` for `(symbol, entryCandleOpenTime)` and pass real ticks into `simulateShadowFill`.** **No, do not inject `CandleLoader` via `BacktestModule` without breaking the module graph.** **No, do not treat bar high/low alone as fixing the miss-detector.** Amend dispatch for **repo-based load**, **per-event tick cache**, **explicit missing-data tagging contract**, and **forward-only soak expectations**.

---

## Verified Current State

### Empty ticks guarantee a miss (unchanged shared contract)

```57:59:packages/shared/src/util/missedFillDetector.ts
    if (ticks.length === 0) {
        return true; // no ticks → cannot confirm fill → missed
    }
```

Shadow uses `SHADOW_FILL_DEFAULT_POLICY = 'marketable_limit_ioc'` (`OrderPolicyEnum.MARKETABLE_LIMIT_IOC`), so this path always fires today.

### Shadow orchestrator passes no evidence today

```308:325:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
        const fillRequest: IFillRequest = {
            // ...
            signalBarOpenMs: event.entryCandleOpenTime,
            barHigh: entryPrice,
            barLow: entryPrice,
            // Shadow path has no historical tick replay or live book snapshot —
            // empty inputs force the simulator's bar-extreme fallback (lowFidelity
            // = true), matching ADR 0029 §2.4 ...
            ticks: [],
            bookSnapshot: null,
```

There is **no** bar-extreme fallback in `isMissedFill` for opens. The comment is stale and should be replaced (plan item 3 — mandatory).

### Virtual ledger never opens on missed fills

```275:275:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
        if (openData !== null && !openData.simulatedFill.missed) {
```

Soak evidence (583 v2 + 216 v3 shadow opens, 100% `missed: true`) matches this gate.

### M7 already loads the same tick window

```53:63:apps/engine/src/backtest/service/CandleLoader.ts
    async loadTicksForBar(symbol: string, barOpenMs: number): Promise<TickAggregateEntity[]> {
        const fromDate = new Date(barOpenMs);
        const toDate = new Date(barOpenMs + CANDLE_5M_INTERVAL_MS);

        return this.tickAggregateRepository
            .createQueryBuilder('tick')
            .where('tick.symbol = :symbol', { symbol })
            .andWhere('tick.ts >= :fromDate', { fromDate })
            .andWhere('tick.ts < :toDate', { toDate })
            .orderBy('tick.ts', 'ASC')
            .getMany();
    }
```

`TickAggregateRepository.findRange(symbol, fromTs, toTs)` on `MarketDataModule` can express the same half-open `[barOpen, barOpen + 5m)` without importing `BacktestModule`.

### `CandleLoader` is not exported; `BacktestModule` imports `StrategyModule`

```34:40:apps/engine/src/backtest/BacktestModule.ts
@Module({
    imports: [
        // ...
        StrategyModule,
```

```27:32:apps/engine/src/strategy/StrategyModule.ts
@Module({
    imports: [
        // ...
        MarketDataModule,
```

Injecting `CandleLoader` into `ShadowStrategyOrchestratorService` via `BacktestModule` creates **`StrategyModule` → `BacktestModule` → `StrategyModule`**. Prefer `TickAggregateRepository` (already exported from `MarketDataModule`) or move `loadTicksForBar` to market-data as a shared helper **without** pulling the full backtest module.

### Open-fill path uses ticks only, not `barHigh`/`barLow`

`HistoricalFillAdapter.simulateFill` passes `tickSnapshots` into `sharedApplyFill`; `isMissedFill` evaluates tick touch against `limitPrice`. `barHigh`/`barLow` feed `buildSnapshotForFill` but do **not** substitute for ticks on the open miss check. Shadow config sets `enableIntrabarStopSimulation: false`, so bar extremes do not affect exit simulation either. Plan item 2 is **documentation/consistency**, not a second fix for the miss-detector.

### `ISimulatedFill` has no missed-reason / missing-data tag

```5:22:packages/shared/src/interface/ISimulatedFill.ts
export interface ISimulatedFill {
    // ...
    readonly missed: boolean;
    // ...
    readonly lowFidelity: boolean;
```

`lowFidelity` is already `true` for all shadow fills (including touch-misses). Plan item 5 cannot be satisfied by `lowFidelity` alone — analysis cannot distinguish **missed because no ticks** vs **missed because price never touched limit** without a new optional field, a documented JSONB convention, or downstream SQL joining `tick_aggregates` at query time.

### Cold-restart ledger rebuild replays persisted fills, not re-simulation

```479:481:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
            if (fill === null || !row.gateAllowed || row.action !== SignalActionEnum.OPEN || fill.missed) {
                continue;
            }
```

Pre-M26 `shadow_decisions` rows remain `missed: true` in the DB. After deploy, **new** events populate the ledger; **historical** soak rows do not unless backfilled. M11b on the full 14-day window may need a follow-up replay job (call out in architect/scribe wave).

### Entry-price proxy differs from full M7 backtest timing

Shadow uses `reconstructReferencePrice(event)` for `limitPrice` at the signal bar. M7 replay may advance bar timing and latency differently. “Same-tape parity” QA should assert **identical tick rows loaded for `(symbol, entryCandleOpenTime)`**, not bitwise-equal `entryPrice` vs a backtest run on the same `event_id`.

---

## Decision Critique

### Design A — **Correct (lock it)**

Engine-only SELECT on existing `tick_aggregates` is the minimal fix, matches architect P4, and avoids polluting `IVolatilityDetectedEvent`. Design B is only justified if M27 or other consumers need OHLC on the live event independently — not required for M26.

### Reject WIP “minimal high/low only” — **Plan is right**

`docs/wip/done/paper-soak-zero-trades-and-shadow-fill-gap.md` Tier C still lists “minimal fix: pass trigger bar high/low” as a first step. M26 correctly states that is **insufficient**. Implementation and docs should not resurrect that shortcut.

### Missing-tick conservative miss — **Correct, tagging underspecified**

Keeping `ticks: []` when DB returns no rows preserves ADR 0015 C6 conservatism. Fabricating a tick from candle OHLC would be a fidelity cheat (and still might not cross `limitPrice`). The open question is **how** to tag — recommend one of:

1. **Small shared addendum (preferred for queryability):** optional `missedReason?: 'missing_tick_data' | 'price_not_touched' | null` on `ISimulatedFill` + `simulatedFillSchema` — routed through `bot-shared-maintainer`, still not Design B.
2. **Analysis-layer only:** document SQL pattern `LEFT JOIN tick_aggregates … COUNT(*) = 0` when `missed = true` — no code change, weaker for dashboard/API.
3. **Do not** overload `slippageComponents.latency` with sentinel strings — breaks ADR 0029 §2.3.2 semantics.

Architect wave should pick (1) or (2) before QA writes “tagged” assertions.

### `lowFidelity: true` preservation — **Correct**

Unchanged depth model; M26 only supplies touch evidence. ADR 0029 amendment should say shadow **replays ticks** but remains **low-fidelity** until depth-aware extension.

---

## Must-Fix Before Implementation

1. **DI / module boundary:** Load ticks via `TickAggregateRepository` (or extract `loadTicksForBar` to `MarketDataModule`), **not** `CandleLoader` from `BacktestModule`, unless `forwardRef` + export refactor is explicitly architect-approved.
2. **Per-event tick cache:** In `runShadows`, load `(symbol, entryCandleOpenTime)` **once** and pass the same array into each shadow’s `simulateShadowFill` — avoid N identical queries for v2 + v3 (+ any future shadows).
3. **Missing-data tagging contract:** Lock how item 5 is represented in `simulated_fill` JSONB before QA dispatch; do not ship “tagged” tests against an undefined field.
4. **Replace stale comment** (plan item 3) — remove “bar-extreme fallback” language; state tick replay from `tick_aggregates` and conservative miss when absent.
5. **Amend QA item “Real bar geometry touch test”** to: ticks drive miss-detector; `barHigh`/`barLow` derived from tick min/max (or candle row) for snapshot consistency only.

---

## Should-Fix / Dispatch Adjustments

| # | Amendment | Rationale |
|---|-----------|-----------|
| 1 | Add `loadTicksForBar(symbol, barOpenMs)` to `TickAggregateRepository` mirroring `CandleLoader` query | Single source of truth; DRY with M7 without module cycle |
| 2 | Unit test: two shadows, one event → one DB load (mock call count = 1) | Prevents N× query regression |
| 3 | Quant review: scope same-tape parity to tick row equality; document entry-timing delta vs M7 | Avoid false failing parity test |
| 4 | Scribe/post-deploy: **forward-only** virtual ledger; historical `shadow_decisions` unchanged | Sets M11b expectations on soak window |
| 5 | Optional follow-up milestone: backfill/re-simulate historical shadow fills for soak window | Not blocking M26 ship |
| 6 | Log at `debug` when tick load returns `[]` with `eventId`, `symbol`, `barOpenMs` | Ops visibility for partition/WS gaps |
| 7 | Reference `M7FillGoldenTape` / `M7FillEquivalence.regression.spec.ts` patterns for crossing vs no-touch cases | Reuse proven fixtures |

---

## Test Matrix (Composer Additions)

Beyond the plan’s list:

| Case | Expected |
|------|----------|
| Ticks present, limit crossed (LONG ask touch) | `missed=false`, non-zero `entryPrice`, `tryOpen` success |
| Ticks present, never touch limit | `missed=true`, distinguishable from missing-data if tagging lands |
| No ticks in DB for bar | `missed=true`, conservative, tagged or join-detectable |
| Multiple shadow versions, one event | Single tick load |
| `enableIntrabarStopSimulation: false` unchanged | No accidental enablement |
| `rebuildLedger` with pre-M26 missed rows | Still skips; document forward-only behavior |
| Determinism | Same event + same tick rows → identical `ISimulatedFill` |

---

## Post-Deploy Expectations (Amended)

1. **pg_dump** before engine restart (2-deep retention) — as plan states.
2. **Smoke:** shadow orchestrator boots with `TickAggregateRepository` (or equivalent) injected.
3. **24–48h:** New `shadow_decisions` OPEN rows should show mix of `missed=false` (crossing + ticks present) and `missed=true` (no touch or no ticks) — **not** 100% missed.
4. **Do not expect** historical rows to flip `missed` without backfill; virtual ledger depth grows from deploy forward.
5. **Tick coverage gaps:** If `tick_aggregates` empty for many signal bars (WS outage, missing partition), miss rate stays high — investigate market-data persistence, not shadow logic.
6. **M11b:** Comparable counterfactual PnL becomes **possible** post-M26 for new data; full-window comparison may need replay follow-up.

---

## References Consulted

- Plan: `docs/plans/M26-shadow-counterfactual-fill-wiring.md`
- WIP analysis: `docs/wip/done/paper-soak-zero-trades-and-shadow-fill-gap.md` (Tier C — minimal fix superseded by M26)
- Related: `docs/independent-analysis/composer/M24-paper-open-fill-wiring-review.md` (same miss-detector root cause on live path)
- ADR 0029 (shadow pipeline), ADR 0015 §6 (conservative miss), M7 `CandleLoader.loadTicksForBar`

---

## Sign-Off

| Verdict | **Approve with amendments** |
|---------|------------------------------|
| Ship M26? | **Yes** — after DI/tagging amendments and architect lock on Design A |
| Blockers | Module cycle if using `CandleLoader`; undefined missing-tick tag |
| Parallel with M24/M25? | **Yes** — disjoint files and concerns |
