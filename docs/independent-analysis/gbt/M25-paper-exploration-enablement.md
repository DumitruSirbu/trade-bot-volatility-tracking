# Independent Review - M25 Paper Exploration Enablement

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/M25-paper-exploration-enablement.md`  
**Date:** 2026-06-08

## Verdict

I approve M25's product direction: after M24 fixes gate-approved open fills, switching the paper soak
to v2 momentum and loosening paper-only risk constraints is the right way to generate labeled
win/loss outcomes. The plan correctly separates this from live risk posture, requires an architect
pass, keeps the risk gate in the path, and treats M24 as a hard prerequisite.

I would not dispatch M25 as written. The stress-relaxation part is directionally sound but underspecified
at the code-contract level; the slot/concurrency part is materially larger than the plan says. The
current shared slot enum has only `A`, `B`, and `C`, and several engine/read/backtest paths assume
exactly those three labels. A "5 total concurrent" target is not a small `SlotManager` env override
unless M25 expands into a shared-contract change. There is also a subtle current-code trap:
raising `MAX_IDIOSYNCRATIC_SLOTS` alone would make slot C harder to use, not create more slots.

## Must-Fix Before Dispatch

### H1 - P3 cannot produce 5 positions without changing the shared slot contract

The plan says:

```text
Paper-gated slot bump: make MAX_IDIOSYNCRATIC_SLOTS env-overridable only when EXCHANGE_ENV=paper
... target 5 total concurrent: e.g. 4 idiosyncratic + 1 BTC-correlated.
```

But the slot domain only contains three labels:

```1:5:packages/shared/src/enum/PositionSlotEnum.ts
export enum PositionSlotEnum {
    A = 'A',
    B = 'B',
    C = 'C',
}
```

The current assigner also only ever returns A, B, or C:

```40:54:apps/engine/src/risk/service/SlotManager.ts
        const occupiedSet = new Set(occupied.map((entry) => entry.slot));

        if (!occupiedSet.has(PositionSlotEnum.A)) {
            return { kind: 'assigned', slot: PositionSlotEnum.A };
        }

        if (!occupiedSet.has(PositionSlotEnum.B)) {
            return { kind: 'assigned', slot: PositionSlotEnum.B };
        }

        if (this.isSlotCFreeForIdiosyncratic(occupied)) {
            return { kind: 'assigned', slot: PositionSlotEnum.C };
        }
```

And downstream code maps the enum as a fixed three-slot set:

```279:283:apps/engine/src/read-api/mappers/readApiMappers.ts
const SLOT_ORDINAL_BY_ENUM: Record<PositionSlotEnum, number> = {
    [PositionSlotEnum.A]: 1,
    [PositionSlotEnum.B]: 2,
    [PositionSlotEnum.C]: 3,
};
```

Required plan change:

- Either reduce M25 P3 to what the current contract can safely support: at most the existing three
  slots, plus exposure/capital headroom; or explicitly promote P3 to a shared-contract change that
  adds new slot labels (`D`, `E`, etc.) through `bot-shared-maintainer`, engine mappers, dashboard/read
  surfaces, tests, and ADR updates.
- If the target remains 5, update the dispatch waves. `bot-shared-maintainer` must run before
  `bot-engine-nestjs`; the current "No `packages/shared/` change" statement becomes false.
- Add tests that prove every new slot can be persisted, read, ordered, reconciled into client order
  IDs, replayed in backtest adapters, and serialized in market snapshots.

Without that scope correction, implementation will either fail type checks or quietly keep the real
ceiling at three while the operator believes paper can hold five positions.

### H2 - Raising `MAX_IDIOSYNCRATIC_SLOTS` alone can reduce capacity under the current algorithm

The plan treats `MAX_IDIOSYNCRATIC_SLOTS` as if a higher value creates more idiosyncratic slots. In
current code, it does not. It is only used to decide when slot C can be borrowed by an idiosyncratic
trade:

```61:66:apps/engine/src/risk/service/SlotManager.ts
    private isSlotCFreeForIdiosyncratic(occupied: IOccupiedSlot[]): boolean {
        const slotCTaken = occupied.some((entry) => entry.slot === PositionSlotEnum.C);
        const idiosyncraticCount = occupied.filter((entry) => entry.correlationMode === CorrelationModeEnum.IDIOSYNCRATIC).length;

        return !slotCTaken && idiosyncraticCount >= MAX_IDIOSYNCRATIC_SLOTS;
    }
```

With `MAX_IDIOSYNCRATIC_SLOTS=2`, idiosyncratic trades can take A, then B, then C when no correlated
position holds C. If an env override raises this to `4`, there is no way to reach an idiosyncratic
count of 4 before assigning C, because only A and B have been assigned. Net result: paper can become
stuck at two idiosyncratic positions, which is the opposite of the plan's goal.

Required plan change:

- Do not implement P3 as a simple override of `MAX_IDIOSYNCRATIC_SLOTS`.
- Define the actual allocation model:
  - current-contract version: keep A/B/C and maybe allow C borrowing as today;
  - expanded-contract version: introduce a paper-only ordered pool of slots, with explicit correlated
    reservation semantics.
- Add an adversarial test: setting the paper slot knob above the current slot-label count must fail
  fast at boot or be rejected by validation, not silently reduce capacity.

### H3 - P2 must define exact relaxed legs and keep `isStressed` / `classifyHaltLeg` consistent

The plan says `PAPER_RELAX_MARKET_STRESS` "softens or skips the non-breadth stress legs" and lists
BTC/ETH shock, OI, funding, spread, and multi. That is not concrete enough for implementation because
`StressHaltEvaluator` has two coupled surfaces:

```30:56:apps/engine/src/risk/service/StressHaltEvaluator.ts
    isStressed(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        if (this.hasInvalidStressInputs(snapshot)) {
            return true;
        }

        if (this.isIndexShock(snapshot)) {
            return true;
        }

        if (this.isBreadthCollapse(snapshot)) {
            return true;
        }

        if (snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count) {
            return true;
        }
        // ... OI, funding, liquidity ...
```

```63:79:apps/engine/src/risk/service/StressHaltEvaluator.ts
    classifyHaltLeg(snapshot: IMarketSnapshot, params: IStrategyParams): string {
        if (this.hasInvalidStressInputs(snapshot)) {
            return HALT_LEG_INVALID;
        }

        const legs = this.activeStressLegs(snapshot, params);
        // ...
        return legs[0];
    }
```

If `isStressed` is paper-relaxed but `classifyHaltLeg` still sees the old active legs, persisted
`halt_reason` values and M23 resume eligibility can drift. If the flag also skips invalid-input stress,
paper can start trading on malformed snapshots. If it relaxes spread as a global halt but the per-coin
spread gate remains active, operators may still see `spread_too_wide` rejects and misread that as
P2 failure.

Required plan change:

- Enumerate the exact behavior per leg:
  - invalid inputs: still fail-closed;
  - breadth: unchanged;
  - same-bar: governed only by the raised strategy param, not by the flag;
  - BTC/ETH, OI, funding, spread: either skipped or raised to explicit paper thresholds;
  - multi: derived only from the legs still active under the paper profile.
- Require a single helper used by both `isStressed` and `classifyHaltLeg`, so the stress verdict and
  persisted suffix cannot diverge.
- Add tests for combined legs: breadth+BTC under relax should still classify as breadth-only if BTC is
  ignored; invalid+anything still classifies as invalid and halts.

### H4 - Sizing headroom misses the same-direction exposure cap and paper equity

The plan says to raise `MAX_EXPOSURE_PER_COIN_USDT` and `ACCOUNT_CAPITAL_USDT`. Those are necessary
but not sufficient for a higher-volume paper profile.

The risk gate also enforces same-direction exposure:

```1068:1081:apps/engine/src/risk/service/RiskGateService.ts
    private checkExposureCaps(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState, ledger: ReservationLedger): RejectReasonEnum | null {
        const active = ledger.listActive();

        const perCoin = this.sumNotionalForSymbol(state.openPositions, active, intent.symbol).plus(intent.sizing.notional);

        if (perCoin.greaterThan(context.limits.maxExposurePerCoinUsdt)) {
            return RejectReasonEnum.EXPOSURE_CAP_PER_COIN;
        }

        const sameDirection = this.sumNotionalForSide(state.openPositions, active, intent.tradeSide).plus(intent.sizing.notional);

        if (sameDirection.greaterThan(context.limits.maxSameDirectionExposureUsdt)) {
            return RejectReasonEnum.SAME_DIRECTION_EXPOSURE_CAP;
        }
```

`ACCOUNT_CAPITAL_USDT` drives sizing:

```198:207:apps/engine/src/strategy/service/StrategyService.ts
        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: this.activeParams.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: this.activeParams.funding_rate_suppress_threshold,
```

But the paper ledger's starting equity is configured separately via `PAPER_STARTING_EQUITY_USDT`, and
the plan does not mention aligning it. A paper profile with higher sizing capital but unchanged paper
equity can create confusing drawdown/equity telemetry even if the simulator does not enforce margin in
the same way an exchange does.

Required plan change:

- Include `MAX_SAME_DIRECTION_EXPOSURE_USDT` in the sizing-headroom profile and tests.
- State whether `PAPER_STARTING_EQUITY_USDT` must be raised with `ACCOUNT_CAPITAL_USDT` for a fresh
  soak, or intentionally kept at $500 with a clear explanation of what that means for drawdown
  telemetry.
- Add a test/funnel check for `same_direction_exposure_cap`, not only `exposure_cap_per_coin`.

## Should-Fix Before Dispatch

### M1 - P1 should document the strategy-version row status expectation

The plan says `ACTIVE_STRATEGY_VERSION_ID=3` selects DB id 3, version 2 momentum. The WIP analysis
showed that row as `status=shadow`, not `active`. If the engine simply trusts the env id, this is
probably fine; if any loader validates status, the boot or strategy load may fail.

Recommended plan addition:

- Verify before restart that strategy id 3 exists, is version 2 momentum, and is loadable by the active
  strategy loader even if its DB status remains `shadow`.
- If status must change to `active`, call that out as a DB update and apply the repo's pg_dump +
  confirmation rules. The current plan says strategy activation is config-only and no
  `strategy_versions` write occurs; keep that true only if code supports it.

### M2 - Add an acceptance gate for "M24 actually landed"

M25 is explicitly downstream of M24, but the plan's post-deploy acceptance mostly checks for
positions after both changes. If M24 lands with a fill bug, M25 will look like a gate/strategy failure
again.

Recommended plan addition:

- Before enabling M25 flags, run the M24 unit proof that a gate-approved crossing IOC fills with a
  non-zero price and event-time timestamp.
- In the 24-48h funnel check, split outcomes into:
  - no gate approvals;
  - approvals with missed fills;
  - approvals with filled opens.

### M3 - Paper-relax env vars need fail-safe schema validation

New flags should not be parsed ad hoc from `process.env` inside risk services. This repo already routes
typed config through `EnvironmentVariables` and `AppConfigService`.

Recommended plan addition:

- Add `PAPER_RELAX_MARKET_STRESS` and any paper slot variables to `EnvironmentVariables`.
- Use strict validation ranges: boolean flags parse only exact `true`; paper slot target cannot exceed
  the number of supported slot labels unless the shared enum has been expanded.
- Expose typed getters on `AppConfigService`; inject config into services instead of direct env reads.

### M4 - The "byte-identical non-paper" claim needs a practical proof

"Byte-identical" is stronger than "same outputs for fixtures." It is hard to prove for the whole gate
unless tests capture the right boundary.

Recommended plan addition:

- For non-paper mode, run the same table of stress snapshots and slot occupancy fixtures through the
  pre/post M25 logic and assert identical reject reasons / approved slots.
- Include invalid-input snapshots, same-bar stress, spread stress, and correlated/idiosyncratic slot
  occupancy cases.

### M5 - `clearHaltForDate` should be evidence-gated

The plan correctly requires a dump before clearing a stale halt. It should also state the evidence
needed before the write:

- current row is halted;
- halt predates M25 or is known to be caused by a leg intentionally relaxed in paper;
- current breadth is not stressed;
- operator explicitly confirms the date to clear.

This keeps the operational step from becoming a routine "clear whatever blocks trading" habit.

## What Looks Good

- Sequencing M25 after M24 is correct. Strategy/gate loosening without a working paper fill path would
  still produce zero positions.
- Activating v2 for paper exploration is supported by same-event shadow evidence; v3 is the wrong
  choice for volume because it skips catalyst flow.
- The plan correctly frames this as exploration data collection, not live-risk calibration.
- Keeping breadth auto-resume semantics untouched is a good boundary; M23 was deliberately narrow.
- Architect-first dispatch is appropriate because this changes multiple risk concepts and intentionally
  loosens a gate.
- The plan keeps the central risk gate in the path and does not propose a direct execution bypass.
- No migration is needed for P1/P2. P3 also remains migration-free only if it stays within the existing
  A/B/C slot contract.

## Recommended Dispatch Adjustment

I would split M25 into two narrower milestones or formally shrink P3:

1. **M25a - Paper strategy + stress relaxation:** activate v2, typed `PAPER_RELAX_MARKET_STRESS`,
   exact leg semantics, same-bar param adjustment, stale-halt evidence-gated clear, and exposure/capital
   profile including same-direction cap and paper equity.
2. **M25b - Paper concurrency expansion:** either stay within A/B/C and call the target "up to 3", or
   do a proper shared-contract expansion to D/E+ with shared, engine, read API, dashboard/backtest, and
   ADR updates.

If M25 stays as one plan, the must-fix edits are: remove the claim that a `MAX_IDIOSYNCRATIC_SLOTS`
override can target five positions by itself, define the exact relaxed stress-leg contract, add
`MAX_SAME_DIRECTION_EXPOSURE_USDT` / `PAPER_STARTING_EQUITY_USDT` to the profile, and update dispatch
waves if new slot labels are required.

With those corrections, the milestone becomes a useful and auditable paper-only risk-loosening wave
instead of a deceptively small change that crosses shared slot semantics.
