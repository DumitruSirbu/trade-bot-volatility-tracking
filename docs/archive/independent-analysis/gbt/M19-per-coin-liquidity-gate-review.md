# Independent Review - M19 Per-Coin Liquidity Gate

## Verdict

I approve the direction of M19. The diagnosis is sound: `book_depth_10bps_usdt` is a symbol-level liquidity fact, and wiring it into `StressHaltEvaluator` makes one thin alt capable of killing the whole UTC trading day. Moving depth to a per-coin eligibility reject is the right architectural correction.

I would not dispatch the plan as-is. There are a few plan-level gaps that can make the implementation either change strategy behavior outside the stated scope or fail to unblock the current soak after deployment.

## Must-Fix Before Dispatch

### H1 - `stress_breadth_pct` is shared with flow classification, not only the stress halt

The plan treats `stress_breadth_pct` as if it only drives `StressHaltEvaluator.isBreadthCollapse()`. It also drives `classifyFlowType()`:

```50:51:packages/shared/src/util/classifyFlowType.ts
    if (event.marketBreadth5mUpPct > params.stress_breadth_pct && event.sameBarTriggerCount >= params.stress_same_bar_trigger_count) {
        return FlowTypeEnum.MARKET_BETA;
```

Lowering seeded `stress_breadth_pct` from `70` to `30` therefore changes more than the global halt. It can make ordinary breadth values above 30% classify as `MARKET_BETA` whenever same-bar trigger count reaches the threshold. That conflicts with M19's stated "Out of scope: strategy-signal changes".

Required change:

- Either split the risk halt breadth distance into a new risk-only parameter/constant and leave `classifyFlowType()` semantics untouched, or intentionally update `classifyFlowType()` to use the same distance-from-50 definition with paired tests.
- Add shared/strategy tests that prove the M19 migration does not unintentionally turn normal `marketBreadth5mUpPct > 30` cases into `MARKET_BETA`.
- Have `bot-architect` record the chosen semantic split in ADR 0004 and, if classifier behavior changes, ADR 0003 as well.

### H2 - Current-day false halt can survive the deploy and keep blocking trades

The risk gate checks persisted `risk_state.isHalted` before evaluating fresh stress:

```458:469:apps/engine/src/risk/service/RiskGateService.ts
        if (state.today !== null && state.today.isHalted) {
            return RejectReasonEnum.GLOBAL_HALT;
        }

        if (this.stress.isStressed(context.snapshot, context.params)) {
            this.emitMarketStressIfTransitioning(context, state);
            await this.persistHalt(context, state, RejectReasonEnum.MARKET_STRESS);
```

If the old depth-collapse bug already set today's row to halted, restarting the engine with M19 code will still reject every new open as `global_halt` until UTC rollover or an operator clears the halt. That can make post-deploy verification falsely look broken.

Required change:

- Add a rollout step for the active soak day: after backup and explicit operator confirmation, clear only a confirmed false `market_stress` halt for today's row, or explicitly wait for UTC rollover before judging trade flow.
- Add verification that distinguishes "old persisted halt still active" from "new depth gate still halting".
- If using the existing clear-halt path, document the exact safe path and the evidence required before clearing: calm market metrics, halt reason caused by old depth-collapse, and no real stress conditions.

### H3 - Breadth migration should preserve non-default/custom strategy params

The plan says:

```text
UPDATE strategy_versions SET params = jsonb_set(params,'{stress_breadth_pct}','30') for the `volatility-vwap` rows.
down() restores `70`.
```

That is too broad for a live calibration table. `strategy_versions.params` is also the strategy-version comparison surface. A blanket update will overwrite any draft/shadow/operator-tuned `stress_breadth_pct`, and a blanket `down()` can destroy a legitimate post-M19 value of `30` by forcing it back to `70`.

Required change:

- Scope `up()` to rows whose current value is exactly the old default, for example `name = 'volatility-vwap' AND params->>'stress_breadth_pct' = '70'`.
- Make `down()` equally conservative, or document that migration down is not to be used in soak/live per the repo's DB-safety rules.
- Add a migration test/case for a custom row, for example `stress_breadth_pct = 45`, proving it is not changed.

### H4 - New book-depth gate needs an explicit fail-closed policy for invalid depth

After depth is removed from `StressHaltEvaluator`, `hasInvalidStressInputs()` will no longer protect `book_depth_10bps_usdt`. The planned code:

```text
new Money(context.snapshot.book_depth_10bps_usdt).lessThanOrEqualTo(new Money(COIN_DEPTH_FLOOR_10BPS_USDT[intent.coinTier]))
```

is correct for valid decimal strings, but the plan does not say what happens for `null`, `undefined`, non-decimal strings, negative values, or an unknown tier. A malformed depth value should skip the coin, not throw out of the gate or pass open.

Required change:

- Define `isBookTooThin()` as fail-closed for missing/invalid/non-positive depth and unknown tier.
- Add adversarial tests for invalid depth values and prove the outcome is `COIN_BOOK_TOO_THIN` without setting `risk_state.is_halted`.
- Keep the existing spread invalid-input behavior unchanged: non-finite spread remains a global market-stress fail-closed condition because it is still a global liquidity shock input.

## Should-Fix Before Dispatch

### M1 - Per-coin reject should be proven across two signals on the same UTC day

The proposed regression test says a thin coin should reject without setting `risk_state.is_halted`. That is necessary but not sufficient. The bug's practical damage is day-level contagion.

Recommended test:

- Evaluate a thin tier-2/tier-3 signal and assert `COIN_BOOK_TOO_THIN`.
- Reuse the same risk-state fixture/day and evaluate a deep tier-1 signal.
- Assert the second signal reaches approval or the next legitimate gate, not `GLOBAL_HALT`.

### M2 - Boundary semantics should be explicit and aligned with spread semantics

The plan uses `<= floor` for depth and the existing spread gate uses `> ceiling`. That is reasonable: floor is minimum acceptable depth, ceiling is maximum acceptable spread.

Recommended edit:

- State the boundary rule in the plan and tests: depth exactly at the floor is rejected; spread exactly at the ceiling still passes.

### M3 - ADR 0004 needs a careful wording split

ADR 0004 currently groups `bid_ask_spread_pct` and `book_depth_10bps_usdt` together as global spread-widening/depth-collapse stress inputs. M19 should not just delete depth from the list; it should explain the split:

- Global spread widening remains a broad market stress proxy.
- Per-symbol depth floor is an entry eligibility guard.
- Breadth is distance from neutral midpoint in the risk halt, not raw percent-up breadth unless ADR 0003 intentionally keeps that classifier meaning.

## What Looks Good

- The core change respects the risk-gate invariant: strategies still produce intents, and the central gate decides eligibility.
- The new reject reason is preferable to overloading `MARKET_STRESS`; it will make decision-funnel queries much clearer.
- Keeping `STRESS_SPREAD_PCT` global is defensible because broad spread blowouts can signal venue-wide or market-wide dysfunction.
- The test plan already points at the right files and should be quick to implement if the breadth/classifier issue is resolved first.

## Recommended Dispatch Adjustment

Before the listed implementation waves, add a short architect/shared-contract clarification wave:

1. Decide whether `stress_breadth_pct = 30` is risk-only or also intentionally changes `classifyFlowType()`.
2. Update ADR 0004 and, if needed, ADR 0003.
3. Adjust the M19 plan's test list to include classifier regression and conservative migration behavior.
4. Add the rollout note for existing false `risk_state.is_halted` rows.

After that cleanup, M19 is a good, tightly scoped fix and should unblock the soak without weakening the global stress protections that actually belong at market scope.
