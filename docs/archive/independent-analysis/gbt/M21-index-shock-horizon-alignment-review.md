# Independent Review — M21 Index-Shock Horizon Alignment

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M21-index-shock-horizon-alignment.md`  
**Date:** 2026-06-04

## Verdict

I approve the direction of M21. The BTC/ETH horizon mismatch is a real structural bug, Option B (align both legs to the 5-minute window) is the right fix, and moving BTC to an engine-side 5m const matches how ETH already works. The atomic `isIndexShock` + `hasInvalidStressInputs` swap is correctly called out as load-bearing.

I would dispatch M21 after two plan-level additions: a stale-halt rollout note (same class of issue as M19) and an explicit downstream test/fixture sweep beyond `StressHaltEvaluator.spec.ts`. On threshold calibration: **raising ETH 2.0 → 2.5 is a good decision** for this project's survival-first posture; **BTC 1.5% on the 5m leg is reasonable but not "proven" by five calm soak days alone** — treat post-deploy monitoring as part of the milestone, not optional.

## Threshold calibration — is raising the floors a good decision?

This is the core product question. The plan mixes two different fixes:

| Leg | Change | Effect |
|-----|--------|--------|
| **BTC** | 1m @ 1.0% (strategy param) → 5m @ 1.5% (engine const) | **Activates** a leg that never fired in soak (1m peak 0.56%). Not purely "raise to reduce halts" — it changes the measurement window and the control knob location. |
| **ETH** | 5m @ 2.0% → 5m @ 2.5% | **Raises** the floor above the single observed 2.12% near-event. Classic false-positive reduction. |

### What general crypto volatility says

**Regime context (2024–2026):** Post–spot-ETF BTC has materially **compressed** realized volatility versus 2020–2021. Fidelity Digital Assets and CME/BVX commentary both describe lower annualized realized vol at comparable price levels — the asset is maturing, not disappearing. That supports **looser** index-shock floors than legacy crypto assumptions, not tighter ones.

**5-minute moves (BTC):** In normal conditions, absolute BTC 5m moves of **~1% or more happen multiple times per week** (fat tails, vol clustering, macro windows). Moves of **~1.5%+ in five minutes** are much rarer on a calm tape but still routine on FOMC/CPI/liquidation days. Industry use of 5m bars for intraday stress is standard (academic intraday crypto vol work also uses 5m granularity).

**5-minute moves (ETH):** Short-horizon ETH beta to BTC is typically **~1.2–1.5×**. If BTC's shock floor is 1.5% on 5m, a proportional ETH floor lands around **~1.8–2.25%**. The proposed **2.5%** is slightly conservative (higher bar than strict beta parity) — appropriate for a halt that kills the **entire UTC day** for mean-reversion entries.

**Rough sanity check (order of magnitude):** With ~50% annualized realized vol, a naïve Gaussian 5m 1σ is on the order of **~0.15%**; **1.5% BTC / 2.5% ETH** are multi-σ events in a calm vol regime — i.e. genuine stress, not noise — but crypto tails are non-Gaussian, so news weeks will still puncture these levels regularly. That is ** desirable** for a global halt whose purpose is "do not fade during index initiation."

### Soak evidence vs market reality

The plan's calibration sample is **five days**, mostly calm, with peaks **BTC 5m 1.04%** and **ETH 5m 2.12% (once)**. That is enough to fix an **observed miscalibration** (especially ETH at 2.0% clipping a non-panic move) but **not** enough to claim statistical optimality.

| Threshold | Buffer above soak peak | Assessment |
|-----------|------------------------|------------|
| BTC 1.5% | ~44% above 1.04% | Reasonable first cut. Likely quiet on calm soak replay; will fire on real macro/liquidation days. |
| ETH 2.5% | ~18% above 2.12% | Good false-positive fix given n=1 event; slightly aggressive statistically but directionally correct. |
| Old BTC 1m @ 1.0% | Never fired (peak 0.56%) | Dead code path — fixing it is hygiene, not loosening live behavior. |

**Bottom line on thresholds:** For a bot that prioritizes **conservative survival over trade count**, **yes — raising ETH to 2.5% and setting BTC to 1.5% on the 5m leg is a defensible decision**. It aligns with (a) compressed post-ETF BTC vol, (b) ETH's higher short-horizon beta, and (c) the soak's demonstrated false-positive on ETH at 2.0%. The residual risk is **under-halting** during moderate index drift that stays below 1.5%/2.5% but still breaks mean-reversion — mitigated by the **other stress OR-legs** (breadth distance now 40, same-bar count 50, OI, funding, spread) documented in the plan's deferred blind-spot section.

**What I would not do:** Re-tighten ETH back toward 2.0% without new evidence. **What I would do after deploy:** Log index-leg near-misses (`|btc_5m| ∈ [1.2,1.5)`, `|eth_5m| ∈ [2.0,2.5)`) for 2–4 weeks and revisit if the day-halt rate is still zero on active macro weeks.

## Must-fix before dispatch

### H1 — Stale `risk_state.is_halted` can survive deploy (M19 pattern)

M21 is code-only and requires an engine restart. `RiskGateService` still short-circuits on persisted halt before re-evaluating stress:

```458:469:apps/engine/src/risk/service/RiskGateService.ts
        if (state.today !== null && state.today.isHalted) {
            return RejectReasonEnum.GLOBAL_HALT;
        }

        if (this.stress.isStressed(context.snapshot, context.params)) {
            this.emitMarketStressIfTransitioning(context, state);
            await this.persistHalt(context, state, RejectReasonEnum.MARKET_STRESS);
```

The June 3 soak investigation shows halts persist for the UTC day once flipped. M21 stops **new** index-shock false halts but does not automatically clear a row already halted under old thresholds.

**Required change:**

- Add a rollout step mirroring M19: after backup + explicit operator confirmation, inspect today's `risk_state`; if `is_halted=true`, `halt_reason='market_stress'`, and live metrics are calm under the **new** floors, clear only today's false halt via `clearHaltForDate` — or wait for UTC rollover before judging trade flow.
- Distinguish verification failures: "old persisted halt" vs "new threshold still halting."

### H2 — Test/fixture sweep scope is narrower than the blast radius

The plan focuses QA on `StressHaltEvaluator.spec.ts`, but multiple suites still drive stress via **`btc_1m_move_pct`**:

- `apps/engine/tests/risk/service/RiskGateService.spec.ts` (integration-style stress → halt persistence)
- `apps/engine/tests/risk/adversarial/M4-adversarial.spec.ts`
- `apps/engine/tests/risk/RiskGateService.bus.spec.ts` / `.bus.adversarial.spec.ts`

After M21, a high `btc_1m_move_pct` with calm `btc_5m_move_pct` will **no longer** stress-halt. Tests may pass while asserting the wrong contract, or fail without a clear migration story.

**Required change:**

- Extend the QA dispatch item: update stress fixtures to set **`btc_5m_move_pct`** (and `eth_5m_move_pct` at 2.5 boundaries) anywhere index shock is the intended trigger.
- Add one RiskGateService-level test: calm 1m + shocked 5m → `MARKET_STRESS` / halt persisted; shocked 1m + calm 5m → **not** index-stressed.

## Should-fix before dispatch

### M1 — ADR 0004 §6 threshold list is stale pre-M21

ADR 0004 §6 still lists `stress_btc_1m_shock_pct` as an active threshold and describes BTC as "params-driven on its 1m field" (see `riskConsts.ts` annotation). §6c must **replace**, not append ambiguously:

- Both index legs: **5m horizon**, engine consts `STRESS_BTC_5M_SHOCK_PCT` / `STRESS_ETH_5M_SHOCK_PCT`.
- Deprecated strategy keys: comment-only, replay-readable.
- Explicit note that `btc_1m_move_pct` remains on the snapshot for telemetry/idiosyncrasy but **exits** the stress halt.

### M2 — Boundary semantics should be locked in the plan

Existing code uses `>=` for both index legs (inclusive at threshold → stressed). State this explicitly in M21 and in §6c so QA uses the same boundary convention as ETH tests today.

### M3 — `hasInvalidStressInputs`: drop unused 1m guard intentionally

The plan moves the BTC guard from `btc_1m_move_pct` → `btc_5m_move_pct`. After swap, invalid `btc_1m_move_pct` will no longer fail-closed globally. That is correct if 1m is out of the stress contract — document it in §6c so a future engineer does not "fix" it back without restoring a consumer.

Optional hardening (not blocking): keep validating `btc_5m_move_pct` **and** `eth_5m_move_pct` only; remove `btc_1m_move_pct` from the scalar list in the same commit.

### M4 — Post-deploy calibration hook (operational, not code)

Add to verification (read-only):

- Query max `|btc_5m_move_pct|` / `|eth_5m_move_pct|` from recent `decisions.market_snapshot` daily for 14 days post-M21.
- Alert if index leg fires more than **N times/week** on days without concurrent breadth/OI/spread stress (possible remaining miscalibration).

### M5 — Test file header drift

`StressHaltEvaluator.spec.ts` header still references `STRESS_BREADTH_DISTANCE_PCT=30`; live const is **40** after the June hotfix. M21 QA should refresh comments while touching the file.

## What looks good

- **Option B** removes the BTC/ETH apples-to-oranges bug; both legs now match the strategy's 5m bar cadence and existing snapshot fields — no new wiring.
- **Engine-side consts for both index legs** ends the historical accident where ETH was const-driven and BTC was param-driven on a mismatched horizon.
- **Atomic two-edit requirement** (`isIndexShock` + `hasInvalidStressInputs`) is exactly the kind of silent fail-open bug that escaped review before; the paired NaN test is the right proof.
- **Deprecation without schema removal** preserves replay/backtest compatibility — consistent with M19's migration-free discipline.
- **Flash-crash blind-spot deferral** is honest: the retired 1m BTC leg was empirically inert; spread widening + same-bar count are better fast proxies; breadth at distance 40 covers coordinated moves.
- **Quant reviewer in the dispatch wave** is appropriate — threshold ownership belongs there.
- **No dashboard scope** is correct — no new reject reason, same `market_stress` halt surface.

## Recommended dispatch adjustment

1. Add **architect §6c** content from M1 before engine code (already in plan — ensure it supersedes §6 threshold bullets, not duplicates them).
2. Expand **QA wave** to include RiskGateService + adversarial/bus specs (H2).
3. Add **rollout note** for stale halt rows (H1) to Verification and scribe checklist.
4. After restart, run the plan's **30-minute calm-market check** plus a **14-day max-move log** (M4) before calling calibration "closed."

With those additions, M21 is a tight, low-risk milestone that finishes the soak miscalibration arc started in M19/M20. The threshold increases are **directionally correct for modern BTC vol and for this bot's halt semantics**; the main residual risk is **thin calibration data**, which post-deploy telemetry should address rather than blocking ship.
