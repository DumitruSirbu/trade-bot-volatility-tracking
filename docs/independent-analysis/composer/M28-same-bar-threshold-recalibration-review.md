# Independent Review — M28 Same-Bar Stress Threshold Recalibration

**Plan reviewed:** `docs/plans/M28-same-bar-threshold-recalibration.md`  
**Codebase snapshot:** 2026-06-09 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M28 correctly identifies the **next soak conservatism** in the market-stress arc after M21/M22/M23: the `same_bar` leg engages at `stress_same_bar_trigger_count = 5` (~5% co-trigger on a ~100-symbol universe), which conflates routine correlated crypto sessions with genuine cascades. The June soak table (Jun 7 peak 52, Jun 6 max 12 with 118 decisions and no harm) supports raising the engage floor and pairing it with **transient-leg auto-resume** rather than a UTC-day lock.

The plan’s **structural centerpiece** — decoupling the halt threshold from the strategy param while leaving `classifyFlowType` MARKET_BETA routing on the param at 5 — mirrors the breadth fix in ADR 0004 §6b and is **verified in code** today (`StressHaltEvaluator` line 121 vs `classifyFlowType.ts` line 50). Extending M23’s resume machinery to `same_bar` with leg-scoped predicates, hysteresis (20 engage / 12 resume), and N=2 clean ticks is architecturally sound.

**Assessment:** **Approve with amendments** — ship as migration-free, determinism-preserving calibration + duration fix with the full test plan and paper-first gates. Treat 20 / 12 / 2 as **distribution-separated starting points** (plan is honest). Add must-fix items for **`RiskListeners` same_bar resume handling** (currently breadth-only), **leg-specific `clearCount` in resume events**, and **ADR §6d fail-safe parse drift** (still lists `:same_bar` as non-eligible).

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | Threshold=5 vs ~100 symbols; soak narrative and coupling to `classifyFlowType` are code-verified. |
| Decoupling (D1) | A | Correct breadth §6b pattern; param stays at 5 for flow only. |
| Engage threshold (20) | B+ | Separates routine (≤12) from cascade (52); Jun 4/5 at 26–30 intentionally halt-then-resume. |
| Resume threshold (12) + hysteresis | B+ | 8-count buffer mirrors breadth 40→30; not held-out validated. |
| N=2 clean ticks | B | Plausible for single-bar spikes; different estimand than breadth N=3 — acceptable split. |
| M23 extension (D2–D4) | A- | Right seam (`resolveDayHalt` leg-parameterisation); missing downstream consumers. |
| Evidence base | C+ | 14-day single-regime soak; Jun 3 halt cause not isolated in plan. |
| Scope / safety | A | Code-only, no migration; `same_bar` stays out of M25 relax set. |
| Test plan | A- | Strong unit coverage; add RiskListeners + flag-round-trip cases. |
| Post-deploy / backtest gates | A- | Stale-halt + cascade-window backtest are load-bearing. |

**Bottom line:** **Yes, raise same_bar engage engine-side to ~20 and wire auto-resume.** **Yes, keep the strategy param at 5 for MARKET_BETA.** Amend dispatch to include **`RiskListeners` + halt-flag clear** for `triggerLeg: 'same_bar'`, fix **ADR §6d** fail-safe parse text, and extend QA for **end-to-end resume** (DB clear + in-memory flag + control API).

---

## Verified Current State

### Same_bar engage reads strategy param today

```121:123:apps/engine/src/risk/service/StressHaltEvaluator.ts
        if (this.isLegActive(HALT_LEG_SAME_BAR, isPaperRelaxActive) && snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count) {
            legs.push(HALT_LEG_SAME_BAR);
        }
```

Param seeds at **5** (`SeedStrategyVersions` migration). M28’s core behaviour change — engage at engine const **20** while param stays **5** — is the right regression to lock in tests.

### Param is load-bearing for flow classification (decoupling is mandatory)

```50:50:packages/shared/src/util/classifyFlowType.ts
    if (event.marketBreadth5mUpPct > params.stress_breadth_pct && event.sameBarTriggerCount >= params.stress_same_bar_trigger_count) {
```

Re-seeding the param to fix halts would silently change MARKET_BETA routing. Plan D1 is **non-negotiable** and matches ADR 0004 Conflicts #1.

### Same_bar suffix exists; resume is breadth-only today

```588:594:apps/engine/src/risk/service/RiskGateService.ts
    private isBreadthAutoResumeEligible(haltReason: string | null): boolean {
        if (!this.appConfig.marketStressAutoResumeEnabled) {
            return false;
        }

        return haltReason === `${RejectReasonEnum.MARKET_STRESS}:${MARKET_STRESS_RESUME_ELIGIBLE_LEG}`;
    }
```

`MARKET_STRESS_RESUME_ELIGIBLE_LEG` is `HALT_LEG_BREADTH` only (`riskConsts.ts` line 165). `market_stress:same_bar` halts **always** full-day lock — plan problem statement is accurate.

### Resume predicate is breadth-only; no same_bar analogue

```567:577:apps/engine/src/risk/service/RiskGateService.ts
        if (this.stress.isGlobalStressed(context.snapshot)) {
            this.stressClearCount = 0;

            return dayHaltVerdict;
        }

        this.stressClearCount++;

        if (this.stressClearCount < MARKET_STRESS_RESUME_CLEAR_TICKS) {
```

`isGlobalStressed` checks breadth distance only (plus NaN fail-closed on btc/eth/breadth 5m fields). M28’s `isSameBarStillStressed` is the correct symmetric addition.

### ADR §6e already drafted; §6d table partially updated

`docs/architecture/adr/0004-risk-management.md` already contains §6e (M28 decisions locked) and the `halt_reason` table row for `:same_bar` as resume-eligible. **But** §6d fail-safe parse prose (lines 638–640) still lists `:same_bar` among suffixes that default to full-day lock — **contradicts** §6e and the table. Scribe must reconcile in the M28 ADR pass.

### ADR 0042 doc drift (P2 “raise param” vs M28 “keep param at 5”)

ADR 0042 §paper exploration still lists `stress_same_bar_trigger_count` as a “raise above 5” no-code lever. M28 explicitly **rejects** raising the param (flow coupling). Scribe should amend 0042 to point at engine const `STRESS_SAME_BAR_HALT_COUNT` instead.

---

## Decision Critique — Pros and Cons

### 1. Engine-side engage at 20, param stays 5 (D1 / D5)

| Pros | Cons |
|------|------|
| Fixes halt without touching MARKET_BETA — exact §6b precedent. | Operators tuning “same bar” in strategy UI no longer affects halts — document in ADR/runbook. |
| Regression test “count=10, param=5 → no engage” is crisp. | MARKET_BETA still fires at count≥5 on correlated days — **intentional** but may confuse soak analysts comparing flow mix vs halt mix. |
| No shared-package / migration churn. | Backtest fixtures hard-code `stress_same_bar_trigger_count: 5`; replay engage changes only if snapshot counts cross 20. |

**Verdict:** **Correct and load-bearing.** Ship as specified.

---

### 2. Engage = 20, resume clean band &lt; 12 (D2 hysteresis)

| Pros | Cons |
|------|------|
| Jun 6 max=12 / 118 decisions supports routine ceiling. | Jun 3 max=11 but “halted=yes” in plan table — if that halt was **breadth** not same_bar, row is fine; if same_bar-driven, threshold 20 would have **avoided** Jun 3 halt (plan should state which leg). |
| Jun 7 peak=52 clearly above 20. | Jun 4/5 peaks 26–30 **will still engage** — plan correctly frames as halt-then-resume, not day-lock. |
| 15 rejected for thin buffer over Jun 6 — good discipline. | 25+ rejected to preserve elevated-session halts — reasonable; not empirically sensitivity-tested. |
| `[12, 20)` gap prevents boundary chatter. | Count=15 blocks resume but does not re-engage — correct hysteresis; needs explicit unit test (plan has this). |

**Verdict:** **Reasonable starting calibration.** Log alongside breadth-N tech-debt (plan already does). Post-deploy per-bar same_bar series is essential.

---

### 3. N=2 clean ticks for same_bar vs N=3 for breadth

| Pros | Cons |
|------|------|
| Same-bar spike is bar-local; next bar often mean-reverts (soak avgs vs maxes). | One spurious sub-12 reading could resume into still-elevated tape (12–19 band). |
| Shorter unlock than breadth matches signal persistence difference. | Decision cadence ≠ bar cadence strictly — “2 ticks” wall-clock time varies with trigger density. |
| Reuses same in-memory counter with leg-parameterised threshold — minimal new state. | Shared counter semantics across legs on **re-halt after resume** are unchanged from M23 — still correct. |

**Verdict:** **Acceptable.** Prefer telemetry on `clearCountAtResume` split by leg after deploy.

---

### 4. Shared re-halt cap (3/day, breadth + same_bar combined)

| Pros | Cons |
|------|------|
| Consistent with M23 chatter budget. | A noisy same_bar day could exhaust cap and block breadth auto-resume later — conservative, possibly painful. |
| Plan explicitly defers per-leg cap — honest scope. | In-memory cap resets on restart (M23 quirk) — unchanged. |

**Verdict:** **Good decision** for M28. Document combined budget in operator runbook.

---

### 5. Reuse `MARKET_STRESS_AUTO_RESUME_ENABLED` (D4)

| Pros | Cons |
|------|------|
| One master switch matches “one mechanism.” | Live stays default-off — same_bar resume inactive on live until explicit activation post-soak. |
| Paper-default-on picks up both legs on restart. | No per-leg kill switch if same_bar resume misbehaves while breadth resume is fine — acceptable given paper gate. |

**Verdict:** **Correct.** Matches M23 pattern.

---

## Must-fix before dispatch

### H1 — `RiskListeners` only clears halt flag for `triggerLeg === 'breadth'`

```96:100:apps/engine/src/alert/listeners/RiskListeners.ts
        if (event.triggerLeg !== MARKET_STRESS_RESUME_ELIGIBLE_LEG) {
            this.logger.warn(`marketStress.autoResume.unexpectedLeg leg=${event.triggerLeg} — skipping flag clear`);

            return;
        }
```

Plan step 7 fixes `RiskGateService` emit/log `triggerLeg` but **does not list `RiskListeners`** in scope. If unchanged, a successful `same_bar` DB resume leaves **`HaltFlagService` halted** → `GET /v1/control/halt` still reports halted, Telegram/alert path may skip clear.

**Required:**

- Add `apps/engine/src/alert/listeners/RiskListeners.ts` to scope.
- Replace single-leg check with `MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(event.triggerLeg)` (or equivalent).
- Extend `RiskListeners.m23.spec.ts` (RL6 / RL1) for `triggerLeg: 'same_bar'`.

This is a **functional gap**, not polish.

### H2 — `autoResumeMarketStress` hard-codes `clearCount: MARKET_STRESS_RESUME_CLEAR_TICKS` (3)

Payload always sends `clearCount: 3` even when same_bar required 2. Plan step 7 mentions `triggerLeg` but not `clearCount`. Pass **leg-selected** `requiredTicks` into the event for telemetry correctness.

Optional follow-on: `breadthAtResume` is breadth-specific naming — for same_bar resume, consider adding `sameBarCountAtResume` in a future shared-contract wave, or document that `breadthAtResume` is **ignored** for same_bar events (scribe note). Not a blocker if alerts parse `triggerLeg` first.

### H3 — ADR §6d fail-safe parse contradicts §6e

§6d lines 638–640 list `:same_bar` among non-resume-eligible suffixes. §6e and the table row say resume-eligible. **Amend §6d** to: recognised resume-eligible suffixes = `{ breadth, same_bar }`; full-day lock = `{ multi, invalid, bare, all other legs }`.

Also update §6d “tag `:breadth` only when sole engaging leg” prose to mention **`:same_bar` when sole engaging leg** (classifier already returns `legs[0]` in engage order).

### H4 — Jun 3 halt attribution in soak table

Plan marks Jun 3 “halted=yes” with max same_bar=11. At threshold 20, same_bar would **not** engage. Clarify in plan or ADR whether Jun 3 halt was breadth/other — avoids false expectation that M28 “fixes Jun 3.”

---

## Should-fix before dispatch

### M1 — `StressHaltEvaluator.spec.ts` still documents param-based same_bar engage

Legacy suite (`triggers when same_bar_trigger_count >= stress_same_bar_trigger_count`) must be updated or duplicated for const-based engage — plan lists m23/m25 specs but not base `StressHaltEvaluator.spec.ts`.

### M2 — Backtest `sameBarTriggerCount: 0` default

`BacktestRunnerService` seeds `sameBarTriggerCount: 0` — replay may not exercise M28 unless fixtures inject counts. Post-deploy backtest step 4 should use **soak-derived snapshot series**, not default runner fixtures.

### M3 — Analysis / funnel SQL

Soak queries using `halt_reason = 'market_stress'` miss suffixed rows. Audit `packages/analysis` for prefix match (M23 lesson) — add `market_stress:same_bar` to monitoring dashboards if funnel splits by leg.

### M4 — Same-tick resume → re-engage with same_bar

M23 QA pattern: resume on tick T, `same_bar_trigger_count >= 20` on same evaluation after clear → re-halt + re-halt counter. Add case parallel to M23 breadth same-tick test.

### M5 — Tech-debt merge

Merge M28 per-bar same_bar calibration debt into existing breadth-N / stress-calibration row in `docs/tech-debt.md` (M22/M23 scribe lesson — avoid duplicate MEDIUM lines).

### M6 — Stale-halt procedure wording

Post-deploy step 2: clear when `same_bar < 12` (resume band), not only “under old threshold=5 lock” — a halt persisting from count=15–19 would also be stale under new engage/resume bands.

---

## What looks good

- **Problem framing** — 5% co-trigger vs cascade; soak table is actionable.
- **Decoupling** — mirrors proven breadth pattern; code-verified coupling to `classifyFlowType`.
- **M23 extension model** — `resumeProfileFor(leg)` keeps `resolveDayHalt` thin; conventions-compliant.
- **Hysteresis** — engage/resume gap and between-band lock behaviour are explicit and testable.
- **Conservative defaults** — `:multi`, loss halts, invalid, flag-off, NaN fail-closed unchanged.
- **M25 invariant** — `same_bar` never in `PAPER_RELAXABLE_LEGS`; recalibrate not relax.
- **Determinism** — tick counter, no wall-clock in control path.
- **No migration** — fits CLAUDE.md DB safety; pg_dump + restart only.
- **Honest calibration caveat** — 14-day starting point, tech-debt, 14-day paper soak before live resume.
- **Test plan** — decoupling regression, boundary 19/20, hysteresis 15, mixed-leg profiles, cap, flag-off, telemetry `triggerLeg`.
- **Post-deploy backtest** — cascade-window check (Jun 7) is the right quant gate.
- **ADR §6e pre-draft** — decisions are already locked in architecture doc; implementation can trace directly.

---

## Consciously out of scope (agree with plan)

- Held-out validation of 20 / 12 / 2 (tech-debt with breadth-N).
- Per-leg re-halt cap split.
- Persisting in-memory resume counters.
- Breadth resume path changes.
- Dedicated `SAME_BAR_AUTO_RESUME_ENABLED` flag.
- Raising `stress_same_bar_trigger_count` param (correctly rejected).

---

## Comparison to milestone arc

| Milestone | Layer |
|-----------|--------|
| M21 | Index-shock horizon + thresholds |
| M22 | Depth floors |
| M23 | Breadth halt **duration** (auto-resume) |
| **M28** | Same_bar halt **calibration** + **duration** |

M28 is the logical successor to M23 for the `same_bar` leg — same pattern (threshold move + resume wiring), different signal (bar-local co-trigger vs breadth distance). Sequencing after M25 paper exploration is correct: M28 does not relax engage via paper profile; it recalibrates the const.

---

## Recommended dispatch adjustment (summary)

1. **Engine** — consts + engage branch + `isSameBarStillStressed` + `isStressLegAutoResumeEligible` + `resumeProfileFor` + leg-accurate `triggerLeg` / `clearCount` in resume emit. **Include `RiskListeners`** (H1).
2. **Shared** — confirm `IMarketStressResumedEvent.triggerLeg: string` needs no union change (plan step 8); optional future field for same_bar count at resume (M2 note).
3. **QA** — plan test list + H1 RiskListeners RL* for `same_bar` + M4 same-tick re-halt + base `StressHaltEvaluator.spec.ts` refresh (M1) + backtest soak replay (M2).
4. **Reviewers** — quant: Jun 4/5 engage-at-20 + resume-at-12 expectancy in 30m windows; logic: H1 flag/DB parity; security: unchanged surface.
5. **Scribe** — §6e already present; fix §6d fail-safe parse (H3); ADR 0042 param-lever drift; tech-debt merge (M5); milestone-log.
6. **Rollout** — pg_dump → stale `market_stress:same_bar` inspect (M6 calm band) → restart → backtest soak window → 10-min smoke → 24–48h `MARKET_STRESS_RESUMED` with `triggerLeg=same_bar` + control API `running`.

With **H1 (RiskListeners)** and **H3 (ADR parse)**, M28 is a disciplined follow-on: **same stress detector family, calibrated engage threshold, shorter penalty for a transient leg, survival-first fallbacks when the tape chatters.**
