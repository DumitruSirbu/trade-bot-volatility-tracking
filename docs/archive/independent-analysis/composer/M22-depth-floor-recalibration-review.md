# Independent Review — M22 Depth-Floor Recalibration

**Plan reviewed:** `docs/plans/archive/M22-depth-floor-recalibration.md`  
**Codebase snapshot:** 2026-06-04 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M22 correctly identifies the **next soak bottleneck** after M19/M20/M21: the per-coin depth guard works as designed, but M19’s **placeholder floors** (`$20k / $10k / $5k`) are **4–80×** the live per-coin notional cap (`MAX_EXPOSURE_PER_COIN_USDT = 250`) and blocked **7 of 10** `coin_book_too_thin` rejects on a single calm day for coins with **$3.5k–$9.2k** one-sided 10bps depth — books that are thin relative to majors but adequate for a $250 clip.

Re-anchoring floors to **book-consumption ratio** (order size vs one-sided resting depth) is the right calibration frame for this bot. The proposed `{ tier1: 10_000, tier2: 2_500, tier3: 2_000 }` set is internally consistent, tier-differentiated, and matches the plan’s 7-unblocked / 3-still-blocked soak replay **if** each depth is tested at the **correct tier** the engine assigned that day.

**Assessment:** **Approve with amendments** — ship as a standalone, migration-free loosening milestone with the plan’s regression tests and 14-day slippage telemetry. Treat this as **calibration correction**, not optimality proof (one calm day, n=10). Add QA/scribe fixes for **tier-accurate soak fixtures**, **tech-debt deduplication**, and **post-deploy funnel mix**, not new product scope.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | M19 guard works; floors are the blocker; soak counts and depth band are plausible. |
| Calibration anchor | A- | Book-consumption vs $250 cap is correct; one-sided semantics must stay explicit in §6a. |
| Proposed floor values | B+ | Directionally sound; tier1 $10k is a ranking patch as much as depth math. |
| Evidence base | C+ | One day, 10 rejects — enough to reject old floors, not enough to close tuning. |
| Architectural scope | A | Const + comment + §6a only; no logic/boundary/fail-closed drift — correct. |
| Ops / DB safety | A | No halt persistence; backup-before-restart; no `clearHaltForDate` needed. |
| Test / telemetry plan | B+ | Load-bearing regression test is right; tier pinning + tech-debt merge missing. |

**Bottom line:** **Yes, lower the floors** along the proposed table. **Yes, keep `<=` and fail-closed parse unchanged.** **Yes, mandate 14-day realized-slippage telemetry before scale-up.** Amend dispatch so soak regression tests use **actual per-symbol tiers**, scribe **updates** existing M19 tech-debt rather than duplicating it, and verification tracks **reject-reason mix** after deploy.

---

## Verified Current State

### Floors today — conservative round numbers (M19 placeholder)

```79:83:apps/engine/src/risk/const/riskConsts.ts
export const COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
    [CoinTierEnum.TIER_1]: 20_000,
    [CoinTierEnum.TIER_2]: 10_000,
    [CoinTierEnum.TIER_3]: 5_000,
};
```

`docs/tech-debt.md` line 24 already records these as “reasonable round numbers, not derived from depth-vs-slippage” — M22 should **supersede that entry**, not add a third duplicate MEDIUM.

### Per-coin guard — correct seam, locked semantics

```618:644:apps/engine/src/risk/service/RiskGateService.ts
    private isBookTooThin(intent: IOrderIntent, context: IRiskGateContext): boolean {
        const floor = COIN_DEPTH_FLOOR_10BPS_USDT[intent.coinTier];
        // ...
        return depth.lessThanOrEqualTo(new Money(floor));
    }
```

- Runs in `firstFailingTierFilter` **after** halt checks → **skip only**, never day-halt (M19 fix intact).
- Boundary **`<=`** (at floor → reject) — plan correctly forbids flipping to `<`.
- Fail-closed: unknown tier / missing / garbage depth → thin (try/catch on `parseMoney`) — M22 must not touch this path.

### Order-size anchor exists in code

```54:54:apps/engine/src/risk/const/riskConsts.ts
export const MAX_EXPOSURE_PER_COIN_USDT = 250;
```

Plan’s consumption table (250 / floor) matches the engine const. Note: many fills may be **below** $250 after funding halving and sizing — using the **cap** as anchor is **conservative** (floors look stricter than realized consumption). Worth one sentence in §6a so operators do not assume every fill is $250.

### Tests already encode M19 floors — must be rewritten, not only constants

`RiskGateService.spec.ts` depth block (lines ~1407–1481) hard-codes narrative `20_000` / `10_000` / `5_000` in titles and uses `COIN_DEPTH_FLOOR - 1` for thin cases — good pattern; M22 QA should add:

- At-floor reject / one-tick-above pass for **all three tiers** (tier-2 boundary exists; tier-1 and tier-3 at-floor cases are not explicit today).
- **Regression-proof** cases with soak depths **and correct `coinTier`** (see H1 below).

### Backtest default depth avoids the gate today

`BacktestRunnerService.spec.ts` uses `book_depth_10bps_usdt: '50000000'` — replay will not stress new floors unless fixtures are tightened. Plan’s “grep backtest for old floor literals” is correct; expect **no** backtest code change unless a test asserts 20k/10k/5k (quick ripgrep in QA wave).

### Execution slippage is decoupled from depth floors

Entry slippage caps come from `MAX_SLIPPAGE_TIER_PCT` / SL distance (`OrderPolicyRouter`), not from `book_depth_10bps_usdt`. Loosening depth **admits more coins** without automatically widening modeled slippage. That makes the **14-day realized-vs-modeled** telemetry in the plan **essential** — not optional documentation.

### No stale-halt class (unlike M21)

Plan is correct: `coin_book_too_thin` is not persisted on `risk_state`. Restart picks up new floors immediately; post-deploy read-only `risk_state` check is sufficient.

---

## Calibration — are the new floors a good decision?

### What M22 actually changes

| Dimension | Effect |
|-----------|--------|
| **Risk direction** | Loosening — more symbols pass eligibility |
| **Failure mode if wrong** | Thin-book fills, elevated realized slippage, exit gap on alts — mitigated by `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2`, not prevented at entry |
| **Evidence** | 10 rejects on one calm day; 7 depths in $3.5k–$9.2k band |

This is **not** analogous to M21’s mixed “loosen ETH / enable new BTC leg” story — M22 is uniformly **lowering barriers** on a guard that was already per-coin. The plan’s explicit “risk-loosening” framing is appropriate.

### Book-consumption ratios (plan table, $250 cap, one-sided depth)

| Tier | New floor | Consumption | Plan slippage hint | Assessment |
|------|-----------|-------------|-------------------|------------|
| tier1 | $10,000 | 2.5% | ~conservative | Non-binding for real BTC/ETH; filters volume-mis-ranked tier1 impostors (MAGMA $529, H $5,380) — **good symptom fix**, not ranking fix |
| tier2 | $2,500 | 10% | ~2 bps | Correctly breaks old “tier2 = tier1 strictness” ($10k) bug |
| tier3 | $2,000 | 12.5% | ~2.5 bps | Better than $1k (~50% one-sided); exit-gap argument is qualitative but directionally right for alts |

**Rejected alternatives in the plan are well argued:**

- tier1 **$5,000** would pass H ($5,380) — bad for a mis-ranked tier1.
- tier3 **$1,000** — ~50% consumption; too aggressive for stop-exit gap risk on tier3.

### Soak replay (7 / 3 split)

Internal consistency holds **if** each depth in $3,468–$9,174 was evaluated at a tier whose **new** floor is strictly below that depth, and $529 / $681 / $2,321 were on tiers where depth ≤ new floor. The plan does not list **symbol → tier → depth** tuples in the milestone doc — QA must pin them (H1). Without that, the “load-bearing” regression test could pass with wrong tiers and still miss production behavior.

### Statistical humility (same lesson as M21)

One calm day proves **old floors were overcautious** for $250 clips; it does **not** prove 10k/2.5k/2k are optimal across volatile weeks. The plan already requires **14-day** `book_depth_10bps_usdt` at entry + realized slippage — **keep that in Verification as a hard gate before scale-up**, not scribe fluff.

---

## Must-fix before dispatch

### H1 — Soak regression tests must use actual `coinTier` per symbol

The regression-proof case (“$3,468–$9,174 pass at new floors; would fail at old”) must be implemented as **concrete `(coinTier, depth)` pairs** from 2026-06-04 decisions, not “pick tier2 and any depth in range.” Volume-only ranking means **tier1 + $5,380** (H) is the edge case: must **still reject** at tier1 floor $10,000 (passes at $5k hypothetical — plan rejects $5k tier1 for this reason).

**Add to `bot-qa-engineer` dispatch:** export or hand-copy 10 reject rows (symbol, tier, depth) into the spec as named examples.

### H2 — Scribe: update existing tech-debt row, don’t duplicate

`docs/tech-debt.md` already has MEDIUM “Per-tier book-depth floors not empirically calibrated…” (M19). M22 should:

1. **Close or rewrite** that row with the book-consumption anchor and pointer to §6a + 14-day telemetry.
2. **Add** the two **new** MEDIUM items the plan specifies (volume-only tier ranking; entry-vs-exit depth gap).

Do not leave three overlapping depth-calibration MEDIUM lines.

---

## Should-fix before dispatch

### M1 — ADR §6a amendment must supersede M19 floor prose, not append

§6a today still documents `{20_000, 10_000, 5_000}` and “deeper-book tiers carry the higher floor” without consumption math. Architect wave should **replace** the floor table and rationale wholesale (plan says this — reinforce for orchestrator diff).

**Side note:** §6b in the same ADR still documents `STRESS_BREADTH_DISTANCE_PCT = 30` while `riskConsts.ts` has **40** (June hotfix). Touching ADR §6 for M22 is a good moment to fix §6b **one line** or add “see code” — avoids two sources of truth in the same edit session.

### M2 — All three tiers: at-floor and one-tick-above tests

Plan requires it; only tier-2 boundary tests exist today. Add tier-1 at 10_000 and tier-3 at 2_000 with the same `<=` / pass-above pattern.

### M3 — Clarify telemetry deliverable (read-only vs code)

Post-deploy step 5 describes SQL-style observation on `decisions.market_snapshot` and `positions`. Specify in scribe scope: **runbook query / milestone-log template**, not a new logging feature, unless the team wants automated daily max — out of scope for a const swap.

### M4 — Post-deploy: track reject-reason mix, not only slippage

After floors drop, expect **`coin_book_too_thin` share to fall** and other gates (spread, funding, stress, slots) to rise. Add to Verification: same funnel query as M19 soak, 24–48h after restart — confirms the guard stopped dominating without implying “more trades” automatically.

### M5 — `estimated_slippage_pct` vs admitted depth

Snapshot carries `estimated_slippage_pct` (from `resolveSlippagePct` in mapper). Quant reviewer (wave 4) should confirm loosening depth does not leave **optimistic modeled slippage** on coins admitted near the floor — or document that divergence kill switch is the safety valve (plan mentions `MODEL_DIVERGENCE_SLIPPAGE_RATIO` — good).

### M6 — Orchestrator diff checklist (plan already has this — emphasize)

Diff **const values**, **comment block**, and **ADR §6a table** in one pass; a common failure mode is updating numbers while leaving M19 “round numbers” language in comments.

---

## What looks good

- **Sequencing after M19/M20/M21** — fixes the right layer (calibration), not architecture.
- **Book-consumption anchor** replaces hand-wavy round numbers; ties to `MAX_EXPOSURE_PER_COIN_USDT`.
- **Tier2 ≠ tier1 strictness** — old $10k tier2 was incoherent with tier1.
- **tier1 $10k** as impostor filter without binding real majors — pragmatic until ranking tech-debt is fixed.
- **Explicit risk-loosening milestone** with review trail — correct governance for a gate change.
- **No shared package / dashboard** — reject reason unchanged; scope disciplined.
- **No stale halt / no `clearHaltForDate`** — accurate for per-decision skip.
- **Fail-closed and `<=` locked** in Boundary section — prevents accidental semantic drift.
- **Load-bearing regression test** (old floors would block soak-unblocked depths) — high value.
- **`bot-review-quant` in wave 4** — correct owner for consumption ratios and telemetry.
- **DB backup before restart** — matches CLAUDE.md; no migration.

---

## Consciously out of scope (agree with plan)

- Volume-only tier ranking fix — MEDIUM tech-debt; $10k tier1 is a guardrail only.
- Exit-liquidity-aware sizing — MEDIUM tech-debt; 14-day fills inform later work.
- Spread / breadth / index-shock / OI — do not mix into M22.
- Dashboard — tooltip for `coin_book_too_thin` already exists from M19.

---

## Comparison to other independent reviews

No `docs/archive/independent-analysis/gbt/` or `gemini/` M22 review exists at review time. This Composer review aligns with the plan’s embedded **architect + quant APPROVE-WITH-AMENDMENTS** synthesis (2026-06-04) and extends it with **code-verified** seams, **tech-debt deduplication**, and **tier-accurate QA** requirements.

---

## Recommended dispatch adjustment (summary)

1. **Architect** — §6a supersede with new table, one-sided + `<=`, consumption anchor, soak evidence, 14-day telemetry; consider one-line §6b breadth drift fix (M1).  
2. **Engine** — const swap + comment rewrite only (`riskConsts.ts`).  
3. **QA** — boundary tests all tiers; **soak tuples with real tiers** (H1); old-floor regression; fail-closed unchanged; ripgrep backtest for `20_000`/`10_000`/`5_000`.  
4. **Reviewers** — quant owns consumption math + telemetry; logic owns 7/3 split with tier pinning.  
5. **Rollout** — pg_dump → restart → read-only `risk_state` → 10-min smoke → funnel mix check (M4) → start 14-day slippage log.  
6. **Scribe** — merge tech-debt row (H2); milestone-log; overview/CLAUDE status.

With H1 and H2, M22 is a tight follow-on to M19: **same guard, evidence-based floors, survival-first with mandatory fill telemetry before trusting the new numbers.**
