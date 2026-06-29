# Independent Review — M48 Fill-Anchor Geometry Fix

**Plan reviewed:** `docs/plans/m48-geometry-fill-anchor-fix.md`  
**Codebase snapshot:** 2026-06-26 (pre-implementation; M47 deployed, M48 PLANNED)  
**Reviewer:** Composer (independent analysis)  
**Passes:** initial review → **second pass** after plan incorporated prior amendments

---

## Executive Verdict

M48 correctly closes the **residual geometry hole M47 left open**: every pre-fill check anchors to `intent.referencePrice` / `reconstructReferencePrice`, while persisted `entry_price` is the **fill**. Position 212 (1.53% reconstruction drift → `slDist` ~35× smaller at fill → hair-trigger SL / 85:1 R:R) is consistent with code mechanics — `evaluateFillDrift` today only rejects wrong-side-of-SL; a fill barely past SL passes unchecked.

**Second-pass assessment:** The plan has been **substantially revised** since the initial review. All six prior amendments are now locked in the plan text (Items 1–3, observability owners, renamed test (a), mean-reversion scope, `DEGENERATE_GEOMETRY_AT_FILL` const, tests (e2)/(e3)). The milestone is **implementation-ready**.

**Assessment:** **Approve — ready to dispatch** after pinning three minor residual details below (not blockers). Quant reviewer leads; architect re-blesses ADR 0045 §D2 + `IOrderIntentApprovedEvent.geometryParams` before Wave 1.

| Area | Grade (2nd pass) | Assessment |
|------|------------------|------------|
| Problem diagnosis | A+ | Unchanged — gap is real, code-verified, live evidence coherent. |
| Seam / invariants | A | `evaluateFillDrift` extension; Option B preserved; live-only (D1B6). |
| Algorithm | A | Ordering → floor → ratio; dual anchor (fill distances, reference floor). |
| Params plumbing (Item 1) | A | `geometryParams` stamp at `emitApproval` — `activeParams` in scope (line 119). |
| Fail-closed / unconditional (Item 3) | A- | Specified for missing `geometryParams`; extend to missing `atr_14` (see Residual 2). |
| Observability | B+ | Owner seam named; alarm **threshold** still unspecified (Residual 1). |
| DRY (`resolveSlFloorDistance`) | B | Extraction specified; **layer placement** ambiguous vs “no strategy core touch” (Residual 3). |
| Test matrix | A | (a)–(g), (e2), (e3), MR defense-in-depth — strong adversarial bar. |
| Dispatch / scope | A- | ≤5-file cap may require splitting engine vs test files across dispatches. |

**Bottom line:** **Dispatch M48.** This is the correct M47 follow-on and directly implements the M47 independent review’s fill-anchored safety-net recommendation.

---

## Plan Revision Status (amendments incorporated)

| Prior amendment | Status in current plan |
|-----------------|------------------------|
| 1 — `geometryParams` on approved event (1A) | **Locked** — ADR scope line 7, Item 1, Task 0 touches, dispatch note |
| 2 — `slFloor` pct leg = `intent.referencePrice` | **Locked** — pseudocode line 66, Item 2, test (e3) |
| 3 — Unconditional fail-closed leg | **Locked** — Step 0, Item 3, test (e2) |
| 4 — Test (a) TP-ordering rename | **Locked** — test (a) lines 108–109 |
| 5 — Observability owners | **Locked** — Item at lines 102–103 (`rejectAndUnwindIfUnacceptable`) |
| 6 — Mean-reversion defense-in-depth | **Locked** — bullet line 104, Task 1 MR test |
| DRY `resolveSlFloorDistance` | **Added** — Task 0 touches + bullet line 101 |
| `DEGENERATE_GEOMETRY_AT_FILL` const | **Added** — invariant 8, reject vocabulary |

---

## Verified Current State (unchanged)

### M47 Option B — frozen geometry at signal time

```80:97:apps/engine/src/strategy/strategies/momentumCore.ts
    return {
        takeProfitPrice,
        stopLossPrice: new Money(event.vwapSession),
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: nowMs + params.time_stop_minutes * MS_PER_MINUTE,
        tpRebaseEligible: false,
        atrDistance: atrTarget,
    };
```

### Gate R:R — signal reference only, loose floor 1.0

```1196:1214:apps/engine/src/risk/service/RiskGateService.ts
    private isRewardRiskTooLow(clampedExit: IProposedExit, intent: IOrderIntent): boolean {
        const referencePrice = intent.referencePrice;
        // ... sl/tp distances from referencePrice ...
        return tpDistance.dividedBy(slDistance).lessThan(MIN_RR_GATE_FLOOR);
    }
```

### `evaluateFillDrift` — wrong-side only today

```39:49:apps/engine/src/execution/utils/exitGeometryHelper.ts
export function evaluateFillDrift(ctx: IFillDriftContext): { shouldReject: boolean; reason?: string; driftPct?: number } {
    const fill = new Money(ctx.avgFillPrice);
    const sl = new Money(ctx.clampedExit.stopLossPrice);
    const isWrongSideOfStop = ctx.side === PositionSideEnum.LONG ? fill.lessThanOrEqualTo(sl) : fill.greaterThanOrEqualTo(sl);
    if (isWrongSideOfStop) {
        return { shouldReject: true, reason: 'wrong_side_of_sl' };
    }
    // magnitude leg opt-in only — MAX_SIGNAL_DRIFT_PCT undefined → inert
```

### Fill seam — reject after DB insert, before arm

`rejectAndUnwindIfUnacceptable` at `ExecutionService.ts:1065–1067` / `1170–1216`; unwind via `fillAcceptanceUnwind.emitSyntheticClose`.

### `geometryParams` stamp point — verified available

`StrategyService.activeParams` loaded at `onModuleInit` (line 119); `emitApproval` (line 394) is OPEN-only and has access to `this.activeParams`. **Not yet on `IOrderIntentApprovedEvent`** — implementation adds it.

```394:405:apps/engine/src/strategy/service/StrategyService.ts
    private emitApproval(intent: IOrderIntent, decision: IApprovedRiskDecision, entrySnapshot: IMarketSnapshot): void {
        const payload: IOrderIntentApprovedEvent = {
            intent,
            approvedSlot: decision.approvedSlot,
            approvedSizing: decision.approvedSizing,
            clampedExit: decision.clampedExit,
            reservationId: decision.reservationId,
            entrySnapshot,
            strategyVersionId: this.activeStrategyVersionId,
        };
        this.events.emit(ORDER_INTENT_APPROVED_EVENT, payload);
    }
```

### No implementation landed yet

Grep confirms no `geometryParams`, `DEGENERATE_GEOMETRY_AT_FILL`, or `GEOMETRY_ANCHOR_DRIFT` in engine code. Status remains **PLANNED** in `docs/plans/README.md`.

---

## Strengths (second pass)

1. **Closes the exact M47 residual gap** without reopening fill-time rebase or duplicating the risk gate.
2. **Dual-anchor design is correct:** fill-anchored distances + signal-calibrated `slFloor` threshold preserves the 212 guard (pct leg must not track slippage).
3. **Fail-closed on wiring bugs** — missing `geometryParams` cannot silently pass (test e2).
4. **Two-tier R:R is explicit** — gate 1.0 at signal, `min_rr` 1.5 at fill; `[1.0, 1.5)` fill rejects are intentional.
5. **Strategy-agnostic seam** with `flow_type`-broken-out observability — MR over-reject is detectable separately from momentum H5 alarm.
6. **Small, bounded contract touch** — engine-internal `IOrderIntentApprovedEvent` + ADR 0045; no shared-package wave.
7. **Parity foresight** — backtest inert + `|backtest_fill − ref| < slFloor` guard for future slippage models.

---

## Residual Items (pin before or during Wave 1 — not blockers)

### Residual 1 — H5 alarm threshold (LOW)

Success criteria require a momentum `degenerate_geometry_at_fill` **reject-rate alarm** but no provisional threshold (e.g. “>X% of momentum OPEN fills over 7d” or “≥N rejects in 24h”). Existing `FILL_ACCEPTANCE_REJECTED` is a **log label**, not a structured counter with `flow_type` dimensions today.

**Recommendation:** Add one provisional threshold to Section 5 or the deploy runbook (e.g. “alarm if momentum reject rate > 5% over rolling 20 fills”) — re-tune post-soak like M47 `min_rr`.

### Residual 2 — Fail-closed should cover `atr_14`, not only `geometryParams` (LOW)

`atr14` is sourced from `entrySnapshot.atr_14`. Item 3 fail-closed covers missing `geometryParams`; if `entrySnapshot` is absent on an OPEN approval, the leg cannot compute `slFloor`. Treat missing `entrySnapshot` / `atr_14` the same as missing params — reject/escalate, never skip.

### Residual 3 — `resolveSlFloorDistance` placement vs layer boundaries (LOW)

Plan extracts the util into `exitGeometryHelper.ts` but also states **no strategy core touch**. Strategy modules do not import from execution today. Options:

- **(A — preferred):** Place `resolveSlFloorDistance` in `apps/engine/src/common/utils/` (or `strategy/utils/`) and import from both `meanReversionCore` and `exitGeometryHelper`.
- **(B):** Duplicate in `exitGeometryHelper` with a **parity unit test** asserting bit-for-bit match with `meanReversionCore`’s private function (no strategy file change).

Pick one in the ADR amendment — do not leave the engine agent to choose ad hoc.

### Residual 4 — Integration test file (NIT)

Task 0 does not name `ExecutionService.m38.fillAcceptance.spec.ts`. Add one FA* case (212-style reject → `emitSyntheticClose`, no arm/attach/`POSITION_OPENED_EVENT`) to Task 0 or Task 1 checklist — mirrors existing FA2/FA3 pattern.

### Residual 5 — Dispatch file-count split (NIT)

Task 0 touches ≥5 production files (`exitGeometryHelper`, `ExecutionService`, `IOrderIntentApprovedEvent`, `StrategyService`, `executionConsts`, possibly `meanReversionCore` if DRY option A). Per `dev-qa-cycle.md` §1.1, split into **Wave 1a** (helper + const + event + stamp) and **Wave 1b** (call-site wiring + logs) if needed.

---

## Dispatch Recommendation

| Wave | Contents |
|------|----------|
| 0 (serial) | Architect re-bless ADR 0045 §D2 + `geometryParams` field + `resolveSlFloorDistance` placement (Residual 3). |
| 1 (serial) | `bot-engine-nestjs` Task 0 — helper leg, const, event stamp, call site, observability. ≤5 files per sub-wave if needed. |
| 2 (serial) | `bot-qa-engineer` Task 1 — (a)–(g), (e2), (e3), MR case, `ExecutionService.m38` FA* (Residual 4). |
| 3 (parallel) | Reviewers — **quant lead**. |
| 4 (serial) | Scribe — ADR, work-log, milestone log, STATUS, plans README. |
| Post-deploy | Fill-anchored R:R query; `GEOMETRY_ANCHOR_DRIFT` distribution; momentum reject rate vs H5 threshold (Residual 1). |

---

## Summary

**Second pass: approve and dispatch.** The plan absorbed all material feedback from the initial review and is internally consistent with the codebase. The diagnosis remains sound; the seam, dual-anchor math, params plumbing, and test matrix are implementation-ready.

Pin **Residuals 1–3** in the ADR amendment or runbook (alarm threshold, `atr_14` fail-closed, util placement). No further plan rewrite required before architect bless and engine wave.
