# Independent Review — M23 Market-Stress Adaptive Resume

**Plan reviewed:** `docs/plans/archive/M23-market-stress-adaptive-resume.md`  
**Codebase snapshot:** 2026-06-05 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M23 correctly identifies the **remaining soak conservatism** after M21/M22: breadth halts are now calibrated to fire on genuine extremes (`STRESS_BREADTH_DISTANCE_PCT = 40`), but the **UTC-day lock** still treats a 5-minute breadth flush like a loss-based edge failure. The June 5 example (halt at 02:45 UTC, tape calm by ~07:00, forfeited rest of day) is plausible and aligns with how `firstFailingHaltCheck` works today — line 459 returns `GLOBAL_HALT` before any fresh stress evaluation runs.

The proposed fix — **breadth-only adaptive resume** with hysteresis, consecutive clean ticks, and a per-day re-halt cap — threads the right needles: shorten locks when breadth mean-reverts, but fall back to the day-lock when the market chatters. Quant pre-review findings (per-leg predicate, branch placement, unvalidated N) are incorporated thoughtfully.

**Assessment:** **Approve with amendments** — ship as a migration-free, determinism-preserving loosening milestone with the full test plan and paper-first evidence gates. Treat N=3 and the 30/40 hysteresis band as **starting points**, not calibrated optima. Add must-fix items for **leg-classifier completeness**, **HaltFlag/restore string canonicalization**, **re-halt counter restart semantics**, and an explicit **paper-only enforcement story** (code flag or documented operational gate).

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | Day-lock after transient breadth is the right target; line-459 short-circuit verified in code. |
| Architectural seam (branch before early return) | A | Load-bearing; plan correctly identifies HIGH 1. |
| Per-leg resume predicate (`isGlobalStressed`) | A- | Breadth-only for M23 is sound; NaN fail-closed extension needs explicit test. |
| Hysteresis (engage 40 / resume 30) | B+ | Directionally right; 30 is the old engage value — revisit after longer soak. |
| N=3 clear ticks | C+ | Honest about weak evidence; tick-based determinism is correct. |
| Re-halt cap (3) | B | Good chatter guard; in-memory + restart reset is a gap. |
| `halt_reason` suffix encoding | B | No-migration win; restore/flag double-prefix risk must be locked in ADR. |
| Paper-first rollout | B- | Gates are good; no code-level mode enforcement in scope. |
| Test / telemetry plan | A- | Comprehensive; add multi-leg engage + restart re-halt cases. |
| Deferred surge cooldown (M24) | B | Reasonable split; surge resume is the riskiest path. |

**Bottom line:** **Yes, add breadth-only adaptive resume** with hysteresis and a re-halt cap. **No, do not treat N=3 or resume distance 30 as calibrated.** Amend dispatch for leg-classifier edge cases, canonical `halt_reason` strings across gate/restore/flag, and clarify whether paper-only is operational policy or a `PAPER`-mode code gate.

---

## Verified Current State

### Day-lock short-circuits before any stress re-evaluation

```459:473:apps/engine/src/risk/service/RiskGateService.ts
        if (state.today !== null && state.today.isHalted) {
            return RejectReasonEnum.GLOBAL_HALT;
        }

        if (this.stress.isStressed(context.snapshot, context.params)) {
            // ...
            await this.persistHalt(context, state, RejectReasonEnum.MARKET_STRESS);

            return RejectReasonEnum.MARKET_STRESS;
        }
```

Once `is_halted=true`, every subsequent decision returns `GLOBAL_HALT` until UTC rollover or operator `clearHaltForDate`. There is **no** path today to auto-clear a breadth halt when breadth recovers. M23's branch **must** sit before line 459 — the plan is correct.

### `persistHalt` writes bare enum string today

```691:698:apps/engine/src/risk/service/RiskGateService.ts
    private async persistHalt(context: IRiskGateContext, state: ILoadedState, reason: RejectReasonEnum): Promise<void> {
        if (state.today !== null && state.today.isHalted) {
            return;
        }

        const base = state.today ?? this.emptyDay(context.utcDateString);

        await context.riskState.upsertDay({ ...base, isHalted: true, haltReason: reason });
    }
```

`haltReason` is currently `RejectReasonEnum.MARKET_STRESS` → `'market_stress'` with **no leg suffix**. M23 extends this to `market_stress:breadth` etc. The `upsertDay` path already supports clearing via `clearHaltForDate` / `is_halted=false` — resume reuses that pattern.

### `StressHaltEvaluator.isStressed()` is a multi-leg disjunction

Engage order today: invalid inputs → index shock → breadth → `same_bar_trigger_count` → OI → funding → spread. M23's leg classifier must define behavior when **multiple legs** fire on the same snapshot (not spelled out in the plan).

### `resolveProgrammaticSource` splits on first colon only

```219:232:apps/engine/src/bootstrap/HaltStateRestoreService.ts
function resolveProgrammaticSource(haltReason: string | null): HaltSourceEnum {
    // ...
    const sepIndex = haltReason.indexOf(':');
    const prefix = sepIndex < 0 ? haltReason : haltReason.slice(0, sepIndex);
    // maps prefix to HaltSourceEnum
}
```

`market_stress:breadth` → prefix `market_stress` → `HaltSourceEnum.MARKET_STRESS`. **Works** for source resolution.

**But** restore applies the flag as:

```165:165:apps/engine/src/bootstrap/HaltStateRestoreService.ts
            this.haltFlag.halt(`${resolution.source}:${resolution.reason ?? 'restored'}`);
```

If `resolution.reason` is already `market_stress:breadth` and `resolution.source` is `market_stress`, the in-memory flag becomes **`market_stress:market_stress:breadth`**. The plan flags this interaction (§5) but does not mandate a fix. This is a **must-fix** before dispatch.

### Sequencing after M21/M22 is correct

- M21 aligned index-shock horizons; M22 recalibrated depth floors.
- Breadth distance is **40** in `riskConsts.ts` (June hotfix); plan references the 02:45 UTC event at 8% breadth correctly.
- M23 is the next logical layer: **duration**, not threshold.

---

## Decision Critique — Pros and Cons

Each major decision in the plan, judged as an independent critic.

### 1. Breadth-only auto-resume (other stress legs stay full-day locked)

| Pros | Cons |
|------|------|
| Breadth is fast mean-reverting; day-lock is a poor fit (plan's core thesis). | Zero soak events for BTC/ETH/OI/funding stress legs — breadth-only evidence does not validate the *classifier* for rare legs. |
| Dataset has 14 breadth events; zero non-breadth stress halts — resume-N for other legs is unvalidated. | If a future halt is **multi-leg** (breadth + BTC shock same tick), suffix choice affects resume eligibility — plan silent on tie-break. |
| Keeps slower/trendier signals on the conservative day-lock — survival-first. | `same_bar_trigger_count` is a global stress leg in `isStressed()` but **absent** from the plan's suffix list — unclassified engages default to full-day lock (safe) but may surprise operators. |
| Narrow scope limits blast radius of a risk-loosening change. | Surge-triggered breadth halts auto-resume without M24 directional cooldown — squeeze risk on fade entries (plan defers HIGH 3). |

**Verdict:** **Good decision** for M23 scope. **Amend:** leg classifier must cover `same_bar_trigger_count` and document multi-leg precedence (recommend: **most conservative leg wins** → no auto-resume unless breadth was the *sole* engage leg).

---

### 2. New `isGlobalStressed()` — breadth-only at resume distance (BLOCKER 1)

| Pros | Cons |
|------|------|
| Fixes the fatal flaw of reusing full `isStressed()` (per-coin funding/spread would block resume forever). | Name `isGlobalStressed` is slightly misleading in M23 — it checks **one** global leg at resume threshold, not "all global legs clean." |
| Per-coin funding/spread correctly stay at entry gate only. | Resume path also fail-closes on BTC/ETH 5m NaN (plan §1) even though resume predicate is breadth-only — conservative but couples resume to index fields that did not trigger the halt. |
| Reuses existing `isBreadthCollapse` distance logic with a different const — DRY-friendly. | Does not check OI/spread/index at resume — intentional, but means auto-resume can open while e.g. BTC 5m is still shocked (if halt was breadth-only). That is correct given leg suffix, but needs an integration test. |

**Verdict:** **Correct and load-bearing.** Ship as specified; add test: breadth halt suffix + BTC still shocked → resume allowed after clean breadth streak (proves leg-scoped semantics).

---

### 3. Hysteresis — engage \|breadth−50\| ≥ 40, resume \|breadth−50\| ≤ 30

| Pros | Cons |
|------|------|
| 10-point buffer on each side prevents boundary chatter (plan's June 5 oscillation example). | Resume band **[20, 80]** reintroduces the **old M19 engage threshold** (30) as the "clean" inner band — ironic given M19 raised engage to 40 precisely because 30 fired too often. |
| Gap zone (10–20) and (80–90) neither halts nor counts toward resume — explicit dead band. | A breadth of 21% is "clean" for resume but would have been a **collapse engage** under the pre-hotfix distance-30 rule — resume may re-open while tape is still skewed (just not extreme). |
| Simple to explain and test (plan's hysteresis edge cases are good). | No empirical distribution of time-in-gap-zone in the 14-event dataset — buffer width is judgment, not measured. |

**Verdict:** **Reasonable starting point.** The asymmetry (hard engage / soft resume) is standard control-theory hysteresis. Log as **MEDIUM tech-debt**: validate inner band against per-bar breadth autocorrelation after 30–60 day soak (aligns with existing breadth threshold debt in `docs/tech-debt.md`).

---

### 4. `MARKET_STRESS_RESUME_CLEAR_TICKS = 3` (configurable, not validated)

| Pros | Cons |
|------|------|
| Plan honestly labels N=3 as a **starting point** (BLOCKER 2 resolved the right way). | Original +5/+10/+15m sampling **does not** prove 3 consecutive clean **decision ticks** — different estimand. |
| Tick-based (not wall-clock) preserves live↔backtest determinism (§6). | Decision cadence ≈5m aligned but not guaranteed — N=3 could be 3 minutes or 15+ minutes depending on trigger density. |
| Configurable const allows post-soak tuning without code change. | Too low → resume into still-volatile tape; too high → little benefit over day-lock. No sensitivity analysis in plan. |
| In-memory counter resets on restart → conservative (extra confirmation after crash). | Restart **during** a clean streak wastes progress — acceptable for survival-first. |

**Verdict:** **Acceptable to ship default 3** with explicit deferred calibration debt (plan already does). **Recommend:** post-deploy telemetry on distribution of `clearCountAtResume` to inform N tuning.

---

### 5. Per-day re-halt cap `MARKET_STRESS_MAX_DAILY_REHALT = 3`

| Pros | Cons |
|------|------|
| Directly addresses the reconstructed 5-cycle oscillation morning (plan §3). | Counter is **in-memory only** — engine restart mid-day **resets** the cap, allowing a 4th+ engage after crash (undermines chatter protection). |
| Falls back to full-day lock — restores survival-first default when regime is unstable. | "3rd engage" vs "3rd re-halt after resume" wording in plan is slightly ambiguous; test plan clarifies cap on re-halts — lock semantics in ADR. |
| Resets at UTC rollover — consistent with `stressEmittedForDate` pattern. | On cap hit, bot stays locked even if breadth is calm for hours — correct but painful; operators need `MARKET_STRESS_RESUMED` + cap-hit telemetry to distinguish. |

**Verdict:** **Good decision.** **Amend:** persist re-halt count on `risk_state` day row (optional field) or accept restart reset as documented conservative quirk — pick one in ADR §6.

---

### 6. `halt_reason` suffix encoding — no migration (`market_stress:<leg>`)

| Pros | Cons |
|------|------|
| No schema migration — fits CLAUDE.md DB safety rules. | `varchar` free-form strings are harder to query in soak SQL than a normalized column (acceptable for M23). |
| Legacy bare `market_stress` → full-day lock is fail-safe. | `resolveProgrammaticSource` + `haltFlag.halt(source:reason)` **double-prefix** risk (see Verified State). |
| `RejectReasonEnum.MARKET_STRESS` unchanged for decisions row — suffix only on `risk_state`. | Dashboard/analysis queries filtering `halt_reason = 'market_stress'` miss suffixed rows unless `LIKE 'market_stress%'` — check `selectHaltState` consumers. |
| First-colon parsing preserves `HaltSourceEnum` mapping. | Suffix vocabulary must stay in sync across engage classifier, resume parser, restore, alerts, and docs. |

**Verdict:** **Good no-migration tradeoff.** **Must-fix:** canonical string rules in ADR §6 — recommend `risk_state.halt_reason = 'market_stress:breadth'` and `HaltFlagService` stores **leg only** (`breadth`) or full reason **without** re-prefixing on restore.

---

### 7. In-process tick counting (not cron / wall-clock)

| Pros | Cons |
|------|------|
| Preserves determinism invariant — same snapshot sequence → same resume in backtest. | If decision rate drops (WS gap, symbol universe empty), confirmation wall-clock time stretches unpredictably. |
| Aligns with gate evaluation cadence (~5m breadth field). | No explicit max wall-clock ceiling on resume wait — a stuck tape at breadth 25% never resumes (correct) but also never escalates. |
| Restart resets counter — conservative after crash. | Harder to explain to operators ("3 ticks" vs "~15 minutes"). |

**Verdict:** **Correct decision** for this codebase's live↔backtest contract. Document operator-facing "~15 min at normal cadence" in ADR, not in control logic.

---

### 8. Paper-first rollout; live gated on backtest + 14-day soak

| Pros | Cons |
|------|------|
| HIGH 4 directly addresses "no evidence of positive expectancy in unlocked windows." | Implementation scope has **no** `ExchangeEnvironmentEnum.PAPER` guard or feature flag — "paper-only" is **policy**, not enforced in code. |
| 30-minute post-resume trade window in backtest is a concrete measurable. | 30-minute window is arbitrary — fade entries may need 60m+ to resolve; could miss slow losses or wins. |
| Composes with M21/M22 14-day slippage telemetry — neither gate alone unlocks live. | If soak engine is already paper, deploying M23 code changes behavior immediately — "paper-only" means "don't go live yet," not "code inactive." |
| Revert-or-raise-N path if windows show losses — explicit escape hatch. | Backtest must enable auto-resume in replay path — confirm `BacktestRunnerService` uses same `RiskGateService` branch (plan mentions; orchestrator must verify). |

**Verdict:** **Good governance.** **Amend:** add either (a) `MARKET_STRESS_AUTO_RESUME_ENABLED` env default `true` in paper / `false` in live, or (b) explicit scribe/runbook statement that live activation requires a **second** deploy after gates pass. Option (a) is safer engineering.

---

### 9. Defer post-resume directional cooldown to M24 (HIGH 3)

| Pros | Cons |
|------|------|
| Ships the core mechanism without blocking on surge-vs-collapse entry policy. | Surge auto-resume + fade strategy = **directional squeeze risk** — the riskiest resume path stays unguarded in M23. |
| Hysteresis + re-halt cap partially mitigate chatter, not directional risk. | One bad surge-resume fade cluster could exceed the savings from hours of unlocked calm tape. |
| Clean milestone boundary — M23 = halt duration, M24 = post-resume entry policy. | Quant review flagged HIGH 3; deferral is honest but should be **HIGH** tech-debt, not only MEDIUM. |

**Verdict:** **Acceptable split** given paper-first gate. Escalate M24 cooldown to **HIGH** in `docs/tech-debt.md` if paper soak shows entries within minutes of surge-resume events.

---

### 10. Same-tick resume then re-engage `isStressed()` below the branch

| Pros | Cons |
|------|------|
| Prevents a one-tick "false calm" from leaving the bot unprotected when stress immediately returns. | Same tick can: resume → re-halt → increment re-halt counter → emit second `RISK_HALT_TRIGGERED` — alert noise. |
| Re-halt counter captures true chatter within a single evaluation cycle. | `emitMarketStressIfTransitioning` uses `stressEmittedForDate` dedup — may suppress legitimate re-halt alert on same UTC day after auto-resume cleared `is_halted`. **Worth verifying** event emit rules after resume. |
| Matches state machine intuition: resume is provisional until engage check passes. | Race: two concurrent `evaluate()` calls (M9 R2 pattern) need the same dedup discipline for resume + re-halt. |

**Verdict:** **Correct control flow.** Add QA case: resume on tick T, breadth back to 8% on same snapshot after resume clear → re-halt + re-halt counter increment + **no duplicate** halt bus emit if dedup expects prior emit.

---

## Must-fix before dispatch

### H1 — Canonical `halt_reason` / `HaltFlagService` string contract

Lock in ADR §6 **before** engine wave:

- `risk_state.halt_reason` written value (e.g. `market_stress:breadth`).
- `HaltFlagService.getReason()` / restore path must **not** produce `market_stress:market_stress:breadth`.
- Whether `HaltFlagService.haltedLeg` holds the suffix token alone (`breadth`) while `halt_reason` holds the full string.

Add round-trip test: persist → restore → flag reason matches spec.

### H2 — Leg classifier completeness

`StressHaltEvaluator` engage paths include `same_bar_trigger_count` (and invalid-input pseudo-leg). Plan suffix list omits them.

**Decision needed (recommend):**

- `market_stress:same_bar` → full-day lock (no auto-resume).
- `market_stress:invalid` → full-day lock (plan has this).
- Multi-leg engage → record **primary** leg by engage order **or** `market_stress:multi` → full-day lock.

Document in ADR; add classifier unit tests for each engage path.

### H3 — Re-halt counter restart semantics

Plan says in-memory per UTC day. Restart resets counter → chatter cap bypass.

Either:

1. **Accept and document** as conservative-quirk (restart gives fresh cap — could be *more* permissive, not less), or
2. **Persist** `stress_rehalt_count` on today's `risk_state` row (no migration if stored in existing JSON/metadata — but there is no JSON column; would need varchar hack or defer).

Recommend (1) for M23 + ADR note; flag as LOW tech-debt if restart-during-chatter is plausible.

### H4 — Paper-only enforcement story

Add to implementation scope **one** of:

- `MARKET_STRESS_AUTO_RESUME_ENABLED` env (off on live until gates pass), or
- Runbook-only gate with explicit "do not set `EXCHANGE_ENV=live` until …" checklist.

Without this, "paper-first" is review governance only.

---

## Should-fix before dispatch

### M1 — `emitMarketStressIfTransitioning` after auto-resume

After resume clears `is_halted`, same-day re-halt may be suppressed by `stressEmittedForDate` dedup (line 491). Confirm whether re-halt after auto-resume should emit a fresh `RISK_HALT_TRIGGERED` / increment telemetry. Logic review in wave 4.

### M2 — Analysis / dashboard `halt_reason` queries

`packages/analysis/src/query/selectHaltState.ts` returns raw `halt_reason`. Any funnel SQL using `halt_reason = 'market_stress'` needs `LIKE 'market_stress%'` or suffix parse. Read-only audit in QA wave — no dashboard change required if queries already use prefix match.

### M3 — `MARKET_STRESS_RESUMED` payload fields

Plan specifies clear-count, breadth at resume, trigger leg, re-halt count. Also include `utcDateString` and whether cap was near limit — aids soak dashboards.

### M4 — Backtest replay parity test

Dedicated test: ordered snapshots with breadth collapse → recovery → resume tick → entry admitted. Proves determinism claim beyond unit mocks.

### M5 — Stale-halt procedure for suffixed reasons

Post-deploy step 2 mentions bare `market_stress`. Extend: if `market_stress:breadth` under old code path blocked resume, `clearHaltForDate` still applies — document in runbook.

### M6 — Tech-debt deduplication

Existing `docs/tech-debt.md` row for breadth threshold validation. M23 adds N calibration, M24 cooldown, signal-dependent N. **Merge** breadth-related debt into one row with sub-bullets; avoid three overlapping "breadth calibration" MEDIUM lines (M22 scribe lesson).

---

## What looks good

- **Problem framing** — distinguishes loss-halt (persistent) vs breadth-halt (transient); June 5 example is actionable.
- **Quant pre-review integration** — blockers folded into architecture, not ignored.
- **Branch placement** — before line 459; verified against current code.
- **Fail-safe defaults** — legacy bare reason, unknown suffix, NaN, restart → all conservative.
- **Breadth-only scope** — limits loosening blast radius.
- **Hysteresis + re-halt cap** — paired answer to "too punitive" and "too eager."
- **Determinism** — tick counter, no `Date.now()` in control path.
- **No migration** — `upsertDay` clear on resume reuses existing path.
- **Shared-contract first** — `IMarketStressResumedEvent` in wave 1.
- **Test plan** — hysteresis edges, loss-lock, non-breadth lock, legacy row, NaN, determinism.
- **DB safety section** — pg_dump, idempotent day upsert, no bulk writes.
- **`bot-review-quant` in wave 4** — correct owner for N and hysteresis soundness.
- **Explicit risk-loosening milestone** — honest governance label.

---

## Consciously out of scope (agree with plan)

- Post-resume directional cooldown (M24).
- Auto-resume for BTC/ETH/OI/funding/spread legs.
- N calibration from full per-bar series (deferred MEDIUM).
- `risk_state.updated_at` (M11).
- Dashboard UI changes (event bus + Telegram sufficient for soak).

---

## Comparison to other independent reviews

No `docs/archive/independent-analysis/gbt/` or `gemini/` M23 review exists at review time. This Composer review aligns with the plan's embedded **architect + quant APPROVE-WITH-AMENDMENTS** (2026-06-05) and extends it with **code-verified** branch placement, **HaltFlag double-prefix** risk, **leg-classifier gaps**, and **paper-only enforcement** gap.

---

## Recommended dispatch adjustment (summary)

1. **Architect** — ADR 0004 §6: breadth-only auto-resume; hysteresis 40/30; re-halt cap; canonical `halt_reason` + flag/restore strings (H1); leg classifier including `same_bar` and multi-leg rule (H2); paper-only enforcement (H4); in-process determinism note.  
2. **Shared** — `IMarketStressResumedEvent` + constant (wave 1).  
3. **Engine** — `isGlobalStressed`; resume branch before line 459; counters; suffix write/clear; `haltedLeg`; restore counter reset; event emit. Consider `MARKET_STRESS_AUTO_RESUME_ENABLED` env.  
4. **QA** — full test plan + H1 round-trip + same-tick re-halt emit behavior (M1) + backtest replay parity (M4) + classifier coverage for every engage leg (H2).  
5. **Reviewers** — quant owns N/hysteresis/cap; logic owns same-tick resume→re-halt and `stressEmittedForDate` interaction.  
6. **Rollout** — pg_dump → stale-halt inspect (bare + suffixed) → restart → backtest with auto-resume → 10-min smoke → 14-day paper soak on resume-window expectancy.  
7. **Scribe** — merge tech-debt rows (M6); milestone-log; CLAUDE.md status; escalate M24 surge cooldown if soak shows surge-resume entries.

With H1, H2, and H4, M23 is a disciplined follow-on to M21/M22: **same stress detector, shorter breadth penalty, survival-first fallbacks when the tape will not stay quiet.**
