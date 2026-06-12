# Independent Review — M19 Per-Coin Liquidity Gate

**Plan reviewed:** `docs/plans/archive/M19-per-coin-liquidity-gate.md`  
**Codebase snapshot:** 2026-06-03 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M19 correctly diagnoses a **real soak-blocking defect**: a per-coin book-depth property is wired into the **global** market-stress halt, so one thin alt on a UTC day sets `risk_state.is_halted=true` and every later signal — including deep tier-1 books — dies as `global_halt`. The proposed fix (move depth to per-tier eligibility in `firstFailingTierFilter`, keep spread widening global) matches ADR 0004’s intent and the existing `TIER_SPREAD_CEILING_PCT` pattern.

The breadth-threshold bug is also **verified in code**: with seeded `stress_breadth_pct = 70`, `|breadth − 50| ≥ 70` is impossible (max distance is 50). Re-seeding to 30 is mathematically correct for the stress evaluator.

**Assessment:** Approve the direction and dispatch waves. Resolve **parameter coupling** and **invalid-depth fail-closed** behavior before or during implementation; add **post-deploy halt clearing** and **dashboard tooltip** to verification/scribe scope.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | Matches live funnel (83 `global_halt`) and code path in `StressHaltEvaluator` → `persistHalt`. |
| Architectural fix | A- | Per-tier filter after halt checks is the right seam; mirrors spread gate. |
| Breadth fix (stress) | A | Dead threshold confirmed; 30 is the first value that can fire. |
| Parameter coupling | C+ | Same `stress_breadth_pct` drives flow routing with **different** semantics — side effect under-documented. |
| Migration / soak ops | B | Dump gate is correct; missing “clear today’s halt after deploy” step. |
| Test plan | B+ | Good regression (thin coin, no halt); breadth tests need param value alignment. |
| Dashboard / ops UX | B- | New reject reason not in `DecisionsFeed` tooltips. |

**Bottom line:** **Approve with amendments** — ship M19 after documenting breadth param side effects, specifying invalid-depth handling, and adding post-deploy soak steps.

---

## Verified Current State

### Global depth collapse is live today

```81:86:apps/engine/src/risk/service/StressHaltEvaluator.ts
    private isLiquidityShock(snapshot: IMarketSnapshot): boolean {
        const spreadWidening = snapshot.bid_ask_spread_pct >= STRESS_SPREAD_PCT;
        const depthCollapse = new Money(snapshot.book_depth_10bps_usdt).lessThanOrEqualTo(STRESS_BOOK_DEPTH_FLOOR);

        return spreadWidening || depthCollapse;
    }
```

`STRESS_BOOK_DEPTH_FLOOR_USDT = 20_000` in `riskConsts.ts`. Any snapshot with depth ≤ $20k trips **global** stress.

### Halt persists before per-coin filters run

```412:428:apps/engine/src/risk/service/RiskGateService.ts
    private async firstFailingCheck(...): Promise<RejectReasonEnum | null> {
        const haltReason = await this.firstFailingHaltCheck(context, state);

        if (haltReason !== null) {
            return haltReason;
        }

        const tierReason = this.firstFailingTierFilter(intent, context);
        // ...
    }
```

When stress fires, `persistHalt` sets `is_halted=true` for the UTC day. Subsequent intents hit `GLOBAL_HALT` at line 458–459 even on deep books.

### Breadth halt is permanently dead at seed value

```74:78:apps/engine/src/risk/service/StressHaltEvaluator.ts
    private isBreadthCollapse(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        const distanceFromBalance = Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT);

        return distanceFromBalance >= params.stress_breadth_pct;
    }
```

Seed migration sets `stress_breadth_pct: 70` (`20260522020000-SeedStrategyVersions.ts`). Maximum `|breadth − 50|` is 50, so this branch never returns true.

### Per-coin spread gate is the template M19 should follow

`firstFailingTierFilter` already rejects `SPREAD_TOO_WIDE` via `TIER_SPREAD_CEILING_PCT` (tier-keyed, no halt). Plan correctly places `isBookTooThin` adjacent to `isSpreadTooWide`.

### Test fixtures already use deep book depth

`buildGateContext` / `buildPassingContext` default `book_depth_10bps_usdt: '20000000.00'` — unrelated gate tests should not trip a per-tier floor once added, assuming defaults stay deep.

---

## High-Risk Findings

### H1 — `stress_breadth_pct` is overloaded; migration changes flow routing, not just stress halt

The plan fixes stress breadth via `stress_breadth_pct: 70 → 30`, but the **same param** is used in `classifyFlowType` with **different semantics**:

```48:52:packages/shared/src/util/classifyFlowType.ts
    if (event.marketBreadth5mUpPct > params.stress_breadth_pct && event.sameBarTriggerCount >= params.stress_same_bar_trigger_count) {
        return FlowTypeEnum.MARKET_BETA;
    }
```

| Consumer | Semantics at 70 | Semantics at 30 |
|----------|-----------------|-----------------|
| `StressHaltEvaluator` | Never fires (`|b−50| ≥ 70` impossible) | Fires at breadth ≤ 20 or ≥ 80 |
| `classifyFlowType` | MARKET_BETA only if breadth **> 70%** | MARKET_BETA if breadth **> 30%** (much more often) |

A calm soak with breadth ~55% and `same_bar_trigger_count ≥ 5` would **not** have routed to MARKET_BETA at 70, but **would** at 30. That is a strategy-layer behavior change outside the plan’s stated scope (“strategy-signal changes” out of scope).

**Required:**

- Architect ADR note: document intentional coupling or recommend splitting params in a follow-up.
- QA: add/update `classifyFlowType.spec.ts` cases at `stress_breadth_pct: 30` (breadth 55 + trigger count 5).
- Verification: after migration, spot-check decision funnel for shift in flow-type mix, not only reject-reason counts.

If the team did **not** intend to loosen MARKET_BETA routing, use a migration that only updates rows for stress purposes is insufficient — split `stress_breadth_distance_pct` vs `flow_market_beta_breadth_min_pct` (larger scope) or keep flow threshold at 70 while fixing stress with a new param.

### H2 — Invalid / missing `book_depth_10bps_usdt` needs explicit fail-closed in `isBookTooThin`

`hasInvalidStressInputs` does **not** include `book_depth_10bps_usdt`. After M19, bad depth no longer trips global stress, but `new Money(context.snapshot.book_depth_10bps_usdt)` can throw `MoneyParseException` on malformed strings — unlike spread, which uses `Number.isFinite` fail-closed in `isSpreadTooWide`.

**Required in implementation (plan should specify):**

- Mirror spread defense: if depth string is missing, empty, or not parseable → reject `COIN_BOOK_TOO_THIN` (fail-closed skip), not an unhandled exception.
- Unit test: invalid depth → per-coin reject, `upsertDay` not called with halt.

---

## Medium-Risk Findings

### M1 — Post-deploy: today’s `risk_state.is_halted` may still block deep coins

Deploying code-only depth fix stops **new** halts from depth collapse, but soak rows already flipped `is_halted=true` for the current UTC day remain until rollover or operator clear (`RiskStateRepository.clearHaltForDate` exists for this).

**Add to verification (post-deploy):**

1. Check today’s `risk_state` row; if `is_halted` and `halt_reason = market_stress` from pre-M19 depth, **clear halt** via dashboard/operator path before judging funnel metrics.
2. Re-run funnel query only after clear (or after UTC midnight).

Without this, verification may falsely conclude M19 failed when stale halt state is the blocker.

### M2 — Migration SQL should follow existing migration patterns

Plan sketch:

```sql
UPDATE strategy_versions SET params = jsonb_set(params,'{stress_breadth_pct}','30') ...
```

**Tighten:**

- Explicit `WHERE name = 'volatility-vwap'` (matches `20260621000000-PromoteShadowStrategyVersions.ts` pattern).
- Use parameterized query or `'30'::jsonb` for type clarity.
- `down()` restores `70` only for rows still at 30 (idempotent).
- Confirm migration runs on **all** `volatility-vwap` versions (v0–v3), not only active — replay and shadow rows load params too.

### M3 — Boundary semantics: depth uses `<=`, spread uses `>`

Plan’s `lessThanOrEqualTo(floor)` matches today’s global stress behavior (depth exactly at floor = stressed). Tier spread uses strict `>` (at ceiling = pass). Tests should document:

- Tier-2 depth exactly **10_000** → `coin_book_too_thin`
- Tier-2 depth **10_000.01** (or smallest tick above) → pass depth gate

Align with spread suite boundary style in `RiskGateService.spec.ts` (~lines 288–320).

### M4 — Dashboard operator visibility

`DecisionsFeed.tsx` documents many risk reject reasons but has no entry for `coin_book_too_thin`. Soak operators will see the raw string without tooltip context.

**Recommendation:** Add scribe/dashboard task (small): one `TooltipEntry` under “Risk gate reject reasons”. Out of engine scope but cheap; avoids confusion during funnel verification.

### M5 — Breadth unit tests use `stress_breadth_pct: 80`, not production 70/30

`StressHaltEvaluator.spec.ts` `calmParams()` uses 80; breadth cases fire at breadth 130 (`|130−50| = 80`). After migration-focused tests at 30, add:

- Fires at breadth **20** and **80** (`|20−50| = |80−50| = 30`)
- Silent at breadth **25** and **75** (distance 25 &lt; 30)

Update `calmSnapshot` comment — it currently says “well under stress_breadth_pct=80”.

### M6 — Backtest inline fixtures still hardcode `stress_breadth_pct: 70`

`BacktestOrchestrator.spec.ts`, `BacktestRunnerService.spec.ts`, `ComparisonRunnerService.spec.ts` embed params with 70. Migration does not affect them; breadth halt stays dead in those tests unless fixtures update. Acceptable if out of scope, but quant reviewer should note **backtest stress breadth remains dead** until a separate harness fix.

---

## Low-Risk / Clarifications

### L1 — ADR 0004 §6 still lists depth as global stress input

Plan correctly schedules architect **before** engine. ADR must remove `book_depth_10bps_usdt` from global stress field list and point to per-tier `COIN_DEPTH_FLOOR_10BPS_USDT`.

### L2 — `STRESS_BOOK_DEPTH_FLOOR_USDT` removal is clean

Only referenced in `StressHaltEvaluator.ts`, `riskConsts.ts`, and `StressHaltEvaluator.spec.ts` (grep 2026-06-03). No dashboard/shared export beyond tests.

### L3 — Locked tier floors vs soak data

Floors `{ tier1: 20k, tier2: 10k, tier3: 5k }` align with moving the old global 20k floor to tier-1 only and relaxing alts. Roughly half of soak opens had depth &lt; 20k; tier-2 at 10k still skips the thinnest (~$1k–$7k) while allowing mid-tier alts through — consistent with “skip thin, don’t halt market.”

### L4 — `hasInvalidStressInputs` unchanged is correct

Book depth was never in the global invalid-input guard; removing depth from stress does not weaken spread/BTC/breadth NaN fail-closed behavior.

### L5 — Shared enum only; no Zod schema change

`RejectReasonEnum` addition is sufficient if decisions persist reason as enum string (existing pattern). No shared snapshot schema change needed.

---

## What the Plan Gets Right

1. **Root cause is architectural**, not threshold tuning — moving depth out of global stress is the correct fix, not lowering the global floor alone.
2. **Pipeline placement** — per-coin filter after halt checks guarantees thin coin → skip, never day-kill.
3. **Spread widening stays global** — market-wide spread blowout still halts; reasonable split of “coin illiquidity” vs “market illiquidity.”
4. **Regression test requirement** — thin coin → `coin_book_too_thin` **without** `is_halted` is the must-have adversarial case.
5. **DB safety gate** — dump before breadth migration on soak; depth change is code-only.
6. **Dispatch order** — architect → shared → engine → QA → parallel review → scribe matches CLAUDE.md and ADR touch.
7. **Do not edit seed migration** — follow-up migration correcting 70→30 is the right pattern for already-run seeds.

---

## Recommended Plan Amendments

| # | Amendment |
|---|-----------|
| 1 | New subsection **“`stress_breadth_pct` coupling”** — document `classifyFlowType` MARKET_BETA side effect; state whether 30 is intentional for both or split params deferred. |
| 2 | Specify **invalid-depth fail-closed** in `isBookTooThin` (mirror `isSpreadTooWide`). |
| 3 | Post-deploy verification: **clear stale `market_stress` halt** for current UTC day before funnel metrics. |
| 4 | Migration: explicit `WHERE name = 'volatility-vwap'`, parameterized/`::jsonb`, idempotent `down()`. |
| 5 | Scribe: dashboard `coin_book_too_thin` tooltip in `DecisionsFeed.tsx`. |
| 6 | QA: breadth tests at threshold **30**; optional `classifyFlowType` test at migrated param. |

---

## Suggested Verification Additions

Beyond the plan’s checklist:

8. **Stale halt clear** — after deploy, confirm operator can resume trading same UTC day (halt clear path), then deep tier-1 intent reaches slot/sizing gates.
9. **No depth global stress** — snapshot with depth $5k, spread calm, BTC calm → `coin_book_too_thin` on tier-2 intent, **not** `market_stress`; `risk_state.is_halted` unchanged.
10. **Flow-type spot check** — sample 20 post-migration OPEN/SKIP decisions: note whether MARKET_BETA share increased vs pre-migration (guards H1).
11. **Invalid depth** — malformed `book_depth_10bps_usdt` → per-coin reject, no process throw.
12. **Migration idempotency** — run migration twice on dev DB; `stress_breadth_pct` stays 30.

---

## Implementation Wave Risk Summary

| Wave | Risk if skipped |
|------|-----------------|
| Architect | ADR/code drift; breadth coupling undocumented |
| Shared enum | Engine cannot compile reject reason |
| Engine | Soak keeps day-killing on thin alts |
| QA | Regression reintroduces global halt on depth |
| Review | H1/H2 missed; invalid depth crashes evaluate path |
| Scribe | Operators misread funnel; status docs stale |

---

## Conclusion

M19 is **necessary, well-scoped, and fixes the actual soak calibration blocker**. The depth→per-tier move is the highest-value change; the breadth migration is correct for the stress evaluator but has **cross-layer side effects** that the plan should acknowledge explicitly.

**Recommended status:** **Approve with amendments** — proceed with dispatch after adding H1 coupling note, H2 invalid-depth spec, and M1 post-deploy halt-clear step to the plan (or track as implementation checklist items verified by orchestrator).
