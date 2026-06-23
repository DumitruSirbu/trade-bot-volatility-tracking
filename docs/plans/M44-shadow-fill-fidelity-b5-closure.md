# M44 — Verify shadow-fill fidelity & close the B5 gap (soak verification, no fix required)

> **What M44 is (scoping decision).** M44 is a **verification / soak gate**, **not** an implementation
> milestone. The investigation in this doc established that the historical shadow-fill degeneracy was a
> **pre-fix artifact that is already resolved** in the deployed code (the clean post-`a43fda1` window — B5.2 —
> produces non-degenerate fills with no code change). **Therefore: no simulator fix is required to close B5.**
> B5 closes by **soak accumulation + re-measurement** — let the live shadow path keep producing clean fills
> until the count floor is met, then re-run the measurement query and record the result.
>
> M44 does **not** change the live trade path, does **not** promote any strategy version, does **not** tune
> any strategy parameter, and (in its blocking scope) does **not** change any code. The only deliverable that
> gates B5 is **D2 — the soak/verify gate**. Two optional hardening items (D1.1 schema invariant, D1.3 miss
> observability) are **non-blocking** and may ship as a small separate PR or be deferred. A contingency
> branch (§Contingency) covers the case where re-measurement at n≥30 still shows degeneracy — only **then** is
> an evidence-based fix built, as separate work.
>
> Every `CLAUDE.md` trading-safety invariant holds trivially: the shadow path is fire-and-forget, never
> reaches the risk gate or the exchange, strategies stay pure/deterministic, money stays `decimal`, no LLM in
> the loop. B5 closure makes the cross-version comparison surface (`compareVersions`, the shadow
> `getPerformance` path) trustworthy for non-active versions — specifically **v3 (id=4)**, the hybrid router
> that is the deferred-D1b promotion candidate.

> **Version naming (state once to end the recurring confusion).** In `strategy_versions`, the row primary
> key `strategy_versions_id` is **not** the strategy `version` number — ids start at 1, versions at 0:
>
> | id (`strategy_versions_id`) | name | `version` | status | role |
> |----|------|------|--------|------|
> | 1 | volatility-vwap | 0 | shadow | v0 baseline |
> | 2 | volatility-vwap | 1 | shadow | v1 mean-reversion |
> | **3** | volatility-vwap | **2** | **active** | **v2 momentum — LIVE** |
> | 4 | volatility-vwap | 3 | shadow | v3 hybrid router (shadow-only) |
> | 5 | manual_adopted | 0 | draft | manual draft |
>
> So the **live strategy is v2 momentum (id=3)**; **v3 hybrid (id=4) is shadow-only**. All B5 measurements in
> this doc are on **id=4 (v3)**. (Verified against the live DB 2026-06-23.)

---

## Why M44 exists — the research chain

A 2026-06-23 analysis session produced three docs (`docs/analysis/timestop-sweep-20260623-1158.md`,
`docs/analysis/rr-sweep-20260623-1611.md`, `docs/analysis/win-rate-improvement-analysis-20260623-1914.md`).
The chain of findings:

1. **The binding constraint is win rate, not exits or geometry.** At realized RR ≈ 1.2, breakeven needs
   ≈ 45% win; live v2 runs ≈ 25–29%.
2. **Time-stop is not the lever.** A 15/30/45/60-min sweep degrades expectancy on the clean 15-vs-30
   same-trade comparison.
3. **TP:SL ratio is not the lever.** Risk-sized sweep 0.5→2.0 lifts realized RR 0.76→1.23 but drops win%
   22→19; expectancy is negative at every ratio.
4. **Selectivity is the real lever, but unproven.** `trend_initiation` + idiosyncrasy ≥ 0.75 ≈ 44% win
   (breakeven) but is **unstable across sub-windows** (window-3-heavy, n small); the residual loses robustly.
5. **A separate correctness finding** (logged in `docs/tech-debt.md`): the sizer risks off 1.5×ATR while the
   momentum stop is the VWAP (≈ 4×ATR) → ≈ 2.7× over-risk on a full stop-out.

**The common downstream dependency of (4) and any v3 evaluation is a working shadow comparison** — and that
comparison is blocked by **B5**. M44 closes B5 so those questions become answerable on real data. M44 does
**not** itself act on findings (4) or (5); it only **unblocks** their evaluation.

---

## B5 — what it is (history)

B5 is the shadow-fill re-qualification gate (history in `docs/milestone-log/archive/M37.md, M39.md, M40.md`
and `docs/plans/archive/M43-strategy-selectivity-and-rr-geometry.md` §B5). The prior framing referenced a
post-restart window; **M44 supersedes that with the pinned date in D2** (there was no restart — B5.2). B5
closes when, over **≥ 1 full soak day on the pinned post-fix window**, the v3 shadow series shows ALL of:

1. **Non-null `simulated_fill` for gate-allowed opens** (the previously-degenerate `!hasNextBarEntry` /
   `missed:true, missedReason:null, entryPrice:"0"` path is eliminated).
2. **A non-degenerate `close_reason` distribution** — `force_close` fraction ≤ `MAX_FORCE_CLOSE_FRACTION`
   (**0.5**, `packages/shared/src/const/comparisonConsts.ts:22`) — i.e. the deferred next-bar walk is
   landing, not just the synchronous W1 force_close write.
3. **Non-null fill count ≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN`** (**30**, same file, line 13).

M43-D5 left the `!hasNextBarEntry` rate **UNMEASURED** (the engine was unreachable at M43 close — see
`STATUS.md` line 9). M44 measures it, diagnoses it, and closes it.

---

## Measured evidence (live DB, read-only, 2026-06-23)

All queries run against the soak DB via
`PGPASSWORD=… docker compose exec -T postgres psql -U trade_bot -d trade_bot` (READ-ONLY).

### B5.1 — v3 (id=4) gate-allowed open outcomes, full history

`shadow_decisions WHERE strategy_version_id=4 AND action='open' AND gate_allowed IS TRUE`:

| Outcome | Count | % |
|---|---|---|
| **Total gate-allowed opens** | **304** | 100% |
| `simulated_fill IS NULL` (`!hasNextBarEntry`) | 112 | 37% |
| `simulated_fill` present, `missed:true` | 180 | 59% |
| `simulated_fill` present, `missed:false` (filled) | 12 | 4% |
| …of filled, with a real `close_reason` | 10 | 3% |

The 180 missed split as: **177 with blank `missedReason`, `lowFidelity:true`, `entryPrice:"0"`** + **3
`wrong_side_of_stop`**. The 177-blank-reason shape (missed `true`, `missedReason` null, `entryPrice "0"`) is
the degenerate signature. Only **12 of 304 (4%) actually fill** — far below the ≥ 30 floor.

### B5.2 — the boundary that reframes the milestone (outcome by calendar day) — and its CONFOUND

> **Correction (quant review).** There was **no engine-restart gap**: v3 (id=4) emitted shadow decisions
> **continuously 06-09 → 06-23**. An earlier framing of "pre-restart vs post-restart" was wrong. The actual
> 06-21 boundary is a **gate-regime change**, not a restart. The fidelity flip is **observed**, but its
> specific cause is **NOT isolated** — see the confound note below.

Daily v3 open-intent breakdown (`strategy_version_id=4`, all `action='open'`), reproduced against the live
DB:

| Day | Open-intents | Gate-ALLOWED opens | Gate-BLOCKED opens | Non-null fills |
|---|---|---|---|---|
| 2026-05-30 → 06-08 | 281 | 281 | 0 | **0** |
| 2026-06-09 | 28 | 9 | 19 | 1 |
| 2026-06-10 | 34 | **0** | 34 | 0 |
| 2026-06-11 | 26 | 1 | 25 | 1 |
| **2026-06-12 → 06-20** | 192 | **0** (all blocked, 10 days) | 192 | **0** |
| **2026-06-21** | 23 | 5 | 18 | 3 |
| **2026-06-22** | 27 | 5 | 22 | 4 |
| **2026-06-23** | 39 | 3 | 36 | 3 |

Two facts the day table makes precise:

1. **06-12 → 06-20: zero gate-allowed opens for 10 straight days** — every v3 open-intent was
   `gate_allowed=false`. So the "no clean fills in that window" is explained by the **gate blocking the
   opens before fill simulation ever runs**, not by a fill-simulator defect. The 291 degenerate
   `simulated_fill` rows are concentrated in the **05-30 → 06-08** all-gate-allowed era.
2. **Gate-allowed opens resume only 06-21**, and the fills they produce are clean: across 06-21→06-23,
   **13 gate-allowed opens → 10 non-null fills** (≈ 77% fill rate), close reasons **7 `time_stop`, 2 `tp`,
   1 `sl`, 0 `force_close`**; the 3 misses are all `wrong_side_of_stop` (a legitimate geometry rejection,
   not a fidelity failure).

> **The 06-21 boundary is confounded — the specific cause is NOT isolated.** The boundary coincides with
> **at least three** simultaneous changes: the **M40 deploy** (commit `a43fda1`, 2026-06-21 ~00:19 — the
> stop-side re-anchor to `reconstructReferencePrice`), the **M43 deploy** (selectivity / `catalyst_risk →
> skip`, 06-22), **and** the gate-regime change that re-allowed v3 opens. The clean fills appear after all
> three. **M44 therefore does NOT claim "M40's re-anchor is the proven fix."** It claims only that the flip
> is **observed at a multi-deploy + gate-regime boundary** and the specific causal lever is **not separable**
> from this data (consistent with R2 below — the pre-fix degeneracy is not reproducible). The hardening case
> (D1) stands on its own **regardless of which change flipped it**: a `simulated_fill` that records a miss
> while ticks demonstrably exist (B5.3) is a defect class worth making unrepresentable, whatever its trigger.

### B5.3 — the time-join (loading-bug vs genuine-gap, the requested deliverable)

For all 292 degenerate v3 opens (112 null_fill + 180 missed), parsing the signal-bar open time from the
`event_id` (format `SYMBOL:BARTIME_MS`, e.g. `PORTAL/USDT:USDT:1780172700000`) and joining to
`tick_aggregates` on the **signal-bar half-open window `[barOpen, barOpen + 5m)`** — the exact window
`loadSignalBarEvidence → loadTicksForBar` uses (`TickAggregateRepository.loadTicksForBar`, half-open
`ts >= from AND ts < from+5m`):

| Degenerate kind | Rows | Signal-bar ticks **present** | Signal-bar ticks **absent** |
|---|---|---|---|
| null_fill | 112 | **112 (100%)** | 0 |
| missed | 180 | **180 (100%)** | 0 |

**Verdict: NOT a coverage gap — a loading/code defect.** Every single degenerate row has dense
`tick_aggregates` (≈ 60 ticks per 5-min bar, ~5s cadence; both signal bar and next bar fully populated for
all recent opens) at the exact window the shadow path queries. The "no next-bar evidence" miss was recorded
**despite the ticks existing in the DB**.

### B5.4 — flush-lag is not the driver (and the timing comparison is itself confounded)

A natural hypothesis for the degeneracy is **flush lag**: the shadow fires ~1 s after bar close, before the
bar's final ticks persist. Decision-to-bar-close latency by group:

| Group | Decision fired (avg) relative to signal-bar close |
|---|---|
| degenerate null_fill (05-30→06-08 era) | +1.1 s after bar close |
| degenerate missed (05-30→06-08 era) | +10.4 s after bar close |
| clean filled (06-21→06-23) | +0.9 s after bar close |

The clean fills fire at the **same ~1 s latency** as the degenerate null rows yet fill correctly — so a fixed
~1 s flush window is **not** a sufficient explanation on its own. **But this comparison is itself confounded:**
the two groups sit on opposite sides of the same multi-deploy + gate-regime boundary as B5.2, so "same
latency, opposite outcome" shows flush-lag is **not the sole driver**, not that timing is irrelevant. A
sub-second ingestion race remains the most *plausible* transient trigger, but it is **unproven** — which is
why M44 does **not** build a retry against it (§Not doing); a fix is justified only if §Contingency triggers.

### Diagnosis

**The fidelity flip is observed; its specific cause is not isolated; the live-relevant open work is sample
size + hardening.**

- The degenerate `simulated_fill` rows are concentrated in the **05-30 → 06-08** all-gate-allowed era; B5.3
  proves ticks existed for 100% of them, so they record a miss despite available data — a genuine defect
  *class*.
- That class **no longer reproduces** on the only clean gate-allowed window we have (06-21→06-23): 13 opens
  → 10 fills, non-degenerate close reasons. **But the boundary is confounded** (M40 + M43 deploys + gate
  re-allow), so M44 does **not** attribute the fix to any one change.
- The degenerate rows are **window-excluded, not backfilled** — see the explicit B5 window pin in D2.
- The open work is therefore (a) **harden** the path so this defect class becomes unrepresentable and
  self-diagnosing regardless of trigger (D1), and (b) **accumulate ≥ 30 clean v3 fills** spanning ≥ 1 regime
  to satisfy the count floor (D2).

---

## Mechanism of the historical degeneracy (already resolved — context, not a fix list)

The current clean window is non-degenerate, so **no simulator fix is required to close B5**. This section
explains *what the 291 degenerate rows were* (so the window-exclusion in D2 is justified), not *what to
build*. Two code facts pin the artifact:

1. **The `missed:true, missedReason:null, entryPrice:"0"` shape is not constructible by the current
   `buildMissedShadowFill`** (`ShadowStrategyOrchestratorService.ts:1036-1054`), which always sets a
   non-null `missedReason` (`MISSING_TICK_DATA` or `WRONG_SIDE_OF_STOP`). A null `missedReason` with
   `missed:true` is therefore a row written by a **prior code revision** (verified pre-fix against commit
   `6f74ffe`) that has since changed shape. This is the smoking gun that those rows are **pre-fix
   artifacts** — and the reason B5 is measured on the **pinned post-fix window** (D2), never on full history.

2. **The `loadSignalBarEvidence` "no ticks ⇒ conservative miss" path** (`:265-280`) collapses both "ticks
   genuinely absent" and "ticks present but not loaded" into the same silent `nextBarOpenPrice: null` /
   `debug`-log outcome. B5.3 proves ticks were present for 100% of the degenerate rows, so that branch fired
   for a transient (most plausibly a sub-second ingestion race), not a real absence. That branch **no longer
   produces degenerate fills on the clean post-`a43fda1` window** (B5.2) — the artifact is historical.

> **Important non-claim (the evidence-first stance).** M44 does **not** assert the degenerate rows had a
> single deterministic root cause, and does **not** pre-build a fix for it. They are not reproducible on the
> current clean window, and the 06-21 boundary is confounded by multiple deploys + the gate-regime change
> (B5.2/B5.4). B5 is closed by **soak accumulation + re-measurement** on the pinned post-fix window, under the
> **window-exclusion discipline** (D2) that keeps the historical artifacts out of the series. If — and only
> if — re-measurement at n≥30 *still* shows degeneracy does an evidence-based fix get built, as separate work
> (§Contingency).

---

## Scope

### D2 (IN — THE milestone deliverable, no code) — soak + re-measure to close B5

This is the **only B5-gating deliverable**. There is no code change; the live shadow path already produces
clean fills, so M44 closes B5 by letting the soak accumulate fills and then re-running the measurement and
recording the result. The executable acceptance criteria, query, and timeline are in the **B5 close criteria**
section below.

### D1 (OPTIONAL — non-blocking hardening; does NOT gate B5)

Neither item is required to close B5. Both may ship as a small separate PR **or** be deferred. They exist
only because the failure mode was **silent for ~3 weeks** before this investigation surfaced it.

- **D1.1 — Typed-miss invariant (OPTIONAL regression guard).** Make the blank-`missedReason` miss
  **unrepresentable**: enforce `missed === true ⟹ missedReason != null` (and `missed === false ⟹ non-null
  `closeReason` + `exitPrice`). Best landing point is the Zod schema refine
  `packages/shared/src/schema/simulatedFillSchema.ts` (cross-field rule on the `missedReason` field at line
  25 via `.superRefine`) — the durable boundary, since `insertShadowDecision` validates through it before
  write — and optionally mirrored in the build functions (`ShadowStrategyOrchestratorService.ts:1036-1054`,
  `:654-674`, `:778-808`). **Nice-to-have**: it would have made the historical artifact a hard write-time
  error instead of silent data. It does **not** change runtime fill behavior and is **not** required to close
  B5.
- **D1.3 — Miss observability (RECOMMENDED cheap insurance).** Promote the silent `debug` log on the
  conservative-miss branch (`:269-275`, `:372-376`) to a **counter / `warn`-on-rate**, distinguishing "ticks
  absent" from "evidence null despite ticks." This is the **recommended** of the two: it is cheap and it is
  what would surface a *future* recurrence within hours instead of weeks (the failure was undetected for ~3
  weeks). Still **non-blocking** for B5 — B5 closes on the re-measurement regardless.

---

## B5 close criteria + window discipline (the executable acceptance surface for D2)

There is no harness that enforces soak criteria, so the **recorded evaluation is the executable surface**
(per M43 reviewer H1).

> **Pinned B5 measurement window (reproducible — there is NO restart timestamp).** All B5 counts use
> `from = 2026-06-21 00:00 UTC` — the first day gate-allowed v3 opens resumed and the first clean fills
> appear — which is at/after the **M40 commit `a43fda1` (2026-06-21 ~00:19 UTC)**. Use the M40 commit time as
> the precise lower bound. This pin (not "≥ some restart ts") is what makes the R4 window-exclusion
> **reproducible**: every B5 / `compareVersions` read must set `from ≥ 2026-06-21` so the 291 degenerate
> 05-30→06-08-era rows can never re-enter the series.

B5 closes when an operator/scribe records, on the pinned window above spanning **≥ 1 full soak day**, that
for **v3 (id=4)**:

1. **Zero** `simulated_fill IS NULL` rows among gate-allowed opens (the `!hasNextBarEntry` path produces no
   misses on the window), **and** zero blank-`missedReason` misses (the degenerate signature does not recur).
2. Non-null **fill** count **≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` (30)** — the floor is on **fills, not
   opens**.
3. `force_close` fraction among populated fills **≤ `MAX_FORCE_CLOSE_FRACTION` (0.5)**.
4. **The 30 fills span ≥ 1 regime** (e.g. a market-condition shift across the window, not 30 fills from a
   single quiet stretch). A count met inside one regime is the **same overfitting trap** as the win-rate
   selectivity core (research #4, window-3-heavy); the B5 record must note the regime span, not just the
   count.

The pinned window already satisfies (1) and (3) at **n=10 fills**; M44 closes (2) purely by **soak
accumulation** — no deploy is required, the live shadow path already produces clean fills. **Throughput math
(with the fill-rate haircut):** v3 produces ≈ 4–5 gate-allowed opens/day, but the ≥30 floor is on **fills**,
and fills run ≈ **77%** of gate-allowed opens (10/13 on the clean window) ⇒ ≈ **3.3 fills/day**. Honest base
case to clear 30 fills is therefore **≈ 9–10 days**, not ~7 — and faster only if elevated volatility lifts
the trigger/gate-allow rate. **Do NOT backfill degenerate rows to fake the count** (M40/M43 non-goal — see
Non-goals).

### Re-measurement step (the executable B5 close action)

Once ≥ 9–10 soak days have elapsed past the pin, the operator/scribe runs this **read-only** query and
records the four-criteria result + the regime span in the work-log. B5 closes iff all four hold:

```sql
-- B5 re-measurement: v3 (id=4), pinned post-fix window. READ-ONLY.
SELECT
  count(*) FILTER (WHERE simulated_fill IS NULL)                                              AS null_fills,            -- criterion 1: must be 0
  count(*) FILTER (WHERE (simulated_fill->>'missed')::boolean IS TRUE
                     AND simulated_fill->>'missedReason' IS NULL)                             AS blank_reason_misses,   -- criterion 1: must be 0
  count(*) FILTER (WHERE (simulated_fill->>'missed')::boolean IS FALSE)                       AS fills,                 -- criterion 2: must be >= 30
  count(*) FILTER (WHERE (simulated_fill->>'missed')::boolean IS FALSE
                     AND simulated_fill->>'closeReason' = 'force_close')                      AS force_close_fills      -- criterion 3: / fills must be <= 0.5
FROM shadow_decisions
WHERE strategy_version_id = 4 AND action = 'open' AND gate_allowed IS TRUE
  AND created_at >= '2026-06-21';
-- criterion 4 (regime span) is assessed from the close_reason / daily-PnL spread across the window, recorded narratively.
```

If criteria 1–4 hold → record B5 CLOSED. If criterion 2 (count) is not yet met → keep soaking. If criterion 1
or 3 **fails at n≥30** → go to §Contingency.

### Non-goals (explicit)

- **No code change gates B5.** No strategy code, no parameter tuning, no promotion, no simulator change. v3
  stays shadow; v2 stays active. (D1.1/D1.3 optional hardening may ship separately but is not part of the B5
  gate.)
- **No backfill of the 291 degenerate (05-30→06-08-era) rows.** They are window-excluded, not repaired. A
  populated-but-fabricated series fails the spirit of B5.
- **No pre-built fill-simulator fix.** The current path is non-degenerate on the clean window; a fix is built
  only if §Contingency triggers.
- **No acting on win-rate findings (4) or over-risk finding (5).** Those are downstream work that B5
  closure ENABLES (see "What this unblocks"), not M44 deliverables.

---

## Code locations (reference — no B5-gating change)

The B5 deliverable (D2) touches **no code**. These are the reference points for the optional D1.1/D1.3
hardening and for any future §Contingency fix:

- `packages/shared/src/const/comparisonConsts.ts` — `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` (30),
  `MAX_FORCE_CLOSE_FRACTION` (0.5) (read-only; the B5 thresholds the re-measurement query checks).
- `packages/analysis/src/query/compareVersions.ts` (`:96-191`) — already pairs v3 from `shadow_decisions`
  on `event_id`; **no change needed**, but it is the consumer B5 closure makes trustworthy.
- `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` (optional hardening / contingency
  only):
  - `loadSignalBarEvidence` (`:265-280`) + conservative-miss branch (`:369-376`) — where D1.3 observability
    would land, and where a §Contingency retry would land if ever justified.
  - `buildMissedShadowFill` (`:1036-1054`), `buildFilledShadowFill` (`:654-674`),
    `persistShadowDecision` (`:778-808`) — where the D1.1 invariant would land (alongside the schema refine).
  - `simulateShadowFill` (`:624-652`) + `runDeferredExitWalks` (`:532-569`) — the W1-same-bar +
    deferred-next-bar split that already yields the clean post-`a43fda1` `time_stop/sl/tp` distribution.
    **Behavior is correct; do not change it.**
- `packages/shared/src/schema/simulatedFillSchema.ts` (`:25`) — where the optional D1.1 cross-field refine
  would land.

---

## Verification / QA requirements

**The B5 gate (D2) has no unit test — its executable surface is the re-measurement query** (above), re-run on
the pinned window `from ≥ 2026-06-21` (M40 commit `a43fda1`) once ≥ 9–10 soak days have elapsed, with the
four-criteria result + regime span recorded in the work-log. That recorded artifact is the B5 close action.

**Optional-item tests (only if D1.1 / D1.3 ship as the separate hardening PR)** — per
`docs/best-practices/dev-qa-cycle.md` (paired tests per fix item, adversarial QA):

1. **D1.1 invariant test (unit, only if D1.1 ships).** A constructed `missed:true` fill with null
   `missedReason` must be rejected by the Zod schema refine; assert `buildMissedShadowFill` always sets a
   typed reason and `persistShadowDecision` refuses an asymmetric fill. Boundary: `missed:true`+
   `missedReason:null`, `missed:false`+`closeReason:null`.
2. **D1.3 observability test (unit, only if D1.3 ships).** A conservative-miss emits the rate-counter/`warn`
   and the log payload distinguishes "ticks absent" from "evidence null despite ticks."

There is **no retry test and no parity-guard test** in M44 — the bounded retry is explicitly **not built**
(see §Not doing). If §Contingency later justifies a retry, its tests (filled-on-retry, typed-miss-on-exhaust,
fire-and-forget, and the same-FINAL-tick-state parity guard against the never-retrying backtest
`BacktestOrchestrator.ts:270`) are specified **in that separate work**, not here.

If the optional D1.1 schema refine ships, the architect signs off on the contract touch to the shadow fill
JSONB shape (it tightens, never widens, the existing `ISimulatedFill` contract).

---

## Not doing (no evidence) — the bounded signal-bar-evidence retry

Earlier drafts of M44 proposed a **bounded retry** of `loadSignalBarEvidence` to absorb a hypothesised
sub-second ingestion lag. **It is explicitly NOT built.** The timing data does **not** establish flush-lag as
the cause: the clean fills fire at the **same ~1 s post-bar-close latency** as the historical degenerate null
rows yet fill correctly (B5.4), and the 06-21 flip is confounded by multiple deploys + the gate-regime change
(B5.2) — so a retry would be **speculative engineering against an unproven cause**. A retry is built **only
if** D1.3 observability (if shipped) later proves that real lag-induced misses occur on live data, or if
§Contingency triggers. This is the evidence-first stance: don't add code to fix a cause we have not
demonstrated.

---

## Contingency — if re-measurement at n≥30 STILL shows degeneracy

The whole milestone rests on one empirical bet: the clean post-`a43fda1` window is the **true** steady state,
not a fluke or a regime artifact. If the D2 re-measurement reaches **n≥30 fills** but criterion 1 (zero
null/blank-reason misses) or criterion 3 (`force_close` ≤ 0.5) **fails** — i.e. degeneracy reappears at
scale — then **the pre-fix-artifact conclusion is wrong** and B5 is **not** closed by soak alone. In that
case:

1. **Do not close B5.** Record the failing re-measurement (counts + which criterion failed + the symbols /
   regime where degeneracy clustered) in the work-log.
2. **Re-open as separate, evidence-based work** — now with a **reproducing window** (the n≥30 failing data),
   which the current investigation lacks. The fix is then chosen against that evidence (a bounded retry **if**
   the failures correlate with ingestion lag; a different mechanism if they do not). D1.3 observability, if it
   shipped, will have narrowed the cause by then.
3. **M44 does not pre-build that fix.** Pre-building now would be speculative against an unproven cause
   (§Not doing). The contingency is a documented branch, not a deliverable.

---

## Risks

- **R1 — the ≥30-FILL floor takes ≈ 9–10 days, not ~7.** The floor is on non-null **fills**, not opens: v3
  produces ≈ 4–5 gate-allowed opens/day × ≈ 77% fill rate ≈ **3.3 fills/day**. B5 is a pure **soak-duration**
  gate — there is no code to merge, so the only cost is calendar time. Mitigation: none needed beyond
  patience; the count is a recorded soak gate (mirrors the M40/M43 "operator records" pattern). A volatility
  spike that lifts the trigger/gate-allow rate shortens it.
- **R2 — the empirical bet may be wrong** (the clean window is a fluke or regime-dependent, and degeneracy
  reappears at n≥30). This is the central risk of a no-fix milestone. Mitigation: the **§Contingency** branch
  — re-measurement that fails at scale re-opens the work *with* a reproducing window the current
  investigation lacks, and the optional **D1.3** observability (if shipped) would surface a recurrence within
  hours instead of the ~3 weeks the original went undetected.
- **R3 — the failure mode was silent for ~3 weeks**, so a future recurrence could again go unnoticed until a
  promotion query reads garbage. Mitigation: ship the optional **D1.3** miss counter/`warn` as the cheap
  insurance it is intended to be (recommended, though non-blocking for B5).
- **R4 — window-exclusion discipline must be honored by every downstream query.** A B5/`compareVersions` read
  spanning the 05-30→06-08 era will reabsorb the 291 degenerate rows and fail spuriously. Mitigation:
  document **`from ≥ 2026-06-21` (M40 commit `a43fda1`)** as a hard, reproducible precondition in the B5
  record and in the tech-debt window-discipline note (already flagged M40 B6) — a pinned date, not "≥ some
  restart ts" (there is no restart).
- **R5 — STATUS.md / README divergence (for the scribe).** `docs/STATUS.md:7` still shows **M15 ACTIVE**
  while `docs/plans/README.md` now shows M44 ACTIVE + M15 DEFERRED. The architect did **not** edit STATUS
  (single-writer = scribe). The scribe must reconcile STATUS at milestone close. The M15 deferral itself is
  sound (go-live gates behind shadow-fidelity B5 + v3-edge evaluation).

---

## What this unblocks (downstream — NOT part of M44)

B5 closure makes the v3 shadow series trustworthy, which enables — as **separate, later** milestones:

- **D1b — v3-promotion *evaluation*** (NOT promotion). With a non-degenerate v3 series, a real
  `compareVersions(v2=id3, v3=id4, from ≥ 2026-06-21)` can compute the **paired-bootstrap ΔPnL CI on shared
  `event_id`** and the **mechanism-attribution partition** (routed `catalyst_risk`/`forced_exhaustion` vs
  non-routed `trend_initiation`) that M43-D1b lists as promotion prerequisites. M44 enables the
  **evaluation**; promotion still additionally requires the soak-promotion engine pathway + its own ADR (out
  of scope here).
- **A trustworthy `compareVersions`.** The tool already reads `shadow_decisions` and pairs on `event_id`
  (`compareVersions.ts:138`); B5 closure removes the degenerate-fill noise that currently makes its v3 output
  meaningless.
- **Empirical evaluation of the win-rate selectivity finding (research #4)** for v3 — the
  `trend_initiation` + idiosyncrasy ≥ 0.75 hypothesis — against a real shadow PnL series across sub-windows,
  rather than the single-window backtest it rests on today. **Contextual / downstream only.**

---

## ADRs

No new architectural decision is required — M44 is a verification gate that changes no behavior under
**ADR 0029** (shadow counterfactual fill wiring) and its M37/M39/M40 amendments. If the **optional** D1.1
typed-miss invariant ships, the scribe records the tightened `ISimulatedFill` contract as an **ADR 0029
amendment note**, not a new ADR. Any §Contingency fix gets its own ADR entry when (and only if) it is built.
The B5 thresholds live in `comparisonConsts.ts` and are unchanged.
