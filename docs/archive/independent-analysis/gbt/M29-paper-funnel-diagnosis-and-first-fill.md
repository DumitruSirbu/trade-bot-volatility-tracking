# Independent Review — M29 Paper Funnel Diagnosis + First-Fill Enablement

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M29-paper-funnel-diagnosis-and-first-fill.md`  
**Date:** 2026-06-10

## Verdict

**Approve with plan amendments before dispatch.**

M29 is the right hinge milestone for the paper-soak arc. The soak evidence (539 open intents, zero
approvals, zero positions) and the build-order call to defer differentiated slot-C work until
idiosyncratic fills exist are well argued and align with the project's survival-first priority. Root
cause #1 (`exposure_cap_per_coin` with an empty book) is code-accurate and the D2 fix direction
(clamp down to the operator ceiling, never raise caps) is the conservative choice.

I would not dispatch as written. Implementation step 2 names the wrong sizing call site, the plan
should explicitly amend ADR 0042 §4 (which locked "no PositionSizer code change"), and root cause #2
misstates how `sl_outside_liquidation` behaves in the current gate — that matters for post-M29
prioritization and tech-debt wording.

First paper fill is plausible after D2 (up to ~36 historical intents already cleared SL, slot, and
depth checks) but is not guaranteed on restart; the next dominant blocker may still be
`sl_outside_liquidation` or execution-path issues from M24.

---

## Strengths

### 1. Evidence-driven sequencing (D1)

Reversing the WIP lean toward slot C is justified. M24–M28 fixed fill mechanics and stress behaviour,
yet the soak DB still shows zero fills — the choke is upstream of execution. Building a correlated
strategy on zero baseline P&L would make attribution impossible.

### 2. Root cause #1 is verified against code

`checkExposureCaps` sums open + active reservations + intent notional:

```1149:1156:apps/engine/src/risk/service/RiskGateService.ts
    private checkExposureCaps(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState, ledger: ReservationLedger): RejectReasonEnum | null {
        const active = ledger.listActive();

        const perCoin = this.sumNotionalForSymbol(state.openPositions, active, intent.symbol).plus(intent.sizing.notional);

        if (perCoin.greaterThan(context.limits.maxExposurePerCoinUsdt)) {
            return RejectReasonEnum.EXPOSURE_CAP_PER_COIN;
        }
```

With an empty book the predicate reduces to `intent.sizing.notional > maxExposurePerCoinUsdt`. The
plan's ATR sizing vs $500 cap under $1,500 × 1% risk is a calibration conflict, not a gate bug.

### 3. D2 is the safe direction

Clamping to `min(riskTarget, leverageCeiling, perCoinCap)` mirrors `clampToMaxLeverage`, keeps
`checkExposureCaps` as defence in depth, and rejects raising caps or lowering global risk pct. The
min-notional guard after clamp is essential.

### 4. D5 discipline

Refusing to hand-edit VWAP stops, depth floors, or idiosyncrasy thresholds in the same milestone that
unblocks fills avoids over-fitting. Logging follow-ups as MEDIUM tech-debt is correct.

### 5. Observability without schema (D3)

Preferring a canonical rollup in `packages/analysis` (existing query module + Jest pattern) over a
persisted funnel table respects CLAUDE.md DB rules. `getDecisions`, `selectHaltState`, and
`getPerformance` are good templates.

### 6. Gate pipeline ordering supports the D2 impact estimate

In `evaluateEntry`, per-coin exposure is checked inside `reserveAndApprove`, **after**
`clampStopInsideLiquidation`:

```427:448:apps/engine/src/risk/service/RiskGateService.ts
    private async evaluateEntry(intent: IOrderIntent, context: IRiskGateContext, ledger: ReservationLedger): Promise<IRiskDecision> {
        ...
        const clampedExit = this.clampStopInsideLiquidation(intent);

        if (clampedExit === null) {
            return this.rejected(intent, RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        }

        return this.reserveAndApprove(intent, context, state, slot.slot, clampedExit, ledger);
    }
```

The 36 `exposure_cap_per_coin` rejects are therefore a subset that already passed halt, tier/depth,
slot assignment, and the SL gate. Unblocking them is a real funnel improvement, not double-counted
with the 66 SL rejects.

---

## Must-fix before dispatch

### H1 — Wrong sizing call site in implementation step 2

The plan says:

> `RiskGateService.ts` — thread `maxExposurePerCoinUsdt` into the sizing call.

**Code fact:** `RiskGateService` never calls `PositionSizer.size`. Sizing happens in:

- `StrategyService.buildOrderIntent` (live/paper) — cap is on gate context but **not** passed to the sizer today:

```216:226:apps/engine/src/strategy/service/StrategyService.ts
        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: this.activeParams.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: this.activeParams.funding_rate_suppress_threshold,
            instrument,
        });
```

- `BacktestOrchestrator.buildOrderIntent` (replay) — same omission; live/backtest parity (ADR 0015 /
  ADR 0004 §8) requires the same input there.

`StrategyService` already threads `maxExposurePerCoinUsdt` into **gate** limits via
`resolveRiskLimits()` (line ~369). M29 must thread it into **sizing**, not into `RiskGateService`.

**Required plan amendment:**

| File | Change |
|------|--------|
| `PositionSizer.ts` | Add `maxExposurePerCoinUsdt` to `ISizingInput`; generalise clamp (D2). |
| `StrategyService.ts` | Pass `new Money(this.config.maxExposurePerCoinUsdt)` into `sizer.size(...)`. |
| `BacktestOrchestrator.ts` | Pass the same cap from backtest context/limits. |
| `RiskGateService.ts` | **No sizing call** — confirm `checkExposureCaps` unchanged only. |

Missing the backtest path would silently diverge replay sizing from live after M29.

### H2 — Amend ADR 0042 §4 explicitly, not only ADR 0004 §8

ADR 0042 §4 states:

> **No `PositionSizer` code change.** P3b is config-only: the sizer already consumes the threaded
> config values; raising them scales position size and lowers `exposure_cap_per_coin` rejects without
> touching sizer code.

Soak evidence shows config headroom (M25 P3b) was insufficient for low-ATR names where
risk-targeted notional still exceeds `MAX_EXPOSURE_PER_COIN_USDT` before any position exists. M29's
sizer clamp is a justified reversal, but it contradicts a locked ADR unless amended in place.

**Required:** amend **ADR 0042 §4** alongside ADR 0004 §8 in the plan's ADR step, with one sentence
on why config-only scaling did not resolve the empty-book cap conflict.

---

## High-priority plan corrections (non-blocking but should land in plan text)

### M1 — Root cause #2 misstates `sl_outside_liquidation` mechanism

The plan attributes the 66 reachable rejects primarily to "VWAP stop sits too far from entry —
frequently outside the liquidation-safety buffer."

**Code fact:** `clampStopInsideLiquidation` **tightens** stops that exceed the safe distance; it
does **not** reject for distance alone. `SL_OUTSIDE_LIQUIDATION` is returned only when
`clampStopInsideLiquidation` returns `null`:

```1056:1086:apps/engine/src/risk/service/RiskGateService.ts
    private clampStopInsideLiquidation(intent: IOrderIntent): IProposedExit | null {
        ...
        if (this.isWrongSideStop(intent)) {
            return null;
        }

        const stopDistance = intent.entryPrice.minus(intent.proposedExit.stopLossPrice).abs();

        if (stopDistance.lessThanOrEqualTo(safeDistance)) {
            return intent.proposedExit;
        }

        return this.tightenStop(intent, safeDistance);
    }
```

Reject paths are roughly: invalid/over-max leverage, non-positive liquidation fraction (over-levered
relative to maintenance margin), non-positive safe distance, or **wrong-side structural stop**
(`isWrongSideStop`).

For v2 momentum, entry is reconstructed above/below VWAP on the follow side and SL is always
`vwapSession`, so wrong-side stops are **unexpected** unless event geometry or deviation sign is
inconsistent — worth quantifying from decision rows (entry vs stop vs side), not assumed from
"narrative distance."

**Implication for M29:**

- Intents with far VWAP stops may already be **approving with tightened stops**, not appearing in
  the 66 SL rejects. Post-D2 funnel monitoring should watch for approvals with clamped exits, not
  only raw `sl_outside_liquidation` counts.
- Tech-debt entry (b) should say "dominant reachable reject reason under v2 momentum + structural
  VWAP stop" and call for **backtest + decision forensics** (wrong-side vs over-levered vs tightened-
  and-approved), not "stop too far → reject."

This does not block D2; it prevents mis-prioritizing the next milestone.

### M2 — Qualify "first-fill enablement" vs binary acceptance

Code-complete M29 removes the empty-book `exposure_cap_per_coin` choke. First fill still requires a
non-halted session, SL gate clearance, depth/idiosyncrasy passes, gate approval, and M24 fill
execution. Recommend adding to Success criteria:

> Milestone code closure is the clamp + observability + tests; deploy acceptance is checklist items
> 4–5 (`positions` 0 → ≥1).

Prevents a false "M29 failed" if the next session's reachable blocker is entirely
`sl_outside_liquidation` or thin-book skips.

### M3 — D6 should explicitly cover `.env.example`, not only operator `.env`

The duplicate-key hazard is real, but committed `.env.example` already shows `MAX_OPEN_POSITIONS=1`
at line 218 with the paper `=3` block commented at line 291. D6 should require **both** files so
new operators are not misled by reading the top of the example file.

---

## Recommendations (QA / implementation)

### A. Backtest/live sizing parity test

Add an explicit fixture: same inputs through `StrategyService` sizing path and
`BacktestOrchestrator` sizing path produce identical clamped notional when risk-target exceeds
per-coin cap. This is the highest-value regression beyond unit tests on `PositionSizer` alone.

### B. Clamp + qty step-rounding boundary

After clamp, qty is step-rounded down. Assert final `intent.sizing.notional <= maxExposurePerCoinUsdt`
always; document that slightly below cap after rounding is OK, above cap is not.

### C. Secondary effect: lower leverage after clamp may ease SL gate

Clamping notional reduces computed leverage for low-ATR names. That widens `safeDistance` in the SL
check. Some intents near the exposure-cap boundary may become easier to pass the SL gate after D2
even without strategy changes — worth noting in post-deploy monitoring, not as a design goal.

### D. Funnel rollup shape (D3)

Implement as `packages/analysis/src/query/getFunnelSummary.ts` (or similar), exported from the
analysis package index. If an HTTP endpoint is added later, delegate to the same function.

The rollup should expose:

- `gate_allowed = true` / `false` / `NULL` (510 pre-M27 rows — NULL is "unknown", not rejected)
- `reason LIKE 'market_stress%'` for suffixed legs (M23/M28 lesson)
- Halted-day vs reachable split via `reason = 'global_halt'` on `action = 'open'`, not only
  `risk_state.is_halted` on the calendar day

### E. D4 test colocation

Extend existing suites (`StrategyService.spec.ts`, mapper tests, `BacktestOrchestrator.spec.ts`)
rather than scattering new files — matches project conventions and avoids duplicate buffer tests
(already partial coverage for `btc_correlated_not_best_candidate`).

### F. Same-direction cap sanity fixture

With zero open positions, `same_direction_exposure_cap` binds only if a single intent exceeds
`MAX_SAME_DIRECTION_EXPOSURE_USDT`. Under typical paper env ($1,500 same-direction vs $500 per-coin)
this is unlikely after D2, but one QA fixture confirms M29 does not mask a parallel sizing-vs-cap
conflict on that leg.

---

## Safety and invariants

| Invariant | Assessment |
|-----------|------------|
| No order path bypasses risk gate | Preserved — clamp is pre-gate sizing; cap check stays. |
| Strategy purity | Preserved — change in `PositionSizer` + orchestrator wiring, not `momentumCore`. |
| Money as decimal | Plan requires pure decimal clamp — matches existing style. |
| Determinism | Preserved **if** backtest receives the same cap input (H1). |
| DB safety | No migration — pg_dump + restart only; correctly stated. |
| Conservative direction | Clamp shrinks, never grows — passes survival test. |
| Shadow path | Out of scope; shadow uses its own sizing path — no change required for M29 goal. |

---

## Testing assessment

The proposed test matrix is thorough. Priority order for QA:

1. H1 threading + backtest parity (integration)
2. D2 unit tests on `PositionSizer` (each ceiling binding + min-notional after clamp)
3. Defence-in-depth: existing open/reservation + clamped intent still rejects `exposure_cap_per_coin`
4. Funnel query fixture with NULL `gate_allowed`, suffixed stress reasons, mixed halt/reachable days
5. D4 correlated plumbing pins (extend existing specs)

Existing regression locks (M28 stress, M22 depth, no strategy edits) are appropriately listed.

---

## Post-deploy checklist

The checklist is strong. One additional watch:

- If `gate_allowed=true` stays zero for 24h on non-halted days after D2, pull the D3 rollup. If
  **all** reachable rejects are `sl_outside_liquidation`, run decision forensics (M1) before opening
  a "change the VWAP stop" milestone — the fix may be over-leverage / wrong-side geometry, not stop
  distance.

---

## Conclusion

M29 is **approved with plan amendments**:

1. Fix implementation step 2: thread cap through `StrategyService` and `BacktestOrchestrator`, not
   `RiskGateService`.
2. Amend ADR 0042 §4 alongside ADR 0004 §8.
3. Correct root cause #2 narrative to match `clampStopInsideLiquidation` behaviour (M1).
4. Qualify first-fill success criteria (M2) and extend D6 to `.env.example` (M3).

With those updates, the milestone is a focused, evidence-backed hinge: unblock a proven calibration
conflict, instrument the funnel, defer slot-C strategy work until idiosyncratic edge can be measured,
and keep every other safety floor intact. Proceed with the standard dispatch waves once the plan text
reflects the sizing seam, ADR updates, and SL-reject forensics.
