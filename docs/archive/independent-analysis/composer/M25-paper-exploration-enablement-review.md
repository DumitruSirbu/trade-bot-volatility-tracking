# Independent Review — M25 Paper Exploration Enablement

**Plan reviewed:** `docs/plans/archive/M25-paper-exploration-enablement.md`  
**Codebase snapshot:** 2026-06-08 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M25 correctly positions itself as the **volume and approval** milestone after M24's fill fix: switch to v2 momentum (P1), relax non-breadth stress halts in paper (P2), and raise concurrency/sizing headroom (P3). The **paper-gating contract** (`EXCHANGE_ENV=paper` + opt-in flags, breadth leg untouched, gate path intact) is sound and matches ADR 0029 / CLAUDE.md trading-safety invariants. Architect-first dispatch for a deliberate risk-loosening milestone is appropriate.

The plan has one **load-bearing gap**: P3's stated target of **five concurrent positions** (`4 idiosyncratic + 1 BTC-correlated`) is **not achievable** by only bumping `MAX_IDIOSYNCRATIC_SLOTS`. `PositionSlotEnum` has exactly **A, B, C** and `SlotManager` hard-assigns those three labels — the physical ceiling today is **3** concurrent positions, not 5. Worse, setting `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` without new slot enums **breaks** slot-C idiosyncratic overflow (see Verified State). P2's relaxation semantics are also **under-specified** (skip legs vs raise thresholds vs `same_bar` only).

**Assessment:** **Approve with amendments** — ship P1 + P2 + honest P3 (max **3** concurrent + sizing env bumps) after M24 is merged. Defer true 5-slot concurrency to a follow-on that extends `PositionSlotEnum` and `SlotManager` (shared-contract touch). Lock P2 implementation shape in ADR before engine dispatch.

| Area | Grade | Assessment |
|------|-------|------------|
| Sequencing (after M24) | A+ | Correct; M24+M25 is first trades point. |
| P1 v2 activation | A | Config-only; shadow 583 vs 0 evidence is compelling. |
| P2 paper stress relax | B+ | Right direction; breadth isolation good; implementation vague. |
| P3 slot bump | D+ | **5-position target incompatible with A/B/C model**; MAX>2 regresses. |
| P3 sizing headroom | A | Env bumps via `AppConfigService` — correct seam for live paper. |
| Paper-gating semantics | A- | Strong; needs boot-time validation + testnet/live regression. |
| global_halt vs market_stress framing | B | 66% `global_halt` is mostly stale day-lock; P2 + clearHalt helps. |
| DB safety / ops | A | pg_dump, scoped halt clear, no strategy_versions write. |
| Test / dispatch plan | B+ | Good themes; add slot-ceiling math tests and P2 leg matrix. |

**Bottom line:** **Yes** to paper exploration profile (v2 + non-breadth stress relax + sizing). **No** to "5 concurrent" via `PAPER_MAX_IDIOSYNCRATIC_SLOTS` alone — amend P3 target to **3** or scope a slot-model extension milestone. **Lock P2** to skip/disable specific legs in `StressHaltEvaluator` when flag set, never breadth or `hasInvalidStressInputs`.

---

## Verified Current State

### Slot ceiling is three physical slots, not five

```1:5:packages/shared/src/enum/PositionSlotEnum.ts
export enum PositionSlotEnum {
    A = 'A',
    B = 'B',
    C = 'C',
}
```

`SlotManager.assignIdiosyncratic` only ever assigns **A → B → C**. There is no D/E. Maximum concurrent positions:

- **2 idiosyncratic (A+B) + 1 correlated (C)**, or  
- **3 idiosyncratic (A+B+C)** when slot C is used as idiosyncratic overflow.

Architect analysis §3 states hard ceiling **3 concurrent** — consistent with code. M25 P3's "target 5 total" contradicts this.

### `MAX_IDIOSYNCRATIC_SLOTS > 2` reduces capacity (regression)

```61:66:apps/engine/src/risk/service/SlotManager.ts
    private isSlotCFreeForIdiosyncratic(occupied: IOccupiedSlot[]): boolean {
        const slotCTaken = occupied.some((entry) => entry.slot === PositionSlotEnum.C);
        const idiosyncraticCount = occupied.filter((entry) => entry.correlationMode === CorrelationModeEnum.IDIOSYNCRATIC).length;

        return !slotCTaken && idiosyncraticCount >= MAX_IDIOSYNCRATIC_SLOTS;
    }
```

With `MAX_IDIOSYNCRATIC_SLOTS = 2`: after A+B are idiosyncratic, a 3rd idiosyncratic trade may take C — **3 idio max**.

With `MAX_IDIOSYNCRATIC_SLOTS = 4`: C opens only when `idiosyncraticCount >= 4`, but only **3 slots exist** — **C never opens for idiosyncratic overflow**. Effective max idiosyncratic positions drops to **2**.

**Must-fix:** P3 must either (a) keep `MAX_IDIOSYNCRATIC_SLOTS = 2` and document max **3** concurrent, or (b) extend slot model before raising the constant.

### `MAX_OPEN_POSITIONS` does not govern live gate concurrency

Plan correctly cites architect analysis: `RiskGateService` uses `SlotManager`, not `MAX_OPEN_POSITIONS`. Verified — no `maxOpenPositions` reference under `apps/engine/src/risk/`. `MAX_OPEN_POSITIONS` is consumed by `RateLimitPolicyService` (exchange rate buckets) and shadow ledger constants only. Raising it in paper `.env` does **not** unlock slots.

### Stress legs and M23 breadth semantics

`StressHaltEvaluator.isStressed()` disjunction order: invalid inputs → BTC/ETH shock → breadth → `same_bar_trigger_count` → OI → funding → spread.

M23 added `classifyHaltLeg` / `isGlobalStressed` with breadth-only auto-resume. M25 P2 must relax **non-breadth** legs only — implementation should gate at `isStressed()` / `activeStressLegs()` level, **not** disable `isGlobalStressed` or breadth engage thresholds.

`stress_same_bar_trigger_count` is the **only** stress threshold on strategy params (default 5 in seed migration). P2 no-code lever (raise to 15) applies to the **active** version row — after P1 that is **strategy_versions_id=3**, not v1.

### Sizing and exposure read from `AppConfigService` on live path

```329:337:apps/engine/src/strategy/service/StrategyService.ts
    private resolveRiskLimits(): IRiskLimits {
        return {
            dailyLossLimitUsdt: new Money(this.config.dailyLossLimitUsdt),
            // ...
            maxExposurePerCoinUsdt: new Money(this.config.maxExposurePerCoinUsdt),
```

```199:199:apps/engine/src/strategy/service/StrategyService.ts
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
```

P3 sizing headroom via paper `.env` (`MAX_EXPOSURE_PER_COIN_USDT`, `ACCOUNT_CAPITAL_USDT`) is the **correct** lever — no `PositionSizer` code change required if values flow through config. Backtest `BacktestOrchestrator` uses `riskConsts` constants directly — paper env bumps do **not** affect M7 replay (good for ADR 0029).

### `global_halt` dominance in funnel stats

Once `risk_state.is_halted=true`, `firstFailingHaltCheck` returns via `resolveDayHalt` → **`GLOBAL_HALT`** on subsequent intents (not `MARKET_STRESS`). The soak's 66% `global_halt` share is largely **day-lock after an earlier stress engage**, not a separate guard. P2 reduces **new** engages; post-deploy **`clearHaltForDate`** (plan step 3) is required to unblock the current day.

### Correlated slot C strategy leg is immature

`docs/wip/slot-model-and-correlated-leg-gaps.md` notes nothing emits `correlation_mode = correlated` today — slot C is architecturally present but the correlated **strategy** path is not fully wired. P3's "1 BTC-correlated" leg may remain unused even after slot bumps; volume will be **idiosyncratic v2 momentum** through A/B/(C).

---

## Decision Critique — Pros and Cons

### 1. P1 — `ACTIVE_STRATEGY_VERSION_ID=3` (v2 momentum, config-only)

| Pros | Cons |
|------|------|
| Shadow: 583 open intents on same tape vs v1's gate-starved funnel. | v2 still subject to day halts until P2 + clearHalt. |
| No code; reversible env flip. | DB id 3 = "version 2" naming is easy to misconfigure (document in scribe). |
| Aligns with exploration goal (volume + labeled outcomes). | v3 hybrid explicitly wrong for volume — plan doesn't warn against accidental id=4. |

**Verdict:** **Ship.** Pair with optional strategy-param JSONB update on row 3 (WIP Tier A params) if v2 needs `stress_same_bar_trigger_count` / trade caps — not fully enumerated in M25 plan.

---

### 2. P2 — `PAPER_RELAX_MARKET_STRESS` (non-breadth legs only)

| Pros | Cons |
|------|------|
| Addresses engine-constant legs (BTC/ETH/OI/funding/spread) soak cannot tune via params. | Plan says "softens or skips" — ambiguous; quant review needs a single behavior. |
| Breadth + M23 auto-resume preserved — survival baseline remains. | `same_bar` is non-breadth; relaxing it may re-introduce day-killing halts under a different leg suffix (`market_stress:same_bar` → full-day lock per M23). |
| Default-off + `EXCHANGE_ENV=paper` double gate. | Touching both `StressHaltEvaluator` and `RiskGateService` — risk of duplicate or divergent logic. |
| No-code `stress_same_bar_trigger_count` lever complements code flag. | `hasInvalidStressInputs` must **never** be relaxed (fail-closed). |

**Verdict:** **Good with ADR-locked behavior.** Recommend: when flag on, `isStressed()` ignores BTC shock, ETH shock, OI, funding, spread, and `same_bar` — **not** breadth, **not** invalid-input guard. Single implementation in `StressHaltEvaluator`; `RiskGateService` only passes `paperRelaxMarketStress` from config.

---

### 3. P3 — Slot bump (`PAPER_MAX_IDIOSYNCRATIC_SLOTS`)

| Pros | Cons |
|------|------|
| Recognizes slot model — not capital — binds concurrency. | **Cannot reach 5 positions** without new slot enums. |
| Paper-only override pattern matches P2. | `MAX > 2` **breaks** C overflow per current math. |
| | Correlated leg may not produce trades anyway. |
| | May need `idiosyncrasy_min_score` tuning on v2 more than slot count for volume. |

**Verdict:** **Amend scope.** For M25 P3, ship **sizing headroom only** (exposure + capital env) OR keep `MAX_IDIOSYNCRATIC_SLOTS=2` and document **3** as paper concurrent target. Defer true N-slot extension to M25b / tech-debt with shared `PositionSlotEnum` change.

---

### 4. P3 — Sizing headroom (env)

| Pros | Cons |
|------|------|
| `StrategyService` already reads config — minimal code. | Plan cites "$100 default"; `.env.example` uses 100 but `riskConsts` documents 250 — clarify operator paper values (e.g. 250 exposure + 1000 capital). |
| Unblocks `exposure_cap_per_coin` when slots fill. | More capital + more slots (if fixed) = larger paper drawdowns — acceptable for exploration but note in ADR. |
| Backtest path isolated from env bumps. | |

**Verdict:** **Ship as config-only** with explicit recommended paper values in ADR / `.env.example`.

---

### 5. Paper-gating (`EXCHANGE_ENV=paper` + flags)

| Pros | Cons |
|------|------|
| Matches existing `marketStressAutoResumeEnabled` pattern (paper-default-on). | No `EXCHANGE_ENV=testnet` called out — testnet must behave as live (unchanged). |
| Orchestrator byte-identical non-paper check is load-bearing. | String `"false"` truthiness risk (gemini review) — use `class-validator` boolean coercion like M23 flag. |
| Gate path never bypassed. | Accidental `PAPER_RELAX_MARKET_STRESS=true` on live if someone sets wrong `EXCHANGE_ENV` — defense is env enum + flag AND. |

**Verdict:** **Correct pattern.** Add `validateEnv` tests for new flags; assert `exchangeEnv === PAPER` required.

---

### 6. Post-deploy `clearHaltForDate`

| Pros | Cons |
|------|------|
| Stale `is_halted=true` masks P2 immediately after deploy. | If breadth still extreme, halt re-engages on next tick — expected. |
| Scoped upsert — not destructive. | User confirmation + pg_dump before write — plan correct. |
| | Re-halt after clear if relaxation insufficient — monitor in 10-min smoke. |

**Verdict:** **Required step** — keep plan step 3.

---

## Must-fix before dispatch

### H1 — Reconcile P3 "5 positions" with A/B/C slot model

Pick one before architect ADR:

1. **M25 honest target:** max **3** concurrent (current architecture); P3 = sizing env only; optional `PAPER_MAX_IDIOSYNCRATIC_SLOTS` **must stay 2** (or omit env entirely).
2. **Follow-on milestone:** extend `PositionSlotEnum` + `SlotManager` + persistence/backtest mapping for D/E — **out of M25** scope; route through `bot-shared-maintainer`.

Add QA: `PAPER_MAX_IDIOSYNCRATIC_SLOTS=4` must **not** ship without slot enum extension.

### H2 — Lock P2 relaxation semantics in ADR

Document exact legs disabled when `PAPER_RELAX_MARKET_STRESS=true`:

| Leg | Relaxed? |
|-----|----------|
| `hasInvalidStressInputs` | **No** (fail-closed) |
| Breadth | **No** (M23 engage/resume) |
| BTC/ETH shock | Yes |
| `same_bar_trigger_count` | Yes (or rely on param-only lever — pick one, not both redundantly) |
| OI / funding / spread | Yes |

Clarify interaction with `classifyHaltLeg` / `market_stress:multi` when only non-breadth legs would have fired.

### H3 — Boot-time validation for new env vars

Add to `EnvironmentVariables` + `validateEnv.spec.ts`:

- `PAPER_RELAX_MARKET_STRESS` — optional boolean, default `false`
- `PAPER_MAX_IDIOSYNCRATIC_SLOTS` — optional int, default `2`, max `2` until H1 follow-on (or reject `> 2` at boot)

Pattern: mirror `MARKET_STRESS_AUTO_RESUME_ENABLED` resolution in `AppConfigService`.

### H4 — Strategy param update targets v2 row

P2 no-code lever must `UPDATE strategy_versions WHERE strategy_versions_id = 3` (after P1), not assume active v1 row. Document SQL in post-deploy or devops runbook.

---

## Should-fix before dispatch

### M1 — `StressHaltEvaluator` only; inject flag via constructor/config

Avoid splitting relax logic across `RiskGateService` and evaluator — single `isStressed()` gate keeps backtest/paper/live paths consistent.

### M2 — Testnet + live regression matrix

| `EXCHANGE_ENV` | `PAPER_RELAX_*` | Expected |
|----------------|-----------------|----------|
| `paper` | off | Pre-M25 halt behavior (modulo M23) |
| `paper` | on | Non-breadth relaxed |
| `testnet` | on (misconfig) | **Unchanged** — flag ignored |
| `live` | on (misconfig) | **Unchanged** |

### M3 — P2 QA: `same_bar` and `multi` suffix behavior

If `same_bar` relaxed, halt suffix should not be `market_stress:same_bar` on engage. If breadth + BTC both true with relax on, expect `market_stress:breadth` or `multi` depending on classifier — document expected suffix for soak SQL.

### M4 — Funnel acceptance criteria

Post-deploy step 6: define measurable targets (e.g. `market_stress` + `global_halt` share drops vs prior 14d; `positions` row count > 0 within 48h). "Mix of wins and losses" is qualitative — add minimum trade count for soak success.

### M5 — WIP Tier A params not in M25 plan

Companion WIP suggests v2 params (`max_trades_per_bar_universe`, `oi_rising_skip`, etc.). M25 P1 alone may be insufficient volume on non-halted days. Consider optional P1b: JSONB patch on version 3 — strategy-only, no code — in scribe/runbook.

### M6 — Rate limit interaction

If paper raises concurrent positions toward 3, verify `MAX_OPEN_POSITIONS` × `PER_SYMBOL_ORDERS_SHARE` ≤ 1.0 (`RateLimitConfigInvariantException`). May need `MAX_OPEN_POSITIONS=3` in paper `.env` for rate limit math even though gate ignores it for slots.

### M7 — M24 hard prerequisite enforcement

Orchestrator should verify M24 merged and green before M25 engine wave. Deploying M25 without M24 still yields approvals with missed fills.

---

## What looks good

- **Sequencing** — M24 prerequisite explicit; first trades = M24+M25.
- **Risk-loosening visibility** — architect ADR + reviewer wave + explicit label.
- **Breadth untouched** — composes with M23 auto-resume.
- **No shared package** — engine-side only (given amended P3).
- **No migration** — strategy activation is env selection.
- **DB safety** — pg_dump, halt clear scoped, no bulk deletes.
- **Gate path invariant** — thresholds only, no bypass.
- **Shadow/live separation** — M26 deferred.
- **Post-deploy honesty** — 24–48h outcome check; funnel-mix read-only.

---

## Consciously out of scope (agree with plan)

- M24 fill wiring, M26 shadow fills, M27 data capture.
- Live/backtest stress threshold changes.
- Breadth M23 engage/resume edits.
- Strategy-core code changes (v2 already implemented).
- Dashboard UI unless operator asks.

---

## Comparison to other independent reviews

- **Gemini** (`docs/archive/independent-analysis/gemini/M25-paper-exploration-enablement.md`): agrees on paper gating and breadth isolation; recommends boot validation and re-halt monitoring. Composer extends with **slot-model ceiling math (H1)**, **MAX>2 regression**, **P2 leg matrix (H2)**, and **global_halt vs market_stress** framing.
- **Architect analysis P1–P3**: aligned; architect already says 3-slot ceiling — M25 plan's "5 positions" overshoots architect §3.

No `docs/archive/independent-analysis/gbt/` M25 review at review time.

---

## Recommended dispatch adjustment (summary)

1. **Architect** — ADR 0004 paper exploration profile: P2 leg table (H2); P3 concurrent target **3** not 5 (H1); recommended paper env values; live frozen defaults.
2. **Config / ops** — P1 env + optional v2 JSONB (H4); pg_dump; restart; `clearHaltForDate` with user confirm.
3. **Engine Dispatch A (P2)** — `paperRelaxMarketStress` in `AppConfigService`; `StressHaltEvaluator.isStressed()` leg skips; breadth + invalid guard untouched.
4. **Engine Dispatch B (P3)** — **Sizing env only** unless H1 follow-on approved; if slot env added, cap at `2` until enum extension.
5. **QA** — P2 on/off matrix (M2); breadth still halts; testnet ignores flags; slot math regression (H1); `StrategyService` integration with raised exposure; rate-limit invariant (M6).
6. **Reviewers** — Security: paper gate proof. Quant: relaxed profile still analyzable. Logic: slot ceiling + P2 leg classifier.
7. **Scribe** — Record v2 id, relaxed legs, **3-slot ceiling**, clearHalt step; link M24 prerequisite.

With H1–H4, M25 is a disciplined exploration unlock: **more intents (v2), more approved days (P2), fills that stick (M24), sizing that scales (P3 env)** — without pretending the slot model supports five concurrent positions today.
