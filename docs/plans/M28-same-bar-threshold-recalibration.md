# M28 — Same-bar stress threshold recalibration + auto-resume wiring

> **Sequencing note:** M28 is a standalone calibration fix in the market-stress halt arc
> (M21 index-shock horizon → M22 depth floors → M23 breadth auto-resume → **M28 same-bar**). It
> repeats the M21/M22/M23 pattern: an empirically-driven threshold move plus an extension of the
> M23 auto-resume mechanism to one more leg. **Code-only and migration-free** — no schema change,
> no shared-package change, no DB write at rest. An engine restart picks it up. The CLAUDE.md
> DB-safety invariants (#8/#9) still apply to the pre-restart pg_dump, but there is no migration.

## Goal

Stop the `market_stress:same_bar` halt from burning whole trading days on routine correlated
sessions: raise the engage threshold to a true-cascade level and wire the `same_bar` leg into the
M23 consecutive-clean-tick auto-resume so a transient pile-on resumes after the spike resolves
instead of locking to UTC rollover.

## Problem

`same_bar_trigger_count >= 5` fires a full-day `market_stress:same_bar` halt when 5+ symbols
trigger VWAP in the same 5-min bar. It was meant to detect a coordinated market-wide macro shock
(a cascade), not idiosyncratic co-movement. With ~100 active symbols, threshold=5 means a **5%
co-trigger rate halts the entire UTC day** — which is normal correlated behaviour in crypto, not a
cascade.

**Soak evidence (last 14 days, partial Jun 9):**

| Day   | Max same-bar | Avg  | Bars ≥ 5     | Total decisions | Halted? |
|-------|--------------|------|--------------|-----------------|---------|
| Jun 9 | 10           | 4.1  | (partial)    | —               | —       |
| Jun 7 | 52           | 17.3 | 95/191 (50%) | 191             | yes     |
| Jun 6 | 12           | 2.6  | 12/118 (10%) | 118             | no      |
| Jun 5 | 26           | 6.3  | 81/203 (40%) | 203             | no\*    |
| Jun 4 | 30           | 10.6 | 83/201 (41%) | 201             | no\*    |
| Jun 3 | 11           | 3.1  | 30/184 (16%) | 184             | yes     |

\*Jun 4/5 — a halt may have fired mid-day or not persisted across a restart.

> **Jun 3 halt attribution (do not over-claim).** Jun 3 shows `halted=yes` at same-bar max=11.
> **11 is below the new engage threshold (20), so M28 does not "fix" Jun 3 via the same-bar leg** —
> that day's halt was driven by a different leg (breadth/index/loss), not same-bar saturation. The
> post-deploy backtest (step 4) must not be scored on "Jun 3 same-bar halt avoided"; only the
> same-bar-attributed halts (Jun 7-style) are in M28's blast radius. Confirm Jun 3's persisted
> `halt_reason` suffix before drawing any conclusion.

Reading the distribution: **Jun 9 max=10 and Jun 6 max=12 are routine** (Jun 6 ran 118 decisions
with no halt and no harm). **Jun 4 max=30 / Jun 5 max=26 are elevated correlated sessions.**
**Jun 7 peak=52 is the genuine cascade** — 50% of bars above the old floor. At threshold=5 the
detector cannot tell a 5% routine co-trigger from a 52-symbol cascade; it treats both as a panic
and locks the day. The real cascade signal lives far higher — around the **15–20+** band, well
clear of the routine 10–12 ceiling.

### Code-verified current state

- **Threshold is a strategy param, not an engine const.** The engage check is
  `snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count`
  (`StressHaltEvaluator.activeStressLegs`, the `HALT_LEG_SAME_BAR` branch). The param seeds at
  `stress_same_bar_trigger_count: 5` (`SeedStrategyVersions` migration) and is validated
  `z.number().min(1)` (`strategyParamsSchema`).
- **The same param ALSO drives flow classification.** `classifyFlowType` routes `MARKET_BETA` on
  `marketBreadth5mUpPct > stress_breadth_pct && sameBarTriggerCount >= stress_same_bar_trigger_count`
  (`packages/shared/src/util/classifyFlowType.ts:50`). Re-seeding the param to fix the halt would
  **silently change flow classification** — the exact coupling ADR 0004 §6b called out for breadth
  and resolved by moving the halt threshold engine-side (`STRESS_BREADTH_DISTANCE_PCT`).
- **The suffix already exists.** `HALT_LEG_SAME_BAR = 'same_bar'` is defined and
  `classifyHaltLeg` already enumerates the `same_bar` engage path, so `persistHalt` already writes
  `market_stress:same_bar` (ADR 0004 §6d table row is live).
- **`same_bar` is NOT resume-eligible today.** `isBreadthAutoResumeEligible` matches only
  `market_stress:${MARKET_STRESS_RESUME_ELIGIBLE_LEG}` where the eligible leg is `breadth`. A
  `same_bar` halt falls straight through to the full-day lock.
- **The resume predicate is breadth-only.** `isGlobalStressed(snapshot)` evaluates only
  `market_breadth_5m_up_pct` against `MARKET_STRESS_RESUME_BREADTH_DISTANCE`; it has no notion of
  `same_bar`.

## Architectural decisions

### D1 — Move the halt threshold engine-side and raise it to 20 (`STRESS_SAME_BAR_HALT_COUNT = 20`)

Add a new risk-only engine const `STRESS_SAME_BAR_HALT_COUNT = 20` in `riskConsts.ts` and switch
the `HALT_LEG_SAME_BAR` engage branch to compare against it instead of
`params.stress_same_bar_trigger_count`.

**Rationale (decoupling):** risk config lives engine-side (ADR 0004 Conflicts #1), and the
strategy param is load-bearing for `classifyFlowType` MARKET_BETA routing. This is identical to
the breadth fix in §6b: the **halt reads the const; flow classification reads the param; neither
sees the other.** The param `stress_same_bar_trigger_count` stays at **5** and remains consumed
**only** by `classifyFlowType` — it is no longer read by the halt path. Do not re-couple them.

**Rationale (value = 20):** the threshold must cleanly separate "coordinated macro shock" from
"normal correlated session". On the 14-day tape:

- Routine ceiling: Jun 9 max=10, Jun 6 max=12 (118 decisions, no halt, no harm). A threshold ≤ 12
  keeps mis-firing on these.
- Elevated-but-tradeable: Jun 4 max=30, Jun 5 max=26 — correlated but not panic; these are exactly
  the days where a brief halt + auto-resume (D2) is the right shape, not a day-lock.
- True cascade: Jun 7 peak=52, avg 17.3, 50% of bars hot.

**20** sits clearly above the routine ceiling (12) with an 8-count buffer, engages on the genuine
cascade days (Jun 4/5/7 all peak well above 20), and represents ~20% simultaneous co-trigger on a
~100-symbol universe — a real market-wide pile-on, not a 5% correlated drift. 15 was considered and
rejected: it leaves only a 3-count buffer over Jun 6's routine max=12 and would have engaged on
the calm Jun 6 tape. 25+ was rejected: it would miss the elevated Jun 4/5 sessions entirely, which
*should* halt-then-resume rather than trade straight through a 26–30 pile-on.

> **Calibration status (honest).** 20 is a **distribution-separated starting point** from a 14-day
> single-regime soak, NOT a validated calibration — same caveat ADR 0004 §6d carries for the
> breadth N. The 14-day post-deploy soak (and the per-bar same-bar series) re-confirms or re-tunes
> it. Logged as tech-debt alongside the existing breadth-N per-bar autocorrelation item.

### D2 — Wire `same_bar` into the M23 auto-resume (N=2 clean ticks)

Make `market_stress:same_bar` resume-eligible by extending the M23 mechanism — **not** redesigning
it. The eligibility predicate, the resume predicate, and the clean-tick counter all follow the
breadth pattern:

- **Eligibility:** generalise `isBreadthAutoResumeEligible` to recognise **two** resume-eligible
  suffixes — `market_stress:breadth` and `market_stress:same_bar`. `:multi`, `:invalid`, every
  other leg, the bare legacy `market_stress`, and all loss-based reasons stay full-day locked
  (unchanged). Most-conservative-leg-wins is preserved: a `same_bar`+anything snapshot classifies
  `:multi` and locks (unchanged §6d behaviour).
- **Resume predicate (the new bit):** add `isSameBarStillStressed(snapshot)` to
  `StressHaltEvaluator`, mirroring `isGlobalStressed`. It checks **only** the `same_bar` leg at a
  **resume** threshold distinct from engage, with NaN fail-closed: a non-finite
  `same_bar_trigger_count` is treated **as stressed** (counter reset). **Malformed-snapshot
  precheck (locked, mirrors `isGlobalStressed`).** Before evaluating the leg-specific count, the
  resume path must fail-closed on **any** invalid stress scalar, not just `same_bar_trigger_count`.
  Reuse the engage-side `hasInvalidStressInputs` guard (promote it to a callable helper if it is
  private): if **any** consumed stress scalar (`btc_5m_move_pct`, `eth_5m_move_pct`,
  `market_breadth_5m_up_pct`, `same_bar_trigger_count`, `open_interest_change_5m_pct`,
  `funding_rate_annualized`, `bid_ask_spread_pct`) is non-finite, treat the tick as **still
  stressed** (counter reset, no resume, no event). Without this, a snapshot with `same_bar=1` but
  `btc_5m_move_pct=NaN` would count as clean, resume the halt, emit a spurious
  `triggerLeg='same_bar'` resume event, advance the shared re-halt counter, and then immediately
  re-halt as `market_stress:invalid` — a misleading, noisy transition that also corrupts postmortem
  attribution. `isGlobalStressed` already applies this multi-scalar NaN guard; `isSameBarStillStressed`
  matches it for symmetry. The resume threshold is
  `STRESS_SAME_BAR_RESUME_COUNT = 12` — a clean tick is `same_bar_trigger_count < 12`, i.e. back
  inside the routine band the soak showed is harmless. The 8-count hysteresis gap between engage
  (20) and resume (12) stops chatter at the boundary, exactly like the breadth 40→30 inner-band gap.
- **Counter / confirmation:** the existing in-memory clean-tick counter is reused, but resume for
  `same_bar` requires **`SAME_BAR_RESUME_CLEAR_TICKS = 2`** consecutive clean ticks — shorter than
  breadth's 3. A same-bar pile-on is overwhelmingly a **single transient bar**: the spike appears,
  then the next bar resolves (Jun 9 avg 4.1 against a max of 10; Jun 6 avg 2.6 against max 12). One
  confirming clean bar after the spike bar is enough signal; requiring 3 would needlessly burn two
  extra bars of opportunity for a leg that is structurally less persistent than breadth.

  > **"Tick" = gate evaluation, not distinct bar (locked, inherited from §6d).** The counter
  > advances **per gate evaluation**, exactly as the M23 breadth counter does — it is NOT a
  > distinct-bar-close counter. Because every symbol fired in one close pass shares the same
  > cross-sectional `same_bar_trigger_count`, two clean decisions in the **same** close pass can
  > satisfy `SAME_BAR_RESUME_CLEAR_TICKS = 2` and resume within that pass. This is the intended,
  > deterministic behaviour (it matches breadth's `N=3` gate-evaluation semantics — see §6d
  > "In-process tick counting, not cron"); M28 does **not** introduce a per-bar dedup key. A test
  > pins this: two clean same-bar decisions sharing one bar timestamp resume on the second decision.
  > Bar-level semantics (a `lastSameBarResumeBarOpenMs` key) is explicitly out of scope.

**Per-day re-halt cap (same as breadth): yes, 3.** Reuse `MARKET_STRESS_MAX_DAILY_REHALT = 3`. A
tape oscillating in and out of a 20+ pile-on three times in one UTC day is itself a regime signal —
the conservative day-lock should reassert on the 3rd re-halt, identical to breadth. The in-memory
re-halt counter is **shared** across breadth and same_bar (it already counts every `market_stress`
re-halt, not a per-leg count — see the `firstFailingHaltCheck` engage-counter increment). M28 does
not split it per-leg; a combined cascade-chatter budget of 3/day is the intended conservative shape.

### D3 — `halt_reason` suffix: `market_stress:same_bar` (verified, unchanged)

The suffix already exists and is already written. The ONLY change is that the resume-eligibility
check now matches it. The engage writer (`buildPersistedHaltReason` → `classifyHaltLeg`), the
resume parser (the generalised eligibility predicate), and the §6d telemetry vocabulary stay in
sync. The §6d `halt_reason` table row for `market_stress:same_bar` flips from "full-day lock" to
"resume-eligible" — the ADR amendment (§6e) records this.

### D4 — Config flag: reuse `MARKET_STRESS_AUTO_RESUME_ENABLED` (no new flag)

Do **not** add a `SAME_BAR_AUTO_RESUME_ENABLED` flag. The M23 flag
`MARKET_STRESS_AUTO_RESUME_ENABLED` is the master switch for the whole adaptive-resume mechanism
(`marketStressAutoResumeEnabled`, paper-default-on / live-default-off, derived from `EXCHANGE_ENV`
when unset). `same_bar` resume rides under the same flag: when the flag is off, both breadth and
same_bar keep the pre-M23 full-day lock; when on, both are resume-eligible. One master switch for
one mechanism is the correct granularity — a second flag would let the two legs diverge with no
operational reason to. The flag stays read-once-at-boot (determinism invariant preserved).

### D5 — Threshold values are engine consts (not strategy params, not env)

`STRESS_SAME_BAR_HALT_COUNT` (20), `STRESS_SAME_BAR_RESUME_COUNT` (12), and
`SAME_BAR_RESUME_CLEAR_TICKS` (2) are all engine consts in `riskConsts.ts` — same home and
rationale as `STRESS_BREADTH_DISTANCE_PCT` / `MARKET_STRESS_RESUME_BREADTH_DISTANCE` /
`MARKET_STRESS_RESUME_CLEAR_TICKS`. Risk config lives engine-side; this keeps the shared
strategy-params schema unchurned and keeps the halt threshold off the param that `classifyFlowType`
reads.

### D6 — Resume-event dedup must become per-transition, not per-UTC-day

**Code-verified pre-existing bug surfaced by M28.** `autoResumeMarketStress` dedups the
`MARKET_STRESS_RESUMED` emit on `autoResumeEmittedForDate === context.utcDateString` — **at most one
resume event per UTC day.** With breadth as the only resume-eligible leg this was tolerable; M28 adds
a second eligible leg, so the day can legitimately produce two distinct resumes (a breadth resume
then a same_bar resume, or a same_bar resume → re-halt → same_bar resume before the cap). Under the
day-only dedup, **the second resume fires no event** — which directly breaks M28's own monitoring
criterion ("on any `market_stress:same_bar` halt, confirm a `MARKET_STRESS_RESUMED` event with
`triggerLeg='same_bar'` follows"). The same_bar resume would work in the gate yet be invisible in
telemetry.

**Decision:** replace the date-only dedup with **per-transition** dedup that still blocks a
same-tick duplicate emit. The narrowest correct form: dedup on the actual HALTED→RUNNING transition
(the same-call `mutableDay.isHalted` flip already guards re-entry within one tick), so each genuine
resume emits exactly one event regardless of how many resumes occur that day. Acceptable equivalent:
key the dedup on `{ utcDateString, triggerLeg, dailyReHaltCount }`. **Do not** keep day-only dedup.
This is in M28 scope because M28 is the change that makes a second same-day resume reachable.

### D7 — `RiskListeners` must clear the halt flag for the same_bar leg

**Code-verified functional gap.** `RiskListeners.onMarketStressResumed` early-returns unless
`event.triggerLeg === MARKET_STRESS_RESUME_ELIGIBLE_LEG` (the single `breadth` const), logging
`marketStress.autoResume.unexpectedLeg`. If left unchanged, a successful `same_bar` **DB** resume
clears `risk_state` but leaves the in-memory `HaltFlagService` halted — so `GET /v1/control/halt`
keeps reporting halted and the alert path skips the flag clear. The decision-path resume works while
the operator/control surface lies. **Decision:** generalise the listener's leg check to the
membership test `MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(event.triggerLeg)` (same set used by the gate
eligibility predicate), so any resume-eligible leg clears the flag. `RiskListeners.ts` enters M28
scope.

## Scope

### What changes

1. `apps/engine/src/risk/const/riskConsts.ts` — three new consts; `MARKET_STRESS_RESUME_ELIGIBLE_LEG`
   generalised to a set (or a sibling const) covering breadth + same_bar.
2. `apps/engine/src/risk/service/StressHaltEvaluator.ts` — `same_bar` engage branch reads the new
   const; new `isSameBarStillStressed(snapshot)` resume predicate.
3. `apps/engine/src/risk/service/RiskGateService.ts` — eligibility predicate recognises both
   resume-eligible suffixes; the resume branch evaluates the correct per-leg resume predicate and
   the correct per-leg clean-tick confirmation count; the resume-event dedup becomes per-transition
   (D6); the `autoResumeMarketStress` log + `MARKET_STRESS_RESUMED` payload carry the actual resumed
   leg and the leg-selected clean-tick count (`triggerLeg` + `clearCount`), not the hard-coded
   breadth values.
4. `apps/engine/src/alert/listeners/RiskListeners.ts` — `onMarketStressResumed` leg check
   generalised to `MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(event.triggerLeg)` so a same_bar resume
   clears the in-memory halt flag (D7).
5. `apps/engine/src/risk/service/StressHaltEvaluator.ts` (comments) + the M25 spec
   (`StressHaltEvaluator.m25.spec.ts`) — the stale comment/test asserting same_bar engage is
   "relaxed only via its strategy param" is updated to the const-governed contract; the test proving
   `PAPER_RELAX_MARKET_STRESS` still does **not** relax same_bar is rewritten to assert against
   `STRESS_SAME_BAR_HALT_COUNT`, not `params.stress_same_bar_trigger_count`.
6. ADR 0004 — §6e (already drafted) confirmed; §6d `halt_reason` table row for `:same_bar` and the
   §6d **fail-safe parse prose** updated so they no longer list `:same_bar` as full-day-locked.
   ADR 0042 §2 / §appendix param-lever rows that still say "raise `stress_same_bar_trigger_count`"
   amended to point at the engine const `STRESS_SAME_BAR_HALT_COUNT` (the param no longer governs
   the halt).

### What does NOT change

- **No schema migration, no shared-package change, no DB write at rest.** Code + ADR only.
- `params.stress_same_bar_trigger_count` stays seeded at **5** and stays consumed **only** by
  `classifyFlowType` (MARKET_BETA routing) — untouched, not re-coupled to the halt.
- The breadth resume path (threshold 40/30, N=3) is **unchanged**.
- `MARKET_STRESS_MAX_DAILY_REHALT = 3` is **unchanged** and stays shared across legs.
- `classifyHaltLeg` / `buildPersistedHaltReason` / the `:same_bar` suffix string — unchanged.
- The engage-side `hasInvalidStressInputs` NaN fail-closed guard (already covers
  `same_bar_trigger_count`) — unchanged.
- The M25 paper-relax set — `same_bar` is intentionally **never** in `PAPER_RELAXABLE_LEGS` and
  stays out; M28 does not relax the engage, it recalibrates it (ADR 0042 §2 invariant intact).

## Implementation steps (ordered, for `bot-engine-nestjs`)

1. **`riskConsts.ts` — add three consts** in the `--- global market-stress halt (§6) ---` /
   `--- market-stress adaptive resume (§6d, M23) ---` blocks, each with a doc comment citing
   ADR 0004 §6e and the soak evidence:
   - `STRESS_SAME_BAR_HALT_COUNT = 20` — engage threshold (decouples from the strategy param;
     comment the routine-12 / cascade-52 separation).
   - `STRESS_SAME_BAR_RESUME_COUNT = 12` — resume inner-band ceiling; a clean tick is `< 12`.
   - `SAME_BAR_RESUME_CLEAR_TICKS = 2` — consecutive clean ticks before same_bar auto-resume.
2. **`riskConsts.ts` — resume-eligible legs.** Replace the single
   `MARKET_STRESS_RESUME_ELIGIBLE_LEG` with a set the gate can membership-test —
   `MARKET_STRESS_RESUME_ELIGIBLE_LEGS: ReadonlySet<string> = new Set([HALT_LEG_BREADTH, HALT_LEG_SAME_BAR])`.
   Keep the old single const as a deprecated alias only if a test references it; otherwise update
   call sites. **Both `RiskGateService` (eligibility predicate) and `RiskListeners` (flag-clear leg
   check) import this set** — update both consumers, not just the gate.
3. **`StressHaltEvaluator.ts` — engage branch.** In `activeStressLegs`, change the `HALT_LEG_SAME_BAR`
   branch comparison from `params.stress_same_bar_trigger_count` to `STRESS_SAME_BAR_HALT_COUNT`.
   Remove the now-unused `params` read **only** for this leg (params is still passed for the
   signature / other legs — do not drop the parameter).
4. **`StressHaltEvaluator.ts` — resume predicate.** Add `isSameBarStillStressed(snapshot): boolean`
   directly below `isGlobalStressed`, mirroring its shape:
   - **Multi-scalar malformed precheck first (D6/H3):** if `hasInvalidStressInputs(snapshot)` is
     true (ANY consumed stress scalar non-finite, not just `same_bar_trigger_count`), return `true`
     (stressed → counter reset, no resume). Promote `hasInvalidStressInputs` from private to a
     callable helper if needed; do not duplicate the scalar list. This matches `isGlobalStressed`'s
     own multi-scalar NaN guard and keeps the M25 invalid-inputs-never-relaxed invariant intact.
   - Otherwise `return snapshot.same_bar_trigger_count >= STRESS_SAME_BAR_RESUME_COUNT`.
   - Doc comment: resume threshold is distinct from engage (12 vs 20 hysteresis), and this predicate
     plays no role in the breadth resume path.
5. **`RiskGateService.ts` — eligibility predicate.** Rename/generalise `isBreadthAutoResumeEligible`
   to `isStressLegAutoResumeEligible(haltReason)`: returns false when the flag is off; otherwise
   `MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(<leg parsed from haltReason after 'market_stress:'>)`.
   Parse the leg from the suffix exactly as §6d specifies (split on first colon; bare
   `market_stress` → not eligible).
6. **`RiskGateService.ts` — resolveDayHalt resume branch.** Where it currently calls
   `this.stress.isGlobalStressed(...)` and compares `stressClearCount` against
   `MARKET_STRESS_RESUME_CLEAR_TICKS`, select the predicate **and** the confirmation count **by the
   eligible leg**:
   - parse the leg from `day.haltReason`;
   - if leg is `breadth` → predicate `isGlobalStressed`, required ticks `MARKET_STRESS_RESUME_CLEAR_TICKS` (3);
   - if leg is `same_bar` → predicate `isSameBarStillStressed`, required ticks `SAME_BAR_RESUME_CLEAR_TICKS` (2).

   Keep this a small pure helper (e.g. `resumeProfileFor(leg): { isStillStressed, requiredTicks }`)
   so `resolveDayHalt` stays one level of abstraction (conventions §Functions). The clean-tick
   counter, the per-day re-halt cap check, the `autoResumeMarketStress` clear/emit, and the
   in-memory day-row flip are all **unchanged** — only the predicate + required-tick count are
   leg-parameterised.
7. **`RiskGateService.ts` — resume log + emit leg + clean-tick count.** The `autoResumeMarketStress`
   WARN log and the `IMarketStressResumedEvent` payload currently hard-code
   `MARKET_STRESS_RESUME_ELIGIBLE_LEG` (`breadth`) for `triggerLeg` and `MARKET_STRESS_RESUME_CLEAR_TICKS`
   (3) for `clearCount`. Pass the actual resumed leg (parsed from `day.haltReason`) **and** the
   leg-selected required-tick count from `resumeProfileFor(leg)` so a `same_bar` resume logs/emits
   `triggerLeg: 'same_bar'`, `clearCount: 2` — not `breadth`/`3`. `breadthAtResume` stays in the
   payload but is leg-irrelevant for a same_bar resume (carry the snapshot value as-is; do not invent
   a new field — see step 9). (Telemetry correctness — no decision-path change.)
8. **`RiskGateService.ts` — per-transition resume dedup (D6).** Replace the day-only
   `autoResumeEmittedForDate === context.utcDateString` guard so two genuine same-day resumes (e.g.
   breadth then same_bar, or same_bar → re-halt → same_bar) each emit exactly one event, while a
   same-tick duplicate is still suppressed. Prefer relying on the same-call `mutableDay.isHalted`
   flip for same-tick dedup; if a residual guard is kept, key it on `{ utcDateString, triggerLeg,
   dailyReHaltCount }`. Do not regress to one-event-per-day.
9. **`RiskListeners.ts` — leg check (D7).** Replace the single-leg
   `event.triggerLeg !== MARKET_STRESS_RESUME_ELIGIBLE_LEG` early-return with
   `if (!MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(event.triggerLeg)) { warn; return; }` so a same_bar
   resume clears the in-memory halt flag and notates `HaltService`. Everything else in the handler
   (the restart-safe `isHalted()` guard before `resume()`) is unchanged.
10. **M25 comment + spec refresh.** Update the `StressHaltEvaluator.ts` M25 comment block that says
    same_bar "is relaxed only via its strategy param" to state the M28 const-governed contract.
    Rewrite the `StressHaltEvaluator.m25.spec.ts` case that asserts param-governed same_bar engage so
    it asserts against `STRESS_SAME_BAR_HALT_COUNT`; keep a case proving `PAPER_RELAX_MARKET_STRESS`
    still does not relax same_bar.
11. **Verify the shared `IMarketStressResumedEvent` accepts an arbitrary leg string.** It already
    carries `triggerLeg: string` (M23) — no union widening needed (confirmed in
    `packages/shared/src/interface/IMarketStressResumedEvent.ts`). Adding a same-bar-count field is
    **out of scope** (would be a shared-package change); the same_bar count is surfaced via the WARN
    log instead (step 7). If a future reader wants a typed field, route it through
    `bot-shared-maintainer` in a separate milestone.

## Config changes

- **No new env var.** Reuse `MARKET_STRESS_AUTO_RESUME_ENABLED` (already in
  `EnvironmentVariables.ts` / `AppConfigService.marketStressAutoResumeEnabled`, paper-default-on,
  live-default-off). No boot-validation change.
- **No new strategy param, no schema change.** `stress_same_bar_trigger_count` stays at 5 for
  `classifyFlowType`.
- The three new thresholds are engine consts (D5), not configurable at runtime — consistent with
  every other M21/M22/M23 stress threshold.

## Tests required (for `bot-qa-engineer`)

**Unit — `StressHaltEvaluator`:**
- `same_bar` engages at exactly `STRESS_SAME_BAR_HALT_COUNT` (boundary: count = 20 → stressed;
  count = 19 → not stressed on the same_bar leg).
- `same_bar` engage now reads the const, **not** the param: a snapshot with count=10 and
  `params.stress_same_bar_trigger_count=5` does **not** engage same_bar (regression-locks the
  decoupling — this is the core M28 behaviour change).
- `classifyHaltLeg` still returns `same_bar` for a sole-same_bar engage at the new threshold; still
  returns `multi` when same_bar engages with another leg.
- `isSameBarStillStressed`: clean at count=11 (< 12 → false), still-stressed at count=12
  (>= 12 → true), still-stressed at count=20.
- `isSameBarStillStressed` NaN fail-closed on the leg field: `NaN`/`Infinity`
  `same_bar_trigger_count` → `true`.
- `isSameBarStillStressed` **multi-scalar** malformed precheck (D6/H3): a snapshot with a clean
  `same_bar_trigger_count` (e.g. 1) but `NaN`/`Infinity` in **another** stress scalar
  (`btc_5m_move_pct`, `eth_5m_move_pct`, `market_breadth_5m_up_pct`, OI, funding, spread) → `true`
  (still stressed, does NOT count clean).
- Hysteresis: count=15 (between resume-12 and engage-20) is "not clean enough to resume" (predicate
  returns true) yet below engage — locks in the buffer behaviour.
- Base `StressHaltEvaluator.spec.ts` refresh: the legacy "engages at `>= stress_same_bar_trigger_count`"
  case is updated/duplicated to assert engage at `STRESS_SAME_BAR_HALT_COUNT` (the param case is
  removed from the engage path).
- M25 regression: `PAPER_RELAX_MARKET_STRESS` still does not relax same_bar, asserted against
  `STRESS_SAME_BAR_HALT_COUNT` (not the param).

**Unit — `RiskGateService` (the auto-resume branch):**
- `market_stress:same_bar` halt + 2 consecutive clean same_bar ticks (count < 12) → auto-resumes
  on the 2nd clean tick; a single clean tick does **not** resume.
- `market_stress:same_bar` halt + a non-clean tick mid-window resets the counter to 0.
- `market_stress:breadth` still requires 3 clean breadth ticks (regression: breadth profile
  unchanged; a same_bar-style 2-tick resume must NOT shorten breadth).
- Mixed: a `same_bar` clean tick must not advance a `breadth` halt's resume (and vice versa) — the
  predicate/required-ticks are selected by the persisted leg.
- `market_stress:multi`, `market_stress:invalid`, bare `market_stress`, every loss reason → **no**
  same_bar resume (full-day lock preserved).
- Per-day re-halt cap: a 3rd `market_stress` re-halt in one UTC day (any mix of breadth/same_bar)
  → full-day lock for the rest of the day.
- Flag off (`MARKET_STRESS_AUTO_RESUME_ENABLED=false`): `same_bar` halt stays full-day locked.
- `IMarketStressResumedEvent.triggerLeg` is `same_bar` **and** `clearCount` is `2` on a same_bar
  resume (telemetry — pins step 7's leg-selected count, not the hard-coded breadth 3).
- **Two same-day resumes emit two events (D6 dedup fix):** a breadth resume followed by a same_bar
  resume in the same UTC day emits **two** `MARKET_STRESS_RESUMED` events with distinct `triggerLeg`;
  a same_bar resume → re-halt → same_bar resume (before the cap) emits two events. A same-tick
  duplicate still emits only once.
- **Same-tick resume → re-engage:** resume on tick T, then `same_bar_trigger_count >= 20` on the
  same evaluation after clear → re-halt + re-halt counter increment (parallel to the M23 breadth
  same-tick test).
- **Same-close-pass resume (tick semantics, M1):** two clean same_bar decisions sharing one bar
  timestamp resume on the **second** decision (counter advances per gate evaluation, not per
  distinct bar).
- **Malformed-snapshot does not resume (D6/H3):** `market_stress:same_bar` halt + clean
  `same_bar_trigger_count` + `NaN` in another stress scalar → halt is **not** cleared and **no**
  `MARKET_STRESS_RESUMED` event fires (and no spurious `:invalid` re-halt is manufactured from a
  false resume).

**Unit — `RiskListeners` (D7):**
- `onMarketStressResumed` with `triggerLeg: 'same_bar'` clears the in-memory halt flag and notates
  `HaltService` (regression for the current breadth-only early-return).
- `onMarketStressResumed` with `triggerLeg: 'breadth'` still clears (unchanged).
- An unrecognised `triggerLeg` still logs `unexpectedLeg` and skips the flag clear.
- Restart-safe guard preserved: event delivered while flag already unset does not clobber
  `HaltService` state.

**Integration / replay:**
- A same_bar engage at count=20 persists `risk_state.halt_reason='market_stress:same_bar'`,
  `is_halted=true`; after `SAME_BAR_RESUME_CLEAR_TICKS` clean ticks the row clears
  (`is_halted=false`, `halt_reason=null`) and a later coin in the same tick is no longer rejected
  on the day-halt branch.
- Determinism: same snapshot sequence → same resume decision (no wall-clock/RNG in the path).

## Post-deploy checklist

1. **pg_dump before restart** (CLAUDE.md #9): `docker compose exec postgres pg_dump …` into
   `backups/`, then prune to the 2 most recent. **No migration** — restart only.
2. **Stale-halt inspection.** Query `risk_state WHERE halt_reason='market_stress:same_bar' AND
   is_halted=true` for the current UTC day. Clear it via the evidence-gated `clearHaltForDate` when
   the current `same_bar_trigger_count` is back inside the **resume band (< 12)** — this covers both
   (a) a halt persisted from the old threshold=5 lock on a now-calm tape **and** (b) a halt that
   engaged at count 15–19 under the new threshold but is now below the resume band. Do **not** clear
   a day still reading `>= 12` (it is not yet stale under the new engage/resume bands).
3. **10-min live smoke.** Engine boots clean (no module cycle), zero errors/warnings, gate
   evaluates triggers. Confirm `marketStressAutoResumeEnabled` resolved on (paper).
4. **Same-bar verification — offline replay, NOT `BacktestRunnerService` (H1).**
   `BacktestRunnerService` runs **single-symbol** replay and deliberately feeds neutral cross-symbol
   stress (`sameBarTriggerCount: 0`), so it **cannot** exercise the same_bar halt — a "Jun 7 still
   engages" run through it would falsely pass with zero same_bar halts. Verify same_bar instead via
   an **offline SQL/event replay** that supplies real per-bar counts, sourced from persisted
   `decisions.market_snapshot->>'same_bar_trigger_count'` over the soak window. Acceptance
   assertions: a replayed bar with count **52 engages** at `STRESS_SAME_BAR_HALT_COUNT = 20`; a
   replayed bar with count **12 does not** engage; routine days (max ≤ 12) produce **no** same_bar
   halt; the Jun 7 cascade still engages and no new trade lands inside the Jun 7 cascade window.
   Teaching `BacktestRunnerService` cross-sectional same_bar context is **out of scope** for M28
   (a separate backtest-runner milestone). Only the same_bar-attributed days are in scope — **not**
   Jun 3 (a non-same_bar halt; see the soak table note).
5. **24–48h monitoring:**
   - `same_bar` halts now fire only on genuine cascades (expect near-zero on routine 10–12 days).
   - On any `market_stress:same_bar` halt, confirm a `MARKET_STRESS_RESUMED` event with
     `triggerLeg='same_bar'` (and `clearCount=2`) follows within ~2 bars once count drops below 12,
     and that `GET /v1/control/halt` flips back to `running` (verifies the D7 `RiskListeners` clear).
   - Confirm a same-day breadth-then-same_bar (or same_bar→re-halt→same_bar) sequence emits **two**
     distinct resume events (verifies the D6 dedup fix — under the old day-only dedup the second was
     silently dropped).
   - Watch the shared per-day re-halt cap — if breadth+same_bar combined hit 3/day, confirm the
     full-day lock reasserts (intended).
   - **Funnel/analysis SQL prefix-match audit.** Any soak/funnel query in `packages/analysis` (or a
     monitoring dashboard) that filters `halt_reason = 'market_stress'` exactly will **miss** the
     suffixed `market_stress:same_bar` rows (the M23 lesson). Confirm leg-split queries use a prefix
     match (`LIKE 'market_stress%'`) and that `market_stress:same_bar` appears in any per-leg halt
     breakdown.
6. **14-day paper soak** before considering live activation of the same_bar resume (live keeps the
   flag default-off regardless).

## Success criteria — "M28 done"

- `same_bar` engages on `STRESS_SAME_BAR_HALT_COUNT = 20` (engine const), no longer on the
  strategy param; `classifyFlowType` MARKET_BETA routing is provably unchanged (param still 5).
- A `market_stress:same_bar` halt auto-resumes after 2 consecutive clean same_bar ticks (count < 12)
  when `MARKET_STRESS_AUTO_RESUME_ENABLED` is on; breadth still requires 3; loss/multi/invalid
  legs stay full-day locked.
- Replayed against the 14-day soak, routine days (Jun 6/9-style, max ≤ 12) produce **no** same_bar
  halt; the Jun 7 cascade still engages.
- A same_bar resume clears **both** the persisted `risk_state` halt **and** the in-memory
  `HaltFlagService` (`GET /v1/control/halt` flips to `running`) — the D7 `RiskListeners` fix.
- Two genuine same-day resumes emit **two** `MARKET_STRESS_RESUMED` events (D6 per-transition dedup);
  `triggerLeg`/`clearCount` carry the actual resumed leg/count.
- A malformed snapshot (NaN in any stress scalar) never produces a false same_bar resume — the
  multi-scalar precheck holds (M25 invalid-inputs-never-relaxed invariant intact).
- All new unit + integration tests green; full suite green; review closes with zero blockers, zero
  highs, majority of mediums resolved.
- ADR 0004 §6e added; §6d `:same_bar` table row **and** fail-safe parse prose updated; ADR 0042
  param-lever rows amended to point at the engine const; tech-debt entry logged for the per-bar
  same-bar threshold/N validation (merged into the existing breadth-N/stress-calibration row, not a
  duplicate line).
- 10-min live smoke clean; post-deploy monitoring criteria above are in place.

## Out of scope (deferred)

- **Per-bar consecutive-clean-bar validation of the threshold (20), the resume count (12), and N
  (2).** These are distribution-separated starting points from a 14-day single-regime soak, not
  held-out-validated calibrations — same status as the breadth N in §6d. Logged as tech-debt to
  land with the existing breadth-N per-bar autocorrelation item after a 30–60 day soak.
- **Splitting `MARKET_STRESS_MAX_DAILY_REHALT` per leg.** The re-halt cap stays a shared 3/day
  cascade-chatter budget across breadth + same_bar. A per-leg cap is a future refinement if the
  combined budget proves too tight.
- **Persisting the in-memory resume counters** (clean-tick / re-halt). The §6d restart quirk
  (in-memory only, conservative on restart) carries forward unchanged; persisting them stays the
  LOW tech-debt item filed in M23.
- **Any change to the breadth resume path**, the M25 paper-relax set, the engage-side NaN guard,
  or the shared strategy-params schema.
- **A dedicated `SAME_BAR_AUTO_RESUME_ENABLED` flag** — explicitly rejected (D4); one master switch
  per mechanism.
- **Adding a typed `sameBarTriggerCountAtResume` field to `IMarketStressResumedEvent`.** That is a
  shared-package change, which M28 forbids (code-only, migration-free). The same_bar count at resume
  is surfaced via the WARN log instead; a typed field is a future shared-contract wave if needed.
- **Teaching `BacktestRunnerService` cross-sectional same_bar context.** The runner is single-symbol
  and feeds neutral cross-symbol stress; same_bar verification is an offline SQL/event replay
  (post-deploy step 4). Adding same_bar context to the runner is a separate backtest-runner
  milestone.
- **Splitting `breadthAtResume` into a leg-generic `stressMetricAtResume` shape.** Out of scope (a
  shared-contract change); `breadthAtResume` stays and is leg-irrelevant for same_bar events.

## Review findings log

Three independent reviews (composer, gbt, gemini). Each finding classified and dispositioned.

### Applied (real gaps fixed in this plan and/or ADR 0004 §6d/§6e, ADR 0042)

- **[APPLIED] gbt H2 / composer H2 — resume-event dedup is per-UTC-day, drops the 2nd same-day
  resume.** Code-verified (`autoResumeEmittedForDate === utcDateString`). M28 makes a second same-day
  resume reachable, so this silently breaks M28's own monitoring criterion. Added **D6** (per-transition
  dedup), impl step 8, two-event tests, monitoring + success criteria, ADR §6e dedup paragraph. *This
  is the finding that most surprised me — a genuine pre-existing telemetry bug the original plan would
  have shipped around.*
- **[APPLIED] composer H1 — `RiskListeners.onMarketStressResumed` clears the flag only for the breadth
  leg.** Code-verified early-return on `triggerLeg !== MARKET_STRESS_RESUME_ELIGIBLE_LEG`. A same_bar
  resume would clear the DB but leave the in-memory flag halted → `GET /v1/control/halt` lies. Added
  **D7**, scope item, impl step 9, RiskListeners unit tests, ADR §6e paragraph.
- **[APPLIED] gbt H3 — resume predicate too narrow; clears on malformed non-leg scalar.** A clean
  `same_bar_trigger_count` with NaN elsewhere would false-resume then re-halt as `:invalid`. Added the
  multi-scalar `hasInvalidStressInputs` precheck to D2, impl step 4, tests, ADR §6e. Keeps the M25
  invalid-inputs-never-relaxed invariant. (Note: `isGlobalStressed` already does this, so breadth is
  already symmetric — the asymmetry the reviewer worried about does not exist once same_bar matches.)
- **[APPLIED] gbt H1 — soak-window backtest cannot validate same_bar.** Code-verified
  `BacktestRunnerService` feeds `sameBarTriggerCount: 0` (single-symbol replay). Rewrote post-deploy
  step 4 to an offline SQL/event replay with explicit count=52-engages / count=12-does-not assertions;
  added the runner-teaching deferral to out-of-scope.
- **[APPLIED] composer H4 / composer M2-comment — Jun 3 attribution.** Jun 3 max=11 is below the new
  engage (20), so M28 does not fix Jun 3 via same_bar. Added a soak-table note; scoped step 4 to
  same_bar-attributed days only.
- **[APPLIED] composer H3 — ADR §6d fail-safe parse lists `:same_bar` as full-day-locked,
  contradicting §6e.** Reconciled §6d prose: resume-eligible set = `{ :breadth, :same_bar }`.
- **[APPLIED] composer (Verified-State) — ADR 0042 param-lever drift.** 0042 lines 81/259 still said
  "raise `stress_same_bar_trigger_count`". Amended both rows to point at `STRESS_SAME_BAR_HALT_COUNT`
  and mark same_bar never-relaxed.
- **[APPLIED] gbt M3 / composer M1 — stale M25 comment + spec say same_bar is param-governed.** Added
  scope item + impl step 10 to update the comment and rewrite the M25 spec to assert against the const.
- **[APPLIED] composer H2 / gbt H2 — emit hard-codes `clearCount: 3`.** Folded into D6/step 7: payload
  carries the leg-selected `clearCount` (2 for same_bar).
- **[APPLIED] gbt M1 — "tick" vs "bar" ambiguity.** Added a locked note: counter advances per gate
  evaluation (inherited from §6d), with a same-close-pass test. No new per-bar key (that is the
  deliberate M23 model).
- **[APPLIED] composer M6 — stale-halt wording.** Post-deploy step 2 now clears on `same_bar < 12`
  (resume band), covering both old-threshold locks and new 15–19 engage locks.
- **[APPLIED] composer M3 — analysis SQL prefix-match.** Added a funnel/analysis prefix-match audit to
  monitoring (the M23 `LIKE 'market_stress%'` lesson).
- **[APPLIED] composer M4 — same-tick resume → re-engage test.** Added to the test matrix.
- **[APPLIED] composer M5 — tech-debt merge.** Success criteria now require merging into the existing
  breadth-N row, not a duplicate MEDIUM line.

### Rejected

- **[REJECTED — shared-package change, out of M28 scope] gbt M2 / composer H2-followon — add typed
  `sameBarTriggerCountAtResume` to `IMarketStressResumedEvent`.** M28 is locked code-only and
  migration-free; a shared-contract field is forbidden scope. The same_bar count is surfaced via the
  WARN log instead, and monitoring instructions use the log. Listed in out-of-scope; a future
  shared-contract wave can add it.
- **[REJECTED — wrong premise] gbt H3-followon — "document whether breadth should also adopt the
  invalid-input precheck."** `isGlobalStressed` **already** applies the multi-scalar NaN guard
  (code-verified). There is no asymmetry to document once `isSameBarStillStressed` matches it; the
  applied fix makes them symmetric.
- **[REJECTED — out of M28 scope, future refinement] gbt — backtest-runner same_bar context.** Teaching
  the single-symbol runner cross-sectional same_bar is a separate milestone; M28 verifies via offline
  replay. Captured as out-of-scope, not a blocker.
- **[REJECTED — already locked, no change needed] composer / gemini — "keep param at 5", "code-only, no
  migration", "N=2 vs N=3 split acceptable", "shared re-halt cap is fine".** These are confirmations of
  existing locked decisions (D1/D4/D5), not change requests. No edit needed.

### Deferred (tech-debt, not M28)

- **[DEFERRED — tech-debt] composer M4-telemetry / gbt — per-leg `clearCountAtResume` and same-bar
  count telemetry split, and a per-leg re-halt cap.** Useful post-deploy analysis refinements; the
  shared re-halt cap and combined budget are the intended M28 shape. Already in the existing
  out-of-scope list; the per-bar 20/12/2 held-out validation is the standing tech-debt item (merged
  with breadth-N).
