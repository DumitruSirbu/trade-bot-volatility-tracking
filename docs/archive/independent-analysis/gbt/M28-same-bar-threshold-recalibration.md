# Independent Review - M28 Same-Bar Threshold Recalibration

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M28-same-bar-threshold-recalibration.md`  
**Date:** 2026-06-09

## Verdict

I approve M28's direction. The plan identifies the right coupling bug: `same_bar_trigger_count` is
currently both a risk-halt threshold and an input to `classifyFlowType`, so fixing the halt by
re-seeding the strategy param would silently change MARKET_BETA routing. Moving the halt threshold to
an engine-side risk const matches the M21/M22/M23 pattern and is the right architectural boundary.

I would not dispatch M28 as written. The engage-side decoupling is solid, but the verification and
auto-resume contracts need tightening. The current historical backtest path seeds
`sameBarTriggerCount` as neutral, so it cannot prove that Jun 7 still halts. The current resume event
dedup emits at most one `MARKET_STRESS_RESUMED` per UTC day, which will hide later `same_bar` resumes.
And the proposed same-bar resume predicate checks only `same_bar_trigger_count`, which can clear a
halt on an otherwise malformed stress snapshot before the fresh engage path immediately re-halts as
`market_stress:invalid`.

## Must-Fix Before Dispatch

### H1 - The planned soak-window backtest cannot validate same-bar halts

M28's post-deploy checklist and success criteria require a backtest over the soak window that proves
routine days do not halt and Jun 7 still engages. The current backtest runner cannot provide that
evidence: it runs single-symbol replay and deliberately feeds neutral cross-symbol stress inputs.

```598:605:apps/engine/src/backtest/service/BacktestRunnerService.ts
            // Cross-symbol breadth is not reconstructable in single-symbol replay - feed the
            // neutral midpoint (no signal), NOT 0. Since M19 the breadth halt fires at
            // |breadth-50| >= STRESS_BREADTH_DISTANCE_PCT (40); a 0 here would read as |0-50|=50,
            // tripping MARKET_STRESS on bar 1, persisting the halt, and GLOBAL_HALT-ing every
            // later bar. Neutral (|50-50|=0) trips neither the halt nor classifyFlowType routing.
            marketBreadth5mUpPct: MARKET_BREADTH_NEUTRAL_PCT,
            sameBarTriggerCount: 0,
```

Live `sameBarTriggerCount` is cross-sectional and computed after evaluating every closed bar in the
same close pass:

```222:242:apps/engine/src/market-data/service/MarketDataService.ts
    // SINGLE AUTHORITY for the post-close sequence (ADR §4): evaluate the trigger for
    // each symbol that closed a bar, count same-bar triggers, emit volatility.detected
    // for those that fired, then record every closed bar for calibration. BOTH close
    // paths (tick and sweep) route here, so every graduated bar - active or quiet - is
    // evaluated, emitted, and calibrated identically. The ITriggerResult from this pass
    // is threaded into the emit so the side is never recomputed (ADR §3 ordering).
    private handleClosedBars(snapshots: IIndicatorSnapshot[]): void {
        const firedResults: { snapshot: IIndicatorSnapshot; result: ITriggerResult }[] = [];
        // ...
        const sameBarTriggerCount = firedResults.length;

        for (const { snapshot, result } of firedResults) {
            this.emitVolatilityDetected(snapshot, result, sameBarTriggerCount);
        }
```

With the current backtest sentinel, a "Jun 7 still engages" backtest will falsely pass as no same-bar
halt at all. It also cannot prove "no new trades land inside what was a genuine Jun 7-style cascade
window," because the risk gate will never see the cascade count.

Required plan change:

- Replace the generic backtest acceptance gate with a validation path that actually supplies
  per-bar same-bar counts:
  - SQL/replay from persisted `decisions.market_snapshot->same_bar_trigger_count`;
  - a dedicated cross-sectional replay over stored candles/events; or
  - an explicit M28 scope expansion to teach the backtest runner same-bar context.
- If the implementation does not add cross-symbol same-bar replay, state that the soak-window check is
  an offline SQL/event replay, not `BacktestRunnerService`.
- Add an acceptance test or script expectation that a replayed bar with count 52 engages at threshold
  20, and a replayed bar with count 12 does not.

Without this correction, M28 can ship with green backtests that did not exercise the core threshold.

### H2 - The resume event dedup still suppresses later same-day resumes

M28 correctly notices that `autoResumeMarketStress` hard-codes the resumed leg as `breadth`, but it
does not address the stronger current-code problem: resume events are deduped only by UTC date.

```614:629:apps/engine/src/risk/service/RiskGateService.ts
        if (this.autoResumeEmittedForDate === context.utcDateString) {
            return;
        }

        this.autoResumeEmittedForDate = context.utcDateString;

        const payload: IMarketStressResumedEvent = {
            triggerLeg: MARKET_STRESS_RESUME_ELIGIBLE_LEG,
            clearCount: MARKET_STRESS_RESUME_CLEAR_TICKS,
            breadthAtResume: context.snapshot.market_breadth_5m_up_pct,
            dailyReHaltCount: this.stressReHaltCount,
            utcDateString: context.utcDateString,
            nearReHaltCap: this.stressReHaltCount + 1 >= MARKET_STRESS_MAX_DAILY_REHALT,
        };

        this.events.emit(MARKET_STRESS_RESUMED_EVENT, payload);
```

That means a day can produce:

1. `market_stress:breadth` halt -> auto-resume -> one resume event.
2. Later `market_stress:same_bar` halt -> auto-resume -> no resume event, because the date was already
   marked emitted.

The same loss happens for a same-bar halt that resumes, re-halts, and resumes again before the daily
cap. This directly conflicts with M28's monitoring criterion: "On any `market_stress:same_bar` halt,
confirm a `MARKET_STRESS_RESUMED` event with `triggerLeg='same_bar'` follows."

Required plan change:

- Replace date-only resume dedup with transition-level dedup that still prevents same-tick duplicate
  emits. Acceptable shapes:
  - dedup by `{ utcDateString, triggerLeg, dailyReHaltCount }`;
  - dedup by a monotonic in-memory resume sequence for the day;
  - rely on the in-memory `day.isHalted=false` flip for same-call dedup and remove
    `autoResumeEmittedForDate` if tests prove concurrent duplicate emits cannot occur.
- Update `autoResumeMarketStress` to accept a resume profile/leg and emit the actual required tick
  count, not the breadth constant.
- Add tests for two same-day resumes:
  - breadth resume followed by same-bar resume emits two events with different `triggerLeg`;
  - same-bar resume, re-halt, same-bar resume before cap emits two resume events or intentionally
    documents why only one event is allowed.

Without this, the new same-bar resume can work in the gate while remaining invisible in telemetry.

### H3 - The same-bar resume predicate should not clear on malformed stress snapshots

M28 proposes `isSameBarStillStressed(snapshot)` that checks only `same_bar_trigger_count`, with NaN
fail-closed only for that field. That is too narrow for a halt-resolution branch. The engage path's
invalid-input guard covers all consumed stress scalars:

```153:170:apps/engine/src/risk/service/StressHaltEvaluator.ts
    // Fail-closed (ADR 0004 §6 safety): a NaN/Infinity in any consumed numeric stress input
    // is treated AS stress, never as "no stress" (a NaN comparison would otherwise be false).
    // ...
    private hasInvalidStressInputs(snapshot: IMarketSnapshot): boolean {
        const scalars = [
            snapshot.btc_5m_move_pct,
            snapshot.eth_5m_move_pct,
            snapshot.market_breadth_5m_up_pct,
            snapshot.same_bar_trigger_count,
            snapshot.open_interest_change_5m_pct,
            snapshot.funding_rate_annualized,
            snapshot.bid_ask_spread_pct,
        ];

        return scalars.some((value) => !Number.isFinite(value));
    }
```

If a day is halted as `market_stress:same_bar`, and a later snapshot has
`same_bar_trigger_count = 1` but `btc_5m_move_pct = NaN`, the M28 predicate as written will count the
tick as clean. On the second such tick it will clear the same-bar halt, emit a resume, then the fresh
engage path will immediately see invalid stress inputs and re-halt as `market_stress:invalid`.

End state is conservative, but the transition is noisy and misleading:

- a false resume event can be emitted on invalid data;
- the shared daily re-halt counter can advance because a clear/re-halt cycle was manufactured;
- `risk_state.halt_reason` changes from the original leg to `invalid`, making postmortem analysis look
  like the invalid snapshot caused the day lock rather than blocked same-bar resume.

Required plan change:

- Make the resume profile fail-closed on invalid stress input before evaluating the leg-specific clean
  predicate. This can be a public `hasInvalidStressInputs` helper, a new `isStressSnapshotMalformed`
  method, or duplicated guarded-scalar logic with tests.
- Add a test: `market_stress:same_bar` halt + clean same-bar count + NaN in another stress scalar does
  not clear the halt and does not emit `MARKET_STRESS_RESUMED`.
- Document whether breadth resume should also adopt the same invalid-input precheck for consistency.
  If not, explain the intentional asymmetry.

This keeps the M25 invariant intact: invalid inputs are never relaxed and never treated as clean.

## Should-Fix Before Dispatch

### M1 - Clarify clean "ticks" versus clean bars for the same-bar leg

The plan's rationale says same-bar pile-ons are usually a single transient bar and that "one
confirming clean bar after the spike bar is enough signal." The implementation steps reuse the M23
counter, which advances per gate evaluation, not per distinct 5-minute bar.

That distinction matters because every fired event in the same live close pass receives the same
`sameBarTriggerCount`. With `SAME_BAR_RESUME_CLEAR_TICKS = 2`, a clean close pass with two fired
symbols resumes on the second emitted event of that same close pass. That may be acceptable, but it is
not "two clean bars" and not quite "one fully observed clean bar" either; it is two clean gate
evaluations sharing one cross-sectional count.

Recommended plan change:

- State explicitly that same-bar auto-resume counts clean gate evaluations, not distinct bar closes,
  because this preserves the M23 deterministic in-process counter model.
- Add a test that pins same-close-pass behavior:
  - two same-bar-clean decisions with the same bar timestamp resume on the second decision if that is
    intended; or
  - the counter advances only once per distinct bar timestamp if the intended signal is clean bars.
- If bar-level semantics are desired, the plan needs a small state key such as
  `lastSameBarResumeBarOpenMs` so multiple decisions in one bar cannot advance the counter more than
  once.

### M2 - Same-bar resume telemetry should include the same-bar count

`IMarketStressResumedEvent` currently carries `breadthAtResume`, but no same-bar metric:

```1:8:packages/shared/src/interface/IMarketStressResumedEvent.ts
export interface IMarketStressResumedEvent {
    triggerLeg: string;
    clearCount: number;
    breadthAtResume: number;
    dailyReHaltCount: number;
    utcDateString: string;
    nearReHaltCap: boolean;
}
```

M28 only requires `triggerLeg='same_bar'`. That is enough to distinguish the leg, but not enough to
verify the resume predicate in downstream logs/readers. The post-deploy checklist asks operators to
confirm same-bar count dropped below 12; the event does not carry that count.

Recommended plan change:

- Either widen the shared event through `bot-shared-maintainer` with a backward-compatible nullable
  field such as `sameBarTriggerCountAtResume: number | null`, or add a generic
  `stressMetricAtResume` shape.
- If no shared change is desired, at least require the WARN log to include
  `same_bar_trigger_count` for same-bar resumes and update the monitoring instructions to use logs,
  not event payloads.

### M3 - Update stale M25 comments/tests that say same-bar is governed by the strategy param

Current M25 comments and tests explicitly encode the old contract:

```23:26:apps/engine/src/risk/service/StressHaltEvaluator.ts
// M25 (ADR 0042 §2) - the global stress legs that the paper exploration profile SKIPS when
// PAPER_RELAX_MARKET_STRESS is effective. Breadth and same_bar are intentionally absent: breadth
// keeps M23 engage + auto-resume, same_bar is relaxed only via its strategy param. The
// invalid-inputs guard is not a leg here - it is evaluated before, and independent of, the relax
```

M28 changes that: same-bar halt engage is no longer governed by the strategy param, while
`classifyFlowType` still is. The tests under `StressHaltEvaluator.m25.spec.ts` also assert the old
param-governed same-bar halt behavior.

Recommended plan change:

- Add an explicit implementation step to update these comments and M25 regression tests, not only the
  new M28 tests.
- Preserve a test proving `PAPER_RELAX_MARKET_STRESS` still does not relax same-bar, but make it assert
  against `STRESS_SAME_BAR_HALT_COUNT`, not `params.stress_same_bar_trigger_count`.

## Suggested Dispatch Shape

The plan is close, but I would amend it before implementation:

1. Engine implementation may stay code-only, but the verification story must not depend on the current
   single-symbol `BacktestRunnerService` for same-bar evidence.
2. The RiskGate resume helper should return a full profile:
   `{ leg, isStillStressed, requiredTicks, metricAtResume }`, and the auto-resume method should use
   that profile for log/event values.
3. Resume-event dedup should be transition-scoped, not day-scoped.
4. Same-bar clean-count semantics should be locked by tests: either event-ticks by design or distinct
   bar closes by design.

With those corrections, M28 is a good conservative calibration step: it removes a known false day-lock
source without weakening the central risk gate or touching the shared strategy-param contract.
