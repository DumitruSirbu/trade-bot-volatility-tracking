# Review: M29 — Paper funnel diagnosis + first-fill enablement

## Executive summary

M29 is a well-evidenced, conservative milestone that correctly reverses the WIP’s premature slot-C build order. The soak DB analysis (539 open intents, zero approvals, zero positions) and the root-cause write-up for `exposure_cap_per_coin` firing with empty books are strong. The proposed fix — clamp proposed notional to the operator per-coin ceiling rather than raising caps — aligns with the project’s survival-first invariant.

**Verdict: approve with two implementation corrections before dispatch.** The plan is directionally sound and appropriately scoped, but step 2 names the wrong call site for sizing (`RiskGateService` does not invoke `PositionSizer`), and it should explicitly amend ADR 0042 §4, which previously locked “no PositionSizer code change.” Address those in the plan text so `bot-engine-nestjs` does not wire the clamp to a dead path and so reviewers do not treat M29 as contradicting ADR 0042 silently.

First paper fill remains plausible (up to ~36 intents that already passed `sl_outside_liquidation` and slot checks), but it is not guaranteed until post-deploy evidence confirms those intents also clear execution. The plan’s honesty about `sl_outside_liquidation` becoming the next dominant blocker is appropriate.

---

## Strengths

1. **Evidence-driven sequencing (D1).** Deferring the differentiated correlated slot-C strategy until idiosyncratic fills exist is the right call. Building a second order path on zero baseline P&L would make attribution impossible.

2. **Root-cause #1 analysis is code-accurate.** With `checkExposureCaps` summing open + active + intent notional, an empty book reduces the predicate to `intent.sizing.notional > maxExposurePerCoinUsdt`. The ATR sizing formula vs a $500 cap under `$1,500 × 1%` risk and `MAX_LEVERAGE=3` is a credible calibration conflict, not a gate bug.

3. **D2 fix direction is conservative.** Clamping down to the cap preserves the operator ceiling as source of truth, mirrors the existing leverage clamp pattern, and keeps `checkExposureCaps` as defence in depth. Rejected alternatives (raise cap, lower global risk pct) are argued correctly.

4. **Pipeline ordering is reflected in the diagnosis.** Because `sl_outside_liquidation` is evaluated in `evaluateEntry` before `reserveAndApprove` / `checkExposureCaps`, the 36 `exposure_cap_per_coin` rejects are a disjoint set that already cleared the SL gate. Unblocking them is a real funnel improvement, not double-counting with the 66 SL rejects.

5. **D5 discipline.** Refusing to hand-edit VWAP structural stops, depth floors, or idiosyncrasy thresholds in the same milestone that unblocks fills avoids over-fitting. Logging `sl_outside_liquidation` as MEDIUM tech-debt for a quant follow-up is correct.

6. **Observability without schema (D3).** Preferring a canonical rollup query under `packages/analysis` (existing query module, parameterized SQL, Jest coverage pattern) over a new persisted funnel table respects CLAUDE.md DB rules and M27’s “derived reporting” shape.

7. **Operational safety.** pg_dump-before-restart, stale-halt inspection, and the 14-day idiosyncratic-edge soak gate for any slot-C work match project invariants.

---

## Architectural decisions assessment

### D1 — Diagnosis first, not slot C
Sound. The plan correctly distinguishes “correlated plumbing exists” from “correlated strategy does not.” The Jun 7 `btc_correlated_not_best_candidate` batch (20 symbols at one timestamp) is good proof the buffer fires; D4 tests lock that without behaviour change.

### D2 — Sizer clamp to per-coin cap
Conceptually correct and the highest-value code change in the milestone. Two seam details need plan correction (see **Blockers / must-fix** below):

- Sizing runs in `StrategyService.buildOrderIntent` and `BacktestOrchestrator`, not in `RiskGateService`.
- Clamp must be applied to pre-round notional, then qty step-rounded down, then min-notional checked — as the plan states — so final stored notional never exceeds the cap.

### D3 — Funnel rollup
Good minimum-touch scope. Recommend implementing as `packages/analysis/src/query/getFunnelSummary.ts` (or similar) with tests mirroring `getDecisions` / `selectHaltState`, exported from the analysis package index. If an engine HTTP endpoint is added later, it should delegate to the same query function to avoid two canonical shapes.

**Query nuance to document in the rollup:**

- Pre-M27 rows have `gate_allowed IS NULL` (510 rows per plan). Rollup should treat NULL as “unknown / pre-stamp,” not as rejected.
- Group on `(action, reason)` per ADR 0004 conflicts note; use `reason LIKE 'market_stress%'` as specified.
- Split “halted day” vs “reachable” using `reason = 'global_halt'` on `action = 'open'`, not merely counting days with `risk_state.is_halted`.

### D4 — Correlated plumbing tests
Appropriate. Partial coverage already exists (`StrategyService.spec.ts` has a `btc_correlated_not_best_candidate` case; `BacktestOrchestrator.spec.ts` covers `resolveCorrelationMode`). Implementation should extend rather than duplicate. The “same strategy core for correlated winner” test is valuable as an explicit regression lock for the WIP gap.

### D5 — No stop / depth / idiosyncrasy changes
Correct. The VWAP structural stop vs liquidation buffer tension under v2 momentum is real and likely to dominate after D2; quant/backtest is the right venue.

### D6 — Duplicate `MAX_OPEN_POSITIONS`
Hygiene-only and low risk. Note: the duplicate may live in the operator’s local `.env` (not committed); `.env.example` already shows `MAX_OPEN_POSITIONS=1` with a commented paper block at `=3`. D6 should explicitly cover **both** files so new operators are not misled by the conservative default at line 218 while the M25 paper comment block sits farther down.

---

## Blockers / must-fix (plan text, before implementation)

### 1. Wrong sizing call site in implementation step 2

The plan says:

> `RiskGateService.ts` — thread `maxExposurePerCoinUsdt` into the sizing call.

**Code fact:** `RiskGateService` never calls `PositionSizer.size`. Sizing happens in:

- `StrategyService.buildOrderIntent` (live/paper path) — already has `this.config.maxExposurePerCoinUsdt` via `resolveRiskLimits()`.
- `BacktestOrchestrator` (replay path) — must receive the same input for live/backtest parity (ADR 0015 / ADR 0004 §8 determinism).

**Required plan amendment:**

| File | Change |
|------|--------|
| `PositionSizer.ts` | Add `maxExposurePerCoinUsdt` to `ISizingInput`; generalise clamp (D2). |
| `StrategyService.ts` | Pass `new Money(this.config.maxExposurePerCoinUsdt)` into `sizer.size(...)`. |
| `BacktestOrchestrator.ts` | Pass the same cap from backtest context/limits (mirror live). |
| `RiskGateService.ts` | **No sizing call** — only confirm `checkExposureCaps` unchanged. |

Missing the backtest path would silently diverge replay sizing from live after M29.

### 2. Amend ADR 0042 §4 explicitly

ADR 0042 §4 states: **“No `PositionSizer` code change. P3b is config-only.”** That assumption held that raising `ACCOUNT_CAPITAL_USDT` and exposure caps would scale orders into the cap. M29 proves a residual conflict for low-ATR names where risk-targeted notional still exceeds `MAX_EXPOSURE_PER_COIN_USDT` before any position exists.

M29 should amend **ADR 0042 §4** (not only ADR 0004 §8) to record: config headroom alone is insufficient; the sizer must clamp to the per-coin ceiling. Otherwise logic and clean-code reviewers will flag an undocumented reversal of a locked ADR.

---

## Recommendations (non-blocking, should land in plan or QA)

### A. First-fill success criteria — qualify the binary signal

The binary acceptance signal (`positions` 0 → ≥1) is fair for milestone closure **after deploy**, but the plan title “first-fill enablement” could be read as guaranteeing fill on restart. Recommend one sentence in Success criteria:

> Code-complete M29 removes the `exposure_cap_per_coin` choke for single-intent opens; first fill still requires a non-halted session, SL-inside-liquidation clearance, depth/idiosyncrasy passes, and M24 fill execution — post-deploy checklist items 4–5 are the acceptance gate.

This prevents false “M29 failed” if the next session’s reachable blocker is entirely `sl_outside_liquidation`.

### B. Same-direction cap sanity check

With zero open positions, `same_direction_exposure_cap` can only bind if a single intent’s notional exceeds `MAX_SAME_DIRECTION_EXPOSURE_USDT`. Under paper `.env` (typically $1,500 same-direction vs $500 per-coin), this is unlikely but worth one QA fixture so M29 does not accidentally mask a parallel sizing-vs-cap conflict on the same-direction leg.

### C. Funnel query: add `gate_allowed` breakdown

M27 added `gate_allowed`. The rollup should expose:

- `gate_allowed = true`
- `gate_allowed = false` with reason
- `gate_allowed IS NULL` (pre-M27)

Without this, operators cannot confirm the M29 unblock from SQL alone.

### D. D4 test placement

Place correlated-plumbing tests in existing suites (`StrategyService.spec.ts`, `marketSnapshotMapper` unit tests, `BacktestOrchestrator.spec.ts` for mapper boundary) rather than a new scattered file — matches code-conventions colocation.

### E. `.env.example` paper block coherence

After D6, consider moving the authoritative paper `MAX_OPEN_POSITIONS=3` / `MAX_EXPOSURE_PER_COIN_USDT=500` comment block adjacent to the risk-limits section header so “read the top of the file” matches effective paper values (addresses the hazard D6 describes even when no duplicate key exists).

---

## Safety and invariants

| Invariant | Assessment |
|-----------|------------|
| No order path bypasses risk gate | Preserved — clamp is pre-gate sizing; cap check stays. |
| Strategy purity | Preserved — change is in `PositionSizer` / orchestrator wiring, not `momentumCore`. |
| Money as decimal | Plan requires pure decimal clamp — matches existing `PositionSizer` style. |
| Determinism | Preserved if backtest receives the same cap input. |
| DB safety | No migration — pg_dump + restart only; correctly stated. |
| Conservative direction | Clamp shrinks never grows — passes survival test. |

**ADR tension (resolved by explicit amendment):** M29 contradicts ADR 0042’s “no sizer change” only because soak evidence showed config-only P3b was incomplete. That is a justified amendment, not a scope creep, but it must be written down.

---

## Testing assessment

The proposed test matrix is thorough. Priority additions:

1. **BacktestOrchestrator / PositionSizer parity** — same cap input produces identical clamped notional live vs backtest for a fixture that previously exceeded per-coin cap.
2. **Integration: exposure_cap path** — end-to-end open with empty book approves at capped notional (already specified; ensure it uses real gate order through `StrategyService` → gate, not a mocked sizer).
3. **Clamp + step rounding** — assert final `intent.sizing.notional <= maxExposurePerCoinUsdt` after qty round-down (boundary where raw clamp equals cap but step rounding drops slightly below is OK; above cap is not).
4. **Funnel query unit test** — fixture rows with NULL `gate_allowed`, suffixed `market_stress:breadth`, and mixed halt/reachable days.

Existing regression locks (M28 stress, M22 depth, no strategy edits) are appropriately listed.

---

## Post-deploy checklist

The checklist is strong. Additional watch item:

- After D2 lands, if `gate_allowed=true` remains zero for 24h on non-halted days, pull the D3 rollup and confirm whether **all** reachable rejects are `sl_outside_liquidation` — that outcome validates D5 and prioritizes the next milestone without re-litigating M29.

---

## Conclusion

M29 is **approved with plan amendments** before dispatch:

1. Fix implementation step 2 to thread the cap through `StrategyService` and `BacktestOrchestrator`, not `RiskGateService`.
2. Amend ADR 0042 §4 alongside ADR 0004 §8 to document why config-only sizing headroom was insufficient.

With those corrections, the milestone is a focused, evidence-backed hinge: unblock a proven calibration conflict, instrument the funnel, defer slot-C strategy work until idiosyncratic edge can be measured, and keep every other safety floor intact. Proceed with the standard dispatch waves once the plan text reflects the sizing seam and ADR update.
