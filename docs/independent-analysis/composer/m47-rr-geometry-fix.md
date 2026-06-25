# Independent Review — M47 Risk:Reward Geometry Fix

**Plan reviewed:** `docs/plans/m47-rr-geometry-fix.md`  
**Codebase snapshot:** 2026-06-25 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M47 correctly identifies a **code-verified, production-soak structural defect**: SL and TP are anchored to independent references in both strategy cores, momentum applies a **single-leg fill rebase** that voids intent-time geometry, and the risk gate has **no `tp_dist / sl_dist` ratio check**. The live PnL autopsy (inverted R:R on most trades, time-stop dominance, loss concentrated in R:R &lt; 1.0) is consistent with the diagnosed mechanics — not merely a win-rate problem.

The plan’s fix direction is sound: **widen momentum TP / tighten mean-reversion SL** (never the reverse), **freeze momentum legs at signal time (Option B)**, add a **loose gate backstop**, version the params, bump strategy-version rows for clean pre/post partitioning, and close the MFE/MAE seed-timing gap. Scope honesty (geometry ≠ profitability; M48 owns signal-quality fixes) is excellent.

**Assessment:** **Approve with amendments** — dispatch after resolving five implementation details below. Quant reviewer should lead; architect must re-bless ADR 0003 / 0045 / 0004 before the engine wave. Treat Task 5a’s “before first await” wording as a **spec bug** until the insertion point is reconciled with `createPositionFromFill` being async.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis (Bugs 1 & 2) | A+ | Root cause traced to `momentumCore.ts`, `meanReversionCore.ts`, `ExecutionService.ts:1051`, gate gap at `RiskGateService.ts:465–477`. |
| Momentum coupling design (Task 2) | A | `rrFloor` in `max()` with cap + degenerate skip is the right asymmetry (VWAP stop sacred). |
| Mean-reversion coupling (Task 3) | A | Cap SL to `tpDist/min_rr` + ATR-relative floor + skip is correct; signature/DTO refactor prescribed. |
| Option B / Task 0 | A | Mandatory; Option A correctly rejected (pre-fill gate vs post-fill geometry). |
| Gate backstop (Task 4) | A- | Design correct; backtest anchor fix is real but may be simpler than a new shared field (see Amendments). |
| Live/backtest parity (BLOCKER 1) | B+ | Gap confirmed; `IOrderIntent` contract already defines `entryPrice` as signal reference — backtest violates it. |
| MFE/MAE seed fix (Task 5a) | B | Race diagnosis correct; **insertion-point text contradicts “before first await”** (see Amendments). |
| Data foundation (Tasks 5b/5c) | A- | Columns exist; version-ID partition is the right M48 enabler. |
| Migration / deploy sequencing | A | JSON-merge + non-rolling deploy + seeder overwrite warning verified. |
| Success metrics (Section 7) | B | Version-ID partition is right; **fill-anchored vs signal-anchored R:R** needs explicit definition. |
| Scope / dispatch | B+ | Large milestone (geometry + excursion + view); wave per `dev-qa-cycle.md` is mandatory. |
| Test matrix (Task 6) | A | Adversarial bar, ExecutionService-level 5a test, clamp-interaction correction (HIGH 3) are all appropriate. |

**Bottom line:** **Yes, implement M47.** This is the highest-leverage survival fix on the queue — it stops trades from being structurally shaped to lose before signal quality is evaluated. Lock the amendments below in the plan or runbook before Wave 1.

---

## Verified Current State

### Bug 1 — Uncoupled SL/TP anchors (confirmed)

**Momentum:** SL is session VWAP (spike-scaled distance); TP is ATR/cost-floor only — no coupling.

```56:75:apps/engine/src/strategy/strategies/momentumCore.ts
function buildMomentumExit(input: IStrategyInput, tradeSide: PositionSideEnum, nowMs: number) {
    const { event, params } = input;

    const referencePrice = reconstructReferencePrice(event);
    const atrTarget = resolveTakeProfitDistance(tradeSide, referencePrice, event.atr14, event.coinTier, params);
    const takeProfitPrice = tradeSide === PositionSideEnum.LONG ? referencePrice.plus(atrTarget) : referencePrice.minus(atrTarget);

    return {
        takeProfitPrice,
        // SL sits at VWAP — a structural price level, not an ATR-distance stop.
        stopLossPrice: new Money(event.vwapSession),
        // ...
        tpRebaseEligible: true,
        atrDistance: atrTarget,
    };
}
```

**Mean-reversion:** structural stop (wick + hard cap) and half-retrace TP are computed independently in `buildMeanReversionExit` — no `min_rr` coupling today.

### Bug 2 — Asymmetric fill rebase (confirmed)

Live executor rebases TP only when `tpRebaseEligible && atrDistance !== null`:

```1045:1053:apps/engine/src/execution/service/ExecutionService.ts
        const resolvedTakeProfitPrice: MoneyValue =
            event.clampedExit.tpRebaseEligible && event.clampedExit.atrDistance !== null
                ? rebaseMomentumTakeProfit(event.clampedExit, fillSummary.avgFillPrice, event.intent.tradeSide)
                : event.clampedExit.takeProfitPrice;
```

Backtest mirrors the same seam (`BacktestOrchestrator.ts:451–454`). SL is never rebased in either path. Plan’s rebase-path audit (only two consumers) is accurate.

### Risk gate has no R:R ratio check (confirmed)

After liquidation clamp, wrong-side TP, and cost floor — approval:

```465:479:apps/engine/src/risk/service/RiskGateService.ts
        const clampedExit = this.clampStopInsideLiquidation(intent);

        if (clampedExit === null) {
            return this.rejected(intent, RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        }

        if (this.isWrongSideTakeProfit(intent)) {
            return this.rejected(intent, RejectReasonEnum.TP_WRONG_SIDE);
        }

        if (this.isTakeProfitBelowCost(intent, context)) {
            return this.rejected(intent, RejectReasonEnum.TP_BELOW_COST);
        }

        return this.reserveAndApprove(intent, context, state, slot.slot, clampedExit, ledger);
```

`isTakeProfitBelowCost` compares `tp_dist` to round-trip **cost**, not to `sl_dist` — a trade with R:R = 0.4 can pass.

### Liquidation clamp only tightens SL (HIGH 3 correction validated)

```1121:1127:apps/engine/src/risk/service/RiskGateService.ts
        const stopDistance = intent.entryPrice.minus(intent.proposedExit.stopLossPrice).abs();

        if (stopDistance.lessThanOrEqualTo(safeDistance)) {
            return intent.proposedExit;
        }

        return this.tightenStop(intent, safeDistance);
```

Plan is correct to remove the impossible “clamp widens SL and inverts R:R” test and replace it with the two valid clamp-interaction cases.

### Live/backtest gate anchor mismatch (BLOCKER 1 — confirmed)

Live `StrategyService` sets `entryPrice = reconstructReferencePrice(event)` for sizing and gate (`StrategyService.ts:214`).

Backtest `BacktestOrchestrator` sets `entryPrice = ctx.nextBarOpen` (fill estimate) and also sets `midAtTrigger: entryPrice` (`BacktestOrchestrator.ts:274, 308–309`).

Meanwhile `IOrderIntent` documents `entryPrice` as the **bar-close reference for SL/TP distance math**, explicitly not the fill:

```19:27:apps/engine/src/risk/interface/IOrderIntent.ts
    // Bar-close reference price used for SL/TP DISTANCE math (ADR 0003 §3, ADR 0004 §8).
    // NOT the IOC-limit-price reference — see midAtTrigger for that (ADR 0005 §2).
    readonly entryPrice: MoneyValue;
    // ...
    // Kept separate from `entryPrice` so SL/TP distance math (bar close) and IOC microstructure math (book mid) never get cross-wired.
    readonly midAtTrigger: MoneyValue;
```

Backtest currently violates its own intent contract. Task 4’s parity fix is mandatory; it may not require a **new** shared field if backtest aligns `entryPrice` to `reconstructReferencePrice(event)` and passes `nextBarOpen` only into the sizer (and fill simulation).

### MFE/MAE seed-timing race (tech-debt M7 — confirmed)

`POSITION_OPENED_EVENT` fires at `ExecutionService.ts:1144`, **after** `createPositionFromFill`, `recordEntryTransactionOrEscalate`, and `protectiveAttacher.attach` — all awaited. The instrumentor seeds via async DB round-trip:

```224:227:apps/engine/src/position/service/PositionInstrumentor.ts
    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpenedEvent(event: IPositionOpenedEvent): Promise<void> {
        await this.seedFromRow(event.positionId, 'opened');
    }
```

`onPriceUpdate` drops ticks when `positionsBySymbol` has no entry (`PositionInstrumentor.ts:182–185`). For a volatility-spike bot, the entry-second window is exactly when this race hurts most.

### Task 5c column precondition (HIGH 6 — satisfied)

`positions.stop_loss_price`, `take_profit_price`, and `entry_price` exist on `PositionEntity` (`:48–57`). No extra column migration required for the view unless analytics need signal-reference columns not persisted today.

### Seeder overwrite risk (BLOCKER 3 — confirmed)

`SeedStrategyVersions` migration uses `ON CONFLICT DO UPDATE SET ... params = EXCLUDED.params` (`20260522020000-SeedStrategyVersions.ts:92–93`). Plan’s “seeder is CI/dev-bootstrap only post-M47” warning is correct and should land in the deploy runbook.

### Existing tests that Task 0 will break

`strategyExitFields.m38.spec.ts` asserts momentum `tpRebaseEligible === true` (SC1, SC4). Task 0 must update these paired tests in the same wave — the plan implies but does not name this file.

---

## Strengths

1. **Correct problem framing.** Separates structural geometry bleed from signal-quality / win-rate work (M48). The 29.8% win-rate honesty prevents a false “we fixed profitability” narrative post-deploy.

2. **Asymmetric coupling respects thesis stops.** Momentum widens TP only; mean-reversion tightens SL only. This matches ADR 0003’s invalidation-level philosophy and avoids mutating the VWAP thesis stop.

3. **Option B is the only viable rebase resolution.** Option A correctly rejected: pre-fill gate architecture cannot approve post-fill geometry without restructuring. Fill-acceptance guard (ADR 0045 §D2) bounds drift under Option B.

4. **Two-tier R:R design.** Versioned `min_rr` (core target ≈ 1.5) vs engine const `MIN_RR_GATE_FLOOR` (≈ 1.0) avoids a 92% kill-switch while still catching pathological slips. Strict `<` at the gate vs `≤` at cost floor is deliberate and should be documented in ADR 0004 as the plan states.

5. **Version bump (v1.1/v2.1/v3.1) over deploy-date windows.** Clean partition for Section 7 metrics and `position_segment_stats` — far less fragile than timestamp arithmetic on soak data.

6. **BLOCKER 5 (cap + degenerate skip).** Uncapped `slDist × min_rr` on extreme spikes can produce negative or unreachable TPs; the cap and skip mirror mean-reversion’s `isDegenerateReversionGeometry` pattern.

7. **HIGH 3 self-correction.** Removing the impossible clamp-widens-SL test shows the plan was adversarially reviewed; keep that discipline in QA.

8. **Task 5a ExecutionService-level test requirement.** Unit tests on `PositionInstrumentor` alone cannot reproduce the async open-path race — correct per BLOCKER 2 / HIGH 4.

9. **Gap-band canary `[1.0, 1.5)` with N ≥ 20.** Catches core-coupling regressions the `RR_TOO_LOW` counter alone cannot see — a strong operational metric.

10. **Non-rolling deploy + JSON-merge migration.** `.strict()` schema on `strategyParamsSchema` (`packages/shared/src/schema/strategyParamsSchema.ts:62`) makes partial deploy unsafe; the plan’s stop → migrate → start sequence is correct.

---

## Risks & Amendments

### Amendment 1 — Task 5a: “before first await” contradicts the stated insertion point (MEDIUM → fix spec before implement)

The plan repeatedly requires seeding **before the first await**, but places the call **after** `await createPositionFromFill(...)` at `ExecutionService.ts:~1056`. On the OPEN path, `createPositionFromFill` **is** the first await (DB INSERT via `positions.createOpen`).

**Current open-path order:**
1. `await createPositionFromFill` — ticks during INSERT are still dropped  
2. `await rejectAndUnwindIfUnacceptable` (when drift rejects)  
3. sync `localProtectiveMonitor.arm`  
4. `await recordEntryTransactionOrEscalate`  
5. `await protectiveAttacher.attach`  
6. `POSITION_OPENED_EVENT` → async `seedFromRow`

Moving seed to step 1’s **return** still closes the large window between steps 1–6 (major improvement over today) but does **not** satisfy “before first await” literally.

**Recommendation (pick one and document in the plan):**

- **(A — pragmatic):** Accept the INSERT window as negligible (single INSERT, sub-ms) and revise plan language to “immediately after `createPositionFromFill` returns, before `recordEntryTransactionOrEscalate`” — drop “before first await.”
- **(B — maximal):** Pre-register in `PositionInstrumentor` **before** `createPositionFromFill` using `event.intent.symbol` + a provisional in-memory stub keyed by `eventId`, then finalize with `positionId` after INSERT returns. Higher complexity; only if quant review shows INSERT-window ticks matter empirically.

Also: seed must run **before** `rejectAndUnwindIfUnacceptable` when the position survives — the plan’s `:1056` placement satisfies that, but the paired test should assert ordering relative to **both** `recordEntryTransactionOrEscalate` and `rejectAndUnwindIfUnacceptable`.

### Amendment 2 — Momentum cap can leave R:R below `min_rr` without skipping (MEDIUM → extend Task 2)

When `rrFloorRaw = slDist × min_rr` exceeds `max_tp_dist_factor × atr14`, the cap binds and `tpDist` may yield **R:R &lt; min_rr** even when TP is not “degenerate” (positive, correct side). The plan only skips degenerate TP prices, not cap-bound sub-target geometry.

**Example:** Large VWAP spike → `slDist` huge → capped `tpDist = 5×ATR` → realized ratio 0.8. Gate at 1.0 rejects; core did not skip.

**Recommendation:** After cap, if `tpDist / slDist < min_rr`, **skip as degenerate geometry** (new skip reason or reuse an existing geometry skip) rather than relying on the loose gate alone. Alternatively document explicitly that cap-bound spikes are **expected gate rejects** and add a funnel metric for them. Quant reviewer should choose; default to skip to preserve Invariant 1 (“no trade enters with signal-time R:R &lt; min_rr”).

### Amendment 3 — BLOCKER 1: prefer contract alignment over a new `referencePrice` field (LOW → simplifies Task 4)

`IOrderIntent.entryPrice` is already the documented signal-reference anchor for SL/TP math. Live complies; backtest does not.

**Recommendation:** In `BacktestOrchestrator.buildOrderIntent`, set `entryPrice = reconstructReferencePrice(event)` for gate/clamp/wrong-side checks; keep `ctx.nextBarOpen` as a **local variable** fed only to `PositionSizer.size({ entryPrice: nextBarOpen, ... })` and fill simulation. Fix `midAtTrigger` separately (book mid vs bar close) — today backtest sets `midAtTrigger: entryPrice`, which double-wires the wrong value.

Only route a new shared `referencePrice` field through `bot-shared-maintainer` if sizing and gate **must** diverge on the same struct and refactoring callers is riskier than a duplicate field. Default path: **align backtest to the existing contract**.

### Amendment 4 — Section 7 success metrics: define R:R measurement anchor (MEDIUM → document in plan + view)

After Option B, persisted `stop_loss_price` / `take_profit_price` are signal-time levels but `entry_price` is the **fill** (`createPositionFromFill` writes `fillSummary.avgFillPrice`). Querying `(tp_dist, sl_dist)` from persisted columns using `entry_price` measures **fill-anchored** R:R, which differs from the **signal-reference** R:R the gate approves when fill ≠ reference.

**Recommendation:** Specify success metrics explicitly:

- **Gate/core invariant metric:** distances from `reconstructReferencePrice` (or from momentum reverse-derive via `takeProfitPrice ± atrDistance`) — matches Task 4.  
- **Held-position metric:** distances from fill — acceptable drift bounded by fill-acceptance guard; track separately.

Task 5c `avg_rr` in `position_segment_stats` should document which anchor it uses. Mixing anchors will false-alarm the gap-band canary.

### Amendment 5 — Active version switch for v1.1/v2.1/v3.1 (LOW → runbook line)

The plan adds new version rows and backfills old rows for schema load, but does not state **how live switches** from v1/v2/v3 to v1.1/v2.1/v3.1 (DB `status` flip? engine config? operator step?). Add one runbook bullet: which row is `active` post-deploy and whether paper/soak auto-picks active version.

### Amendment 6 — Placeholder fast-revert threshold (LOW)

Section 9 fast-revert uses `[X]%` for time-stop runaway — replace with a concrete provisional threshold (e.g. 75% of exits) or “TBD at post-deploy review” before scribe close-out.

---

## Minor Notes (no blockers)

- **`atrDistance` post-Option-B:** Plan’s audit note (HIGH 5) is correct — `applyTargetTpSlRatioOverride` still reads `atrDistance`; do not delete it when removing fill-time rebase consumption.
- **Mean-reversion sweep:** Documenting `targetTpSlRatioOverride` as momentum-only is correct (`BacktestOrchestrator.ts:191` null guard).
- **Task 3 `slFloor` percent convention:** Aligning `entry_pct_floor` with `structural_stop_hard_cap_pct` percent-number convention matches `computeStops.ts` (`PCT_DIVISOR = 100`).
- **Milestone size:** Geometry (Tasks 0–4) + excursion (5a–5b) + view (5c) is three workstreams; enforce ≤5 files per dispatch wave per `dev-qa-cycle.md`.
- **Pre-existing tests:** Update `strategyExitFields.m38.spec.ts` in Task 0’s paired-test list by name.

---

## Dispatch Recommendation

| Wave | Contents |
|------|----------|
| 0 (serial) | `bot-shared-maintainer`: Task 1 schema + `RR_TOO_LOW`; DB JSON-merge migration + v1.1/v2.1/v3.1 rows; architect bless ADR 0003. |
| 1 (serial) | Task 0 (Option B + ADR 0045 amend) — gates Tasks 2 and 4. |
| 2 (parallel, ≤5 files each) | Task 2 momentum coupling; Task 3 mean-reversion coupling; Task 4 gate backstop + backtest anchor fix; Task 5a seed race (with Amendment 1 locked). |
| 2b (parallel) | Task 5c view migration (can start after Task 1). |
| 3 | `bot-qa-engineer` Task 6 matrix. |
| 4 | Reviewers (quant lead) + scribe close-out. |
| Post-deploy | Task 5b backfill; provisional `min_rr` review; gap-band canary after N ≥ 20 trades on new version IDs. |

**Do not rolling-deploy.** Stop engine → run param migration → start new binary.

---

## Summary

M47 is **well-diagnosed, correctly scoped, and should proceed**. The geometry bleed is real, quantified, and fixable without rewriting strategy philosophy. The plan’s self-review artifacts (BLOCKERs, HIGHs, corrected clamp tests, seeder warning, version-ID partition) are unusually strong.

Lock **Amendments 1–4** before implementation — especially the Task 5a await wording, cap-bound momentum skip policy, backtest `entryPrice` contract alignment, and success-metric R:R anchor definition. With those pinned, this milestone is the right prerequisite for any credible M48 signal-quality work.
